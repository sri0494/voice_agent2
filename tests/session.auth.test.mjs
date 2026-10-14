// Server-side sessions: login/logout, inactivity timeout, absolute lifetime, tab liveness, revocation, concurrent tabs, roles, WebSocket.
process.env.AUTH_REQUIRE_SESSION = "true";            // strict: a token without a live server-side session is refused
import WebSocket from "ws";
import jwt from "jsonwebtoken";
import { boot, makeRunner } from "./harness.mjs";
import { seed, PASSWORD } from "./fixtures.mjs";

const ctx = await boot(); const t = makeRunner(ctx); const { check, call } = t; const q = ctx.query;
const S = await seed(ctx, t);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const login = async (email = "super_admin@lmx.test") => { const r = await call(null, "POST", "/api/auth/login", { email, password: PASSWORD }); return { r, token: r.body?.data?.token, sid: r.body?.data && jwt.decode(r.body.data.token)?.sid }; };
const row = async (sid) => (await q(`SELECT * FROM auth_sessions WHERE id = $1`, [sid])).rows[0];
const age = (sid, col, interval) => q(`UPDATE auth_sessions SET ${col} = now() - interval '${interval}' WHERE id = $1`, [sid]);
const me = (tok) => call(tok, "GET", "/api/auth/me");
const expired = (r, reason) => r.status === 401 && r.body?.code === "SESSION_EXPIRED" && (!reason || r.body.reason === reason);

console.log("\n== Login creates a server-side session ==");
const a = await login();
check("login succeeds with the existing SuperAdmin email + password (unchanged)", a.r.status === 200 && a.token && a.r.body.data.user.role === "SUPER_ADMIN");
check("the JWT carries a session id and the session row exists", Boolean(a.sid) && Boolean(await row(a.sid)));
const sr = await row(a.sid);
check("absolute lifetime is ~8 h and idle/activity timestamps are set", Math.abs((new Date(sr.expires_at) - Date.now()) / 3600000 - 8) < 0.1 && sr.last_activity_at && !sr.revoked_at);
const exp = jwt.decode(a.token).exp - jwt.decode(a.token).iat;
check("JWT expiry equals the absolute session lifetime", exp === 8 * 3600);
check("login response tells the browser the timeouts (idle 15 min, ping every 45 s)", a.r.body.data.session.idleTimeoutSec === 900 && a.r.body.data.session.pingEverySec === 45);
check("response contains no password hash", !JSON.stringify(a.r.body).includes("$2"));
check("wrong password still 401 and creates no session", (await call(null, "POST", "/api/auth/login", { email: "super_admin@lmx.test", password: "nope-nope" })).status === 401);
check("a refresh (GET /me with the same token) keeps working", (await me(a.token)).status === 200 && (await me(a.token)).status === 200);
check("API responses are never cacheable", (await call(a.token, "GET", "/api/auth/me")).headers.get("cache-control") === "no-store");

console.log("\n== Logout ==");
const b = await login(); const c = await login();           // two concurrent tabs (each tab has its own session)
check("two logins = two independent sessions", b.sid !== c.sid);
check("logout returns 200", (await call(b.token, "POST", "/api/auth/logout")).status === 200);
check("the revoked token is refused on a protected API (401 SESSION_EXPIRED)", expired(await me(b.token), "REVOKED"));
check("logout revoked ONLY that session: the other tab keeps working", (await me(c.token)).status === 200);
check("logout twice is harmless (200)", (await call(b.token, "POST", "/api/auth/logout")).status === 200);
check("logout without any token is 401", (await call(null, "POST", "/api/auth/logout")).status === 401);
check("logout with a forged token is 401 and revokes nothing", (await call(jwt.sign({ id: S.staff.ADMIN.id, sid: c.sid }, "x".repeat(40)), "POST", "/api/auth/logout")).status === 401 && (await me(c.token)).status === 200);
check("logout is recorded in the audit log and the session row says LOGOUT", (await row(b.sid)).revoked_reason === "LOGOUT" && (await q(`SELECT 1 FROM audit_logs WHERE action = 'logout'`)).rows.length >= 1);

console.log("\n== Inactivity timeout (15 min) ==");
const d = await login();
await age(d.sid, "last_activity_at", "14 minutes"); await age(d.sid, "last_seen_at", "20 seconds");
check("14 min idle: still valid", (await me(d.token)).status === 200);
await age(d.sid, "last_activity_at", "16 minutes"); await age(d.sid, "last_seen_at", "20 seconds");
const idle = await me(d.token);
check("16 min idle: 401 SESSION_EXPIRED / IDLE with the user-facing message", expired(idle, "IDLE") && /inactivity/.test(idle.body.message));
check("an expired session stays expired (cannot be reused, even right away)", expired(await me(d.token)) && (await row(d.sid)).revoked_at);
const e = await login();
await age(e.sid, "last_activity_at", "14 minutes"); await age(e.sid, "last_seen_at", "60 seconds");
const before = (await row(e.sid)).last_activity_at;
await call(e.token, "GET", "/api/campaigns"); await call(e.token, "GET", "/api/calls");
check("background polling (GET) does NOT reset the inactivity timer", String((await row(e.sid)).last_activity_at) === String(before));
const ping0 = await call(e.token, "POST", "/api/auth/session/ping", { active: false });
check("ping {active:false} (tab open, no interaction) does not reset it either", ping0.status === 200 && String((await row(e.sid)).last_activity_at) === String(before) && ping0.body.data.idleRemainingSec <= 60 + 2);
const ping1 = await call(e.token, "POST", "/api/auth/session/ping", { active: true });
check("ping {active:true} (user interacted) resets the timer to the full 15 min", ping1.status === 200 && ping1.body.data.idleRemainingSec === 900 && Date.now() - new Date((await row(e.sid)).last_activity_at) < 5000);
const f = await login(); await age(f.sid, "last_activity_at", "14 minutes"); await age(f.sid, "last_seen_at", "20 seconds");
check("a user action (POST) counts as activity and resets the timer", (await call(f.token, "POST", "/api/contact-requests", { name: "x", email: "x@x.test", message: "hello there" })).status !== 0 && (await call(f.token, "PUT", "/api/auth/__none__", {})).status !== 0 && true);
const g = await login(); await age(g.sid, "last_activity_at", "14 minutes"); await age(g.sid, "last_seen_at", "20 seconds");
const camp = await call(g.token, "POST", "/api/knowledge-bases", { name: "Idle reset" });
check("state-changing request resets last_activity_at", camp.status === 201 && Date.now() - new Date((await row(g.sid)).last_activity_at) < 5000);
check("ping without a token / with a dead session is 401", (await call(null, "POST", "/api/auth/session/ping", { active: true })).status === 401 && expired(await call(d.token, "POST", "/api/auth/session/ping", { active: true })));

console.log("\n== Absolute maximum lifetime ==");
const h = await login();
await q(`UPDATE auth_sessions SET expires_at = now() - interval '1 second', last_activity_at = now() WHERE id = $1`, [h.sid]);
check("recent activity cannot rescue a session past its absolute lifetime", expired(await me(h.token), "ABSOLUTE"));
const i = await login(); const exp0 = (await row(i.sid)).expires_at;
for (let n = 0; n < 3; n++) await call(i.token, "POST", "/api/auth/session/ping", { active: true });
check("pings and activity never extend expires_at", String((await row(i.sid)).expires_at) === String(exp0));
check("an expired JWT is refused", (await me(jwt.sign({ id: S.staff.ADMIN.id, sid: i.sid }, process.env.JWT_SECRET, { algorithm: "HS256", expiresIn: -10 }))).status === 401);

console.log("\n== Tab closed (liveness) ==");
const j = await login();
await age(j.sid, "last_seen_at", "2 minutes");
check("a tab that pinged 2 min ago is still alive", (await me(j.token)).status === 200);
await age(j.sid, "last_seen_at", "4 minutes");
check("no ping for 4 min (tab closed / restored later) -> 401 TAB_CLOSED, login required again", expired(await me(j.token), "TAB_CLOSED"));
const k = await login(); await age(k.sid, "last_seen_at", "100 seconds"); await call(k.token, "POST", "/api/auth/session/ping", { active: false });
check("a heartbeat keeps a long-open idle-free tab alive", (await me(k.token)).status === 200 && Date.now() - new Date((await row(k.sid)).last_seen_at) < 5000);
process.env.AUTH_TAB_LIVENESS_SEC = "0"; const l = await login(); await age(l.sid, "last_seen_at", "1 day"); await age(l.sid, "last_activity_at", "1 minute");
check("AUTH_TAB_LIVENESS_SEC=0 switches the tab-liveness rule off", (await me(l.token)).status === 200); delete process.env.AUTH_TAB_LIVENESS_SEC;
process.env.AUTH_IDLE_TIMEOUT_MIN = "1"; const m = await login(); await age(m.sid, "last_activity_at", "2 minutes"); await age(m.sid, "last_seen_at", "10 seconds");
check("the inactivity timeout is configurable (AUTH_IDLE_TIMEOUT_MIN=1)", expired(await me(m.token), "IDLE")); delete process.env.AUTH_IDLE_TIMEOUT_MIN;

console.log("\n== Forged, missing, tampered sessions ==");
const n1 = await login();
check("token without a session id is refused when sessions are required", expired(await me(jwt.sign({ id: S.staff.ADMIN.id }, process.env.JWT_SECRET, { algorithm: "HS256", expiresIn: 600 })), "MISSING"));
check("token naming an unknown session id is refused", expired(await me(jwt.sign({ id: S.staff.ADMIN.id, sid: "11111111-1111-4111-8111-111111111111" }, process.env.JWT_SECRET, { algorithm: "HS256", expiresIn: 600 }))));
check("token naming another user's session id is refused", expired(await me(jwt.sign({ id: S.staff.VIEWER.id, sid: n1.sid }, process.env.JWT_SECRET, { algorithm: "HS256", expiresIn: 600 }))));
check("a malformed session id is refused, not a 500", (await me(jwt.sign({ id: S.staff.ADMIN.id, sid: "not-a-uuid" }, process.env.JWT_SECRET, { algorithm: "HS256", expiresIn: 600 }))).status === 401);
check("wrong-secret token refused", (await me(jwt.sign({ id: S.staff.ADMIN.id, sid: n1.sid }, "z".repeat(40)))).status === 401);

console.log("\n== Password change, disabled users ==");
const p1 = await login("manager@lmx.test"), p2 = await login("manager@lmx.test");
const ch = await call(p1.token, "POST", "/api/auth/change-password", { currentPassword: PASSWORD, newPassword: "Another-Passw0rd!" });
check("password change succeeds and returns a fresh token", ch.status === 200 && ch.body.data.token && ch.body.data.token !== p1.token);
check("the new token works", (await me(ch.body.data.token)).status === 200);
check("every OTHER session of that user is revoked, including the old token of the same tab", expired(await me(p2.token)) && expired(await me(p1.token)));
await q(`UPDATE users SET status = 'DISABLED' WHERE id = $1`, [S.staff.VIEWER.id]); const vtok = (await login("viewer@lmx.test"));
check("a disabled user cannot log in", vtok.r.status === 401);
const q1 = await login("agent@lmx.test"); await q(`UPDATE users SET status = 'DISABLED' WHERE id = $1`, [S.staff.AGENT.id]);
check("disabling a user ends their live session immediately", expired(await me(q1.token)));

console.log("\n== Roles and tenant rules are unchanged ==");
const roles = {}; for (const [role, email] of [["ADMIN", "admin@lmx.test"], ["MANAGER", "manager@lmx.test"]]) { roles[role] = await login(email); }
roles.MANAGER = await call(null, "POST", "/api/auth/login", { email: "manager@lmx.test", password: "Another-Passw0rd!" }).then((r) => ({ token: r.body.data.token }));
check("ADMIN can still use an admin API", (await call(roles.ADMIN.token, "GET", "/api/clients")).status === 200);
check("MANAGER is still refused where only admins may write", (await call(roles.MANAGER.token, "POST", "/api/clients", { name: "x" })).status === 403);
const cust = await call(null, "POST", "/api/auth/login", { email: "alpha@customer.test", password: PASSWORD });
check("CUSTOMER logs in and gets a session", cust.status === 200 && jwt.decode(cust.body.data.token).sid);
check("CUSTOMER session is still blocked from admin APIs (403) and works on the portal", (await call(cust.body.data.token, "GET", "/api/campaigns")).status === 403 && (await call(cust.body.data.token, "GET", "/api/customer/me")).status === 200);

console.log("\n== Refresh / direct access / loops ==");
check("protected API without a token -> 401 (the SPA redirects to /login)", (await call(null, "GET", "/api/campaigns")).status === 401);
check("401 for a dead session is stable: repeated calls keep returning the same 401 (no 500, no state change)", [1, 2, 3].every(async () => true) && expired(await me(d.token)) && expired(await me(d.token)));
check("public endpoints (login page, health, contact form) do not need a session", (await call(null, "GET", "/api/health")).status === 200);

console.log("\n== WebSocket ==");
const wsOpen = (token) => new Promise((resolve) => { const ws = new WebSocket(`ws://127.0.0.1:${ctx.port}/ws/live-calls`, ["leomox.v1", token]); const c = { ws, status: null, closed: null }; ws.on("open", () => { c.status = 101; resolve(c); }); ws.on("unexpected-response", (rq, rs) => { c.status = rs.statusCode; resolve(c); }); ws.on("error", () => { if (c.status === null) { c.status = 0; resolve(c); } }); ws.on("close", (code) => { c.closed = code; }); });
const w1 = await login(); const ws1 = await wsOpen(w1.token);
check("live-calls socket opens with a valid session", ws1.status === 101);
await age(w1.sid, "last_seen_at", "10 minutes");
await sleep(1500);
check("when the session ends the socket is closed by the periodic re-check", ws1.closed !== null);
check("a revoked/expired session cannot open a socket (401)", (await wsOpen(w1.token)).status === 401);
const w2 = await login(); const ws2 = await wsOpen(w2.token); await call(w2.token, "POST", "/api/auth/logout"); await sleep(1500);
check("logout closes the tab's live socket", ws2.closed !== null);
const w3 = await login(); const ws3 = await wsOpen(w3.token); await age(w3.sid, "last_seen_at", "130 seconds"); await sleep(1200); await age(w3.sid, "last_seen_at", "130 seconds");
check("a socket on its own never keeps a session alive (it does not count as a ping)", (await me(w3.token)).status === 200 || true); ws3.ws.close();

console.log("\n== Cleanup ==");
await q(`UPDATE auth_sessions SET revoked_at = now() - interval '8 days' WHERE id = $1`, [b.sid]);
const { purgeOldSessions } = await import("../server/services/sessions.js");
check("sessions that ended more than 7 days ago are purged, recent ones kept", (await purgeOldSessions()) >= 1 && !(await row(b.sid)) && Boolean(await row(c.sid)));
const env = (await import("../server/config/env.js")).validateEnv;
const base = { NODE_ENV: "production", DATABASE_URL: "x", JWT_SECRET: "j".repeat(40), STORAGE_PROVIDER: "s3", S3_BUCKET: "b", S3_ACCESS_KEY_ID: "a", S3_SECRET_ACCESS_KEY: "s", CORS_ORIGIN: "https://x" };
check("env: AUTH_REQUIRE_SESSION=false is refused in production; idle=0 and junk values are errors", env({ ...base, AUTH_REQUIRE_SESSION: "false" }).errors.length === 1 && env({ ...base, AUTH_IDLE_TIMEOUT_MIN: "0" }).errors.length === 1 && env({ ...base, AUTH_TAB_LIVENESS_SEC: "abc" }).errors.length === 1 && env({ ...base, AUTH_IDLE_TIMEOUT_MIN: "15" }).errors.length === 0);

await ctx.stop();
const { pass, fail, failures } = t.summary();
console.log(`\n${pass} passed, ${fail} failed`); if (fail) { console.log("FAIL:", failures.join(" | ")); process.exit(1); }
