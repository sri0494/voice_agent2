// SSRF protection for outbound calls to business integrations.
//  1. assertPublicUrl(): validates scheme/port/credentials/host AND resolves DNS: every resolved address must be public.
//  2. safeRequest(): performs the request with a custom DNS `lookup` that validates the address at CONNECT time and
//     connects to exactly that address, so a hostname cannot be rebound to a private IP between check and use.
//  Redirects are never followed. Response size and time are capped.
import dns from "node:dns/promises";
import dnsCb from "node:dns";
import net from "node:net";
import http from "node:http";
import https from "node:https";

const isProd = () => process.env.NODE_ENV === "production";
// Test-only escape hatch so the request path can be exercised against a local server. Ignored unless NODE_ENV=test.
const allowPrivate = () => process.env.NODE_ENV === "test" && process.env.SSRF_ALLOW_PRIVATE === "true";

export class SsrfError extends Error {
  constructor(message) { super(message); this.name = "SsrfError"; this.statusCode = 422; }
}

function v4ToInt(ip) { return ip.split(".").reduce((a, b) => (a << 8) + Number(b), 0) >>> 0; }
const V4_BLOCKS = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
].map(([base, bits]) => ({ base: v4ToInt(base), mask: bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0 }));

/** True for private, loopback, link-local, metadata, multicast, reserved and unspecified addresses. */
export function isPrivateIp(ip) {
  if (net.isIPv4(ip)) { const n = v4ToInt(ip); return V4_BLOCKS.some((b) => (n & b.mask) === (b.base & b.mask)); }
  if (net.isIPv6(ip)) {
    const x = ip.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(x) || /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(x);
    if (mapped) {
      if (mapped[2] === undefined) return isPrivateIp(mapped[1]);
      const hi = parseInt(mapped[1], 16), lo = parseInt(mapped[2], 16);
      return isPrivateIp(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    if (x === "::" || x === "::1") return true;
    if (/^f[cd]/.test(x)) return true;                 // fc00::/7 unique local (includes fd00:ec2::254 metadata)
    if (/^fe[89ab]/.test(x)) return true;              // fe80::/10 link-local
    if (/^ff/.test(x)) return true;                    // multicast
    if (x.startsWith("64:ff9b:")) return true;         // NAT64
    if (x.startsWith("2001:db8")) return true;         // documentation
    return false;
  }
  return true; // not an IP at all: refuse
}

const BLOCKED_NAMES = [/^localhost$/i, /\.localhost$/i, /\.local$/i, /\.internal$/i, /\.lan$/i, /^metadata\.google\.internal$/i, /^instance-data$/i];
const allowedPorts = () => new Set([443, ...(process.env.SSRF_ALLOWED_PORTS || "").split(",").map(Number).filter(Boolean), ...(isProd() && process.env.SSRF_ALLOW_HTTP !== "true" ? [] : [80])]);

let resolver = (host) => dns.lookup(host, { all: true, verbatim: true });
/** Test hook: replace DNS resolution. */
export function setResolver(fn) { resolver = fn || ((host) => dns.lookup(host, { all: true, verbatim: true })); }

function parse(urlStr) {
  let u;
  try { u = new URL(String(urlStr)); } catch { throw new SsrfError("Invalid URL"); }
  const httpOk = !isProd() || process.env.SSRF_ALLOW_HTTP === "true";
  if (u.protocol !== "https:" && !(httpOk && u.protocol === "http:")) throw new SsrfError(isProd() ? "Only https:// URLs are allowed" : "Only http:// and https:// URLs are allowed");
  if (u.username || u.password) throw new SsrfError("Credentials inside the URL are not allowed");
  const port = Number(u.port || (u.protocol === "https:" ? 443 : 80));
  if (!allowPrivate() && !allowedPorts().has(port)) throw new SsrfError(`Port ${port} is not allowed`);
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (!host) throw new SsrfError("URL has no host");
  return { u, host, port };
}

/** Validates the URL and resolves DNS; throws SsrfError unless every address is public. Returns the URL. */
export async function assertPublicUrl(urlStr) {
  const { u, host } = parse(urlStr);
  if (allowPrivate()) return u;
  if (BLOCKED_NAMES.some((re) => re.test(host))) throw new SsrfError("This host is not allowed");
  if (net.isIP(host)) { if (isPrivateIp(host)) throw new SsrfError("Private, loopback and link-local addresses are not allowed"); return u; }
  let addrs;
  try { addrs = await resolver(host); } catch { throw new SsrfError("Host could not be resolved"); }
  if (!addrs.length) throw new SsrfError("Host could not be resolved");
  if (addrs.some((a) => isPrivateIp(a.address))) throw new SsrfError("Host resolves to a private or reserved address");
  return u;
}

// DNS lookup used at connect time: resolves, validates ALL answers, then hands back the validated address.
function safeLookup(hostname, options, cb) {
  if (typeof options === "function") { cb = options; options = {}; }
  Promise.resolve(resolver(hostname)).then((addrs) => {
    if (!addrs.length || (!allowPrivate() && addrs.some((a) => isPrivateIp(a.address)))) {
      return cb(new SsrfError("Host resolves to a private or reserved address"));
    }
    if (options && options.all) return cb(null, addrs.map((a) => ({ address: a.address, family: a.family })));
    cb(null, addrs[0].address, addrs[0].family);
  }).catch((e) => cb(e));
}

/**
 * @returns {Promise<{ status:number, headers:object, body:Buffer }>}
 */
export async function safeRequest(urlStr, { method = "GET", headers = {}, body, timeoutMs = 10000, maxBytes = 1024 * 1024 } = {}) {
  const u = await assertPublicUrl(urlStr);
  const lib = u.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(u, { method, headers, lookup: net.isIP(u.hostname.replace(/^\[|\]$/g, "")) ? undefined : safeLookup, timeout: timeoutMs }, (res) => {
      const chunks = []; let size = 0;
      res.on("data", (c) => {
        size += c.length;
        if (size > maxBytes) { req.destroy(new Error("Response too large")); return; }
        chunks.push(c);
      });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error(`Request timed out after ${timeoutMs} ms`)));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}
