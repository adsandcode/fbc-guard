/**
 * Negative tests for the rules themselves.
 *
 * A guard that has never been shown to fail is decoration. Every rule here is
 * proven to fail on its own, on a fixture that breaks that rule and nothing
 * else, and the reference implementation is proven to pass all of them. The
 * CLI and the MCP server both run this before judging anything, and refuse to
 * give a verdict if it does not pass.
 */

import { checkCode, RULES, type RuleId, type Status } from "./rules.js";
import { planScripts } from "./fetch.js";

/** Original known-bad fixture: writes only when the cookie is missing, decodes twice, hard-codes subdomainIndex. */
export const BAD_FIXTURE = String.raw`<script>
var qs=new URLSearchParams(location.search), fbclid=qs.get('fbclid');
var ck=document.cookie;
if(fbclid && ck.indexOf('_fbc=')<0){
  document.cookie='_fbc=fb.1.'+Date.now()+'.'+decodeURIComponent(fbclid)+';path=/';
}
</script>`;

/** Original known-good fixture. Every per-rule fixture below is this with one change. */
export const GOOD_FIXTURE = String.raw`<script>
var qs=new URLSearchParams(location.search), fbclid=qs.get('fbclid');
var ck=document.cookie;
var hp=location.hostname.split('.'), root=hp.slice(-2).join('.');
var sdi=root.split('.').length-1;
var curFbc=(ck.match(/(?:^|;\s*)_fbc=([^;]*)/)||[])[1]||'';
var curId=curFbc?curFbc.split('.').slice(3).join('.'):'';
if(fbclid && curId!==fbclid){
  document.cookie='_fbc=fb.'+sdi+'.'+Date.now()+'.'+fbclid+';path=/;domain=.'+root;
}
</script>`;

/**
 * The example printed in README.md. scripts/check-publish-ready.mjs refuses to
 * publish if the README no longer contains this exact text, so the example
 * readers copy is always one that has been run through the rules.
 */
export const README_EXAMPLE = String.raw`<script>
(function () {
  // URLSearchParams.get() already returns the decoded value. Use it as is.
  var fbclid = new URLSearchParams(location.search).get('fbclid');
  if (!fbclid) return;

  // The click ID in an existing _fbc cookie is its fourth field:
  // fb.<subdomainIndex>.<creationTime>.<fbclid>
  var current = (document.cookie.match(/(?:^|;\s*)_fbc=([^;]*)/) || [])[1] || '';
  var storedId = current ? current.split('.')[3] : '';

  // A different click replaces the stored one. The same click keeps it.
  if (storedId !== fbclid) {
    // Use the widest domain the browser accepts for a cookie, and derive
    // subdomainIndex from it: example.com is 1, www.example.com is 2.
    var host = location.hostname, parts = host.split('.');
    var domain = host, domainAttr = '';
    for (var i = parts.length - 2; i >= 0; i--) {
      var candidate = parts.slice(i).join('.');
      document.cookie = 'cookie_domain_probe=1;path=/;domain=' + candidate;
      if (document.cookie.indexOf('cookie_domain_probe=1') >= 0) {
        document.cookie = 'cookie_domain_probe=;path=/;domain=' + candidate + ';max-age=0';
        domain = candidate;
        domainAttr = ';domain=' + candidate;
        break;
      }
    }
    var subdomainIndex = domain.split('.').length - 1;

    // creationTime is Date.now(): milliseconds, not seconds. 90 days = 7776000 s.
    document.cookie = '_fbc=fb.' + subdomainIndex + '.' + Date.now() + '.' + fbclid +
      ';path=/' + domainAttr + ';max-age=7776000;SameSite=Lax';
  }
})();
</script>`;

function variant(from: string, to: string): string {
  if (!GOOD_FIXTURE.includes(from)) throw new Error("selftest fixture is out of date: " + from);
  return GOOD_FIXTURE.replace(from, to);
}

const COND = "if(fbclid && curId!==fbclid){";
const WRITE = "document.cookie='_fbc=fb.'+sdi+'.'+Date.now()+'.'+fbclid+';path=/;domain=.'+root;";
const READ = "var ck=document.cookie;";

export interface CodeCase {
  name: string;
  code: string;
  expectStatus: Status;
  expectFailed: RuleId[];
}

export const CODE_CASES: CodeCase[] = [
  { name: "original bad fixture", code: BAD_FIXTURE, expectStatus: "fail", expectFailed: ["FBC-01", "FBC-02", "FBC-06"] },
  { name: "original good fixture", code: GOOD_FIXTURE, expectStatus: "pass", expectFailed: [] },
  { name: "README example", code: README_EXAMPLE, expectStatus: "pass", expectFailed: [] },
  {
    name: "FBC-01 only: writes the cookie only when it is missing",
    code: variant(COND, "if(fbclid && ck.indexOf('_fbc=')<0){"),
    expectStatus: "fail", expectFailed: ["FBC-01"],
  },
  {
    name: "FBC-01 only: never compares the stored ID with the URL fbclid",
    code: variant(COND, "if(fbclid && !curFbc){"),
    expectStatus: "fail", expectFailed: ["FBC-01"],
  },
  {
    name: "FBC-02 only: decodes fbclid a second time",
    code: variant(WRITE, WRITE.replace("+fbclid+", "+decodeURIComponent(fbclid)+")),
    expectStatus: "fail", expectFailed: ["FBC-02"],
  },
  {
    name: "FBC-03 only: lower-cases fbclid",
    code: variant(READ, "fbclid=fbclid&&fbclid.toLowerCase();\n" + READ),
    expectStatus: "fail", expectFailed: ["FBC-03"],
  },
  {
    name: "FBC-04 only: truncates fbclid",
    code: variant(READ, "fbclid=fbclid&&fbclid.slice(0,100);\n" + READ),
    expectStatus: "fail", expectFailed: ["FBC-04"],
  },
  {
    name: "FBC-05 only: _fbc creationTime in seconds",
    code: variant(WRITE, "document.cookie=`_fbc=fb.${sdi}.${Math.floor(Date.now()/1000)}.${fbclid};path=/;domain=.${root}`;"),
    expectStatus: "fail", expectFailed: ["FBC-05"],
  },
  {
    name: "FBC-06 only: hard-coded subdomainIndex",
    code: variant(WRITE, WRITE.replace("'_fbc=fb.'+sdi+'.'", "'_fbc=fb.1.'")),
    expectStatus: "fail", expectFailed: ["FBC-06"],
  },
  {
    name: "FBP-01 only: _fbp creationTime in seconds",
    code: variant(WRITE, WRITE + "\n  document.cookie=`_fbp=fb.${sdi}.${Math.floor(Date.now()/1000)}.${Math.floor(Math.random()*1e10)};path=/`;"),
    expectStatus: "fail", expectFailed: ["FBP-01"],
  },
  {
    name: "no _fbc at all is not applicable, even with a broken fbclid line",
    code: "<script>var fbclid=new URLSearchParams(location.search).get('fbclid');sessionStorage.setItem('click',fbclid.toLowerCase());</script>",
    expectStatus: "not_applicable", expectFailed: [],
  },
];

interface PlanCase {
  name: string;
  html: string;
  page: string;
  max?: number;
  expectFetch: string[];
  expectSkipped: string[];
}

const many = Array.from({ length: 25 }, (_, i) => `<script src="/s${i}.js"></script>`).join("\n");

export const PLAN_CASES: PlanCase[] = [
  {
    name: "same-origin scripts are fetched, everything else is not",
    page: "https://example.com/lp/index.html",
    html: [
      '<script src="/js/tracking.js"></script>',
      "<script async src='https://www.googletagmanager.com/gtm.js?id=GTM-TEST'></script>",
      "<script src=//connect.facebook.net/en_US/fbevents.js></script>",
      '<script src="https://cdn.example.com/lib.js"></script>',
      '<script src="http://example.com/insecure.js"></script>',
      '<script data-src="/lazy.js"></script>',
      '<script type="module" src="app.js#v2"></script>',
      '<script src="/js/tracking.js"></script>',
      '<script src="https://example.com/absolute.js"></script>',
      '<script src="data:text/javascript,void 0"></script>',
    ].join("\n"),
    expectFetch: [
      "https://example.com/js/tracking.js",
      "https://example.com/lp/app.js",
      "https://example.com/absolute.js",
    ],
    expectSkipped: [
      "https://www.googletagmanager.com/gtm.js?id=GTM-TEST",
      "https://connect.facebook.net/en_US/fbevents.js",
      "https://cdn.example.com/lib.js",
      "http://example.com/insecure.js",
      "data:text/javascript,void 0",
    ],
  },
  {
    name: "at most 20 scripts are fetched",
    page: "https://example.com/",
    html: many,
    expectFetch: Array.from({ length: 20 }, (_, i) => `https://example.com/s${i}.js`),
    expectSkipped: Array.from({ length: 5 }, (_, i) => `https://example.com/s${i + 20}.js`),
  },
];

const same = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

export function run(log: (s: string) => void = console.log): boolean {
  let passed = 0;
  let failed = 0;
  const record = (ok: boolean, line: string) => {
    ok ? passed++ : failed++;
    log(`    [${ok ? "ok" : "FAIL"}] ${line}`);
  };

  log("  rules");
  for (const c of CODE_CASES) {
    const r = checkCode(c.code);
    const ok = r.status === c.expectStatus && same(r.failed, c.expectFailed);
    const want = `${c.expectStatus} [${c.expectFailed.join(",")}]`;
    const got = `${r.status} [${r.failed.join(",")}]`;
    record(ok, `expected ${want.padEnd(30)} got ${got.padEnd(30)} ${c.name}`);
  }

  // Each rule must be shown to fail on its own somewhere above.
  for (const rule of RULES) {
    const isolated = CODE_CASES.some(
      (c) => c.expectFailed.length === 1 && c.expectFailed[0] === rule.id,
    );
    record(isolated, `${rule.id} has a fixture that fails it and no other rule`);
  }

  log("  script fetching");
  for (const c of PLAN_CASES) {
    const p = planScripts(c.html, c.page, c.max);
    const ok = same(p.fetch, c.expectFetch) && same(p.skipped.map((s) => s.url), c.expectSkipped);
    record(ok, `fetch ${p.fetch.length}, skip ${p.skipped.length}  ${c.name}`);
  }

  log(`  ${passed} passed, ${failed} failed`);
  return failed === 0;
}

if (process.argv[1] && /selftest\.js$/.test(process.argv[1])) {
  process.exit(run() ? 0 : 2);
}
