// Live Calls WebSocket: authenticated at upgrade, tenant-scoped per message, sessions expire.
import WebSocket from "ws";
import { boot, makeRunner } from "./harness.mjs";
import { seed, PASSWORD, ALL_PERMS } from "./fixtures.mjs";

const ctx = await boot(); const t = makeRunner(ctx); const { check, call } = t;
const S = await seed(ctx, t); const q = ctx.query; const A = S.CA.token, B = S.CB.token, ADMIN = S.admin;
const { publishCallUpdate, liveClientCount } = await import("../server/services/liveCalls.js");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// connect() resolves { ws, status, messages[], closed:{code}|null }
function connect(token, { via = "protocol", path = "/ws/live-calls" } = {}) {
  return new Promise((resolve) => {
    const url = `ws://127.0.0.1:${ctx.port}${path}${via === "query" && token ? `?token=${token}` : ""}`;
    const ws = new WebSocket(url, via === "protocol" && token ? ["leomox.v1", token] : []);
    const c = { ws, status: null, messages: [], closed: null };
    ws.on("open", () => { c.status = 101; resolve(c); });
    ws.on("unexpected-response", (req, res) => { c.status = res.statusCode; resolve(c); });
    ws.on("error", () => { if (c.status === null) { c.status = 0; resolve(c); } });
    ws.on("message", (m) => c.messages.push(JSON.parse(m.toString())));
    ws.on("close", (code) => { c.closed = { code }; });
  });
}
const updates = (c) => c.messages.filter((m) => m.type === "call_update");

console.log("\n== Upgrade authentication ==");
check("no token -> refused 401", (await connect(null)).status === 401);
check("garbage token -> refused 401", (await connect("garbage")).status === 401);
check("expired token -> refused 401", (await connect(S.jwtFor(S.staff.ADMIN.id, {}, { expiresIn: -5 }))).status === 401);
check("wrong-secret token -> refused 401", (await connect((await import("jsonwebtoken")).default.sign({ id: S.staff.ADMIN.id }, "x".repeat(40)))).status === 401);
check("a path other than /ws/live-calls is dropped", (await connect(ADMIN, { path: "/ws/other" })).status === 0);
const staff = await connect(ADMIN);
check("staff connects with a Sec-WebSocket-Protocol token (token not in the URL)", staff.status === 101 && staff.ws.protocol === "leomox.v1");
const ca = await connect(A), cb = await connect(B);
check("customers with calls_view connect", ca.status === 101 && cb.status === 101);
await call(ADMIN, "PUT", `/api/clients/${S.CB.client.id}/permissions`, { permissions: ALL_PERMS.filter((p) => p !== "calls_view") });
check("customer WITHOUT calls_view is refused (403)", (await connect(B)).status === 403);
await call(ADMIN, "PUT", `/api/clients/${S.CB.client.id}/permissions`, { permissions: ALL_PERMS });
process.env.WS_ALLOW_QUERY_TOKEN = "false";
check("?token= can be disabled (WS_ALLOW_QUERY_TOKEN=false)", (await connect(ADMIN, { via: "query" })).status === 401);
delete process.env.WS_ALLOW_QUERY_TOKEN;
const viaQ = await connect(ADMIN, { via: "query" }); check("?token= fallback works when allowed", viaQ.status === 101); viaQ.ws.close();
check("server tracks the open sockets", liveClientCount() >= 3);

console.log("\n== Tenant-scoped events ==");
await sleep(150);
const ids = { a: S.callA1, b: S.callB1, orphan: S.callU };
await publishCallUpdate(ids.a); await sleep(250);
check("call of Customer A -> staff and A receive it", updates(staff).some((m) => m.call.id === ids.a) && updates(ca).some((m) => m.call.id === ids.a));
check("call of Customer A -> Customer B receives NOTHING", updates(cb).length === 0);
await publishCallUpdate(ids.b); await sleep(250);
check("call of Customer B -> B and staff receive it", updates(cb).some((m) => m.call.id === ids.b) && updates(staff).some((m) => m.call.id === ids.b));
check("call of Customer B -> Customer A never receives it", !updates(ca).some((m) => m.call.id === ids.b) && updates(ca).length === 1);
await publishCallUpdate(ids.orphan); await sleep(250);
check("call of NO customer (unassigned campaign) -> staff only", updates(staff).some((m) => m.call.id === ids.orphan) && !updates(ca).some((m) => m.call.id === ids.orphan) && !updates(cb).some((m) => m.call.id === ids.orphan));
const msg = updates(ca)[0].call;
check("customer payload: phone masked, no provider id / client id / agent id / transcript", msg.phone === "98*****210" && !("provider_call_id" in msg) && !("client_id" in msg) && !("agent_id" in msg) && !JSON.stringify(msg).includes("9876543210"));
check("staff payload carries the unmasked phone (existing Live Calls UI keeps working)", updates(staff).find((m) => m.call.id === ids.a).call.phone === "9876543210");
// real flow: a provider status webhook publishes to the right tenant only
const live = (await q(`INSERT INTO calls (campaign_id, agent_id, phone, status, provider_call_id) VALUES ($1,$2,'9876543210','Ringing','CAlive1') RETURNING id`, [S.campA1, S.agentA])).rows[0].id;
const nA = updates(ca).length, nB = updates(cb).length;
await call(null, "POST", "/api/telephony/status", { providerCallId: "CAlive1", status: "Completed", durationSec: 30 }); await sleep(300);
check("status webhook -> A and staff get the update; B gets nothing", updates(ca).length === nA + 1 && updates(ca).at(-1).call.status === "Completed" && updates(cb).length === nB);
check("no messages for a non-existent call", await (async () => { const n = updates(staff).length; await publishCallUpdate("00000000-0000-4000-8000-000000000000"); await sleep(150); return updates(staff).length === n; })());

console.log("\n== Session lifetime ==");
const shortTok = S.jwtFor(S.staff.MANAGER.id, {}, { expiresIn: 2 });
const short = await connect(shortTok); await sleep(3200);
check("expired JWT: server closes the socket (4401)", short.status === 101 && short.closed?.code === 4401, JSON.stringify(short.closed));
const tmp = (await q(`INSERT INTO users (name,email,password_hash,role,status) VALUES ('T','wst@lmx.test',(SELECT password_hash FROM users LIMIT 1),'AGENT','ACTIVE') RETURNING id`)).rows[0].id;
const tmpSock = await connect(S.jwtFor(tmp));
await call(ADMIN, "POST", `/api/users/${tmp}/disable`); await sleep(1000);
check("disabled user: socket closed within one revalidation cycle", tmpSock.status === 101 && tmpSock.closed?.code === 4401, JSON.stringify(tmpSock.closed));
check("closed socket stops receiving events", await (async () => { const n = tmpSock.messages.length; await publishCallUpdate(ids.a); await sleep(150); return tmpSock.messages.length === n; })());
const cbLive = await connect(B);
await call(ADMIN, "PUT", `/api/clients/${S.CB.client.id}`, { status: "Inactive" }); await sleep(1000);
check("deactivated customer account: socket closed", cbLive.closed?.code === 4401, JSON.stringify(cbLive.closed));
await call(ADMIN, "PUT", `/api/clients/${S.CB.client.id}`, { status: "Active" });
const caLive = await connect(A);
await call(ADMIN, "PUT", `/api/clients/${S.CA.client.id}/permissions`, { permissions: ALL_PERMS.filter((p) => p !== "calls_view") }); await sleep(1000);
check("calls_view removed while connected: socket closed (4403)", caLive.closed?.code === 4403, JSON.stringify(caLive.closed));
await call(ADMIN, "PUT", `/api/clients/${S.CA.client.id}/permissions`, { permissions: ALL_PERMS });
const pwUser = (await q(`INSERT INTO users (name,email,password_hash,role,status) VALUES ('P','wsp@lmx.test',(SELECT password_hash FROM users WHERE email='admin@lmx.test'),'AGENT','ACTIVE') RETURNING id`)).rows[0].id;
const pwTok = (await call(null, "POST", "/api/auth/login", { email: "wsp@lmx.test", password: PASSWORD })).body.data.token; const pwSock = await connect(pwTok);
await sleep(1100); await call(ADMIN, "POST", `/api/users/${pwUser}/reset-password`, { newPassword: "Another1234x!" }); await sleep(1000);
check("password reset: the user's open socket is closed", pwSock.closed?.code === 4401, JSON.stringify(pwSock.closed));
const per = await connect(S.jwtFor(S.staff.VIEWER.id));
check("a read-only VIEWER may watch live calls", per.status === 101);
for (const c of [staff, ca, cb, per]) c.ws.terminate();
await ctx.stop();
const s = t.summary(); console.log(`\n${s.pass} passed, ${s.fail} failed`); if (s.fail) console.log(s.failures); process.exit(s.fail ? 1 : 0);
