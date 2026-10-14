// Browser-side session behaviour (jsdom): tab-scoped token storage, legacy purge, SESSION_EXPIRED handling, no redirect loops.
import { JSDOM } from "jsdom";
import { makeRunner } from "./harness.mjs";
const t = makeRunner({}); const { check } = t;
const JWT = "aaa.bbb.ccc";
function env(url = "http://localhost/dashboard", ls = {}, ss = {}) {
  const dom = new JSDOM(`<!doctype html><body></body>`, { url, pretendToBeVisual: true });
  for (const [k, v] of Object.entries(ls)) dom.window.localStorage.setItem(k, v);
  for (const [k, v] of Object.entries(ss)) dom.window.sessionStorage.setItem(k, v);
  const calls = []; dom.window.fetch = async (u, o) => { calls.push([String(u), o]); return env.next(u); };
  env.replaced = []; dom.window.__lmxRedirect = (p) => env.replaced.push(p);
  return { dom, calls };
}
const boot = async (e) => { for (const k of ["window", "document", "sessionStorage", "localStorage"]) Object.defineProperty(globalThis, k, { value: e.dom.window[k], configurable: true, writable: true }); globalThis.window = e.dom.window; delete globalThis.window.__lmxAuthStorage; delete globalThis.window.__lmxGuard; const n = Date.now() + Math.random(); await import(`../src/services/authStorage.js?${n}`); await import(`../src/services/sessionGuard.js?${n}`); return e.dom.window; };
const json = (status, body) => ({ status, clone() { return this; }, json: async () => body });

console.log("\n== Token storage ==");
let e = env("http://localhost/login", { leomox_token: JWT, theme: "dark", user: "{}" }); let w = await boot(e);
check("a JWT left in localStorage by an older version is purged at startup (no auto-login after reopening)", w.localStorage.getItem("leomox_token") === null);
check("unrelated settings (theme) survive", w.localStorage.getItem("theme") === "dark");
w.localStorage.setItem("leomox_token", "x1.y2.z3");
check("existing api.js writing the JWT to localStorage is redirected to sessionStorage", w.sessionStorage.getItem("leomox_token") === "x1.y2.z3" && !Object.keys(w.localStorage).includes("leomox_token"));
check("reads through localStorage still find it (refresh keeps working)", w.localStorage.getItem("leomox_token") === "x1.y2.z3");
w.localStorage.removeItem("leomox_token");
check("logout removal clears it", w.sessionStorage.getItem("leomox_token") === null);
w.localStorage.setItem("leomox_user", JSON.stringify({ token: JWT }));
check("a JSON blob containing a token is also kept tab-scoped", w.sessionStorage.getItem("leomox_user") !== null && w.localStorage.getItem("leomox_user") !== null && !Object.keys(w.localStorage).includes("leomox_user"));
e = env("http://localhost/dashboard"); w = await boot(e);
check("a NEW tab (empty sessionStorage) starts logged out", [...Array(w.sessionStorage.length).keys()].every((i) => !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(w.sessionStorage.getItem(w.sessionStorage.key(i)))));

console.log("\n== SESSION_EXPIRED handling ==");
env.next = () => json(401, { code: "SESSION_EXPIRED", reason: "IDLE", message: "Your session has expired due to inactivity. Please log in again." });
e = env("http://localhost/campaigns", {}, { tok: JWT }); w = await boot(e);
await w.fetch("/api/campaigns"); await w.fetch("/api/calls"); await w.fetch("/api/clients");
check("an expired session redirects to /login exactly once even with several parallel 401s", env.replaced.length === 1 && env.replaced[0] === "/login");
check("client auth state is cleared and the notice is stored", w.sessionStorage.getItem("tok") === null && w.sessionStorage.getItem("lmx_session_notice") === "Your session has expired. Please log in again.");
const { takeNotice } = await import(`../src/services/sessionGuard.js?x${Math.random()}`);
check("the login page can read the notice once", takeNotice() === "Your session has expired. Please log in again." && takeNotice() === null);
e = env("http://localhost/login", {}, {}); w = await boot(e); await w.fetch("/api/auth/login", { method: "POST" }); await w.fetch("/api/campaigns");
check("no redirect loop: nothing happens when already on /login", env.replaced.length === 0);
env.next = () => json(401, { message: "Wrong email or password" });
e = env("http://localhost/login"); w = await boot(e); await w.fetch("/api/auth/login", { method: "POST" });
check("a normal failed login (401 without SESSION_EXPIRED) does not redirect or show the notice", env.replaced.length === 0);
env.next = () => json(403, { message: "Forbidden" });
e = env("http://localhost/x", {}, { tok: JWT }); w = await boot(e); await w.fetch("/api/clients");
check("403 (role) does not log the user out", env.replaced.length === 0 && w.sessionStorage.getItem("tok") === JWT);

console.log("\n== Heartbeat ==");
env.next = () => json(200, { ok: true });
e = env("http://localhost/x", {}, { tok: JWT }); w = await boot(e);
w.dispatchEvent(new w.Event("pointerdown")); await w.__lmxGuardPing();
const p = e.calls.find(([u]) => u.includes("/session/ping"));
check("heartbeat posts {active:true} with the bearer token after a real interaction", p && JSON.parse(p[1].body).active === true && p[1].headers.Authorization === `Bearer ${JWT}`);
await w.__lmxGuardPing();
check("without interaction the next heartbeat reports {active:false}", JSON.parse(e.calls.filter(([u]) => u.includes("/session/ping")).pop()[1].body).active === false);
e = env("http://localhost/login"); w = await boot(e); await w.__lmxGuardPing();
check("no token (logged out / new tab) -> no pings", e.calls.length === 0);
env.next = () => json(401, { code: "SESSION_EXPIRED", reason: "TAB_CLOSED" });
e = env("http://localhost/x", {}, { tok: JWT }); w = await boot(e); await w.__lmxGuardPing();
check("heartbeat that discovers a dead session sends the user to /login", env.replaced[0] === "/login");

const { pass, fail, failures } = t.summary(); console.log(`\n${pass} passed, ${fail} failed`); if (fail) { console.log("FAIL:", failures.join(" | ")); process.exit(1); } process.exit(0);
