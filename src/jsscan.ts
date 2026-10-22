/**
 * A small, dependency-free view of JavaScript source for the rules that need
 * more than a regular expression over raw text.
 *
 * It is not a parser. It does three things:
 *   1. masks string, template and regular-expression contents and comments,
 *      so that brackets, semicolons and identifiers seen afterwards are code;
 *   2. finds the extent of the statement around a position;
 *   3. lists simple `name = expression` assignments.
 *
 * Masking keeps every character position, so a match in the masked text maps
 * straight back to the original text for evidence.
 */

/** Replaces the contents of strings, template text and regex literals. Not an identifier, operator or space. */
export const MASK = "\u2591";

export type SourceKind = "html" | "js";

export interface Source {
  code: string;
  /** How to read `code`. Omitted: HTML if it starts with "<", JavaScript otherwise. */
  kind?: SourceKind;
}

const REGEX_AFTER_PUNCT = new Set("(,=:[!&|?{};+-*%<>~^".split(""));
const REGEX_AFTER_WORD = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void",
  "throw", "case", "do", "else", "yield", "await",
]);
const isSpace = (c: string) => /\s/.test(c) || c === "\uFEFF";
const isIdentStart = (c: string) => /[A-Za-z_$]/.test(c) || c > "\u007f";
const isIdentPart = (c: string) => /[\w$]/.test(c) || c > "\u007f";

/**
 * Mask comments (with spaces) and the contents of strings, template text and
 * regex literals (with MASK). Quotes and backticks are kept; the `${` and `}`
 * around template expressions are masked and the expressions stay as code.
 * Line breaks are always kept. With `keepLiterals`, only comments are masked.
 */
export function maskJs(src: string, keepLiterals = false): string {
  const n = src.length;
  const out = src.split("");
  const put = (k: number, ch: string) => {
    if (keepLiterals && ch === MASK) return;
    if (k < n && src[k] !== "\n" && src[k] !== "\r") out[k] = ch;
  };
  const templateDepths: number[] = [];
  let brace = 0;
  let prev = "";
  let inTemplate = false;
  let i = 0;

  while (i < n) {
    const c = src[i];
    if (inTemplate) {
      if (c === "\\") { put(i, MASK); put(i + 1, MASK); i += 2; continue; }
      if (c === "`") { inTemplate = false; prev = "lit"; i++; continue; }
      if (c === "$" && src[i + 1] === "{") {
        put(i, MASK); put(i + 1, MASK);
        templateDepths.push(brace);
        inTemplate = false; prev = "("; i += 2; continue;
      }
      put(i, MASK); i++; continue;
    }
    if (isSpace(c)) { i++; continue; }
    if (c === "/" && src[i + 1] === "/") {
      while (i < n && src[i] !== "\n") { put(i, " "); i++; }
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      let j = i + 2;
      while (j < n && !(src[j] === "*" && src[j + 1] === "/")) j++;
      const end = Math.min(n, j + 2);
      for (let k = i; k < end; k++) put(k, " ");
      i = end; continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== "\n") {
        if (src[j] === "\\") { put(j, MASK); put(j + 1, MASK); j += 2; continue; }
        put(j, MASK); j++;
      }
      i = j < n && src[j] === c ? j + 1 : j;
      prev = "lit"; continue;
    }
    if (c === "`") { inTemplate = true; i++; continue; }
    if (c === "/" && (prev === "" || prev === "kw" || REGEX_AFTER_PUNCT.has(prev))) {
      let j = i + 1;
      let inClass = false;
      while (j < n && src[j] !== "\n") {
        const d = src[j];
        if (d === "\\") { j += 2; continue; }
        if (inClass) { if (d === "]") inClass = false; }
        else if (d === "[") inClass = true;
        else if (d === "/") break;
        j++;
      }
      if (j < n && src[j] === "/") {
        j++;
        while (j < n && /[a-z]/i.test(src[j])) j++;
        for (let k = i; k < j; k++) put(k, MASK);
        i = j; prev = "lit"; continue;
      }
      prev = "/"; i++; continue;
    }
    if (isIdentStart(c)) {
      let j = i + 1;
      while (j < n && isIdentPart(src[j])) j++;
      prev = REGEX_AFTER_WORD.has(src.slice(i, j)) ? "kw" : "id";
      i = j; continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < n && /[\w.]/.test(src[j])) j++;
      prev = "num"; i = j; continue;
    }
    if (c === "{") { brace++; prev = "{"; i++; continue; }
    if (c === "}") {
      if (templateDepths.length && brace === templateDepths[templateDepths.length - 1]) {
        templateDepths.pop(); put(i, MASK); inTemplate = true; i++; continue;
      }
      brace--; prev = "}"; i++; continue;
    }
    prev = c; i++;
  }
  return out.join("");
}

// A line break ends a statement unless the line ends or the next line starts
// with something that can only continue an expression.
const CONTINUES_AT_END = new Set("+-*/%=&|^!~?:,.([{<>".split(""));
const CONTINUES_AT_START = new Set("+-*/%=&|^?:,.)]>".split(""));

function prevNonSpace(m: string, k: number): string {
  while (k >= 0 && isSpace(m[k])) k--;
  return k >= 0 ? m[k] : "";
}
function nextNonSpace(m: string, k: number): string {
  while (k < m.length && isSpace(m[k])) k++;
  return k < m.length ? m[k] : "";
}
function lineBreakEnds(m: string, k: number): boolean {
  return !CONTINUES_AT_END.has(prevNonSpace(m, k - 1)) && !CONTINUES_AT_START.has(nextNonSpace(m, k + 1));
}

/**
 * End (exclusive) of the statement containing masked position `from`.
 * Stops at `;` or a statement-ending line break outside brackets, or at a `}`
 * that closes the enclosing block. With `stopAtComma`, a top-level comma or a
 * closing bracket of an enclosing group also ends it (one declarator or argument).
 */
export function statementEnd(m: string, from: number, stopAtComma = false): number {
  let depth = 0;
  for (let k = from; k < m.length; k++) {
    const c = m[k];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]") {
      if (depth > 0) depth--;
      else if (stopAtComma) return k;
    } else if (c === "}") {
      if (depth > 0) depth--;
      else return k;
    } else if (depth === 0) {
      if (c === ";" || (stopAtComma && c === ",")) return k;
      if (c === "\n" && lineBreakEnds(m, k)) return k;
    }
  }
  return m.length;
}

/** Start of the statement containing masked position `from`. Enclosing parentheses are part of it; braces are not. */
export function statementStart(m: string, from: number): number {
  let depth = 0;
  for (let k = from - 1; k >= 0; k--) {
    const c = m[k];
    if (c === ")" || c === "]") depth++;
    else if (c === "}") {
      if (depth === 0) return k + 1;
      depth++;
    } else if (c === "(" || c === "[") {
      if (depth > 0) depth--;
    } else if (c === "{") {
      if (depth === 0) return k + 1;
      depth--;
    } else if (depth === 0) {
      if (c === ";") return k + 1;
      if (c === "\n" && lineBreakEnds(m, k)) return k + 1;
    }
  }
  return 0;
}

export interface Assignment {
  name: string;
  /** Masked position of the name. */
  at: number;
  rhsStart: number;
  rhsEnd: number;
}

/** `name = expression` assignments (including `var`/`let`/`const` declarators), in source order. */
export function assignments(m: string): Assignment[] {
  const out: Assignment[] = [];
  const re = /(?<![\w$\u0080-\uFFFF])([A-Za-z_$][\w$]*)\s*=(?![=>])/g;
  for (const match of m.matchAll(re)) {
    const at = match.index ?? 0;
    const rhsStart = at + match[0].length;
    out.push({ name: match[1], at, rhsStart, rhsEnd: statementEnd(m, rhsStart, true) });
  }
  return out;
}

export function sourceKind(s: Source): SourceKind {
  return s.kind ?? (/^\s*</.test(s.code.replace(/^\uFEFF/, "")) ? "html" : "js");
}

const blank = (s: string) => s.replace(/[^\n]/g, " ");

/**
 * Walk an HTML document once. HTML comments are blanked, so markup that was
 * commented out is ignored. Each `<script>` body is collected as a unit and,
 * in the returned text, has its JavaScript comments blanked.
 */
export function scanHtml(html: string): { text: string; units: string[] } {
  const lower = html.toLowerCase();
  const units: string[] = [];
  let text = "";
  let i = 0;
  while (i < html.length) {
    const comment = lower.indexOf("<!--", i);
    const scriptMatch = /<script\b/g;
    scriptMatch.lastIndex = i;
    const sm = scriptMatch.exec(lower);
    const script = sm ? sm.index : -1;
    if (comment < 0 && script < 0) {
      text += html.slice(i);
      break;
    }
    if (comment >= 0 && (script < 0 || comment < script)) {
      text += html.slice(i, comment);
      const close = lower.indexOf("-->", comment + 4);
      const end = close < 0 ? html.length : close + 3;
      text += blank(html.slice(comment, end));
      i = end;
      continue;
    }
    text += html.slice(i, script);
    const openEnd = html.indexOf(">", script);
    if (openEnd < 0) {
      text += html.slice(script);
      break;
    }
    const close = lower.indexOf("</script", openEnd + 1);
    const bodyEnd = close < 0 ? html.length : close;
    const body = html.slice(openEnd + 1, bodyEnd);
    if (body.trim()) units.push(body);
    text += html.slice(script, openEnd + 1) + maskJs(body, true);
    i = bodyEnd;
  }
  return { text, units };
}

export interface JsView {
  /** Script units joined in document order. */
  raw: string;
  /** `raw` with each unit masked separately, same length: comments blanked, literal contents masked. */
  masked: string;
}

export interface Views {
  /** Every source with comments blanked (JavaScript and HTML) and string contents intact. */
  text: string;
  /** The JavaScript only, for analysis. */
  js: JsView;
}

/** Build the views the rules read. Units are joined with a hard statement break so one cannot run into the next. */
export function buildViews(sources: readonly Source[]): Views {
  const units: string[] = [];
  const texts: string[] = [];
  for (const s of sources) {
    if (sourceKind(s) === "js") {
      units.push(s.code);
      texts.push(maskJs(s.code, true));
    } else {
      const h = scanHtml(s.code);
      units.push(...h.units);
      texts.push(h.text);
    }
  }
  const sep = "\n;\n";
  return {
    text: texts.join("\n"),
    js: { raw: units.join(sep), masked: units.map((u) => maskJs(u)).join(sep) },
  };
}
