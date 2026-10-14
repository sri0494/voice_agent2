// Tab-scoped login storage. Must be imported FIRST in main.jsx.
// A login token must live only as long as the browser tab: it is kept in sessionStorage (survives refresh,
// gone when the tab is closed) and never in localStorage (which survives closing the browser = the auto-login bug).
// Your existing api.js may still call localStorage.setItem(<key>, <jwt>): this shim transparently redirects
// such writes to sessionStorage, and removes any JWT left in localStorage by older versions.
const JWT_RE = /^[\w-]+\.[\w-]+\.[\w-]+$/;
const KEYS = "__lmx_auth_keys";
const AUTHY = /token|jwt|auth/i;

export const looksLikeToken = (v) => {
  if (typeof v !== "string") return false;
  if (JWT_RE.test(v)) return true;
  if (v[0] === "{") { try { const o = JSON.parse(v); return [o.token, o.accessToken, o.jwt].some((t) => typeof t === "string" && JWT_RE.test(t)); } catch { return false; } }
  return false;
};
const safe = (fn, d) => { try { return fn(); } catch { return d; } };
const tracked = () => safe(() => JSON.parse(window.sessionStorage.getItem(KEYS) || "[]"), []);
const track = (k) => safe(() => { const s = new Set(tracked()); s.add(k); window.sessionStorage.setItem(KEYS, JSON.stringify([...s])); });

/** Remove every login-related value from localStorage (legacy persistent logins). Returns how many were removed. */
export function purgeLegacyLocalAuth() {
  let n = 0;
  safe(() => {
    const ls = window.localStorage; const doomed = [];
    for (let i = 0; i < ls.length; i++) { const k = ls.key(i); if (looksLikeToken(ls.getItem(k))) doomed.push(k); }
    for (const k of tracked()) if (ls.getItem(k) !== null) doomed.push(k);
    for (const k of new Set(doomed)) { ls.removeItem(k); n++; }
  });
  return n;
}

export function installAuthStorage() {
  if (typeof window === "undefined" || window.__lmxAuthStorage) return;
  window.__lmxAuthStorage = true;
  purgeLegacyLocalAuth();
  const proto = Object.getPrototypeOf(window.localStorage);
  const rawSet = proto.setItem, rawGet = proto.getItem, rawRemove = proto.removeItem;
  proto.setItem = function (k, v) {
    if (this === window.localStorage && (looksLikeToken(String(v)) || (AUTHY.test(String(k)) && tracked().includes(String(k))))) {
      track(String(k)); return window.sessionStorage.setItem(k, v);          // tab-scoped
    }
    return rawSet.call(this, k, v);
  };
  proto.getItem = function (k) {
    if (this === window.localStorage && tracked().includes(String(k))) return window.sessionStorage.getItem(k);
    return rawGet.call(this, k);
  };
  proto.removeItem = function (k) {
    if (this === window.localStorage && tracked().includes(String(k))) window.sessionStorage.removeItem(k);
    return rawRemove.call(this, k);
  };
}
installAuthStorage();
