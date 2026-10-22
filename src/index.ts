#!/usr/bin/env node
/**
 * fbc-guard MCP server.
 *
 * Lets an assistant check Meta click ID (_fbc / fbclid) and browser ID (_fbp)
 * code while it is writing or reviewing a landing page, instead of after Meta
 * Events Manager has started warning about it.
 *
 * check_fbc_code is pure: code in, verdict out. check_fbc_url makes network
 * requests: the page itself, then same-origin scripts only.
 *
 * The negative tests run once at startup and the server refuses to start if
 * they fail, because a checker that cannot prove it still catches known-bad
 * code should not be answering questions about yours.
 */

import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { checkCode, RULES } from "./rules.js";
import { fetchBundle, LIMITS } from "./fetch.js";
import { run as runSelftest } from "./selftest.js";

const VERSION: string = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;

const text = (payload: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
});

const RULE_SUMMARY = RULES.map((r) => `${r.id}: ${r.title}.`).join(" ");

const RESULT_SHAPE =
  'Returns JSON with `status` ("pass", "fail" or "not_applicable"), `failed` (rule IDs), and `rules` (one entry per rule with status, evidence, what it protects against, and a link to Meta\'s documentation). "not_applicable" means no `_fbc` appeared in the content, so nothing was judged; it is not a pass.';

const server = new McpServer({ name: "fbc-guard", version: VERSION });

server.tool(
  "check_fbc_code",
  "Statically check HTML or JavaScript that reads `fbclid` from the URL and writes Meta's `_fbc` click ID cookie (and optionally `_fbp`). " +
    "It catches the mistakes that make Meta Events Manager report a modified fbclid or attribute a conversion to the wrong ad: " +
    "keeping an old click ID when a visitor arrives from a new ad, decoding, re-casing or truncating the click ID, writing creationTime in seconds instead of milliseconds, and hard-coding subdomainIndex. " +
    `Rules: ${RULE_SUMMARY} ` +
    RESULT_SHAPE +
    " This is regular-expression analysis of source text: minified, bundled or obfuscated code can hide a mistake, so a pass is not proof of correctness.",
  {
    code: z.string().describe("HTML or JavaScript source to check. Include every file that touches fbclid, _fbc or _fbp, concatenated."),
  },
  async ({ code }) => text(checkCode(code)),
);

server.tool(
  "check_fbc_url",
  "Fetch a landing page and run the same checks as check_fbc_code on its HTML plus every same-origin <script src> it loads, so tracking code kept in an external file is included. " +
    `Cross-origin scripts (tag managers, the Meta Pixel, analytics SDKs) are never fetched and are listed under skipped_scripts. Limits: ${LIMITS.timeoutMs / 1000} s timeout per request, at most ${LIMITS.maxScripts} scripts, ${LIMITS.maxBytes / 1024 / 1024} MB per file. ` +
    "Uses a mobile Safari user agent. " +
    RESULT_SHAPE +
    " Also returns final_url (after redirects), scanned_scripts and skipped_scripts.",
  {
    url: z.string().describe("http or https URL of the landing page."),
  },
  async ({ url }) => {
    try {
      const bundle = await fetchBundle(url);
      return text({
        url,
        final_url: bundle.finalUrl,
        ...checkCode(bundle.code),
        scanned_scripts: bundle.scripts,
        skipped_scripts: bundle.skipped,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ...text({ url, status: "error", error: message }), isError: true };
    }
  },
);

async function main() {
  const lines: string[] = [];
  if (!runSelftest((s) => lines.push(s))) {
    console.error("fbc-guard: negative tests failed, refusing to start.");
    console.error(lines.join("\n"));
    process.exit(2);
  }
  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  console.error("fbc-guard: fatal", err);
  process.exit(1);
});
