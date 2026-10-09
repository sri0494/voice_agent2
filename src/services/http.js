// One small API client for everything added in this change (customer portal, customer accounts, recordings).
// It reads the JWT your login already stored. If auto-detection ever picks the wrong value,
// set TOKEN_KEY to the exact localStorage key your AuthContext uses.
export const TOKEN_KEY = ""; // e.g. "leomox_token"
const BASE = "/api";
const JWT_RE = /^[\w-]+\.[\w-]+\.[\w-]+$/;

function* storedValues() {
  for (const store of [window.localStorage, window.sessionStorage]) {
    try { for (let i = 0; i < store.length; i++) { const k = store.key(i); yield [store, k, store.getItem(k)]; } } catch { /* storage blocked */ }
  }
}
const jwtIn = (v) => {
  if (!v) return null;
  if (JWT_RE.test(v)) return v;
  if (v[0] === "{") { try { const o = JSON.parse(v); const t = o.token || o.accessToken || o.jwt; if (typeof t === "string" && JWT_RE.test(t)) return t; } catch { /* not json */ } }
  return null;
};

export function getToken() {
  if (TOKEN_KEY) return window.localStorage.getItem(TOKEN_KEY) || window.sessionStorage.getItem(TOKEN_KEY) || null;
  for (const [, , v] of storedValues()) { const t = jwtIn(v); if (t) return t; }
  return null;
}

/** Remove the login (token + stored user) but leave unrelated settings such as the theme. */
export function clearAuth() {
  const doomed = [];
  for (const [store, k, v] of storedValues()) if (jwtIn(v) || /token|auth|jwt|session|user/i.test(k)) doomed.push([store, k]);
  doomed.forEach(([store, k]) => store.removeItem(k));
}

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const qs = (params) => {
  const p = Object.entries(params || {}).filter(([, v]) => v !== undefined && v !== null && v !== "");
  return p.length ? `?${new URLSearchParams(p)}` : "";
};

export async function http(path, { method = "GET", body, params } = {}) {
  const token = getToken();
  const isForm = typeof FormData !== "undefined" && body instanceof FormData;
  const res = await fetch(`${BASE}${path}${qs(params)}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body && !isForm ? { "Content-Type": "application/json" } : {}) },
    body: body ? (isForm ? body : JSON.stringify(body)) : undefined,
  });
  const json = (res.headers.get("content-type") || "").includes("json") ? await res.json().catch(() => null) : null;
  if (!res.ok) throw new HttpError(res.status, json?.message || json?.error || `Request failed (${res.status})`);
  return json && typeof json === "object" && "data" in json ? json.data : json;
}

/** Authenticated file download (CSV etc.): an <a href> cannot send the Authorization header. */
export async function downloadFile(path, filename, params) {
  const token = getToken();
  const res = await fetch(`${BASE}${path}${qs(params)}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!res.ok) throw new HttpError(res.status, res.status === 403 ? "You do not have permission to download this" : "Download failed");
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---- authenticated media (recordings) ----
// Recordings are private. The server answers /url with either
//   { mode: "presigned", url }  -> a 5-minute signed Cloudflare R2 / S3 URL (production), or
//   { mode: "stream",    url }  -> an API path that needs the Authorization header (local development storage).
// An <audio src> cannot send headers, so "stream" links are fetched with the token and played from a blob.
export async function fetchBlob(apiPath) {
  const token = getToken();
  const res = await fetch(apiPath, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!res.ok) throw new HttpError(res.status, res.status === 403 ? "You do not have permission to open this recording" : "Could not load the recording");
  return res.blob();
}

/** -> { src, release() }  Call release() when the player is closed. */
export async function resolvePlayback(meta) {
  if (meta.mode === "presigned") return { src: meta.url, release() {} };
  const objectUrl = URL.createObjectURL(await fetchBlob(meta.url));
  return { src: objectUrl, release: () => URL.revokeObjectURL(objectUrl) };
}

/** Download through the same two modes. meta = { mode, url } as returned for a *download* link. */
export async function saveRecording(meta, filename = "recording") {
  let href = meta.url, release = () => {};
  if (meta.mode !== "presigned") { href = URL.createObjectURL(await fetchBlob(meta.url)); release = () => URL.revokeObjectURL(href); }
  const a = document.createElement("a");
  a.href = href; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(release, 1000);
}

// ---- recordings API (staff) ----
export const getRecordings = (params) => http("/recordings", { params });
export const getRecordingUrl = (id, { download = false } = {}) => http(`/recordings/${id}/url`, { params: download ? { download: 1 } : undefined });
export const deleteRecording = (id) => http(`/recordings/${id}`, { method: "DELETE" });
export function uploadRecording(blob, { callId, durationSec } = {}) {
  const form = new FormData();
  form.append("audio", blob, "recording");
  if (callId) form.append("callId", callId);
  if (durationSec) form.append("durationSec", String(durationSec));
  form.append("source", "browser");
  return http("/recordings", { method: "POST", body: form });
}

// ---- live calls WebSocket ----
// The token travels in the Sec-WebSocket-Protocol header (not in the URL, so it never lands in server logs).
export function openLiveCallsSocket() {
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  const token = getToken();
  return new WebSocket(`${proto}://${window.location.host}/ws/live-calls`, token ? ["leomox.v1", token] : ["leomox.v1"]);
}

/** After a password change the server issues a fresh token and older ones stop working: swap it wherever the old one is stored. */
export function replaceToken(oldToken, newToken) {
  if (!oldToken || !newToken) return;
  for (const [store, k, v] of storedValues()) {
    if (v === oldToken) store.setItem(k, newToken);
    else if (v && v[0] === "{" && v.includes(oldToken)) store.setItem(k, v.split(oldToken).join(newToken));
  }
}

// ---- customers (people) edit: PUT /api/customers/:id ----
export const updateCustomer = (id, data) => http(`/customers/${id}`, { method: "PUT", body: data });
