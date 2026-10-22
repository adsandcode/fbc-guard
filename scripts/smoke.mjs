/**
 * Talks to the built server over stdio the way a real MCP client would.
 * Compiling is not evidence that the server answers.
 *
 * Two servers are started: one with FBC_GUARD_ALLOW_PRIVATE=1, so it can
 * check pages served by this script on 127.0.0.1, and one with the default
 * policy, which must refuse them.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { createServer } from "node:http";

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(here, "..", "dist");
const load = (f) => import(pathToFileURL(resolve(dist, f)).href);
const { BAD_FIXTURE, GOOD_FIXTURE, SNIPPET_SECONDS, SNIPPET_MS, CODE_CASES } = await load("selftest.js");
const { fetchBundle, UNREACHABLE } = await load("fetch.js");

async function startServer(env) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve(dist, "index.js")],
    env: { ...getDefaultEnvironment(), ...env },
  });
  const client = new Client({ name: "fbc-guard-smoke", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

let failures = 0;
const expect = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`  [${ok ? "ok" : "FAIL"}] ${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
};
const parse = (r) => JSON.parse(r.content[0].text);

const client = await startServer({ FBC_GUARD_ALLOW_PRIVATE: "1" });
const call = async (c, name, args) => parse(await c.callTool({ name, arguments: args }));

const { tools } = await client.listTools();
const names = tools.map((t) => t.name).sort();
console.log("tools:", names.join(", "));
expect("tool list", names, ["check_fbc_code", "check_fbc_url"]);

const bad = await call(client, "check_fbc_code", { code: BAD_FIXTURE });
expect("bad code", [bad.status, bad.failed, bad.warnings], ["fail", ["FBC-01", "FBC-02"], ["FBC-06"]]);
expect("bad code reports every rule", bad.rules.length, 7);
expect("FBC-06 is reported as warn", bad.rules.find((r) => r.id === "FBC-06").status, "warn");

const good = await call(client, "check_fbc_code", { code: GOOD_FIXTURE });
expect("good code", [good.status, good.failed, good.warnings], ["pass", [], []]);

const none = await call(client, "check_fbc_code", { code: "<p>no tracking here</p>" });
expect("code without _fbc", none.status, "not_applicable");

const secs = await call(client, "check_fbc_code", { code: SNIPPET_SECONDS });
expect("seconds snippet", [secs.status, secs.failed], ["fail", ["FBC-05"]]);
const ms = await call(client, "check_fbc_code", { code: SNIPPET_MS });
expect("milliseconds snippet", [ms.status, ms.failed, ms.unknown, ms.warnings], ["pass", [], [], []]);

const unresolvable = CODE_CASES.find((c) => c.expectStatus === "unknown");
const unk = await call(client, "check_fbc_code", { code: unresolvable.code });
expect("unresolvable click ID is unknown, not a failure", [unk.status, unk.failed, unk.unknown], ["unknown", [], ["FBC-01"]]);

// The same JavaScript without <script> tags, read as HTML, has no script to analyse.
const bare = SNIPPET_SECONDS.replace(/<\/?script>/g, "");
expect("kind js reads bare JavaScript", (await call(client, "check_fbc_code", { code: bare, kind: "js" })).failed, ["FBC-05"]);
expect("kind html finds no inline script in bare JavaScript", (await call(client, "check_fbc_code", { code: bare, kind: "html" })).failed, []);

const badUrl = await client.callTool({ name: "check_fbc_url", arguments: { url: "ftp://example.com/" } });
expect("non-http URL is refused", [parse(badUrl).status, badUrl.isError === true], ["error", true]);

// Local servers. Different ports are different origins. The tracking code
// lives only in an external same-origin file; the other origin and the
// "internal" host on 127.0.0.2 must never receive a request unless allowed.
const hits = { site: [], other: [], internal: [] };
const other = createServer((req, res) => {
  hits.other.push(req.url);
  res.end("document.cookie='_fbc=fb.1.'+Date.now()/1000;");
});
const internal = createServer((req, res) => {
  hits.internal.push(req.url);
  res.end("<html>internal</html>");
});
const site = createServer((req, res) => {
  hits.site.push(req.url);
  const o = `http://127.0.0.1:${other.address().port}`;
  const routes = {
    "/start": () => { res.writeHead(302, { location: "/lp/" }); res.end(); },
    "/lp/": () => {
      res.setHeader("content-type", "text/html");
      res.end(`<html><head>
<script src="/js/tracking.js"></script>
<script src="${o}/sdk.js"></script>
<script src="/js/jump.js"></script>
<script src="/js/huge.js"></script>
<script src="/js/huge-stream.js"></script>
</head><body>landing page</body></html>`);
    },
    "/js/tracking.js": () => res.end(BAD_FIXTURE.replace(/<\/?script>/g, "")),
    "/js/jump.js": () => { res.writeHead(302, { location: `${o}/jumped.js` }); res.end(); },
    "/js/huge.js": () => res.end("/*" + "x".repeat(2 * 1024 * 1024 + 10) + "*/"),
    "/js/huge-stream.js": () => {
      // No Content-Length: the size cap has to be enforced while reading.
      for (let i = 0; i < 3; i++) res.write("/*" + "y".repeat(1024 * 1024) + "*/");
      res.end();
    },
    "/to-internal": () => { res.writeHead(302, { location: `http://127.0.0.2:${internal.address().port}/secret` }); res.end(); },
  };
  (routes[req.url] ?? (() => { res.statusCode = 404; res.end(); }))();
});
await Promise.all([
  new Promise((ok) => site.listen(0, "127.0.0.1", ok)),
  new Promise((ok) => other.listen(0, "127.0.0.1", ok)),
  new Promise((ok) => internal.listen(0, "127.0.0.2", ok)),
]);
const siteOrigin = `http://127.0.0.1:${site.address().port}`;

const viaUrl = await call(client, "check_fbc_url", { url: `${siteOrigin}/start` });
expect("url (opt-in): follows the page redirect", viaUrl.final_url, `${siteOrigin}/lp/`);
expect("url (opt-in): judges code found in the external file", [viaUrl.status, viaUrl.failed], ["fail", ["FBC-01", "FBC-02"]]);
expect("url (opt-in): scanned scripts", viaUrl.scanned_scripts, [`${siteOrigin}/js/tracking.js`]);
expect(
  "url (opt-in): skipped scripts",
  viaUrl.skipped_scripts.map((s) => s.url).sort(),
  [`${siteOrigin}/js/huge-stream.js`, `${siteOrigin}/js/huge.js`, `${siteOrigin}/js/jump.js`, `http://127.0.0.1:${other.address().port}/sdk.js`].sort(),
);
expect("url (opt-in): requests that reached the other origin", hits.other, []);

// Default policy: a server started without the opt-in refuses all of this.
const strict = await startServer({});
const siteHitsBefore = hits.site.length;
const refusedLoopback = await strict.callTool({ name: "check_fbc_url", arguments: { url: `${siteOrigin}/lp/` } });
expect("default: 127.0.0.1 is refused", [parse(refusedLoopback).status, parse(refusedLoopback).error, refusedLoopback.isError], ["error", UNREACHABLE, true]);
for (const u of [`http://localhost:${site.address().port}/lp/`, `http://[::1]:${site.address().port}/`, "http://169.254.169.254/latest/meta-data/", "http://10.0.0.1/", "http://2130706433/"]) {
  expect(`default: ${u} is refused`, (await call(strict, "check_fbc_url", { url: u })).error, UNREACHABLE);
}
expect("default: no request reached the local site", hits.site.length - siteHitsBefore, 0);
const unreachable = await call(strict, "check_fbc_url", { url: "http://nothing-here.invalid/" });
expect("default: an unresolvable host gives the same error as a refused one", unreachable.error, UNREACHABLE);

// Redirect from an allowed host to an internal one. The allowed host here is
// 127.0.0.1 through a policy that permits exactly that address, standing in
// for a public page. First prove the redirect is really followed when allowed.
const toInternal = `${siteOrigin}/to-internal`;
await fetchBundle(toInternal, { allowPrivate: true });
expect("control: with everything allowed, the redirect reaches 127.0.0.2", hits.internal.length, 1);
let redirectError = null;
try {
  await fetchBundle(toInternal, { isAllowedAddress: (ip) => ip === "127.0.0.1" });
} catch (err) {
  redirectError = err.message;
}
expect("redirect to an internal address is refused", redirectError, UNREACHABLE);
expect("the internal host received no further request", hits.internal.length, 1);

await strict.close();
await Promise.all([site, other, internal].map((s) => new Promise((ok) => { s.close(ok); s.closeAllConnections(); })));
await client.close();
console.log(failures ? `\n${failures} smoke check(s) failed` : "\nall smoke checks passed");
process.exit(failures ? 1 : 0);
