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

The first two are the kind of mistake behind Events Manager diagnostics saying
your events carry a modified fbclid in the `fbc` parameter. fbc-guard finds
these patterns in source code before it ships. It does not run the code and
it sends nothing to Meta.

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

## MCP tools

| Tool | Input | What it does |
|---|---|---|
| `check_fbc_code` | `code`: HTML or JavaScript | Runs every rule on the source you pass. No network access. |
| `check_fbc_url` | `url`: http or https URL | Fetches the page and every same-origin `<script src>` it loads, then runs every rule on all of it. Also returns `final_url`, `scanned_scripts` and `skipped_scripts`. |

Both return JSON:

```json
{
  "status": "fail",
  "failed": ["FBC-01"],
  "rules": [
    {
      "id": "FBC-01",
      "title": "A new fbclid must overwrite an older _fbc cookie",
      "status": "fail",
      "evidence": "indexOf('_fbc=')<0",
      "protects": "If the cookie is only written when it is missing, ...",
      "basis": "official",
      "reference": "https://developers.facebook.com/documentation/ads-commerce/conversions-api/parameters/fbp-and-fbc"
    }
  ]
}
```

`status` is `pass`, `fail`, or `not_applicable`. `not_applicable` means the
string `_fbc` does not appear anywhere in what was scanned, so no rule was
evaluated. It is not a pass: the code may live somewhere the scan cannot see.

The server runs its own negative tests at startup and refuses to start if any
rule no longer fails on the code it is supposed to catch.

## Command line

```
fbc-guard <url|file> [<url|file> ...]   check pages (http/https) or local files
fbc-guard --json <url|file> [...]       print JSON instead of text
fbc-guard --selftest                    run only the negative tests
fbc-guard --help | --version
```

Each target is judged separately. URLs are fetched together with their
same-origin scripts. Local files are scanned as they are, without following
`<script src>`, so list your JavaScript files as well.

Before judging any target the CLI runs the same negative tests as the server.
If they fail, it prints which test failed and exits with code 2 without
giving a verdict.

| Exit code | Meaning |
|---|---|
| 0 | Every target passed, or contained no `_fbc` code (reported as not applicable) |
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

| ID | Flags | Basis |
|---|---|---|
| FBC-01 | The `_fbc` cookie is written only when it does not exist, or the stored click ID is never compared with the one in the URL | Official |
| FBC-02 | `decodeURIComponent(fbclid)` | Derived |
| FBC-03 | `fbclid.toLowerCase()` / `fbclid.toUpperCase()` | Official |
| FBC-04 | `fbclid.slice(`, `.substring(`, `.substr(` | Derived |
| FBC-05 | `_fbc` creationTime written as `Date.now()/1000` | Official |
| FBC-06 | A literal digit as `subdomainIndex` in an `_fbc` cookie value | Observed in practice |
| FBP-01 | `_fbp` creationTime written as `Date.now()/1000` | Official |

### FBC-01: a new fbclid must overwrite an older `_fbc` cookie

Code written as "set the cookie if there is none" keeps the first click ID
forever. A visitor who returns through a different ad still carries the old
one, and the conversion is credited to the earlier ad. Meta's page lists, as a
case where the cookie should be set, a URL `fbclid` that
"isn't equal to the corresponding value in the `_fbc` cookie value".

The rule fails when it finds the `indexOf('_fbc=') < 0` pattern, or when it
finds no `!==` / `!=` comparison involving a variable named `fbclid`.

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

### FBC-06: do not hard-code subdomainIndex in the `_fbc` cookie

Meta's page says "subdomainIndex is which domain the cookie is defined on",
with `com` as 0, `example.com` as 1 and `www.example.com` as 2. A literal digit
is only correct while the cookie is always set on a domain of that level. The
page also says to use 1 when the value is generated on a server without
saving a cookie, so a literal is not wrong in itself, and Meta does not say a
mismatched value is rejected. This rule is a heuristic from real
implementations: derive the value from the domain the cookie is actually set
on.

### FBP-01: `_fbp` creationTime must be in milliseconds

The `fbp` section of the same page uses the same definition:
"creationTime is the UNIX time since epoch in milliseconds". This only
matters if your own code writes `_fbp`; normally the Meta Pixel does.

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

- It reads the stored click ID as the fourth dot-separated field. That is the
  click ID both in the documented format and when Meta's
  [Parameter Builder](https://developers.facebook.com/documentation/ads-commerce/conversions-api/parameter-builder-library)
  has added its suffix after it.
- Browsers refuse cookies on public suffixes such as `com` or `com.tw`, so the
  loop settles on the registrable domain (`example.com`, `example.com.tw`).
- The 90-day lifetime follows Meta's page, which recommends storing `_fbc` with
  a 90-day expiration.
- If the Meta Pixel is installed it manages `_fbc` and `_fbp` itself. Code like
  this is for pages that capture the click ID without the Pixel, for example
  to forward it through the Conversions API.

## Limitations

This is regular-expression analysis of source text. Read a pass as "none of
the known mistakes were found in the shapes this tool recognises", not as
"this code is correct".

- **False negatives.** Minified, bundled or obfuscated code, code assembled at
  runtime, and code that keeps the click ID in a variable not named `fbclid`
  can all hide a mistake. FBC-02, FBC-03 and FBC-04 only look at a variable
  literally named `fbclid`. FBC-05 and FBP-01 only catch `Date.now()/1000`
  inside the same string or template literal as `_fbc=fb.` / `_fbp=fb.`; the
  common concatenated form `'_fbc=fb.' + i + '.' + Math.floor(Date.now()/1000)`
  is **not** detected, and neither is `new Date().getTime()/1000`.
- **False positives.** FBC-01 only recognises a `!==` or `!=` comparison next to
  a variable named `fbclid`. Equivalent logic written another way, such as
  `if (storedId === fbclid) return;`, is reported as a failure.
- **Not applicable is not a pass.** If `_fbc` does not appear in what was
  scanned, nothing is judged. Tracking code in a tag manager container, a
  cross-origin script, or a server-side integration is invisible to this scan.
- **URL scanning limits.** Only same-origin scripts are fetched, at most 20,
  up to 2 MB each, with a 30-second timeout per request and a mobile Safari
  user agent. Cross-origin scripts are never fetched; they are listed under
  `skipped_scripts`. A same-origin script that redirects to another origin is
  not followed. Markup served only after JavaScript runs is not seen.
- **No runtime check.** Static analysis cannot tell you what value is actually
  sent. To confirm, load the page in a browser with an old `_fbc` cookie
  already set and a realistic `fbclid` in the URL, and compare what your code
  sends with the URL value character by character. Block requests to Meta
  while testing so test click IDs are not reported as real events.

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
