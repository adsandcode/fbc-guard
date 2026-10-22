/**
 * Talks to the built server over stdio the way a real MCP client would.
 * Compiling is not evidence that the server answers.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { createServer } from "node:http";

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(here, "..", "dist");
const { BAD_FIXTURE, GOOD_FIXTURE } = await import(pathToFileURL(resolve(dist, "selftest.js")).href);

const transport = new StdioClientTransport({ command: process.execPath, args: [resolve(dist, "index.js")] });
const client = new Client({ name: "fbc-guard-smoke", version: "0.0.0" });
await client.connect(transport);

let failures = 0;
const expect = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`  [${ok ? "ok" : "FAIL"}] ${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
};
const parse = (r) => JSON.parse(r.content[0].text);

const { tools } = await client.listTools();
const names = tools.map((t) => t.name).sort();
console.log("tools:", names.join(", "));
expect("tool list", names, ["check_fbc_code", "check_fbc_url"]);

const bad = parse(await client.callTool({ name: "check_fbc_code", arguments: { code: BAD_FIXTURE } }));
expect("bad code status", bad.status, "fail");
expect("bad code failed rules", bad.failed, ["FBC-01", "FBC-02", "FBC-06"]);
expect("bad code reports every rule", bad.rules.length, 7);

const good = parse(await client.callTool({ name: "check_fbc_code", arguments: { code: GOOD_FIXTURE } }));
expect("good code status", good.status, "pass");
expect("good code failed rules", good.failed, []);

const none = parse(await client.callTool({ name: "check_fbc_code", arguments: { code: "<p>no tracking here</p>" } }));
expect("code without _fbc", none.status, "not_applicable");

const badUrl = await client.callTool({ name: "check_fbc_url", arguments: { url: "ftp://example.com/" } });
expect("non-http URL is refused", [parse(badUrl).status, badUrl.isError === true], ["error", true]);

// check_fbc_url against two local servers on different ports, which are
// different origins. The tracking code lives only in an external same-origin
// file; the other origin must never receive a request.
const otherHits = [];
const other = createServer((req, res) => {
  otherHits.push(req.url);
  res.end("document.cookie='_fbc=fb.1.'+Date.now()/1000;");
});
const site = createServer((req, res) => {
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
  };
  (routes[req.url] ?? (() => { res.statusCode = 404; res.end(); }))();
});
await Promise.all([site, other].map((s) => new Promise((ok) => s.listen(0, "127.0.0.1", ok))));
const siteOrigin = `http://127.0.0.1:${site.address().port}`;

const viaUrl = parse(await client.callTool({ name: "check_fbc_url", arguments: { url: `${siteOrigin}/start` } }));
expect("url: follows the page redirect", viaUrl.final_url, `${siteOrigin}/lp/`);
expect("url: judges code found in the external file", [viaUrl.status, viaUrl.failed], ["fail", ["FBC-01", "FBC-02", "FBC-06"]]);
expect("url: scanned scripts", viaUrl.scanned_scripts, [`${siteOrigin}/js/tracking.js`]);
expect(
  "url: skipped scripts",
  viaUrl.skipped_scripts.map((s) => s.url).sort(),
  [`${siteOrigin}/js/huge-stream.js`, `${siteOrigin}/js/huge.js`, `${siteOrigin}/js/jump.js`, `http://127.0.0.1:${other.address().port}/sdk.js`].sort(),
);
expect("url: requests that reached the other origin", otherHits, []);

await Promise.all([site, other].map((s) => new Promise((ok) => { s.close(ok); s.closeAllConnections(); })));
await client.close();
console.log(failures ? `\n${failures} smoke check(s) failed` : "\nall smoke checks passed");
process.exit(failures ? 1 : 0);
