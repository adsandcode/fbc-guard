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
import { maskJs, statementEnd } from "./jsscan.js";
import { isBlockedAddress } from "./fetch.js";

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


// Fixtures in the shape of a minimal hand-written snippet: f holds the URL
// click ID, id the click ID stored in _fbc, i the subdomainIndex.
const HEAD =
  "var f=new URLSearchParams(location.search).get('fbclid');" +
  "var c=(document.cookie.match(/_fbc=([^;]*)/)||[])[1]||'';" +
  "var id=c.split('.')[3]||'';" +
  "var i=location.hostname.split('.').length-1;";
const snippet = (body: string) => `<script>${HEAD}${body}</script>`;
const WRITE_MS = "if(f&&id!==f){document.cookie='_fbc=fb.'+i+'.'+Date.now()+'.'+f;}";

/** Writes creationTime in seconds through Math.floor(Date.now()/1000). Must fail FBC-05 and nothing else. */
export const SNIPPET_SECONDS =
  "<script>var f=new URLSearchParams(location.search).get('fbclid');var c=(document.cookie.match(/_fbc=([^;]*)/)||[])[1]||'';var id=c.split('.')[3]||'';var i=location.hostname.split('.').length-1;if(f&&id!==f){document.cookie='_fbc=fb.'+i+'.'+Math.floor(Date.now()/1000)+'.'+f;}</script>";
/** The same snippet with Date.now(). Must pass every rule. */
export const SNIPPET_MS = SNIPPET_SECONDS.replace("Math.floor(Date.now()/1000)", "Date.now()");

export interface CodeCase {
  name: string;
  code: string;
  expectStatus: Status;
  expectFailed: RuleId[];
  expectUnknown?: RuleId[];
  expectWarnings?: RuleId[];
}

const fails = (rule: RuleId) => ({ expectStatus: "fail" as const, expectFailed: [rule] });
const passes = { expectStatus: "pass" as const, expectFailed: [] };
const warns = (rule: RuleId) => ({ expectStatus: "pass" as const, expectFailed: [], expectWarnings: [rule] });

export const CODE_CASES: CodeCase[] = [
  { name: "original bad fixture", code: BAD_FIXTURE, expectStatus: "fail", expectFailed: ["FBC-01", "FBC-02"], expectWarnings: ["FBC-06"] },
  { name: "original good fixture", code: GOOD_FIXTURE, ...passes },
  { name: "README example", code: README_EXAMPLE, ...passes },

  // One fixture per rule, each a one-change variant of the original good fixture.
  { name: "FBC-01 only: writes the cookie only when it is missing", code: variant(COND, "if(fbclid && ck.indexOf('_fbc=')<0){"), ...fails("FBC-01") },
  { name: "FBC-01 only: never compares the stored ID with the URL fbclid", code: variant(COND, "if(fbclid && !curFbc){"), ...fails("FBC-01") },
  { name: "FBC-02 only: decodes fbclid a second time", code: variant(WRITE, WRITE.replace("+fbclid+", "+decodeURIComponent(fbclid)+")), ...fails("FBC-02") },
  { name: "FBC-03 only: lower-cases fbclid", code: variant(READ, "fbclid=fbclid&&fbclid.toLowerCase();\n" + READ), ...fails("FBC-03") },
  { name: "FBC-04 only: truncates fbclid", code: variant(READ, "fbclid=fbclid&&fbclid.slice(0,100);\n" + READ), ...fails("FBC-04") },
  {
    name: "FBC-05 only: _fbc creationTime in seconds, template literal",
    code: variant(WRITE, "document.cookie=`_fbc=fb.${sdi}.${Math.floor(Date.now()/1000)}.${fbclid};path=/;domain=.${root}`;"),
    ...fails("FBC-05"),
  },
  { name: "FBC-06 only: hard-coded subdomainIndex (warning)", code: variant(WRITE, WRITE.replace("'_fbc=fb.'+sdi+'.'", "'_fbc=fb.1.'")), ...warns("FBC-06") },
  {
    name: "FBP-01 only: _fbp creationTime in seconds, template literal",
    code: variant(WRITE, WRITE + "\n  document.cookie=`_fbp=fb.${sdi}.${Math.floor(Date.now()/1000)}.${Math.floor(Math.random()*1e10)};path=/`;"),
    ...fails("FBP-01"),
  },

  // FBC-05: every way of writing seconds must fail, and only FBC-05.
  { name: "FBC-05 seconds: Math.floor(Date.now()/1000) concatenated", code: SNIPPET_SECONDS, ...fails("FBC-05") },
  { name: "FBC-05 seconds: Date.now()/1e3|0", code: snippet("if(f&&id!==f){document.cookie='_fbc=fb.'+i+'.'+(Date.now()/1e3|0)+'.'+f;}"), ...fails("FBC-05") },
  { name: "FBC-05 seconds: ~~((new Date).getTime()/1000)", code: snippet("if(f&&id!==f){document.cookie='_fbc=fb.'+i+'.'+~~((new Date).getTime()/1000)+'.'+f;}"), ...fails("FBC-05") },
  { name: "FBC-05 seconds: Math.round(new Date().valueOf()/1000)", code: snippet("if(f&&id!==f){document.cookie='_fbc=fb.'+i+'.'+Math.round(new Date().valueOf()/1000)+'.'+f;}"), ...fails("FBC-05") },
  { name: "FBC-05 seconds: Math.trunc( Date.now() / 1000 ) with spaces", code: snippet("if (f && id !== f) { document.cookie = '_fbc=fb.' + i + '.' + Math.trunc( Date.now() / 1000 ) + '.' + f; }"), ...fails("FBC-05") },
  { name: "FBC-05 seconds: parseInt(Date.now()/1000,10)", code: snippet("if(f&&id!==f){document.cookie='_fbc=fb.'+i+'.'+parseInt(Date.now()/1000,10)+'.'+f;}"), ...fails("FBC-05") },
  { name: "FBC-05 seconds: inside a template literal", code: snippet("if(f&&id!==f){document.cookie=`_fbc=fb.${i}.${Math.floor(Date.now()/1000)}.${f}`;}"), ...fails("FBC-05") },
  { name: "FBC-05 seconds: stored in a variable first", code: snippet("var ts=Math.floor(Date.now()/1000);if(f&&id!==f){document.cookie='_fbc=fb.'+i+'.'+ts+'.'+f;}"), ...fails("FBC-05") },
  {
    name: "FBC-05 seconds: statement split across lines",
    code: snippet("\nif (f && id !== f) {\n  document.cookie = '_fbc=fb.' + i + '.' +\n    Math.floor(Date.now() / 1000) + '.' + f;\n}\n"),
    ...fails("FBC-05"),
  },
  {
    name: "FBC-05 seconds: a URL string with // earlier on the line",
    code: snippet("var home='https://example.com/';if(f&&id!==f){document.cookie='_fbc=fb.'+i+'.'+Math.floor(Date.now()/1000)+'.'+f;}"),
    ...fails("FBC-05"),
  },

  { name: "FBC-05 seconds: Math.floor(new Date()/1000)", code: snippet("if(f&&id!==f){document.cookie='_fbc=fb.'+i+'.'+Math.floor(new Date()/1000)+'.'+f;}"), ...fails("FBC-05") },
  { name: "FBC-05 seconds: new Date()/1e3|0", code: snippet("if(f&&id!==f){document.cookie='_fbc=fb.'+i+'.'+(new Date()/1e3|0)+'.'+f;}"), ...fails("FBC-05") },
  { name: "FBC-05 seconds: Math.floor((new Date)/1000)", code: snippet("if(f&&id!==f){document.cookie='_fbc=fb.'+i+'.'+Math.floor((new Date)/1000)+'.'+f;}"), ...fails("FBC-05") },
  { name: "FBC-05 seconds: d.getTime()/1000 for a Date in a variable", code: snippet("var d=new Date();if(f&&id!==f){document.cookie='_fbc=fb.'+i+'.'+Math.floor(d.getTime()/1000)+'.'+f;}"), ...fails("FBC-05") },
  { name: "ms: t0.getTime()/1000 in another statement", code: snippet("var t0=new Date();" + WRITE_MS + "window.onbeforeunload=function(){var stay=Math.round(t0.getTime()/1000);};"), ...passes },
  { name: "FBC-05 seconds: Math.floor(new Date().getTime()/1000)", code: snippet("if(f&&id!==f){document.cookie='_fbc=fb.'+i+'.'+Math.floor(new Date().getTime()/1000)+'.'+f;}"), ...fails("FBC-05") },

  // FBP-01 variants.
  { name: "FBP-01 seconds: concatenated", code: snippet(WRITE_MS + "document.cookie='_fbp=fb.'+i+'.'+Math.floor(Date.now()/1000)+'.'+Math.floor(Math.random()*1e10);"), ...fails("FBP-01") },
  { name: "FBP-01 seconds: +new Date/1000 stored in a variable", code: snippet("var now=Math.round(+new Date/1000);" + WRITE_MS + "document.cookie='_fbp=fb.'+i+'.'+now+'.'+Math.floor(Math.random()*1e10);"), ...fails("FBP-01") },

  // Millisecond code must pass, whatever else in the file divides by 1000.
  { name: "ms: Date.now() concatenated", code: SNIPPET_MS, ...passes },
  { name: "ms: countdown timers with /1000 elsewhere in the script", code: snippet("var end=Date.now()+60000;var left=Math.floor((end-Date.now())/1000);var secs=Math.floor(Date.now()/1000);" + WRITE_MS + "var later=Math.floor(Date.now()/1000);"), ...passes },
  {
    name: "ms: no semicolons, seconds timer on the next line",
    code: snippet("\nconst g = f\nif (g && id !== g) document.cookie = `_fbc=fb.${i}.${Date.now()}.${g}`\nconst secondsLeft = Math.floor(Date.now() / 1000)\n"),
    ...passes,
  },
  { name: "ms: Date.now() stored in a variable first", code: snippet("var ts=Date.now();if(f&&id!==f){document.cookie='_fbc=fb.'+i+'.'+ts+'.'+f;}"), ...passes },
  { name: "ms: variable reassigned from seconds to milliseconds before use", code: snippet("var ts=Math.floor(Date.now()/1000);showTimer(ts);ts=Date.now();if(f&&id!==f){document.cookie='_fbc=fb.'+i+'.'+ts+'.'+f;}"), ...passes },
  { name: "ms: a seconds variable named now, cookie uses Date.now()", code: snippet("var now=Math.floor(Date.now()/1000);" + WRITE_MS), ...passes },
  { name: "ms: commented-out seconds line", code: snippet("\n// document.cookie='_fbc=fb.'+i+'.'+Math.floor(Date.now()/1000)+'.'+f;\n" + WRITE_MS), ...passes },
  { name: "ms: max-age computed from a time difference in the same statement", code: snippet("var exp=Date.now()+7776e6;if(f&&id!==f){document.cookie='_fbc=fb.'+i+'.'+Date.now()+'.'+f+';max-age='+Math.floor((exp-Date.now())/1000);}"), ...passes },

  // FBC-01: which variable holds the URL click ID, and is it compared with the stored one.
  {
    name: "FBC-01 pass: clickId from a regex on fbclid=, compared with !=",
    code: "<script>var clickId=(location.search.match(/[?&]fbclid=([^&]+)/)||[])[1];var stored=((document.cookie.match(/_fbc=([^;]*)/)||[])[1]||'').split('.')[3];var i=location.hostname.split('.').length-1;if(clickId&&stored!=clickId){document.cookie='_fbc=fb.'+i+'.'+Date.now()+'.'+clickId;}</script>",
    ...passes,
  },
  {
    name: "FBC-01 pass: fbclid from split('fbclid='), === with early return",
    code: "(function(){var fbclid=location.search.split('fbclid=')[1];if(!fbclid)return;fbclid=fbclid.split('&')[0];var cur=((document.cookie.match(/_fbc=([^;]*)/)||[])[1]||'').split('.')[3];if(cur===fbclid)return;document.cookie='_fbc=fb.'+(location.hostname.split('.').length-1)+'.'+Date.now()+'.'+fbclid;})();",
    ...passes,
  },
  {
    name: "FBC-01 pass: click from .get(\"fbclid\"), stored !== click",
    code: '<script>var click=new URLSearchParams(location.search).get("fbclid");var storedId=((document.cookie.match(/_fbc=([^;]*)/)||[])[1]||"").split(".")[3];if(click&&storedId!==click){document.cookie="_fbc=fb."+(location.hostname.split(".").length-1)+"."+Date.now()+"."+click;}</script>',
    ...passes,
  },
  { name: "FBC-01 pass: missing-or-different, indexOf combined with a comparison", code: snippet("if(f&&(document.cookie.indexOf('_fbc=')<0||id!==f)){document.cookie='_fbc=fb.'+i+'.'+Date.now()+'.'+f;}"), ...passes },
  { name: "FBC-01 fail: f never compared", code: snippet("if(f){document.cookie='_fbc=fb.'+i+'.'+Date.now()+'.'+f;}"), ...fails("FBC-01") },
  {
    name: "FBC-01 fail: clickId only compared with literals",
    code: "<script>var clickId=(location.search.match(/[?&]fbclid=([^&]+)/)||[])[1];var i=location.hostname.split('.').length-1;if(clickId!==''&&clickId!=null){document.cookie='_fbc=fb.'+i+'.'+Date.now()+'.'+clickId;}</script>",
    ...fails("FBC-01"),
  },
  { name: "FBC-01 fail: f with the write-only-if-missing pattern", code: snippet("if(f&&document.cookie.indexOf('_fbc=')<0){document.cookie='_fbc=fb.'+i+'.'+Date.now()+'.'+f;}"), ...fails("FBC-01") },
  {
    name: "FBC-01 fail: write-only-if-missing, click ID variable not resolvable",
    code: "<script>var x=readClickId();if(x&&document.cookie.indexOf('_fbc=')<0){document.cookie='_fbc=fb.'+sdi()+'.'+Date.now()+'.'+x;}</script>",
    ...fails("FBC-01"),
  },
  {
    name: "FBC-01 unknown: click ID comes from a function call",
    code: "<script>var x=readClickId();var s=storedClickId();if(x&&s!==x){document.cookie='_fbc=fb.'+sdi()+'.'+Date.now()+'.'+x;}</script>",
    expectStatus: "unknown", expectFailed: [], expectUnknown: ["FBC-01"],
  },
  {
    name: "FBC-01 unknown: click ID is a parameter not named fbclid",
    code: "function saveClick(cid){var s=storedClickId();if(s!==cid){document.cookie='_fbc=fb.'+sdi()+'.'+Date.now()+'.'+cid;}}",
    expectStatus: "unknown", expectFailed: [], expectUnknown: ["FBC-01"],
  },

  // Comments, prose in strings and commented-out markup are not code.
  { name: "comment: README-style line mentioning decodeURIComponent(fbclid)", code: variant(READ, "// don't use decodeURIComponent(fbclid)\n" + READ), ...passes },
  { name: "comment: block comment mentioning fbclid.toLowerCase()", code: variant(READ, "/* never call fbclid.toLowerCase() */\n" + READ), ...passes },
  { name: "comment: fbclid.slice( in a comment at the end of a line", code: variant(READ, READ + " // fbclid.slice(0,10) would truncate it"), ...passes },
  { name: "string: a warning message that mentions decodeURIComponent(fbclid)", code: variant(READ, "console.warn('do not call decodeURIComponent(fbclid) twice');\n" + READ), ...passes },
  { name: "comment: old hard-coded _fbc=fb.1. value in a comment", code: variant(READ, "// was: '_fbc=fb.1.'+Date.now()\n" + READ), ...passes },
  {
    name: "HTML comment: a commented-out old script",
    code: "<!-- <script>var fbclid=new URLSearchParams(location.search).get('fbclid');document.cookie='_fbc=fb.1.'+decodeURIComponent(fbclid);</script> -->\n" + GOOD_FIXTURE,
    ...passes,
  },
  { name: "comment control: code after a block comment still fails", code: variant(READ, "/* note */ fbclid=fbclid&&fbclid.toLowerCase();\n" + READ), ...fails("FBC-03") },

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

/** Semicolons inside strings, regexes, template text and comments must not end a statement. */
const SCANNER_CASES = [
  { name: "string", src: "a='x;y'+b;c", statement: "a='x;y'+b" },
  { name: "regex literal", src: "a=s.match(/;[^;]*/g);c", statement: "a=s.match(/;[^;]*/g)" },
  { name: "template literal with an expression", src: "a=`;${b+';'}`+c;d", statement: "a=`;${b+';'}`+c" },
  { name: "comment", src: "a=b // x;y\n;c", statement: "a=b // x;y" },
  { name: "line break after an operator continues", src: "a=b+\nc\nd", statement: "a=b+\nc" },
];

/** [address, refused by default]. */
export const ADDRESS_CASES: [string, boolean][] = [
  ["127.0.0.1", true],
  ["127.255.0.9", true],
  ["10.1.2.3", true],
  ["172.16.0.1", true],
  ["172.31.255.255", true],
  ["192.168.1.1", true],
  ["169.254.169.254", true],
  ["100.64.0.1", true],
  ["0.0.0.0", true],
  ["224.0.0.1", true],
  ["255.255.255.255", true],
  ["::", true],
  ["::1", true],
  ["fc00::1", true],
  ["fd12:3456::1", true],
  ["fe80::1", true],
  ["fe80::1%eth0", true],
  ["ff02::1", true],
  ["::ffff:127.0.0.1", true],
  ["::ffff:7f00:1", true],
  ["::ffff:169.254.169.254", true],
  ["64:ff9b::a00:1", true],
  ["2002:c0a8:101::1", true],
  ["not-an-ip", true],
  ["8.8.8.8", false],
  ["172.32.0.1", false],
  ["100.128.0.1", false],
  ["93.184.215.14", false],
  ["2606:4700:4700::1111", false],
  ["::ffff:8.8.8.8", false],
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

  log("  scanner");
  for (const c of SCANNER_CASES) {
    const got = c.src.slice(0, statementEnd(maskJs(c.src), 0));
    record(got === c.statement, `statement ${JSON.stringify(got)}  ${c.name}`);
  }

  log("  rules");
  for (const c of CODE_CASES) {
    const r = checkCode(c.code);
    const expectUnknown = c.expectUnknown ?? [];
    const expectWarnings = c.expectWarnings ?? [];
    const ok =
      r.status === c.expectStatus && same(r.failed, c.expectFailed) &&
      same(r.unknown, expectUnknown) && same(r.warnings, expectWarnings);
    const fmt = (s: string, f: readonly string[], u: readonly string[], w: readonly string[]) =>
      `${s} [${f.join(",")}]` + (u.length ? ` ?[${u.join(",")}]` : "") + (w.length ? ` w[${w.join(",")}]` : "");
    const want = fmt(c.expectStatus, c.expectFailed, expectUnknown, expectWarnings);
    const got = fmt(r.status, r.failed, r.unknown, r.warnings);
    record(ok, `expected ${want.padEnd(30)} got ${got.padEnd(30)} ${c.name}`);
  }

  // Each rule must be shown to fire on its own somewhere above (fail, or warn for a warning-level rule).
  for (const rule of RULES) {
    const isolated = CODE_CASES.some((c) => {
      const fired = [...c.expectFailed, ...(c.expectWarnings ?? [])];
      return fired.length === 1 && fired[0] === rule.id;
    });
    record(isolated, `${rule.id} has a fixture that fires it and no other rule`);
  }

  log("  address policy (default: public hosts only)");
  for (const [ip, blocked] of ADDRESS_CASES) {
    const got = isBlockedAddress(ip);
    record(got === blocked, `${blocked ? "refuse" : "allow "} ${ip}`);
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
