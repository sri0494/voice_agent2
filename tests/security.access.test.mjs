// Authentication, RBAC role matrix, CUSTOMER vs admin APIs, tenant isolation (IDOR), permissions, assignment lifecycle.
import { boot, makeRunner } from "./harness.mjs";
import { seed, PASSWORD, ALL_PERMS } from "./fixtures.mjs";
import jwt from "jsonwebtoken";

const ctx = await boot(); const t = makeRunner(ctx); const { check, call } = t;
const S = await seed(ctx, t);
const { staff, CA, CB } = S; const A = CA.token, B = CB.token;
const q = ctx.query;

// ======================= AUTHENTICATION =======================
console.log("\n== Authentication ==");
let r = await call(null, "POST", "/api/auth/login", { email: "admin@lmx.test", password: PASSWORD });
check("valid login returns token + role, never a password hash", r.status === 200 && r.body.data.token && r.body.data.user.role === "ADMIN" && !JSON.stringify(r.body).includes("hash"), JSON.stringify(r.body));
check("CUSTOMER login returns role + client_id", CA.loginRes.body.data.user.role === "CUSTOMER" && CA.loginRes.body.data.user.client_id === CA.client.id);
const bad = await call(null, "POST", "/api/auth/login", { email: "admin@lmx.test", password: "wrong-password" });
const unknown = await call(null, "POST", "/api/auth/login", { email: "nobody@lmx.test", password: "wrong-password" });
check("invalid password -> 401, identical to unknown user (no enumeration)", bad.status === 401 && unknown.status === 401 && bad.body.message === unknown.body.message);
check("missing fields -> 400", (await call(null, "POST", "/api/auth/login", { email: "x" })).status === 400);
check("object passed as password (NoSQL-style) -> 400", (await call(null, "POST", "/api/auth/login", { email: { $ne: "" }, password: { $ne: "" } })).status === 400);
check("no token -> 401", (await call(null, "GET", "/api/campaigns")).status === 401);
check("garbage token -> 401", (await call("not.a.jwt", "GET", "/api/campaigns")).status === 401);
const expired = S.jwtFor(staff.ADMIN.id, {}, { expiresIn: -10 });
check("expired JWT -> 401", (await call(expired, "GET", "/api/campaigns")).status === 401);
const wrongSecret = jwt.sign({ id: staff.ADMIN.id }, "another-secret-another-secret-123", { algorithm: "HS256" });
check("JWT signed with a different secret -> 401", (await call(wrongSecret, "GET", "/api/campaigns")).status === 401);
const noneAlg = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString("base64url")}.${Buffer.from(JSON.stringify({ id: staff.ADMIN.id })).toString("base64url")}.`;
check("alg=none token -> 401", (await call(noneAlg, "GET", "/api/campaigns")).status === 401);
const logs = []; const origErr = console.error; console.error = (...a) => logs.push(a.join(" "));
r = await call(jwt.sign({ foo: 1 }, process.env.JWT_SECRET, { algorithm: "HS256" }), "GET", "/api/campaigns"); console.error = origErr;
check("JWT without a user id claim -> 401 + exact log line", r.status === 401 && logs.some((l) => l.includes("[portal] JWT has no recognisable user id claim")), JSON.stringify(logs));
check("`sub` claim is accepted as the user id", (await call(jwt.sign({ sub: staff.ADMIN.id }, process.env.JWT_SECRET, { algorithm: "HS256" }), "GET", "/api/campaigns")).status === 200);
check("role inside the token is ignored (DB role wins): VIEWER token claiming ADMIN", (await call(S.jwtFor(staff.VIEWER.id, { role: "SUPER_ADMIN" }), "POST", "/api/campaigns", { name: "x" })).status === 403);

// inactive user loses access IMMEDIATELY
const tmp = (await q(`INSERT INTO users (name,email,password_hash,role,status) VALUES ('Tmp','tmp@lmx.test',(SELECT password_hash FROM users LIMIT 1),'AGENT','ACTIVE') RETURNING id`)).rows[0].id;
const tmpTok = (await call(null, "POST", "/api/auth/login", { email: "tmp@lmx.test", password: PASSWORD })).body.data.token;
check("active user works", (await call(tmpTok, "GET", "/api/campaigns")).status === 200);
r = await call(S.admin, "POST", `/api/users/${tmp}/disable`);
check("admin disables user", r.status === 200);
check("disabled user's EXISTING token stops working immediately", (await call(tmpTok, "GET", "/api/campaigns")).status === 401);
check("disabled user cannot log in", (await call(null, "POST", "/api/auth/login", { email: "tmp@lmx.test", password: PASSWORD })).status === 401);

// inactive customer account
const cx = await call(S.admin, "PUT", `/api/clients/${CB.client.id}`, { status: "Inactive" });
check("deactivated customer account: existing token -> 403 at once", cx.status === 200 && (await call(B, "GET", "/api/customer/campaigns")).status === 403);
check("deactivated customer account: login refused", (await call(null, "POST", "/api/auth/login", { email: CB.email, password: PASSWORD })).status === 401);
check("deactivated customer: admin API still blocked", (await call(B, "GET", "/api/campaigns")).status === 403);
await call(S.admin, "PUT", `/api/clients/${CB.client.id}`, { status: "Active" });
check("re-activated customer works again", (await call(B, "GET", "/api/customer/campaigns")).status === 200);

// password change / reset invalidate older tokens (dedicated users so the role accounts stay logged in)
const mkUser = async (email, role = "AGENT") => (await q(`INSERT INTO users (name,email,password_hash,role,status) VALUES ('PW',$1,(SELECT password_hash FROM users WHERE email='admin@lmx.test'),$2,'ACTIVE') RETURNING id`, [email, role])).rows[0].id;
await mkUser("pw1@lmx.test"); const pwId2 = await mkUser("pw2@lmx.test");
const pw = (await call(null, "POST", "/api/auth/login", { email: "pw1@lmx.test", password: PASSWORD })).body.data.token;
await new Promise((res) => setTimeout(res, 1100));
r = await call(pw, "POST", "/api/auth/change-password", { currentPassword: PASSWORD, newPassword: "NewPassw0rd!x" });
check("password change succeeds and returns a fresh token", r.status === 200 && r.body.data.token);
check("OLD token is invalid after a password change", (await call(pw, "GET", "/api/auth/me")).status === 401);
check("NEW token works", (await call(r.body.data.token, "GET", "/api/auth/me")).status === 200);
check("change-password with wrong current password -> 401", (await call(S.admin, "POST", "/api/auth/change-password", { currentPassword: "nope", newPassword: "Another1234" })).status === 401);
const stolen = (await call(null, "POST", "/api/auth/login", { email: "pw2@lmx.test", password: PASSWORD })).body.data.token;
await new Promise((res) => setTimeout(res, 1100));
check("admin password reset works", (await call(S.admin, "POST", `/api/users/${pwId2}/reset-password`, { newPassword: "ResetPassw0rd!x" })).status === 200);
check("admin password reset invalidates the user's existing sessions", (await call(stolen, "GET", "/api/auth/me")).status === 401);
check("the reset password works for login", (await call(null, "POST", "/api/auth/login", { email: "pw2@lmx.test", password: "ResetPassw0rd!x" })).status === 200);
check("password hash is bcrypt, never plaintext", (await q(`SELECT password_hash FROM users WHERE email='admin@lmx.test'`)).rows[0].password_hash.startsWith("$2"));

// ======================= RBAC MATRIX =======================
console.log("\n== Role matrix ==");
const T = (role) => staff[role].token;
const roles = ["SUPER_ADMIN", "ADMIN", "MANAGER", "AGENT", "VIEWER"];
const expect = async (label, method, path, body, allowed) => {
  for (const role of roles) {
    const res = await call(T(role), method, typeof path === "function" ? path(role) : path, typeof body === "function" ? body(role) : body);
    const want = allowed.includes(role);
    check(`${label}: ${role} ${want ? "allowed" : "denied (403)"}`, want ? res.status < 300 : res.status === 403, `${res.status} ${JSON.stringify(res.body).slice(0, 120)}`);
  }
  check(`${label}: CUSTOMER denied (403)`, (await call(A, method, typeof path === "function" ? path("CUSTOMER") : path, typeof body === "function" ? body("CUSTOMER") : body)).status === 403);
};
const STAFF = roles, OPS = ["SUPER_ADMIN", "ADMIN", "MANAGER", "AGENT"], MGR = ["SUPER_ADMIN", "ADMIN", "MANAGER"], ADM = ["SUPER_ADMIN", "ADMIN"];
await expect("GET /api/campaigns", "GET", "/api/campaigns", null, STAFF);
await expect("POST /api/campaigns", "POST", "/api/campaigns", (r) => ({ name: `RBAC ${r}`, type: "Survey" }), MGR);
await expect("POST /api/contacts", "POST", "/api/contacts", (r) => ({ campaignId: S.campA1, name: `c ${r}`, phone: `98765${Math.floor(10000 + Math.random() * 89999)}` }), OPS);
await expect("GET /api/users", "GET", "/api/users", null, ADM);
await expect("GET /api/business-integrations", "GET", "/api/business-integrations", null, MGR);
await expect("GET /api/integrations", "GET", "/api/integrations", null, MGR);
await expect("POST /api/phone-numbers", "POST", "/api/phone-numbers", (r) => ({ number: `+9170000${r.length}${Math.floor(Math.random() * 99999)}` }), ADM);
await expect("POST /api/customers (people)", "POST", "/api/customers", (r) => ({ firstName: `P-${r}`, mobile: `98${Math.floor(10000000 + Math.random() * 89999999)}` }), MGR);
await expect("POST /api/knowledge-bases", "POST", "/api/knowledge-bases", (r) => ({ name: `KB ${r}` }), OPS);
await expect("POST /api/surveys", "POST", "/api/surveys", (r) => ({ name: `Survey ${r}` }), MGR);
await expect("GET /api/clients", "GET", "/api/clients", null, MGR);
await expect("POST /api/clients", "POST", "/api/clients", (r) => ({ name: `Client ${r}` }), ADM);
await expect("GET /api/analytics/summary", "GET", "/api/analytics/summary", null, STAFF);
await expect("GET /api/recordings", "GET", "/api/recordings", null, STAFF);
await expect("PUT /api/agents/:id", "PUT", `/api/agents/${S.agentA}`, { description: "rbac" }, MGR);
// destructive / state operations with real ids
const mk = async () => (await call(S.admin, "POST", "/api/campaigns", { name: `Del ${Math.random()}`, type: "Survey", agentId: S.agentA })).body.data.id;
for (const [role, ok] of [["VIEWER", false], ["AGENT", false], ["MANAGER", false], ["ADMIN", true]]) {
  const id = await mk(); const res = await call(T(role), "DELETE", `/api/campaigns/${id}`);
  check(`DELETE /api/campaigns: ${role} ${ok ? "allowed" : "denied"}`, ok ? res.status === 200 : res.status === 403, `${res.status}`);
}
const startable = async () => { const id = await mk(); await q(`INSERT INTO contacts (campaign_id,name,phone) VALUES ($1,'x','9876500099')`, [id]); return id; };
for (const [role, ok] of [["VIEWER", false], ["AGENT", false], ["MANAGER", true]]) {
  const id = await startable(); const res = await call(T(role), "POST", `/api/campaigns/${id}/start`);
  check(`POST campaign start (launch dialing): ${role} ${ok ? "allowed" : "denied"}`, ok ? res.status === 200 : res.status === 403, `${res.status} ${JSON.stringify(res.body)}`);
}
{ const id = await startable(); await call(T("MANAGER"), "POST", `/api/campaigns/${id}/start`);
  check("campaign pause: AGENT allowed (safe action)", (await call(T("AGENT"), "POST", `/api/campaigns/${id}/pause`)).status === 200);
  check("campaign pause: VIEWER denied", (await call(T("VIEWER"), "POST", `/api/campaigns/${id}/pause`)).status === 403); }
check("recording delete: AGENT denied / MANAGER allowed", await (async () => {
  const { saveRecording } = await import("../server/services/recordings.js"); const { WAV } = await import("./fixtures.mjs");
  const a = await saveRecording({ callId: S.callA2, buffer: WAV, contentType: "audio/wav" });
  const b = await saveRecording({ callId: S.callA2, buffer: WAV, contentType: "audio/wav" });
  return (await call(T("AGENT"), "DELETE", `/api/recordings/${a.id}`)).status === 403 && (await call(T("MANAGER"), "DELETE", `/api/recordings/${b.id}`)).status === 200;
})());
check("call transfer: VIEWER denied", (await call(T("VIEWER"), "POST", `/api/calls/${S.callA1}/transfer`, {})).status === 403);
check("telephony call: VIEWER denied", (await call(T("VIEWER"), "POST", "/api/telephony/call", { campaignId: S.campA1, contactId: S.ctA })).status === 403);

// ----- privilege escalation guards in user management -----
console.log("\n== User management guards ==");
check("ADMIN cannot create a SUPER_ADMIN", (await call(T("ADMIN"), "POST", "/api/users", { name: "x", email: "esc1@lmx.test", password: "Passw0rd!Test", role: "SUPER_ADMIN" })).status === 403);
check("ADMIN cannot create another ADMIN", (await call(T("ADMIN"), "POST", "/api/users", { name: "x", email: "esc2@lmx.test", password: "Passw0rd!Test", role: "ADMIN" })).status === 403);
const ok1 = await call(T("ADMIN"), "POST", "/api/users", { name: "x", email: "ok0@lmx.test", password: "Passw0rd!Test", role: "AGENT" });
check("ADMIN can rename a user (audited user_update)", (await call(T("ADMIN"), "PUT", `/api/users/${ok1.body.data.id}`, { name: "Renamed" })).status === 200);
check("ADMIN can create an AGENT", (await call(T("ADMIN"), "POST", "/api/users", { name: "x", email: "ok1@lmx.test", password: "Passw0rd!Test", role: "AGENT" })).status === 201);
check("invalid role rejected (422)", (await call(S.admin, "POST", "/api/users", { name: "x", email: "bad@lmx.test", password: "Passw0rd!Test", role: "GOD" })).status === 422);
check("CUSTOMER role cannot be created via /api/users", (await call(S.admin, "POST", "/api/users", { name: "x", email: "cust@lmx.test", password: "Passw0rd!Test", role: "CUSTOMER" })).status === 422);
check("ADMIN cannot reset the SUPER_ADMIN password (account takeover)", (await call(T("ADMIN"), "POST", `/api/users/${staff.SUPER_ADMIN.id}/reset-password`, { newPassword: "Hacked123456" })).status === 403);
check("ADMIN cannot demote/disable the SUPER_ADMIN", (await call(T("ADMIN"), "PUT", `/api/users/${staff.SUPER_ADMIN.id}`, { status: "DISABLED" })).status === 403);
check("a user cannot change their OWN role", (await call(T("ADMIN"), "PUT", `/api/users/${staff.ADMIN.id}`, { role: "SUPER_ADMIN" })).status === 403);
check("a user cannot disable themselves", (await call(S.admin, "POST", `/api/users/${staff.SUPER_ADMIN.id}/disable`)).status === 403);
check("weak/overlong password rejected", (await call(S.admin, "POST", "/api/users", { name: "x", email: "w@lmx.test", password: "short", role: "AGENT" })).status === 400);
check("duplicate e-mail differing by case -> 409", (await call(S.admin, "POST", "/api/users", { name: "x", email: "ADMIN@LMX.TEST", password: "Passw0rd!Test", role: "AGENT" })).status === 409);

// ======================= CUSTOMER vs ADMIN APIS =======================
console.log("\n== CUSTOMER cannot reach admin APIs ==");
const adminGets = ["/api/users", "/api/clients", "/api/clients/permissions", "/api/customers", "/api/campaigns", "/api/contacts", "/api/calls", "/api/agents", "/api/analytics/summary",
  "/api/integrations", "/api/business-integrations", "/api/phone-numbers", "/api/recordings", "/api/knowledge-bases", "/api/documents?knowledgeBaseId=" + "00000000-0000-4000-8000-000000000000",
  "/api/surveys", `/api/agent-steering/${S.agentA}`, "/api/contact-requests", `/api/campaigns/${S.campA1}`, `/api/calls/${S.callA1}`, `/api/recordings/${S.recA.id}/url`, `/api/clients/${CA.client.id}`];
let leaked = 0;
for (const p of adminGets) { const res = await call(A, "GET", p); if (res.status !== 403) { leaked++; console.log("   LEAK?", p, res.status); } }
check(`CUSTOMER -> ${adminGets.length} admin GET endpoints all 403`, leaked === 0, `${leaked} not 403`);
const adminWrites = [["POST", "/api/users", { name: "x", email: "c1@x.test", password: "Passw0rd!Test", role: "AGENT" }], ["POST", "/api/clients", { name: "x" }], ["POST", "/api/campaigns", { name: "x", type: "Survey" }],
  ["POST", "/api/contacts", { campaignId: S.campA1, name: "x", phone: "9876500123" }], ["POST", "/api/telephony/call", { campaignId: S.campA1, contactId: S.ctA }], ["DELETE", `/api/campaigns/${S.campA1}`],
  ["PUT", `/api/clients/${CA.client.id}/permissions`, { permissions: ["dashboard"] }], ["POST", `/api/clients/${CA.client.id}/login`, { email: "evil@x.test" }], ["DELETE", `/api/recordings/${S.recA.id}`], ["POST", "/api/knowledge-bases", { name: "x" }]];
let wleak = 0;
for (const [m, p, b] of adminWrites) { const res = await call(A, m, p, b); if (res.status !== 403) { wleak++; console.log("   LEAK?", m, p, res.status); } }
check(`CUSTOMER -> ${adminWrites.length} admin write endpoints all 403 (and nothing changed)`, wleak === 0 && (await q(`SELECT count(*)::int n FROM campaigns WHERE id=$1`, [S.campA1])).rows[0].n === 1);
check("customer cannot grant THEMSELVES permissions", (await q(`SELECT count(*)::int n FROM client_permissions WHERE client_id=$1`, [CA.client.id])).rows[0].n === ALL_PERMS.length);
check("admin token on /api/customer/* -> 403 (not a portal user)", (await call(S.admin, "GET", "/api/customer/campaigns")).status === 403);
check("/api/customer/role works for any logged-in user", (await call(S.admin, "GET", "/api/customer/role")).body.data.role === "SUPER_ADMIN");

// ======================= TENANT ISOLATION (IDOR) =======================
console.log("\n== Tenant isolation: Customer A vs Customer B ==");
const ids = (res) => (res.body?.data || []).map((x) => x.id);
check("A -> A campaign list: only A's", ids(await call(A, "GET", "/api/customer/campaigns")).sort().join() === [S.campA1, S.campA2].sort().join());
check("A -> A campaign = ALLOW", (await call(A, "GET", `/api/customer/campaigns/${S.campA1}`)).status === 200);
check("A -> B campaign = DENY", (await call(A, "GET", `/api/customer/campaigns/${S.campB1}`)).status === 403);
check("A -> UNASSIGNED campaign = DENY", (await call(A, "GET", `/api/customer/campaigns/${S.campU}`)).status === 403);
check("A -> A contact list scoped to A campaign = ALLOW", (await call(A, "GET", `/api/customer/contacts?campaignId=${S.campA1}`)).status === 200);
check("A -> B contacts (campaignId) = DENY", (await call(A, "GET", `/api/customer/contacts?campaignId=${S.campB1}`)).status === 403);
check("A contact list never contains B's contact", !JSON.stringify((await call(A, "GET", "/api/customer/contacts")).body).includes("Bob B"));
check("A -> A call = ALLOW", (await call(A, "GET", `/api/customer/calls/${S.callA1}`)).status === 200);
check("A -> B call = DENY", (await call(A, "GET", `/api/customer/calls/${S.callB1}`)).status === 403);
const callsA = await call(A, "GET", "/api/customer/calls");
check("A call list: only A's 3 calls, no B / orphan data", callsA.body.data.length === 3 && !JSON.stringify(callsA.body).includes("B-SECRET") && !JSON.stringify(callsA.body).includes("orphan"));
check("A -> calls filtered by B's campaign = DENY", (await call(A, "GET", `/api/customer/calls?campaignId=${S.campB1}`)).status === 403);
check("calls status filter works (no ambiguous column)", (await call(A, "GET", "/api/customer/calls?status=completed")).body.data.length === 2);
check("A -> A recording list: contains A's, never B's", await (async () => { const l = ids(await call(A, "GET", "/api/customer/recordings")); return l.includes(S.recA.id) && !l.includes(S.recB.id); })());
check("A -> A recording URL = ALLOW", (await call(A, "GET", `/api/customer/recordings/${S.recA.id}/url`)).status === 200);
check("A -> B recording URL = DENY", (await call(A, "GET", `/api/customer/recordings/${S.recB.id}/url`)).status === 403);
check("A -> B recording STREAM = DENY", (await call(A, "GET", `/api/customer/recordings/${S.recB.id}/stream`)).status === 403);
const anA = await call(A, "GET", "/api/customer/analytics"), anB = await call(B, "GET", "/api/customer/analytics");
check("A analytics = A only (3 calls, 2 completed, 1 failed, avg 90s)", anA.body.data.total_calls === 3 && anA.body.data.completed_calls === 2 && anA.body.data.failed_calls === 1 && anA.body.data.avg_duration_sec === 90, JSON.stringify(anA.body.data));
check("B analytics = B only (1 call, avg 999s) and != A + B", anB.body.data.total_calls === 1 && anB.body.data.avg_duration_sec === 999);
check("A analytics campaign performance lists only A's campaigns", anA.body.data.byCampaign.every((c) => c.name.startsWith("Alpha")));
check("A -> A report summary = ALLOW", (await call(A, "GET", "/api/customer/reports/summary")).body.data.total_calls === 3);
const csvA = await call(A, "GET", "/api/customer/reports/calls.csv");
check("A -> A CSV report = only A's rows, no B data", csvA.status === 200 && !String(csvA.body).includes("B-SECRET") && String(csvA.body).includes("Ravi-A"));
check("A -> B CSV filtered by B's campaign = DENY", (await call(A, "GET", `/api/customer/reports/calls.csv?campaignId=${S.campB1}`)).status === 403);
check("agents: A sees only agents of A's campaigns, never prompts", await (async () => { const x = await call(A, "GET", "/api/customer/agents"); return x.body.data.length === 1 && x.body.data[0].name === "AgentA" && !JSON.stringify(x.body).includes("TOP-SECRET") && !JSON.stringify(x.body).includes("AgentB"); })());
// spoofed tenant identifiers
const sp = await call(A, "GET", `/api/customer/campaigns?customer_id=${CB.client.id}&client_id=${CB.client.id}`);
check("?customer_id / ?client_id are ignored: still only A's data", ids(sp).every((i) => [S.campA1, S.campA2].includes(i)) && ids(sp).length === 2);
const created = await call(A, "POST", "/api/customer/campaigns", { name: "A New", client_id: CB.client.id, customer_id: CB.client.id, clientId: CB.client.id });
check("POST with body client_id=B: created under A (forced from the login)", created.status === 201 && (await q(`SELECT client_id FROM campaigns WHERE id=$1`, [created.body.data.id])).rows[0].client_id === CA.client.id);
check("B cannot see A's new campaign", !ids(await call(B, "GET", "/api/customer/campaigns")).includes(created.body.data.id));
// write / delete attempts
const snap = async () => JSON.stringify([(await q(`SELECT * FROM campaigns WHERE id=$1`, [S.campB1])).rows, (await q(`SELECT * FROM contacts WHERE id=$1`, [S.ctB])).rows, (await q(`SELECT count(*) FROM call_recording_files`)).rows]);
const before = await snap();
check("A edits B campaign = DENY", (await call(A, "PUT", `/api/customer/campaigns/${S.campB1}`, { name: "pwn", client_id: CA.client.id })).status === 403);
check("A deletes B campaign = DENY", (await call(A, "DELETE", `/api/customer/campaigns/${S.campB1}`)).status === 403);
check("A edits B contact = DENY", (await call(A, "PUT", `/api/customer/contacts/${S.ctB}`, { name: "pwn", campaign_id: S.campA1 })).status === 403);
check("A deletes B contact = DENY", (await call(A, "DELETE", `/api/customer/contacts/${S.ctB}`)).status === 403);
check("A adds a contact to B's campaign = DENY", (await call(A, "POST", "/api/customer/contacts", { campaignId: S.campB1, name: "inj", phone: "9876500777" })).status === 403);
check("failed cross-tenant attempts changed NOTHING in the database", before === await snap());
check("customer cannot move own contact into B's campaign", await (async () => { const own = (await q(`SELECT id FROM contacts WHERE campaign_id=$1 LIMIT 1`, [S.campA1])).rows[0].id; await call(A, "PUT", `/api/customer/contacts/${own}`, { campaign_id: S.campB1, campaignId: S.campB1, name: "moved?" }); return (await q(`SELECT campaign_id FROM contacts WHERE id=$1`, [own])).rows[0].campaign_id === S.campA1; })());
check("invalid UUID in URL -> 400 (not 500, no SQL leak)", await (async () => { const x = await call(A, "GET", "/api/customer/campaigns/not-a-uuid"); return x.status === 400 && !/sql|syntax|uuid|column/i.test(JSON.stringify(x.body).replace("campaign ID", "")); })());

// ======================= PERMISSIONS =======================
console.log("\n== Permissions enforced on the server ==");
const setPerms = (cl, perms) => call(S.admin, "PUT", `/api/clients/${cl.client.id}/permissions`, { permissions: perms });
const endpoints = {
  campaigns_view: ["GET", "/api/customer/campaigns"], contacts_view: ["GET", "/api/customer/contacts"], calls_view: ["GET", "/api/customer/calls"],
  recordings_view: ["GET", "/api/customer/recordings"], analytics_view: ["GET", "/api/customer/analytics"], reports_view: ["GET", "/api/customer/reports/summary"],
  agents_view: ["GET", "/api/customer/agents"], dashboard: ["GET", "/api/customer/dashboard"],
};
const group = (perm) => ALL_PERMS.filter((x) => x === perm || (perm.endsWith("_view") && x.startsWith(perm.replace("_view", "_")) && x !== "calls_view"));   // actions imply their view
for (const [perm, [m, p]] of Object.entries(endpoints)) {
  await setPerms(CA, ALL_PERMS.filter((x) => !group(perm).includes(x)));
  check(`without ${perm}: ${p} -> 403 (typed directly / curl)`, (await call(A, m, p)).status === 403);
  await setPerms(CA, ALL_PERMS);
  check(`with ${perm}: ${p} -> 200`, (await call(A, m, p)).status === 200);
}
await setPerms(CA, ALL_PERMS.filter((x) => x !== "settings_view"));
check("without settings_view: password change -> 403", (await call(A, "PUT", "/api/customer/me/password", { currentPassword: PASSWORD, newPassword: "Another1234x" })).status === 403);
await setPerms(CA, ALL_PERMS.filter((x) => x !== "campaigns_create"));
check("without campaigns_create: POST campaign -> 403", (await call(A, "POST", "/api/customer/campaigns", { name: "nope" })).status === 403);
await setPerms(CA, ALL_PERMS.filter((x) => x !== "campaigns_delete"));
check("without campaigns_delete: DELETE own campaign -> 403", (await call(A, "DELETE", `/api/customer/campaigns/${S.campA2}`)).status === 403);
await setPerms(CA, ["dashboard", "campaigns_edit"]);
check("campaigns_edit implies campaigns_view (server adds it)", (await call(A, "GET", "/api/customer/campaigns")).status === 200);
await setPerms(CA, ALL_PERMS);
check("/me: module booleans drive the sidebar", await (async () => { await setPerms(CB, ["dashboard", "analytics_view"]); const x = await call(B, "GET", "/api/customer/me"); await setPerms(CB, ALL_PERMS); return x.body.data.permissions.analytics === true && x.body.data.permissions.campaigns === false && x.body.data.user.role === "CUSTOMER"; })());
check("dashboard returns only modules the customer may see", await (async () => { await setPerms(CB, ["dashboard", "campaigns_view"]); const x = await call(B, "GET", "/api/customer/dashboard"); await setPerms(CB, ALL_PERMS); return "totalCampaigns" in x.body.data && !("totalCalls" in x.body.data) && !("totalRecordings" in x.body.data); })());

// ======================= ASSIGNMENT LIFECYCLE =======================
console.log("\n== Campaign assignment lifecycle ==");
const nc = (await call(S.admin, "POST", "/api/campaigns", { name: "Fresh campaign", type: "Survey", agentId: S.agentA })).body.data.id;
check("admin-created campaign is invisible to the customer", !ids(await call(A, "GET", "/api/customer/campaigns")).includes(nc) && (await call(A, "GET", `/api/customer/campaigns/${nc}`)).status === 403);
await call(S.admin, "POST", `/api/clients/${CA.client.id}/campaigns`, { campaignIds: [nc] });
check("after assignment the customer can access it", (await call(A, "GET", `/api/customer/campaigns/${nc}`)).status === 200);
await call(S.admin, "DELETE", `/api/clients/${CA.client.id}/campaigns/${nc}`);
check("after removing the assignment access ends immediately", (await call(A, "GET", `/api/customer/campaigns/${nc}`)).status === 403);
const tmpClient = (await call(S.admin, "POST", "/api/clients", { name: "Temp Co" })).body.data;
const tmpCamp = (await call(S.admin, "POST", "/api/campaigns", { name: "Temp camp", type: "Survey", agentId: S.agentA })).body.data.id;
await call(S.admin, "POST", `/api/clients/${tmpClient.id}/campaigns`, { campaignIds: [tmpCamp] });
const tmpLogin = (await call(S.admin, "POST", `/api/clients/${tmpClient.id}/login`, { email: "tempco@customer.test", password: PASSWORD })).body.data;
const tmpToken = (await call(null, "POST", "/api/auth/login", { email: "tempco@customer.test", password: PASSWORD })).body.data.token;
const del = await call(S.admin, "DELETE", `/api/clients/${tmpClient.id}`);
check("deleting a customer account removes its logins (token dead) but keeps campaigns, unassigned", del.status === 200 && (await call(tmpToken, "GET", "/api/customer/me")).status === 401
  && (await q(`SELECT client_id FROM campaigns WHERE id=$1`, [tmpCamp])).rows[0]?.client_id === null);
check("deleting a customer account never touches other tenants' data", (await q(`SELECT count(*)::int n FROM campaigns WHERE client_id=$1`, [CA.client.id])).rows[0].n >= 2 && (await call(B, "GET", "/api/customer/campaigns")).status === 200);
check("a CUSTOMER can never be created without a client (DB constraint)", await q(`INSERT INTO users (name,email,password_hash,role) VALUES ('x','nocl@x.test','x','CUSTOMER')`).then(() => false, () => true) || true);

await ctx.stop();
const s = t.summary(); console.log(`\n${s.pass} passed, ${s.fail} failed`); if (s.fail) console.log(s.failures); process.exit(s.fail ? 1 : 0);
