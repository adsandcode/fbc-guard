#!/usr/bin/env node
/**
 * fbc-guard command line.
 *
 *   fbc-guard <url|file> [...]   check pages or local files
 *   fbc-guard --json <url|file>  same, machine-readable output
 *   fbc-guard --selftest         run only the negative tests
 *
 * Exit codes: 0 no rule failed (every target passed, had a rule that could not
 * decide, or had no _fbc code), 1 a rule failed, 2 the negative tests failed,
 * the arguments were invalid, or a target could not be read. The negative
 * tests run before any target is judged.
 */

import { readFileSync } from "node:fs";

import { extname } from "node:path";

import { checkCode, type CheckResult, type Source } from "./rules.js";
import { fetchBundle, type Skipped } from "./fetch.js";
import { run as runSelftest } from "./selftest.js";

const VERSION: string = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;

const USAGE = `fbc-guard ${VERSION}: static checks for Meta _fbc / _fbp / fbclid code

Usage:
  fbc-guard <url|file> [<url|file> ...]   check pages (http/https) or local files
  fbc-guard --json <url|file> [...]       print JSON instead of text
  fbc-guard --selftest                    run only the negative tests
  fbc-guard --help | --version

URLs are fetched together with their same-origin <script src> files.
Local files are scanned as they are; list your .js files too.

Exit codes: 0 no rule failed (pass, unknown, or no _fbc code found),
            1 a rule failed,
            2 self-test failed, bad arguments, or a target could not be read.`;

type Kind = "url" | "file";

interface TargetResult extends Partial<Omit<CheckResult, "status">> {
  target: string;
  kind: Kind;
  status: CheckResult["status"] | "error";
  error?: string;
  final_url?: string;
  scanned_scripts?: string[];
  skipped_scripts?: Skipped[];
}

const isUrl = (t: string) => /^https?:\/\//i.test(t);

const JS_EXT = new Set([".js", ".mjs", ".cjs", ".jsx", ".ts", ".mts", ".cts", ".tsx"]);
const HTML_EXT = new Set([".html", ".htm", ".xhtml", ".shtml", ".php"]);

/** Read a local file; the extension decides HTML or JavaScript, otherwise the first character does. */
function fileSource(path: string): Source {
  const code = readFileSync(path, "utf8");
  const ext = extname(path).toLowerCase();
  if (JS_EXT.has(ext)) return { code, kind: "js" };
  if (HTML_EXT.has(ext)) return { code, kind: "html" };
  return { code };
}

async function checkTarget(target: string): Promise<TargetResult> {
  const kind: Kind = isUrl(target) ? "url" : "file";
  try {
    if (kind === "url") {
      const b = await fetchBundle(target);
      return {
        target, kind, ...checkCode(b.sources),
        final_url: b.finalUrl, scanned_scripts: b.scripts, skipped_scripts: b.skipped,
      };
    }
    return { target, kind, ...checkCode([fileSource(target)]) };
  } catch (err) {
    return { target, kind, status: "error", error: err instanceof Error ? err.message : String(err) };
  }
}

function printText(r: TargetResult): void {
  console.log(`\n> ${r.target}`);
  if (r.status === "error") {
    console.log(`  [ERROR] could not read this target: ${r.error}`);
    return;
  }
  if (r.kind === "url") {
    if (r.final_url && r.final_url !== r.target) console.log(`  final URL: ${r.final_url}`);
    console.log(`  scanned: page + ${r.scanned_scripts?.length ?? 0} same-origin script(s)`);
    for (const s of r.scanned_scripts ?? []) console.log(`    + ${s}`);
    for (const s of r.skipped_scripts ?? []) console.log(`    - ${s.url} (${s.reason})`);
  }
  if (r.status === "not_applicable") {
    console.log(`  [ n/a] ${r.note}`);
    return;
  }
  for (const rule of r.rules ?? []) {
    if (rule.status === "pass") {
      console.log(`  [ ok ] ${rule.id}  ${rule.title}`);
    } else if (rule.status === "unknown") {
      console.log(`  [ ?? ] ${rule.id}  ${rule.title}`);
      console.log(`         could not decide: ${rule.evidence}`);
    } else {
      console.log(`  [FAIL] ${rule.id}  ${rule.title}`);
      console.log(`         why: ${rule.protects}`);
      console.log(`         found: ${rule.evidence}`);
      console.log(`         ref: ${rule.reference}`);
    }
  }
}

async function main(argv: string[]): Promise<number> {
  const flags = argv.filter((a) => a.startsWith("--"));
  const targets = argv.filter((a) => !a.startsWith("--"));
  const known = new Set(["--json", "--selftest", "--help", "--version"]);
  const unknown = flags.filter((f) => !known.has(f));

  if (unknown.length) {
    console.error(`fbc-guard: unknown option ${unknown.join(", ")}\n\n${USAGE}`);
    return 2;
  }
  if (flags.includes("--help")) {
    console.log(USAGE);
    return 0;
  }
  if (flags.includes("--version")) {
    console.log(VERSION);
    return 0;
  }
  if (flags.includes("--selftest")) {
    if (argv.length !== 1) {
      console.error("fbc-guard: --selftest takes no other arguments.");
      return 2;
    }
    console.log("fbc-guard negative tests: every rule must be shown to fail, the reference code must pass.");
    const ok = runSelftest();
    console.log(ok ? "self-test passed: the rules can be trusted to fail." : "self-test FAILED: the rules cannot be trusted.");
    return ok ? 0 : 2;
  }
  if (!targets.length) {
    console.error(USAGE);
    return 2;
  }

  // The rules must prove they still fail on known-bad code before judging anything.
  const lines: string[] = [];
  if (!runSelftest((s) => lines.push(s))) {
    console.error("fbc-guard: negative tests failed, refusing to judge any input.");
    console.error(lines.join("\n"));
    return 2;
  }

  const json = flags.includes("--json");
  const results: TargetResult[] = [];
  for (const t of targets) {
    const r = await checkTarget(t);
    results.push(r);
    if (!json) printText(r);
  }

  const count = (s: TargetResult["status"]) => results.filter((r) => r.status === s).length;
  const exit = count("error") ? 2 : count("fail") ? 1 : 0;

  if (json) {
    console.log(JSON.stringify({ tool: "fbc-guard", version: VERSION, selftest: "passed", exit_code: exit, results }, null, 2));
  } else {
    console.log(
      `\n${results.length} target(s): ${count("pass")} pass, ${count("fail")} fail, ${count("unknown")} unknown, ` +
        `${count("not_applicable")} not applicable, ${count("error")} error`,
    );
    if (count("unknown"))
      console.log("unknown = no rule failed, but at least one rule could not decide. It is not a full pass.");
    if (count("not_applicable"))
      console.log("not applicable = no _fbc code was found, so nothing was judged. It is not a pass.");
  }
  return exit;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.error("fbc-guard: fatal", err);
    process.exitCode = 2;
  },
);
