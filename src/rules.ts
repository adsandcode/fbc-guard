/**
 * Static checks for code that handles Meta's click ID (`fbclid` and the `_fbc`
 * cookie) and browser ID (the `_fbp` cookie).
 *
 * Pure logic: source text in, verdict out. No network, no filesystem.
 *
 * Every rule is a regular expression over source text. It recognises the
 * shapes of code it was written for and nothing more, so a pass means "none of
 * the known mistakes were found", not "this code is correct". Minified,
 * bundled or obfuscated code can hide a mistake from every rule here.
 */

/** Meta's reference page for the fbc and fbp parameters. */
export const META_FBC_DOC =
  "https://developers.facebook.com/documentation/ads-commerce/conversions-api/parameters/fbp-and-fbc";

export type RuleId = "FBC-01" | "FBC-02" | "FBC-03" | "FBC-04" | "FBC-05" | "FBC-06" | "FBP-01";

/**
 * How firmly a rule rests on Meta's documentation.
 * - official: the documentation states the requirement directly.
 * - derived: the documentation states a general requirement and this rule
 *   applies it to a specific code pattern the documentation does not name.
 * - observed: not stated by Meta; a mistake seen in real implementations.
 */
export type Basis = "official" | "derived" | "observed";

export interface Rule {
  id: RuleId;
  title: string;
  /** What goes wrong when the rule fails, in one or two sentences. */
  protects: string;
  basis: Basis;
  reference: string;
  /** Returns evidence when the code breaks the rule, or null when it does not. */
  detect(code: string): string | null;
}

export type RuleStatus = "pass" | "fail";
export type Status = "pass" | "fail" | "not_applicable";

export interface RuleResult {
  id: RuleId;
  title: string;
  status: RuleStatus;
  evidence: string | null;
  protects: string;
  basis: Basis;
  reference: string;
}

export interface CheckResult {
  status: Status;
  failed: RuleId[];
  rules: RuleResult[];
  note?: string;
}

const EVIDENCE_MAX = 160;

function snippet(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > EVIDENCE_MAX ? flat.slice(0, EVIDENCE_MAX - 3) + "..." : flat;
}

function firstMatch(re: RegExp, code: string): string | null {
  const m = re.exec(code);
  return m ? snippet(m[0]) : null;
}

// FBC-01: the cookie is written only when it does not exist yet.
const STALE_ONLY_IF_MISSING = /indexOf\(\s*['"]_fbc=['"]\s*\)\s*<\s*0/;
// FBC-01: some comparison between a stored value and the fbclid from the URL.
const COMPARES_WITH_FBCLID = /!==\s*fbclid|fbclid\s*!==|!=\s*fbclid|fbclid\s*!=/;

export const RULES: readonly Rule[] = [
  {
    id: "FBC-01",
    title: "A new fbclid must overwrite an older _fbc cookie",
    protects:
      "If the cookie is only written when it is missing, a returning visitor who clicks a different ad keeps the old click ID, and conversions are attributed to the earlier ad.",
    basis: "official",
    reference: META_FBC_DOC,
    detect(code) {
      const stale = firstMatch(STALE_ONLY_IF_MISSING, code);
      if (stale) return stale;
      if (!COMPARES_WITH_FBCLID.test(code))
        return "no comparison between the stored _fbc click ID and the fbclid from the URL (looked for `!== fbclid` or `fbclid !==`)";
      return null;
    },
  },
  {
    id: "FBC-02",
    title: "Do not URL-decode fbclid a second time",
    protects:
      "URLSearchParams.get() already returns a decoded value. Decoding it again can change the click ID, and throws on a stray '%'.",
    basis: "derived",
    reference: META_FBC_DOC,
    detect: (code) => firstMatch(/decodeURIComponent\s*\(\s*fbclid\s*\)/, code),
  },
  {
    id: "FBC-03",
    title: "Do not change the case of fbclid",
    protects: "The click ID is case sensitive. A lower- or upper-cased value no longer matches the click Meta recorded.",
    basis: "official",
    reference: META_FBC_DOC,
    detect: (code) => firstMatch(/fbclid\s*\.\s*to(Lower|Upper)Case/, code),
  },
  {
    id: "FBC-04",
    title: "Do not truncate fbclid",
    protects: "A shortened click ID is a modified click ID and no longer matches the click Meta recorded.",
    basis: "derived",
    reference: META_FBC_DOC,
    detect: (code) => firstMatch(/fbclid\s*\.\s*(slice|substring|substr)\s*\(/, code),
  },
  {
    id: "FBC-05",
    title: "_fbc creationTime must be in milliseconds",
    protects:
      "Meta defines creationTime as milliseconds since the epoch. Date.now()/1000 writes seconds, a value that does not follow the documented format.",
    basis: "official",
    reference: META_FBC_DOC,
    detect: (code) => firstMatch(/_fbc=fb\.[^'"]{0,40}Date\.now\(\)\s*\/\s*1000/, code),
  },
  {
    id: "FBC-06",
    title: "Do not hard-code subdomainIndex in the _fbc cookie",
    protects:
      "subdomainIndex describes the domain the cookie is set on (example.com is 1, www.example.com is 2). A literal digit is wrong whenever the cookie lands on a different domain level.",
    basis: "observed",
    reference: META_FBC_DOC,
    detect: (code) => firstMatch(/_fbc=fb\.\d+\./, code),
  },
  {
    id: "FBP-01",
    title: "_fbp creationTime must be in milliseconds",
    protects: "Same as FBC-05, for the browser ID cookie.",
    basis: "official",
    reference: META_FBC_DOC,
    detect: (code) => firstMatch(/_fbp=fb\.[^'"]{0,40}Date\.now\(\)\s*\/\s*1000/, code),
  },
];

export const NOT_APPLICABLE_NOTE =
  "No `_fbc` found in the scanned content, so no rule was evaluated. If this page does set the click ID cookie, the code may live in a cross-origin script, a tag manager container, or be assembled at runtime, none of which a static scan can see.";

/** Run every rule against the given HTML or JavaScript. */
export function checkCode(code: string): CheckResult {
  if (!code.includes("_fbc")) {
    return { status: "not_applicable", failed: [], rules: [], note: NOT_APPLICABLE_NOTE };
  }
  const rules: RuleResult[] = RULES.map((r) => {
    const evidence = r.detect(code);
    return {
      id: r.id,
      title: r.title,
      status: evidence === null ? "pass" : "fail",
      evidence,
      protects: r.protects,
      basis: r.basis,
      reference: r.reference,
    };
  });
  const failed = rules.filter((r) => r.status === "fail").map((r) => r.id);
  return { status: failed.length ? "fail" : "pass", failed, rules };
}
