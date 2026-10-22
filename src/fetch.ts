/**
 * Fetch a landing page and the same-origin scripts it loads, so that tracking
 * code kept in an external file such as /tracking.js is scanned too. Scanning
 * only the HTML misses that code and reports "not applicable" for a page that
 * does set the cookie.
 *
 * Cross-origin scripts (tag managers, the Meta Pixel itself, analytics SDKs)
 * are never fetched. They are listed as skipped so the caller can see what was
 * not scanned.
 */

import type { Source } from "./jsscan.js";

export const LIMITS = Object.freeze({
  timeoutMs: 30_000,
  maxScripts: 20,
  maxBytes: 2 * 1024 * 1024,
  maxScriptRedirects: 5,
});

/** A mobile browser user agent: paid social traffic is mostly mobile, and some sites serve different markup to it. */
export const USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

export interface Skipped {
  url: string;
  reason: string;
}

export interface ScriptPlan {
  fetch: string[];
  skipped: Skipped[];
}

export interface FetchedBundle {
  /** URL of the page after redirects. Same-origin is judged against this. */
  finalUrl: string;
  /** The page as HTML, then every same-origin script that was fetched, as JavaScript. */
  sources: Source[];
  /** Same-origin script URLs that were fetched and included in `code`. */
  scripts: string[];
  /** Script URLs that were not scanned, with the reason. */
  skipped: Skipped[];
}

const SCRIPT_SRC = /<script\b[^>]*?\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;

/** Every `src` of a `<script>` tag, in document order, as written. */
export function extractScriptSrcs(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(SCRIPT_SRC)) {
    const src = (m[1] ?? m[2] ?? m[3] ?? "").trim();
    if (src) out.push(src);
  }
  return out;
}

/**
 * Decide which scripts to fetch. Pure, so the same-origin rule can be tested
 * without a network.
 */
export function planScripts(html: string, pageUrl: string, maxScripts: number = LIMITS.maxScripts): ScriptPlan {
  const page = new URL(pageUrl);
  const plan: ScriptPlan = { fetch: [], skipped: [] };
  const seen = new Set<string>();
  for (const src of extractScriptSrcs(html)) {
    let abs: URL;
    try {
      abs = new URL(src, page);
    } catch {
      plan.skipped.push({ url: src, reason: "not a valid URL" });
      continue;
    }
    abs.hash = "";
    const key = abs.href;
    if (seen.has(key)) continue;
    seen.add(key);
    if (abs.protocol !== "http:" && abs.protocol !== "https:") {
      plan.skipped.push({ url: key, reason: `unsupported scheme ${abs.protocol}` });
    } else if (abs.origin !== page.origin) {
      plan.skipped.push({ url: key, reason: "cross-origin, never fetched" });
    } else if (plan.fetch.length >= maxScripts) {
      plan.skipped.push({ url: key, reason: `over the ${maxScripts}-script limit` });
    } else {
      plan.fetch.push(key);
    }
  }
  return plan;
}

class TooLarge extends Error {}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw new TooLarge(`larger than ${maxBytes} bytes`);
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new TooLarge(`larger than ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    all.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder("utf-8").decode(all);
}

function requestInit(redirect: "follow" | "manual"): RequestInit {
  return {
    headers: { "user-agent": USER_AGENT, accept: "*/*" },
    redirect,
    signal: AbortSignal.timeout(LIMITS.timeoutMs),
  };
}

/** Parse and validate a URL argument. Only http and https are accepted. */
export function parseHttpUrl(target: string): URL {
  let u: URL;
  try {
    u = new URL(target);
  } catch {
    throw new Error(`not a valid URL: ${target}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:")
    throw new Error(`only http and https URLs are supported, got ${u.protocol}`);
  return u;
}

/**
 * Fetch one same-origin script. Redirects are followed by hand so that a
 * same-origin URL redirecting to another origin is refused instead of fetched.
 */
async function fetchScript(url: string, origin: string): Promise<string> {
  let current = url;
  for (let hop = 0; hop <= LIMITS.maxScriptRedirects; hop++) {
    const res = await fetch(current, requestInit("manual"));
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => undefined);
      const location = res.headers.get("location");
      if (!location) throw new Error(`HTTP ${res.status} without a Location header`);
      const next = new URL(location, current);
      if (next.origin !== origin) throw new Error(`redirects to another origin (${next.origin}), not followed`);
      current = next.href;
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new Error(`HTTP ${res.status}`);
    }
    return readCapped(res, LIMITS.maxBytes);
  }
  throw new Error(`more than ${LIMITS.maxScriptRedirects} redirects`);
}

/** Fetch the page and its same-origin scripts. Throws if the page itself cannot be read. */
export async function fetchBundle(target: string): Promise<FetchedBundle> {
  const url = parseHttpUrl(target);
  const res = await fetch(url, requestInit("follow"));
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error(`HTTP ${res.status} for ${url.href}`);
  }
  const finalUrl = res.url || url.href;
  const html = await readCapped(res, LIMITS.maxBytes);
  const origin = new URL(finalUrl).origin;

  const plan = planScripts(html, finalUrl);
  const bodies = await Promise.all(
    plan.fetch.map(async (src) => {
      try {
        return { src, body: await fetchScript(src, origin), error: "" };
      } catch (err) {
        return { src, body: null, error: err instanceof Error ? err.message : String(err) };
      }
    }),
  );

  const sources: Source[] = [{ code: html, kind: "html" }];
  const scripts: string[] = [];
  const skipped = [...plan.skipped];
  for (const b of bodies) {
    if (b.body !== null) {
      sources.push({ code: b.body, kind: "js" });
      scripts.push(b.src);
    } else {
      skipped.push({ url: b.src, reason: b.error });
    }
  }
  return { finalUrl, sources, scripts, skipped };
}
