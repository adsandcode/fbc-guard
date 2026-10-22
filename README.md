# fbc-guard

Static checks for the landing-page code that stores Meta's click ID.

Documentation and background: [adsandcode.com/en/open-source/fbc-guard](https://adsandcode.com/en/open-source/fbc-guard/)

fbc-guard reads the HTML and JavaScript that turn the `fbclid` URL parameter into the `_fbc`
cookie (and, if you write it yourself, the `_fbp` cookie), and flags the known
ways that code changes or loses the click ID.

It runs as an MCP server, so an AI assistant can check tracking code while it
writes or reviews a page, and as a command-line tool for CI.

## The problem it addresses

When someone clicks a Meta ad, the landing page URL carries an `fbclid`
parameter. Your page, or the Meta Pixel, stores it in a first-party `_fbc`
cookie in the form `fb.<subdomainIndex>.<creationTime>.<fbclid>`, and later
events send that value to Meta in the `fbc` parameter.

Hand-written versions of this code tend to go wrong in a few specific ways:

- They keep an older click ID when a returning visitor arrives from a different
  ad, so the conversion is attributed to the earlier ad.
- They change the click ID on the way through: decode it again, change its
  case, or cut it short.
- They write `creationTime` in seconds instead of milliseconds, or hard-code
  `subdomainIndex`.

Advertisers report seeing an Events Manager diagnostic about a modified fbclid
in the `fbc` parameter. Meta's documentation does not list what causes it. The
first two mistakes above alter or replace the click ID between the URL and the
event, so they are worth ruling out when you see it.

fbc-guard finds these patterns in source code before it ships. It does not run
the code and it sends nothing to Meta.

## Install

### MCP server

Add this to your MCP client configuration (Claude Desktop, Cursor, and other
clients that read an `mcpServers` block):

```json
{
  "mcpServers": {
    "fbc-guard": {
      "command": "npx",
      "args": ["-y", "mcp-server-fbc-guard"]
    }
  }
}
```

Claude Code:

```sh
claude mcp add fbc-guard -- npx -y mcp-server-fbc-guard
```

Requires Node.js 18 or later.

### Command line

```sh
npx -y -p mcp-server-fbc-guard fbc-guard https://your-landing-page.example/
# or install it
npm install -g mcp-server-fbc-guard
fbc-guard ./dist/index.html ./dist/js/tracking.js
```

### As a library

```js
import { checkCode } from "mcp-server-fbc-guard";

const result = checkCode(htmlOrJs); // { status, failed, unknown, warnings, rules }
```

The package entry point is the rules module only. Importing it does not start
the MCP server, read files or touch the network.

## MCP tools

| Tool | Input | What it does |
|---|---|---|
| `check_fbc_code` | `code`: HTML or JavaScript; optional `kind`: `auto` (default), `html` or `js` | Runs every rule on the source you pass. No network access. |
| `check_fbc_url` | `url`: http or https URL | Fetches the page and every same-origin `<script src>` it loads, then runs every rule on all of it. Public hosts only, unless the server runs with `FBC_GUARD_ALLOW_PRIVATE=1` (see [Network safety](#network-safety)). Also returns `final_url`, `scanned_scripts` and `skipped_scripts`. |

Both return JSON:

```json
{
  "status": "fail",
  "failed": ["FBC-01"],
  "unknown": [],
  "warnings": ["FBC-06"],
  "rules": [
    {
      "id": "FBC-01",
      "title": "A new fbclid must overwrite an older _fbc cookie",
      "status": "fail",
      "evidence": "indexOf('_fbc=')<0",
      "protects": "If the cookie is only written when it is missing, ...",
      "basis": "official",
      "severity": "error",
      "reference": "https://developers.facebook.com/documentation/ads-commerce/conversions-api/parameters/fbp-and-fbc"
    }
  ]
}
```

Each rule's `status` is `pass`, `fail`, `unknown` or `warn`. `warn` comes only
from warning-level rules (FBC-06); it is listed under `warnings` and never
changes the overall status or the exit code.

The overall `status` is `pass`, `fail`, `unknown`, or `not_applicable`.

- `unknown` means no rule failed, but at least one rule could not decide. Today
  only FBC-01 can return it, when it cannot tell which variable holds the
  `fbclid` from the URL. The rule's `evidence` says what could not be resolved.
- `not_applicable` means the string `_fbc` does not appear anywhere in what was
  scanned, so no rule was evaluated. The code may live somewhere the scan
  cannot see.

Neither is a pass.

In `check_fbc_code`, `kind: "auto"` reads the input as HTML when it starts with
`<` and analyses its inline `<script>` bodies, and reads anything else as
JavaScript.

The server runs its own negative tests at startup and refuses to start if any
rule no longer fails on the code it is supposed to catch.

## Command line

```
fbc-guard <url|file> [<url|file> ...]   check pages (http/https) or local files
fbc-guard --json <url|file> [...]       print JSON instead of text
fbc-guard --allow-private <url> [...]   also allow localhost and private-network URLs
fbc-guard --selftest                    run only the negative tests
fbc-guard --help | --version
```

Each target is judged separately. URLs are fetched together with their
same-origin scripts. Local files are scanned as they are, without following
`<script src>`, so list your JavaScript files as well. A local file is read as
JavaScript when its extension is `.js`, `.mjs`, `.cjs`, `.jsx`, `.ts`, `.mts`,
`.cts` or `.tsx`, as HTML when it is `.html`, `.htm`, `.xhtml`, `.shtml` or
`.php`, and otherwise by its first character, as in `check_fbc_code`.

Before judging any target the CLI runs the same negative tests as the server.
If they fail, it prints which test failed and exits with code 2 without
giving a verdict.

| Exit code | Meaning |
|---|---|
| 0 | No error-level rule failed on any target. This includes targets with warnings only (FBC-06), `unknown` (a rule could not decide) or `not_applicable` (no `_fbc` code); the output marks all three |
| 1 | At least one rule failed on at least one target |
| 2 | The negative tests failed, the arguments were invalid (including `--selftest` with anything else), or a target could not be read or fetched |

In CI:

```sh
npx -y -p mcp-server-fbc-guard fbc-guard ./public/index.html ./public/js/tracking.js
```

## Rules

Each rule cites Meta's reference page,
[ClickID and the fbp and fbc Parameters](https://developers.facebook.com/documentation/ads-commerce/conversions-api/parameters/fbp-and-fbc)
(the older URL under `/docs/marketing-api/conversions-api/parameters/fbp-and-fbc/`
redirects there). The **Basis** column says how directly that page supports the
rule:

- **Official**: the page states the requirement.
- **Derived**: the page states a general requirement; applying it to this
  specific code pattern is our reading.
- **Observed in practice**: not stated by Meta; a mistake seen in real
  implementations.

| ID | Flags | Severity | Basis |
|---|---|---|---|
| FBC-01 | The `_fbc` cookie is written only when it does not exist, or the click ID from the URL is never compared with anything but a literal | error | Official |
| FBC-02 | `decodeURIComponent(fbclid)` | error | Derived |
| FBC-03 | `fbclid.toLowerCase()` / `fbclid.toUpperCase()` | error | Official |
| FBC-04 | `fbclid.slice(`, `.substring(`, `.substr(` | error | Derived |
| FBC-05 | A seconds timestamp in the statement that builds an `_fbc=fb.` value | error | Official |
| FBC-06 | A literal digit as `subdomainIndex` in an `_fbc` cookie value | **warning** | Observed in practice |
| FBP-01 | The same as FBC-05, for `_fbp=fb.` | error | Official |

An error-level rule that fires fails the check (exit code 1). A warning-level
rule that fires is reported with status `warn` and does not change the result
or the exit code.

The rules read the source through a small scanner, not a JavaScript parser.
Nothing inside a JavaScript comment counts, and neither does markup inside an
HTML comment.

- FBC-02, FBC-03 and FBC-04 read only the JavaScript (inline `<script>` bodies
  and fetched script files) and also ignore string contents, so a message such
  as `'do not call decodeURIComponent(fbclid)'` does not trigger them.
- FBC-06 and the write-only-if-missing check of FBC-01 look for text that
  lives inside string literals, so they read the whole document with comments
  removed and string contents kept.
- FBC-01, FBC-05 and FBP-01 also use the scanner to find where a statement
  starts and ends.

### FBC-01: a new fbclid must overwrite an older `_fbc` cookie

Code written as "set the cookie if there is none" keeps the first click ID
forever. A visitor who returns through a different ad still carries the old
one, and the conversion is credited to the earlier ad. Meta's page lists, as a
case where the cookie should be set, a URL `fbclid` that
"isn't equal to the corresponding value in the `_fbc` cookie value".

How the rule decides:

1. It finds the variables that hold the click ID from the URL: assigned from
   `.get('fbclid')`, `['fbclid']` or `.fbclid`, from a `match`, `split`,
   `exec` or similar call on text containing `fbclid=`, or copied from one of
   those (`var f = fbclid || ''`). A variable or parameter literally named
   `fbclid` also counts.
2. It looks for a `!==`, `!=`, `===` or `==` comparison between one of those
   variables and something that is not a literal. `id !== f` and
   `if (stored === clickId) return;` count; `f !== ''` and `f != null` do not.
3. A comparison passes the rule. That includes "set the cookie if it is missing
   or different", written as `indexOf('_fbc=') < 0 || id !== f`.
4. Without a comparison, the rule fails if it finds the write-only-if-missing
   pattern `indexOf('_fbc=') < 0`, or if it found a click ID variable.
5. If it found neither a click ID variable nor that pattern, the status is
   `unknown`, with an explanation. Exit code 0.

### FBC-02: do not URL-decode fbclid a second time

`URLSearchParams.get()` already returns a decoded value. Decoding it again
either leaves it unchanged or changes it, and `decodeURIComponent` throws on a
lone `%`, which stops the rest of the script. Meta's page says to
"do not apply any modifications before using" the click ID. It does not
mention decoding specifically; treating a second decode as a modification is
our reading.

### FBC-03: do not change the case of fbclid

Meta's page states "ClickID value is case sensitive" and names lower- and
upper-casing as modifications to avoid.

### FBC-04: do not truncate fbclid

A shortened click ID is a modified click ID. Meta's page says to
"do not apply any modifications before using" it; truncation is not named
specifically.

### FBC-05: `_fbc` creationTime must be in milliseconds

Meta's page defines it: "creationTime is the UNIX time since epoch in
milliseconds". `Date.now()` already returns milliseconds; dividing by 1000
writes seconds.

The rule looks at each statement that contains an `_fbc=fb.` string or
template literal and fails if that statement divides a millisecond clock by
1000:

- clocks: `Date.now()`, `new Date()`, `(new Date)`, `new Date().getTime()`,
  `(new Date).getTime()`, `new Date().valueOf()`, `+new Date`, and
  `d.getTime()` / `d.valueOf()` on a variable (a `new Date(...)` built from
  arguments is a fixed moment, not the clock, and is not matched);
- divisors: `/1000` or `/1e3`, with or without spaces, whatever wraps it
  (`Math.floor`, `Math.round`, `Math.trunc`, `parseInt`, `|0`, `~~`);
- written directly in the concatenation or template literal, or stored in a
  variable first and concatenated in. For a variable, the last assignment
  before the statement is the one that counts.

It does not fire on `Date.now()` alone, on `/1000` in other statements (a
countdown timer elsewhere in the file), on a commented-out line, or on a time
difference such as `(end - Date.now()) / 1000`, which is a duration like
`max-age`, not a timestamp.

### FBC-06 (warning): check a hard-coded subdomainIndex in the `_fbc` cookie

Meta's page says "subdomainIndex is which domain the cookie is defined on",
with `com` as 0, `example.com` as 1 and `www.example.com` as 2. A literal digit
is only correct while the cookie is always set on a domain of that level. The
page also says to use 1 when the value is generated on a server without
saving a cookie, its own examples use `fb.1.`, and it does not say a
mismatched value is rejected. So a literal is not wrong in itself, and this
rule is a warning, not a failure: it points at a value worth checking against
the domain the cookie is actually set on.

### FBP-01: `_fbp` creationTime must be in milliseconds

The `fbp` section of the same page uses the same definition:
"creationTime is the UNIX time since epoch in milliseconds". This only
matters if your own code writes `_fbp`; normally the Meta Pixel does.
Detection works as in FBC-05, on statements containing `_fbp=fb.`.

## Code that passes every rule

This is the exact snippet the self-test runs through every rule, and the
publish check refuses to release a README in which it differs.

```html
<script>
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
</script>
```

Notes on the example:

- **Which part of the cookie is the click ID.** The example takes the fourth
  dot-separated segment. Meta's fbc page instead says the click ID is the part
  of the cookie value after the last dot. The two differ when Meta's
  [Parameter Builder library](https://developers.facebook.com/documentation/ads-commerce/conversions-api/parameter-builder-library)
  wrote the cookie: its documented format is
  `fb.${subdomain_index}.${creation_time}.${fbclid}.${appendix}`, so the part
  after the last dot is the appendix, not the click ID. The fourth segment is
  the click ID in both formats.
- Browsers refuse cookies on public suffixes such as `com` or `com.tw`, so the
  loop settles on the registrable domain (`example.com`, `example.com.tw`).
- **Prefer a server-set cookie.** Meta's fbc page recommends setting `_fbc` as
  an HTTP cookie in the response headers, with a 90-day expiration, when the
  request arrives with `fbclid`. The example writes it with `document.cookie`,
  which is what you can do from a static page, and browsers limit that:
  WebKit's [Intelligent Tracking Prevention 2.2](https://webkit.org/blog/8828/intelligent-tracking-prevention-2-2/)
  says "persistent cookies set through document.cookie are capped to one day
  of storage" when a domain it classifies as a cross-site tracker sent the
  visitor and the landing URL has a query string or fragment. An ad click
  always carries `fbclid` in the query string, so whenever ITP has classified
  the referring site that way, the 90 days written by this script become one
  day in Safari. If you control the server, set the cookie there.
- If the Meta Pixel is installed it manages `_fbc` and `_fbp` itself. Code like
  this is for pages that capture the click ID without the Pixel, for example
  to forward it through the Conversions API.

## Changes from the original rule set

This package started as an in-house script with the same rule IDs. For the
public release, several rules were reworked because they missed real mistakes
or flagged correct code.

- **FBC-05 and FBP-01** used to catch `Date.now()/1000` only inside the same
  string or template literal as `_fbc=fb.` / `_fbp=fb.`. The common
  concatenated form `'_fbc=fb.' + i + '.' + Math.floor(Date.now()/1000)` passed.
  They now check the whole statement and seconds stored in a variable, as
  described above, and ignore comments.
- **FBC-01** used to accept only `!==` or `!=` next to a variable literally
  named `fbclid`, so correct code such as `if (id !== f)` or
  `if (stored === fbclid) return;` failed. It now resolves which variable holds
  the click ID, accepts all four comparison operators, and reports `unknown`
  instead of failing when it cannot resolve the variable.
- **FBC-06** used to fail. Because Meta itself uses `fb.1.` in its examples and
  for server-generated values, it is now a warning that does not change the
  exit code.
- **FBC-02, FBC-03, FBC-04 and FBC-06** used to match anywhere in the text,
  including comments, so a comment that warned against a mistake triggered the
  rule. They now skip comments, and FBC-02 to FBC-04 also skip string contents.

On the original test fixtures every rule gives the same result as before,
except that FBC-06 now reports `warn` where it used to report `fail`.

## Limitations

This is static analysis of source text, not execution. Read a pass as "none of
the known mistakes were found in the shapes this tool recognises", not as
"this code is correct".

- **False negatives.** Minified, bundled or obfuscated code and code assembled
  at runtime can hide a mistake. FBC-02, FBC-03 and FBC-04 only look at a
  variable literally named `fbclid`, so `f.toLowerCase()` is not caught. FBC-05
  and FBP-01 need the `_fbc=fb.` / `_fbp=fb.` text in one string or template
  literal; a value assembled as `'_fbc=' + value` or with `join('.')` is not
  checked, and seconds returned from a helper function are not traced. Variable
  tracking is textual: it takes the last assignment before the statement and
  does not follow scopes or branches.
- **False positives.** FBC-01 accepts any comparison between the click ID and a
  non-literal, so it cannot tell whether the other side really is the stored
  cookie value. That makes a false pass more likely than a false failure.
  A seconds variable that is reassigned inside a branch can be judged by the
  wrong assignment.
- **HTML or JavaScript.** Inline event handler attributes (`onclick="..."`) are
  not analysed by FBC-01 to FBC-05 or FBP-01. A JavaScript file that starts with
  `<` is read as HTML unless you pass `kind: "js"` or give it a `.js` extension.
- **Not applicable is not a pass.** If `_fbc` does not appear in what was
  scanned, nothing is judged. Tracking code in a tag manager container, a
  cross-origin script, or a server-side integration is invisible to this scan.
- **URL scanning limits.** Only same-origin scripts are fetched, at most 20,
  up to 2 MB each after decompression, with a 30-second timeout per request,
  at most 5 redirects, and a mobile Safari user agent. Cross-origin scripts are
  never fetched; they are listed under `skipped_scripts`. A same-origin script
  that redirects to another origin is not followed. Markup served only after
  JavaScript runs is not seen. Proxy environment variables are not used.
- **No runtime check.** Static analysis cannot tell you what value is actually
  sent. To confirm, load the page in a browser with an old `_fbc` cookie
  already set and a realistic `fbclid` in the URL, and compare what your code
  sends with the URL value character by character. Block requests to Meta
  while testing so test click IDs are not reported as real events.

## Network safety

`check_fbc_url` and the CLI's URL mode fetch whatever URL they are given, and
an AI agent may be the one choosing it. To keep that from becoming a way into
cloud metadata endpoints, localhost services or a private network, fetching is
limited to public hosts by default:

- Only `http` and `https` URLs are accepted.
- A connection is refused when the host is, or resolves to, a loopback,
  private (`10/8`, `172.16/12`, `192.168/16`, `fc00::/7`), link-local
  (`169.254/16`, `fe80::/10`), carrier-grade NAT (`100.64/10`), `0.0.0.0/8`,
  multicast, reserved or unspecified address, including those addresses
  written inside IPv6 (`::ffff:127.0.0.1`, NAT64, 6to4). If any address a name
  resolves to is refused, the name is refused.
- Redirects are followed by hand, at most 5, and every hop is checked the same
  way, as is every same-origin script.
- A refused address, a DNS failure, a refused or reset connection, a TLS error
  and a timeout all return the same error text, so the tool cannot be used to
  tell open ports from closed ones by its messages.

To check a page on your own machine or intranet, opt in: `--allow-private` on
the command line, or `FBC_GUARD_ALLOW_PRIVATE=1` in the MCP server's
environment:

```json
{
  "mcpServers": {
    "fbc-guard": {
      "command": "npx",
      "args": ["-y", "mcp-server-fbc-guard"],
      "env": { "FBC_GUARD_ALLOW_PRIVATE": "1" }
    }
  }
}
```

With the opt-in, no address is refused.

Residual risks:

- **DNS rebinding.** A hostname can resolve to a public address when checked
  and a private one when connected. The address check runs inside the
  connection's own DNS lookup, on the addresses the socket is about to use,
  and every redirect hop and script is resolved and checked again, so a
  changing answer cannot slip between a check and a connection. This depends on
  Node.js calling that lookup for every connection, which it does for host
  names; IP literals are checked before connecting. Treat it as a mitigation,
  not a guarantee.
- **Timing.** A refused address fails at once, while an unreachable public host
  may take up to the 30-second timeout, so timing still reveals something even
  though the messages do not.
- **Public hosts that reach inward.** A public URL whose own server fetches an
  internal resource on your behalf (an open proxy, for example) is outside
  what an address check can see.

## Development

```sh
npm ci
npm run build
npm run selftest                     # negative tests: every rule must fail on its own fixture
node scripts/smoke.mjs               # talks to the built server over stdio, including a local HTTP check
node scripts/check-publish-ready.mjs # package and MCP Registry metadata checks
```

## License

MIT. See [LICENSE](LICENSE).

## Maintainer

Built and maintained by [Ads & Code](https://adsandcode.com/).
