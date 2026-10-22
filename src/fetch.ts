/**
 * Fetch a landing page and the same-origin scripts it loads, so that tracking
 * code kept in an external file such as /tracking.js is scanned too. Scanning
 * only the HTML misses that code and reports "not applicable" for a page that
 * does set the cookie.
 *
 * Cross-origin scripts (tag managers, the Meta Pixel itself, analytics SDKs)
 * are never fetched. They are listed as skipped so the caller can see what was
 * not scanned.
 *
 * Network safety. A URL checker that an AI agent can call is a request
 * forgery risk: it must not become a way to reach cloud metadata endpoints,
 * localhost services or the private network. By default every connection is
 * refused when the host resolves to a loopback, private, link-local, CGNAT,
 * multicast, unspecified or otherwise non-public address, including IPv4
 * addresses embedded in IPv6. The check runs inside the socket's DNS lookup,
 * on the exact addresses the connection will use, so an answer that changes
 * between a check and the connection cannot slip past it. Redirects are
 * followed by hand, at most five, and every hop is checked the same way. A
 * refused address and an unreachable host produce the same error text.
 * Private targets are allowed only when the caller opts in.
 */

import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import zlib from "node:zlib";
import type { Readable } from "node:stream";

import type { Source } from "./jsscan.js";

export const LIMITS = Object.freeze({
  timeoutMs: 30_000,
  maxScripts: 20,
  maxBytes: 2 * 1024 * 1024,
  maxRedirects: 5,
});

/** A mobile browser user agent: paid social traffic is mostly mobile, and some sites serve different markup to it. */
export const USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

/** The one message for a refused address, a DNS failure, a refused or reset connection, a TLS failure and a timeout. */
export const UNREACHABLE =
  "could not fetch this URL: the host resolves to an address that is not allowed, or it could not be reached";

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
  /** Same-origin script URLs that were fetched and included in `sources`. */
  scripts: string[];
  /** Script URLs that were not scanned, with the reason. */
  skipped: Skipped[];
}

export interface FetchOptions {
  /** Allow loopback, private and link-local targets. For testing your own local or intranet pages. */
  allowPrivate?: boolean;
  /** Replaces the address policy entirely. Used by tests. */
  isAllowedAddress?: (ip: string) => boolean;
}

// ---------------------------------------------------------------------------
// Address policy

function parseIPv4(ip: string): number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  return nums.every((n) => n >= 0 && n <= 255) ? nums : null;
}

function parseIPv6(input: string): number[] | null {
  let s = input.split("%")[0];
  let tail: number[] | null = null;
  const lastColon = s.lastIndexOf(":");
  if (s.slice(lastColon + 1).includes(".")) {
    tail = parseIPv4(s.slice(lastColon + 1));
    if (!tail) return null;
    s = s.slice(0, lastColon + 1) + "0:0";
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 ? (halves[1] ? halves[1].split(":") : []) : null;
  const groups = rest === null ? head : [...head, ...Array(8 - head.length - rest.length).fill("0"), ...rest];
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/i.test(g))) return null;
  const bytes = groups.flatMap((g) => {
    const v = parseInt(g, 16);
    return [v >> 8, v & 255];
  });
  if (tail) bytes.splice(12, 4, ...tail);
  return bytes;
}

function blockedIPv4([a, b]: number[]): boolean {
  return (
    a === 0 || // 0.0.0.0/8, "this network"
    a === 10 || // 10.0.0.0/8
    (a === 100 && b >= 64 && b <= 127) || // 100.64.0.0/10, carrier-grade NAT
    a === 127 || // loopback
    (a === 169 && b === 254) || // link-local, including cloud metadata 169.254.169.254
    (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12
    (a === 192 && b === 0) || // 192.0.0.0/24 protocol assignments (and 192.0.2.0/24 documentation)
    (a === 192 && b === 168) || // 192.168.0.0/16
    (a === 198 && (b === 18 || b === 19)) || // 198.18.0.0/15 benchmarking
    a >= 224 // multicast 224.0.0.0/4, reserved 240.0.0.0/4, broadcast
  );
}

/** True when a connection to this address must be refused by default. Anything unparseable is refused. */
export function isBlockedAddress(ip: string): boolean {
  if (net.isIPv4(ip)) return blockedIPv4(parseIPv4(ip)!);
  if (!net.isIPv6(ip)) return true;
  const b = parseIPv6(ip);
  if (!b) return true;
  const zeros = (from: number, to: number) => b.slice(from, to).every((x) => x === 0);
  if (zeros(0, 10) && b[10] === 0xff && b[11] === 0xff) return blockedIPv4(b.slice(12)); // ::ffff:a.b.c.d
  if (zeros(0, 12)) return blockedIPv4(b.slice(12)); // ::a.b.c.d, also :: and ::1
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zeros(4, 12)) return blockedIPv4(b.slice(12)); // 64:ff9b::/96 NAT64
  if (b[0] === 0x20 && b[1] === 0x02) return blockedIPv4(b.slice(2, 6)); // 2002::/16 6to4
  if ((b[0] & 0xfe) === 0xfc) return true; // fc00::/7 unique local
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true; // fe80::/10 link-local
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0xc0) return true; // fec0::/10 old site-local
  if (b[0] === 0xff) return true; // multicast
  return false;
}

function addressPolicy(opts: FetchOptions): (ip: string) => boolean {
  if (opts.isAllowedAddress) return opts.isAllowedAddress;
  if (opts.allowPrivate) return () => true;
  return (ip) => !isBlockedAddress(ip);
}

class Unreachable extends Error {
  constructor() {
    super(UNREACHABLE);
  }
}

/** A DNS lookup for the socket that refuses disallowed addresses. Runs on the addresses actually used to connect. */
function guardedLookup(allowed: (ip: string) => boolean) {
  return (hostname: string, options: dns.LookupOptions, callback: (...args: unknown[]) => void) => {
    dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err);
      const list = addresses as unknown as dns.LookupAddress[];
      if (!list.length || list.some((a) => !allowed(a.address))) return callback(new Unreachable());
      if (options.all) return callback(null, list);
      return callback(null, list[0].address, list[0].family);
    });
  };
}

// ---------------------------------------------------------------------------
// HTTP

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

class HttpStatus extends Error {}
class TooLarge extends Error {}

function decoded(res: http.IncomingMessage): Readable {
  switch ((res.headers["content-encoding"] ?? "").toLowerCase()) {
    case "gzip":
    case "x-gzip":
      return res.pipe(zlib.createGunzip());
    case "deflate":
      return res.pipe(zlib.createInflate());
    case "br":
      return res.pipe(zlib.createBrotliDecompress());
    default:
      return res;
  }
}

/** Read the (decompressed) body, refusing anything over maxBytes. */
async function readCapped(res: http.IncomingMessage, maxBytes: number): Promise<string> {
  const declared = Number(res.headers["content-length"]);
  if (!res.headers["content-encoding"] && Number.isFinite(declared) && declared > maxBytes) {
    res.destroy();
    throw new TooLarge(`larger than ${maxBytes} bytes`);
  }
  const stream = decoded(res);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    total += (chunk as Buffer).length;
    if (total > maxBytes) {
      res.destroy();
      stream.destroy();
      throw new TooLarge(`larger than ${maxBytes} bytes`);
    }
    chunks.push(chunk as Buffer);
  }
  return new TextDecoder("utf-8").decode(Buffer.concat(chunks));
}

function requestOnce(url: URL, allowed: (ip: string) => boolean): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    // An IP literal never goes through DNS, so check it here.
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (net.isIP(host) && !allowed(host)) return reject(new Unreachable());
    const mod = url.protocol === "https:" ? https : http;
    const req = mod.request(
      url,
      {
        method: "GET",
        agent: false,
        lookup: guardedLookup(allowed) as unknown as net.LookupFunction,
        signal: AbortSignal.timeout(LIMITS.timeoutMs),
        headers: { "user-agent": USER_AGENT, accept: "*/*", "accept-encoding": "gzip, deflate, br" },
      },
      resolve,
    );
    req.on("error", () => reject(new Unreachable()));
    req.end();
  });
}

/**
 * GET with manual redirects. Every hop must be http(s) and pass the address
 * policy; with `sameOrigin`, every hop must also stay on that origin.
 */
async function get(start: URL, allowed: (ip: string) => boolean, sameOrigin?: string): Promise<{ url: URL; body: string }> {
  let current = start;
  for (let hop = 0; hop <= LIMITS.maxRedirects; hop++) {
    if (current.protocol !== "http:" && current.protocol !== "https:")
      throw new Error(`redirects to an unsupported scheme ${current.protocol}`);
    if (sameOrigin && current.origin !== sameOrigin)
      throw new Error(`redirects to another origin (${current.origin}), not followed`);
    const res = await requestOnce(current, allowed);
    const status = res.statusCode ?? 0;
    if (status >= 300 && status < 400 && res.headers.location) {
      res.resume();
      current = new URL(res.headers.location, current);
      continue;
    }
    if (status < 200 || status >= 300) {
      res.resume();
      throw new HttpStatus(`HTTP ${status}`);
    }
    try {
      return { url: current, body: await readCapped(res, LIMITS.maxBytes) };
    } catch (err) {
      if (err instanceof TooLarge) throw err;
      throw new Unreachable();
    }
  }
  throw new Error(`more than ${LIMITS.maxRedirects} redirects`);
}

/** Fetch the page and its same-origin scripts. Throws if the page itself cannot be read. */
export async function fetchBundle(target: string, opts: FetchOptions = {}): Promise<FetchedBundle> {
  const allowed = addressPolicy(opts);
  const page = await get(parseHttpUrl(target), allowed);
  const finalUrl = page.url.href;
  const plan = planScripts(page.body, finalUrl);

  const bodies = await Promise.all(
    plan.fetch.map(async (src) => {
      try {
        return { src, body: (await get(new URL(src), allowed, page.url.origin)).body, error: "" };
      } catch (err) {
        return { src, body: null, error: err instanceof Error ? err.message : String(err) };
      }
    }),
  );

  const sources: Source[] = [{ code: page.body, kind: "html" }];
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
