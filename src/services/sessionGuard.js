// Session guard: reacts to server-side session end, reports activity, avoids redirect loops.
import { purgeLegacyLocalAuth } from "./authStorage.js";
const NOTICE = "lmx_session_notice";
export const EXPIRED_MESSAGE = "Your session has expired. Please log in again.";
const JWT_RE = /^[\w-]+\.[\w-]+\.[\w-]+$/;

const onLogin = () => /^\/login\/?$/.test(window.location.pathname);
const authValues = () => { const out = []; try { for (let i = 0; i < sessionStorage.length; i++) { const k = sessionStorage.key(i); if (k && !k.startsWith("__lmx") && !k.startsWith("lmx_")) out.push([k, sessionStorage.getItem(k)]); } } catch { /* blocked */ } return out; };
const hasToken = () => authValues().some(([, v]) => JWT_RE.test(v || "") || (v && v[0] === "{" && /"token"|"accessToken"|"jwt"/.test(v)));
const clearClientAuth = () => { try { for (const [k, v] of authValues()) if (JWT_RE.test(v || "") || /token|auth|jwt|session|user/i.test(k)) sessionStorage.removeItem(k); } catch { /* blocked */ } purgeLegacyLocalAuth(); };

let ending = false;
export function endSession(message = EXPIRED_MESSAGE) {
  if (ending) return; ending = true;                                        // redirect exactly once
  clearClientAuth();
  try { sessionStorage.setItem(NOTICE, message); } catch { /* blocked */ }
  if (!onLogin()) (window.__lmxRedirect || ((p) => window.location.replace(p)))("/login");                         // hard navigation also drops cached React state
  else ending = false;
}
export const takeNotice = () => { try { const m = sessionStorage.getItem(NOTICE); if (m) sessionStorage.removeItem(NOTICE); return m; } catch { return null; } };

export function installSessionGuard() {
  if (typeof window === "undefined" || window.__lmxGuard) return; window.__lmxGuard = true;
  const rawFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const res = await rawFetch(input, init);
    if (res.status === 401) {
      const url = typeof input === "string" ? input : input?.url || "";
      if (!/\/api\/auth\/login/.test(url)) {
        try { const b = await res.clone().json(); if (b?.code === "SESSION_EXPIRED") endSession(b.message && /expired/i.test(b.message) ? EXPIRED_MESSAGE : EXPIRED_MESSAGE); } catch { /* not json */ }
      }
    }
    return res;
  };
  let active = false, pingEvery = 45000, timer = null;
  const mark = () => { active = true; };
  for (const ev of ["pointerdown", "keydown", "wheel", "touchstart", "scroll"]) window.addEventListener(ev, mark, { passive: true, capture: true });
  const ping = async () => {
    if (!hasToken() || ending) return;
    const token = authValues().map(([, v]) => v).find((v) => JWT_RE.test(v || "")) || null;
    const sendActive = active; active = false;
    try {
      const r = await rawFetch("/api/auth/session/ping", { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ active: sendActive }), cache: "no-store" });
      if (r.status === 401) { const b = await r.json().catch(() => ({})); if (b?.code === "SESSION_EXPIRED") endSession(); }
    } catch { /* offline: try again next tick */ }
  };
  const start = () => { if (!timer) timer = setInterval(ping, pingEvery); };
  start();
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") { mark(); ping(); } });
  window.addEventListener("pageshow", (e) => { if (e.persisted) ping(); });   // back/forward cache: re-validate instead of trusting the frozen page
  window.addEventListener("online", ping);
  window.__lmxGuardPing = ping;
}
installSessionGuard();
