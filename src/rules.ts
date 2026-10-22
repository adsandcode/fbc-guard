/**
 * Static checks for code that handles Meta's click ID (`fbclid` and the `_fbc`
 * cookie) and browser ID (the `_fbp` cookie).
 *
 * Pure logic: source text in, verdict out. No network, no filesystem.
 *
 * FBC-02, FBC-03, FBC-04 and FBC-06 are regular expressions over the raw
 * text. FBC-01, FBC-05 and FBP-01 read the inline and external JavaScript
 * through a lightweight scanner (see jsscan.ts) that ignores comments and
 * string contents and knows where a statement starts and ends. Neither is a
 * JavaScript parser, so a pass means "none of the known mistakes were found",
 * not "this code is correct".
 */

import { assignments, jsView, statementEnd, statementStart, MASK, type JsView, type Source } from "./jsscan.js";

export type { Source, SourceKind } from "./jsscan.js";

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

/** `unknown`: the rule could not decide. It is reported, never treated as a failure. */
export type RuleStatus = "pass" | "fail" | "unknown";
export type Status = "pass" | "fail" | "unknown" | "not_applicable";

export interface Verdict {
  status: RuleStatus;
  evidence: string | null;
}

interface Context {
  raw: string;
  js: JsView;
}

export interface Rule {
  id: RuleId;
  title: string;
  /** What goes wrong when the rule fails, in one or two sentences. */
  protects: string;
  basis: Basis;
  reference: string;
  evaluate(ctx: Context): Verdict;
}

export interface RuleResult extends Verdict {
  id: RuleId;
  title: string;
  protects: string;
  basis: Basis;
  reference: string;
}

export interface CheckResult {
  status: Status;
  failed: RuleId[];
  unknown: RuleId[];
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

const pass: Verdict = { status: "pass", evidence: null };
const fail = (evidence: string): Verdict => ({ status: "fail", evidence });
const byRegex = (re: RegExp) => (ctx: Context): Verdict => {
  const hit = firstMatch(re, ctx.raw);
  return hit ? fail(hit) : pass;
};

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ---------------------------------------------------------------------------
// FBC-05 / FBP-01: a seconds timestamp used to build the cookie value.

/**
 * A millisecond clock divided by 1000: Date.now()/1000, (new Date).getTime()/1e3,
 * new Date().valueOf()/1000, +new Date/1000, with any wrapper around it.
 * A clock that is subtracted from, as in (end - Date.now())/1000, is a
 * duration such as a countdown or max-age, not a timestamp, and is excluded.
 */
const SECONDS = new RegExp(
  "(?<!-\\s*)" +
    "(?:Date\\s*\\.\\s*now\\s*\\(\\s*\\)" +
    "|\\(?\\s*new\\s+Date\\s*(?:\\(\\s*\\))?\\s*\\)?\\s*\\.\\s*(?:getTime|valueOf)\\s*\\(\\s*\\)" +
    "|\\+\\s*new\\s+Date\\s*(?:\\(\\s*\\))?)" +
    "\\s*\\)*\\s*\\/\\s*(?:1000|1e3)(?![\\w.])",
  "i",
);

function secondsInCookieValue(js: JsView, cookie: "_fbc" | "_fbp"): string | null {
  const { raw, masked } = js;
  const literal = new RegExp(escapeRe(cookie) + "=fb\\.", "g");
  const assigns = assignments(masked);
  for (const m of raw.matchAll(literal)) {
    const at = m.index ?? 0;
    // Only a cookie value written in a string or template literal counts; a comment does not run.
    if (masked[at] !== MASK) continue;
    const start = statementStart(masked, at);
    const end = statementEnd(masked, at);
    const window = masked.slice(start, end);

    const direct = SECONDS.exec(window);
    if (direct) {
      const s = start + direct.index;
      return snippet(raw.slice(s, s + direct[0].length)) + " in " + snippet(raw.slice(start, end));
    }

    // A variable holding seconds, concatenated into the value. The assignment
    // that counts is the last one before this statement. Property names
    // (the `now` in Date.now) are not variables and are skipped.
    const names = new Set(window.match(/(?<!\.\s*)(?<![\w$])[A-Za-z_$][\w$]*/g) ?? []);
    for (const name of names) {
      let last: (typeof assigns)[number] | undefined;
      for (const a of assigns) if (a.name === name && a.at < start) last = a;
      if (!last) continue;
      const rhs = masked.slice(last.rhsStart, last.rhsEnd);
      if (SECONDS.test(rhs)) {
        return `${name} = ${snippet(raw.slice(last.rhsStart, last.rhsEnd))}, then used in ${snippet(raw.slice(start, end))}`;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// FBC-01: the stored click ID must be compared with the one in the URL.

const STALE_ONLY_IF_MISSING = /indexOf\(\s*['"]_fbc=['"]\s*\)\s*<\s*0/;

/** Right-hand sides that read the click ID from the URL. */
function readsUrlClickId(rhsRaw: string): boolean {
  if (/\.get\s*\(\s*(['"`])fbclid\1\s*\)/.test(rhsRaw)) return true;
  if (/\[\s*(['"`])fbclid\1\s*\]/.test(rhsRaw)) return true;
  if (/\.fbclid(?![\w$])/.test(rhsRaw)) return true;
  return /fbclid=/.test(rhsRaw) && /\b(?:match|exec|split|replace|search|RegExp|indexOf|substring|substr|slice)\b/.test(rhsRaw);
}

/** Identifiers that hold the click ID from the URL. */
export function clickIdNames(js: JsView): string[] {
  const { raw, masked } = js;
  const names = new Set<string>();
  const assigns = assignments(masked);
  for (const a of assigns) if (readsUrlClickId(raw.slice(a.rhsStart, a.rhsEnd))) names.add(a.name);
  // Plain copies such as `var f = fbclid || ''`.
  for (let grew = true; grew; ) {
    grew = false;
    for (const a of assigns) {
      if (names.has(a.name)) continue;
      const alias = /^\s*([A-Za-z_$][\w$]*)\s*(?:\|\||\?\?|$)/.exec(masked.slice(a.rhsStart, a.rhsEnd));
      if (alias && names.has(alias[1])) { names.add(a.name); grew = true; }
    }
  }
  // A variable or parameter literally named fbclid holds the click ID by convention.
  if (/(?<![\w$.])fbclid(?![\w$])/.test(masked)) names.add("fbclid");
  return [...names];
}

const COMPARE = "(?:!==|!=|===|==)";
/** An operand that is a literal, so the comparison cannot be with the stored click ID. */
const LITERAL_OPERAND = new RegExp(`^(?:['"\`${MASK}]|\\d|(?:null|undefined|true|false|NaN|void)(?![\\w$]))`);

/** A comparison between a click-ID identifier and something that is not a literal. */
function comparisonWith(masked: string, names: readonly string[]): string | null {
  for (const name of names) {
    const n = escapeRe(name);
    const right = new RegExp(`(?<![\\w$.])${n}\\s*${COMPARE}\\s*([^\\s);,&|?:}]+)`, "g");
    for (const m of masked.matchAll(right)) if (!LITERAL_OPERAND.test(m[1])) return m[0];
    const left = new RegExp(`([^\\s(;,&|?:{=!]+)\\s*${COMPARE}\\s*${n}(?![\\w$])`, "g");
    for (const m of masked.matchAll(left)) if (!LITERAL_OPERAND.test(m[1])) return m[0];
  }
  return null;
}

function evaluateFbc01(ctx: Context): Verdict {
  const names = clickIdNames(ctx.js);
  if (names.length && comparisonWith(ctx.js.masked, names)) return pass;
  const stale = firstMatch(STALE_ONLY_IF_MISSING, ctx.raw);
  if (stale) return fail(stale + " (writes the cookie only when it is missing, with no comparison against the URL click ID)");
  if (!names.length) {
    return {
      status: "unknown",
      evidence:
        "could not tell which variable holds the fbclid from the URL (looked for assignments from .get('fbclid'), ['fbclid'], .fbclid, or a match/split on 'fbclid='), so the comparison with the stored _fbc click ID could not be checked",
    };
  }
  return fail(`no comparison between the stored _fbc click ID and the URL click ID held in ${names.join(", ")}`);
}

// ---------------------------------------------------------------------------

export const RULES: readonly Rule[] = [
  {
    id: "FBC-01",
    title: "A new fbclid must overwrite an older _fbc cookie",
    protects:
      "If the cookie is only written when it is missing, a returning visitor who clicks a different ad keeps the old click ID, and conversions are attributed to the earlier ad.",
    basis: "official",
    reference: META_FBC_DOC,
    evaluate: evaluateFbc01,
  },
  {
    id: "FBC-02",
    title: "Do not URL-decode fbclid a second time",
    protects:
      "URLSearchParams.get() already returns a decoded value. Decoding it again can change the click ID, and throws on a stray '%'.",
    basis: "derived",
    reference: META_FBC_DOC,
    evaluate: byRegex(/decodeURIComponent\s*\(\s*fbclid\s*\)/),
  },
  {
    id: "FBC-03",
    title: "Do not change the case of fbclid",
    protects: "The click ID is case sensitive. A lower- or upper-cased value no longer matches the click Meta recorded.",
    basis: "official",
    reference: META_FBC_DOC,
    evaluate: byRegex(/fbclid\s*\.\s*to(Lower|Upper)Case/),
  },
  {
    id: "FBC-04",
    title: "Do not truncate fbclid",
    protects: "A shortened click ID is a modified click ID and no longer matches the click Meta recorded.",
    basis: "derived",
    reference: META_FBC_DOC,
    evaluate: byRegex(/fbclid\s*\.\s*(slice|substring|substr)\s*\(/),
  },
  {
    id: "FBC-05",
    title: "_fbc creationTime must be in milliseconds",
    protects:
      "Meta defines creationTime as milliseconds since the epoch. Date.now()/1000 writes seconds, a value that does not follow the documented format.",
    basis: "official",
    reference: META_FBC_DOC,
    evaluate: (ctx) => {
      const hit = secondsInCookieValue(ctx.js, "_fbc");
      return hit ? fail(hit) : pass;
    },
  },
  {
    id: "FBC-06",
    title: "Do not hard-code subdomainIndex in the _fbc cookie",
    protects:
      "subdomainIndex describes the domain the cookie is set on (example.com is 1, www.example.com is 2). A literal digit is wrong whenever the cookie lands on a different domain level.",
    basis: "observed",
    reference: META_FBC_DOC,
    evaluate: byRegex(/_fbc=fb\.\d+\./),
  },
  {
    id: "FBP-01",
    title: "_fbp creationTime must be in milliseconds",
    protects: "Same as FBC-05, for the browser ID cookie.",
    basis: "official",
    reference: META_FBC_DOC,
    evaluate: (ctx) => {
      const hit = secondsInCookieValue(ctx.js, "_fbp");
      return hit ? fail(hit) : pass;
    },
  },
];

export const NOT_APPLICABLE_NOTE =
  "No `_fbc` found in the scanned content, so no rule was evaluated. If this page does set the click ID cookie, the code may live in a cross-origin script, a tag manager container, or be assembled at runtime, none of which a static scan can see.";

export const UNKNOWN_NOTE =
  "At least one rule could not decide (status unknown). No rule failed, but this is not a full pass; see the rule's evidence for what could not be resolved.";

/**
 * Run every rule. Pass one string (HTML or JavaScript, guessed from the first
 * character) or several sources, such as a page and the scripts it loads.
 */
export function checkCode(input: string | readonly Source[]): CheckResult {
  const sources: readonly Source[] = typeof input === "string" ? [{ code: input }] : input;
  const raw = sources.map((s) => s.code).join("\n");
  if (!raw.includes("_fbc")) {
    return { status: "not_applicable", failed: [], unknown: [], rules: [], note: NOT_APPLICABLE_NOTE };
  }
  const ctx: Context = { raw, js: jsView(sources) };
  const rules: RuleResult[] = RULES.map((r) => {
    const v = r.evaluate(ctx);
    return { id: r.id, title: r.title, status: v.status, evidence: v.evidence, protects: r.protects, basis: r.basis, reference: r.reference };
  });
  const failed = rules.filter((r) => r.status === "fail").map((r) => r.id);
  const unknown = rules.filter((r) => r.status === "unknown").map((r) => r.id);
  const status: Status = failed.length ? "fail" : unknown.length ? "unknown" : "pass";
  return { status, failed, unknown, rules, ...(status === "unknown" ? { note: UNKNOWN_NOTE } : {}) };
}
