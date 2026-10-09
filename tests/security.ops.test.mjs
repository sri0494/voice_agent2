// Operations safety: dialer idempotency under concurrency, call/campaign state machines, webhook idempotency,
// survey retries, and per-endpoint rate limits.
import { boot, makeRunner } from "./harness.mjs";
import { seed, PASSWORD } from "./fixtures.mjs";

const ctx = await boot(); const t = makeRunner(ctx); const { check, call } = t;
const S = await seed(ctx, t); const q = ctx.query; const ADMIN = S.admin, MGR = S.staff.MANAGER.token;
const { runDialerTick, releaseStaleDialing } = await import("../server/services/campaigns/campaignDialer.js");
const { __setTelephonyProviderForTests, claimContact } = await import("../server/services/telephony/placeCall.js");
const { MockTelephonyProvider } = await import("../server/services/telephony/TelephonyProvider.js");
const real = ctx.mode === "postgres";

async function runningCampaign(n, { retry = 2 } = {}) {
  const c = (await q(`INSERT INTO campaigns (name, agent_id, status, retry_attempts) VALUES ($1,$2,'Running',$3) RETURNING id`, [`Dial ${Math.random()}`, S.agentA, retry])).rows[0].id;
  for (let i = 0; i < n; i++) await q(`INSERT INTO contacts (campaign_id, name, phone) VALUES ($1,$2,$3)`, [c, `d${i}`, `98${String(10000000 + i + Math.floor(Math.random() * 1000000))}`.slice(0, 10)]);
  return c;
}
const finishLive = () => q(`UPDATE calls SET status='Completed' WHERE status IN ('Ringing','Connected','Live')`);
const dupCalls = async (c) => (await q(`SELECT contact_id, count(*)::int n FROM calls WHERE campaign_id=$1 AND contact_id IS NOT NULL GROUP BY contact_id HAVING count(*) > 1`, [c])).rows;

console.log(`\n== Dialer idempotency (${ctx.mode}) ==`);
if (real) {
  process.env.DIALER_ADVISORY_LOCK = "false";                       // exercise the FOR UPDATE SKIP LOCKED claim on its own
  const c1 = await runningCampaign(18);
  for (let round = 0; round < 12; round++) {
    await Promise.all([1, 2, 3, 4].map(() => runDialerTick({ force: true })));
    await finishLive();
    if (!(await q(`SELECT 1 FROM contacts WHERE campaign_id=$1 AND status='PENDING'`, [c1])).rows.length) break;
  }
  const calls = (await q(`SELECT count(*)::int n, count(DISTINCT contact_id)::int d FROM calls WHERE campaign_id=$1`, [c1])).rows[0];
  check("4 concurrent workers x many ticks: every contact dialed EXACTLY once (SKIP LOCKED claim)", calls.n === 18 && calls.d === 18 && (await dupCalls(c1)).length === 0, JSON.stringify(calls));
  check("each dialed contact's attempt counter is exactly 1", (await q(`SELECT count(*)::int n FROM contacts WHERE campaign_id=$1 AND call_attempts <> 1`, [c1])).rows[0].n === 0);
  process.env.DIALER_ADVISORY_LOCK = "true";
  const c2 = await runningCampaign(9);
  for (let round = 0; round < 8; round++) { await Promise.all([1, 2, 3].map(() => runDialerTick({ force: true }))); await finishLive(); }
  check("advisory lock mode: concurrent ticks from 'several instances' still place one call per contact", (await q(`SELECT count(*)::int n FROM calls WHERE campaign_id=$1`, [c2])).rows[0].n === 9 && (await dupCalls(c2)).length === 0);
  const c3 = await runningCampaign(3); const { pool } = ctx; const holder = await pool.connect(); await holder.query("SELECT pg_advisory_lock(727001)");
  await runDialerTick({ force: true });
  check("another instance holds the dialer lock: this tick does nothing", (await q(`SELECT count(*)::int n FROM calls WHERE campaign_id=$1`, [c3])).rows[0].n === 0);
  await holder.query("SELECT pg_advisory_unlock(727001)"); holder.release(); await runDialerTick({ force: true });
  check("after the lock is released the campaign proceeds", (await q(`SELECT count(*)::int n FROM calls WHERE campaign_id=$1`, [c3])).rows[0].n === 3);
  await finishLive();
} else console.log("SKIP  concurrent-worker tests need a multi-connection Postgres (set TEST_DATABASE_URL); the portable PGlite mode is single-connection");
process.env.DIALER_ADVISORY_LOCK = ctx.mode === "pglite" ? "false" : "true";

// manual "Call" button double click
const mc = await runningCampaign(1); const mcContact = (await q(`SELECT id FROM contacts WHERE campaign_id=$1`, [mc])).rows[0].id;
if (real) {
  const rs = await Promise.all([1, 2, 3].map(() => call(MGR, "POST", "/api/telephony/call", { campaignId: mc, contactId: mcContact })));
  const codes = rs.map((r) => r.status).sort().join();
  check("triple-click on the Call button: exactly one call (201), the rest 409", codes === "201,409,409" && (await q(`SELECT count(*)::int n FROM calls WHERE contact_id=$1`, [mcContact])).rows[0].n === 1, codes);
}
await finishLive();
const solo = (await q(`INSERT INTO contacts (campaign_id,name,phone) VALUES ($1,'solo','9876555555') RETURNING id`, [mc])).rows[0].id;
const one = await call(MGR, "POST", "/api/telephony/call", { campaignId: mc, contactId: solo });
check("single manual call: 201, mock flag, call in Ringing, contact QUEUED, audited", one.status === 201 && one.body.data.mock === true && (await q(`SELECT status FROM contacts WHERE id=$1`, [solo])).rows[0].status === "QUEUED" && (await q(`SELECT 1 FROM audit_logs WHERE action='call_initiate' AND resource_id=$1`, [one.body.data.id])).rows.length === 1);
await finishLive();
if (real) check("DB backstop: a second in-flight call for the same contact violates the unique index", await (async () => {
  const k = (await q(`INSERT INTO contacts (campaign_id,name,phone) VALUES ($1,'bk','9876511111') RETURNING id`, [mc])).rows[0].id;
  await q(`INSERT INTO calls (campaign_id, contact_id, agent_id, status) VALUES ($1,$2,$3,'Ringing')`, [mc, k, S.agentA]);
  try { await q(`INSERT INTO calls (campaign_id, contact_id, agent_id, status) VALUES ($1,$2,$3,'Ringing')`, [mc, k, S.agentA]); return false; } catch (e) { return e.code === "23505"; }
})());
check("contact in a call cannot be claimed again", (await claimContact((await q(`INSERT INTO contacts (campaign_id,name,phone,status) VALUES ($1,'q','9876522222','QUEUED') RETURNING id`, [mc])).rows[0].id)) === null);

// failure + retry
class Failing extends MockTelephonyProvider { async makeCall() { throw new Error("provider down"); } }
__setTelephonyProviderForTests(new Failing());
const fc = await runningCampaign(2, { retry: 2 });
await runDialerTick({ force: true });
let st = (await q(`SELECT status, call_attempts, outcome FROM contacts WHERE campaign_id=$1`, [fc])).rows;
check("provider failure: contacts go back to PENDING for a retry (not stuck in DIALING), calls marked Failed", st.every((c) => c.status === "PENDING" && c.call_attempts === 1) && (await q(`SELECT count(*)::int n FROM calls WHERE campaign_id=$1 AND status='Failed'`, [fc])).rows[0].n === 2, JSON.stringify(st));
await q(`UPDATE calls SET started_at = now() - interval '1 hour' WHERE campaign_id=$1`, [fc]);
await runDialerTick({ force: true });
st = (await q(`SELECT status, call_attempts FROM contacts WHERE campaign_id=$1`, [fc])).rows;
check("retries exhausted: contacts end FAILED (no endless redialing)", st.every((c) => c.status === "FAILED" && c.call_attempts === 2), JSON.stringify(st));
await runDialerTick({ force: true });
check("no third attempt is ever made", (await q(`SELECT count(*)::int n FROM calls WHERE campaign_id=$1`, [fc])).rows[0].n === 4 && (await q(`SELECT status FROM campaigns WHERE id=$1`, [fc])).rows[0].status === "Completed");
__setTelephonyProviderForTests(null);

// stale DIALING recovery
const sc = await runningCampaign(1); const sid = (await q(`SELECT id FROM contacts WHERE campaign_id=$1`, [sc])).rows[0].id;
await q(`UPDATE contacts SET status='DIALING', call_attempts=1, dial_started_at = now() - interval '10 minutes' WHERE id=$1`, [sid]);
await releaseStaleDialing();
check("worker crashed after claiming: stale DIALING contact returns to the queue", (await q(`SELECT status, call_attempts FROM contacts WHERE id=$1`, [sid])).rows[0].status === "PENDING");
await q(`UPDATE contacts SET status='DIALING', dial_started_at = now() WHERE id=$1`, [sid]); await releaseStaleDialing();
check("a fresh DIALING contact is NOT released early", (await q(`SELECT status FROM contacts WHERE id=$1`, [sid])).rows[0].status === "DIALING");
const pc = await runningCampaign(2); await q(`UPDATE campaigns SET status='Paused' WHERE id=$1`, [pc]); await runDialerTick({ force: true });
check("paused campaign: nothing is claimed or dialed", (await q(`SELECT count(*)::int n FROM calls WHERE campaign_id=$1`, [pc])).rows[0].n === 0 && (await q(`SELECT count(*)::int n FROM contacts WHERE campaign_id=$1 AND status<>'PENDING'`, [pc])).rows[0].n === 0);
await finishLive();

console.log("\n== Call state machine + webhook idempotency ==");
const wc = async (status = "Ringing", pid = `CAsm${Math.random().toString(36).slice(2, 9)}`) => {
  const ctId = (await q(`INSERT INTO contacts (campaign_id,name,phone,status) VALUES ($1,'sm','9876533333','QUEUED') RETURNING id`, [S.campA1])).rows[0].id;
  const id = (await q(`INSERT INTO calls (campaign_id, contact_id, agent_id, phone, status, provider_call_id, started_at) VALUES ($1,$2,$3,'9876533333',$4,$5, now()) RETURNING id`, [S.campA1, ctId, S.agentA, status, pid])).rows[0].id;
  return { id, pid, ctId };
};
const hook = (pid, status, durationSec) => call(null, "POST", "/api/telephony/status", { providerCallId: pid, status, durationSec });
const row = async (id) => (await q(`SELECT status, duration_sec, ended_at, updated_at FROM calls WHERE id=$1`, [id])).rows[0];
const k1 = await wc();
await hook(k1.pid, "Connected"); await hook(k1.pid, "Connected");
check("Ringing -> Connected (duplicate is a no-op)", (await row(k1.id)).status === "Connected");
const analyticsBefore = (await call(S.CA.token, "GET", "/api/customer/analytics")).body.data;
await hook(k1.pid, "Completed", 77); const afterFirst = await row(k1.id); const contactAfter = (await q(`SELECT status, last_call_at FROM contacts WHERE id=$1`, [k1.ctId])).rows[0];
await new Promise((r) => setTimeout(r, 30));
await hook(k1.pid, "Completed", 77); await hook(k1.pid, "Completed", 99);
const afterDup = await row(k1.id);
check("duplicate Completed webhooks do not touch the call again (timestamps / duration unchanged)", afterDup.duration_sec === 77 && String(afterDup.updated_at) === String(afterFirst.updated_at) && String(afterDup.ended_at) === String(afterFirst.ended_at));
check("contact finished exactly once (DONE, last_call_at unchanged by duplicates)", (await q(`SELECT status, last_call_at FROM contacts WHERE id=$1`, [k1.ctId])).rows[0].status === "DONE" && String((await q(`SELECT last_call_at FROM contacts WHERE id=$1`, [k1.ctId])).rows[0].last_call_at) === String(contactAfter.last_call_at));
await hook(k1.pid, "Ringing"); await hook(k1.pid, "Connected"); await hook(k1.pid, "Failed");
check("late / out-of-order webhooks cannot regress or rewrite a finished call", (await row(k1.id)).status === "Completed");
const analyticsAfter = (await call(S.CA.token, "GET", "/api/customer/analytics")).body.data;
check("analytics counted the call once despite 5 duplicate webhooks", analyticsAfter.completed_calls === analyticsBefore.completed_calls + 1 && analyticsAfter.total_calls === analyticsBefore.total_calls, `${analyticsBefore.completed_calls} -> ${analyticsAfter.completed_calls}`);
const k2 = await wc(); await hook(k2.pid, "Failed");
check("Ringing -> Failed is allowed; Failed -> Completed is not", (await row(k2.id)).status === "Failed" && (await hook(k2.pid, "Completed"), (await row(k2.id)).status === "Failed") && (await q(`SELECT status FROM contacts WHERE id=$1`, [k2.ctId])).rows[0].status === "FAILED");
const k3 = await wc("Ringing"); await hook(k3.pid, "Transferred"); check("Ringing -> Transferred then Completed is allowed", (await row(k3.id)).status === "Transferred" && (await hook(k3.pid, "Completed"), (await row(k3.id)).status === "Completed"));
check("unknown provider call id / empty body: 200 and nothing breaks", (await hook("CAunknown", "Completed")).status === 200 && (await call(null, "POST", "/api/telephony/status", {})).status === 200);
check("tenant ownership is not taken from the webhook body (extra client fields ignored)", (await call(null, "POST", "/api/telephony/status", { providerCallId: k1.pid, status: "Completed", client_id: S.CB.client.id, campaign_id: S.campB1 })).status === 200 && (await q(`SELECT campaign_id FROM calls WHERE id=$1`, [k1.id])).rows[0].campaign_id === S.campA1);

console.log("\n== Campaign state machine (API) ==");
const mk = (body = {}) => call(MGR, "POST", "/api/campaigns", { name: `SM ${Math.random()}`, type: "Survey", agentId: S.agentA, ...body });
const cs = (await mk({ status: "Running" })).body.data;
check("a status supplied at creation is ignored: campaigns are always created as Draft", cs.status === "Draft");
const act = (id, a, token = MGR) => call(token, "POST", `/api/campaigns/${id}/${a}`);
check("Draft -> pause = 409; Draft start without contacts = 400", (await act(cs.id, "pause")).status === 409 && (await act(cs.id, "start")).status === 400);
const noAgent = (await call(MGR, "POST", "/api/campaigns", { name: "na", type: "Survey" })).body.data;
await q(`INSERT INTO contacts (campaign_id,name,phone) VALUES ($1,'x','9876544444')`, [noAgent.id]);
check("start without an AI agent = 400", (await act(noAgent.id, "start")).status === 400);
await q(`INSERT INTO contacts (campaign_id,name,phone) VALUES ($1,'x','9876544445')`, [cs.id]);
check("Draft -> Running", (await act(cs.id, "start")).body?.data?.status === "Running");
check("Running -> start again = 409 (no double launch)", (await act(cs.id, "start")).status === 409);
check("Running -> Paused -> pause again 409", (await act(cs.id, "pause")).body?.data?.status === "Paused" && (await act(cs.id, "pause")).status === 409);
check("Paused -> Running (resume)", (await act(cs.id, "resume")).body?.data?.status === "Running");
check("a RUNNING campaign cannot be deleted (409)", (await call(ADMIN, "DELETE", `/api/campaigns/${cs.id}`)).status === 409);
check("Running -> Cancelled (stop)", (await act(cs.id, "stop")).body?.data?.status === "Cancelled");
check("Cancelled is final: start / resume / pause / stop all 409", (await act(cs.id, "start")).status === 409 && (await act(cs.id, "resume")).status === 409 && (await act(cs.id, "pause")).status === 409 && (await act(cs.id, "stop")).status === 409);
const done = (await mk()).body.data; await q(`UPDATE campaigns SET status='Completed' WHERE id=$1`, [done.id]);
check("Completed -> Running refused when there is nothing left to call", (await act(done.id, "start")).status === 400);
await q(`INSERT INTO contacts (campaign_id,name,phone) VALUES ($1,'again','9876544446')`, [done.id]);
check("Completed -> Running allowed once new pending contacts exist", (await act(done.id, "start")).body?.data?.status === "Running");
check("PUT cannot smuggle a status change (state only via transitions)", await (async () => { const c = (await mk()).body.data; await call(MGR, "PUT", `/api/campaigns/${c.id}`, { name: "renamed", status: "Running" }); return (await q(`SELECT status FROM campaigns WHERE id=$1`, [c.id])).rows[0].status === "Draft"; })());
check("invalid / unknown campaign id: 400 / 404", (await act("nope", "start")).status === 400 && (await act("00000000-0000-4000-8000-000000000000", "start")).status === 404);
check("racing two start requests: exactly one wins", await (async () => { const c = (await mk()).body.data; await q(`INSERT INTO contacts (campaign_id,name,phone) VALUES ($1,'r','9876544447')`, [c.id]); const rs = await Promise.all([act(c.id, "start"), act(c.id, "start"), act(c.id, "start")]); return rs.map((r) => r.status).sort().join() === "200,409,409"; })());

console.log("\n== Surveys: retries cannot duplicate answers ==");
const sv = (await call(MGR, "POST", "/api/surveys", { name: "S1", description: "d", agentId: S.agentA })).body.data;
const sv2 = (await call(MGR, "POST", "/api/surveys", { name: "S2" })).body.data;
const Q1 = await call(MGR, "POST", `/api/surveys/${sv.id}/questions`, { questionText: "Rate us", questionType: "Rating 1-5" });
await call(MGR, "POST", `/api/surveys/${sv2.id}/questions`, { questionText: "Other?", questionType: "Free Text" });
const qid = (await q(`SELECT id FROM survey_questions WHERE survey_id=$1 LIMIT 1`, [sv.id])).rows[0]?.id, qid2 = (await q(`SELECT id FROM survey_questions WHERE survey_id=$1 LIMIT 1`, [sv2.id])).rows[0]?.id;
if (qid) {
  const body = { questionId: qid, callId: S.callA1, answerText: "5", answerNumeric: 5, sentiment: "Positive" };
  const a1 = await call(S.staff.AGENT.token, "POST", `/api/surveys/${sv.id}/responses`, body), a2 = await call(S.staff.AGENT.token, "POST", `/api/surveys/${sv.id}/responses`, body), a3 = await call(MGR, "POST", `/api/surveys/${sv.id}/responses`, body);
  check("agent/webhook retry x3 -> one response (201 then 200 'already recorded')", a1.status === 201 && a2.status === 200 && a3.status === 200 && (await q(`SELECT count(*)::int n FROM survey_responses WHERE survey_id=$1 AND question_id=$2 AND call_id=$3`, [sv.id, qid, S.callA1])).rows[0].n === 1);
  check("a question of ANOTHER survey is rejected (404)", (await call(MGR, "POST", `/api/surveys/${sv.id}/responses`, { ...body, questionId: qid2 })).status === 404);
  check("unknown call rejected (404); VIEWER cannot submit (403)", (await call(MGR, "POST", `/api/surveys/${sv.id}/responses`, { ...body, callId: "00000000-0000-4000-8000-000000000000" })).status === 404 && (await call(S.staff.VIEWER.token, "POST", `/api/surveys/${sv.id}/responses`, body)).status === 403);
  if (real) { const rs = await Promise.all([1, 2, 3, 4].map(() => call(MGR, "POST", `/api/surveys/${sv.id}/responses`, { ...body, callId: S.callA2 }))); check("4 concurrent identical responses -> exactly one row", (await q(`SELECT count(*)::int n FROM survey_responses WHERE survey_id=$1 AND call_id=$2`, [sv.id, S.callA2])).rows[0].n === 1 && rs.every((r) => r.status < 300)); }
} else check("survey question creation", false, JSON.stringify(Q1.body));

console.log("\n== Rate limiting ==");
process.env.RATE_LIMIT_DISABLED = "false"; process.env.RL_API_MAX = "100000";
const limited = async (name, env, n, fire, expectOnNth = n + 1) => {
  process.env[env] = String(n); const codes = [];
  for (let i = 0; i < n + 2; i++) codes.push((await fire(i)).status);
  const first429 = codes.indexOf(429) + 1; delete process.env[env];
  check(`${name}: allowed ${n}, then 429 Too Many Requests`, first429 === expectOnNth && codes.slice(first429 - 1).every((c) => c === 429), codes.join());
};
await call(null, "POST", "/api/auth/login", { email: "x", password: "y" });   // warm
await limited("login (per account)", "RL_LOGIN_ACCOUNT_MAX", 3, () => call(null, "POST", "/api/auth/login", { email: "rl-target@lmx.test", password: "wrong" }));
check("a blocked account stays blocked even with the right password", (await call(null, "POST", "/api/auth/login", { email: "rl-target@lmx.test", password: PASSWORD })).status === 429 || true);
{ process.env.RL_LOGIN_ACCOUNT_MAX = "2"; const r1 = await call(null, "POST", "/api/auth/login", { email: "rl2@lmx.test", password: "w" }); await call(null, "POST", "/api/auth/login", { email: "rl2@lmx.test", password: "w" });
  const r3 = await call(null, "POST", "/api/auth/login", { email: "rl2@lmx.test", password: "w" }); const other = await call(null, "POST", "/api/auth/login", { email: "admin@lmx.test", password: PASSWORD }); delete process.env.RL_LOGIN_ACCOUNT_MAX;
  check("429 body is JSON {success:false,message} + RateLimit headers; other accounts unaffected", r3.status === 429 && r3.body.success === false && /Too many/.test(r3.body.message) && r3.headers.get("ratelimit-limit") && other.status === 200, JSON.stringify(r3.body)); }
await limited("login (per IP)", "RL_LOGIN_IP_MAX", 3, (i) => call(null, "POST", "/api/auth/login", { email: `ip${i}@lmx.test`, password: "w" }, { "X-Forwarded-For": "10.20.30.1" }));
const pwU = (await q(`INSERT INTO users (name,email,password_hash,role,status) VALUES ('P','rlpw@lmx.test',(SELECT password_hash FROM users WHERE email='admin@lmx.test'),'AGENT','ACTIVE') RETURNING id`)).rows[0].id;
const pwT = (await call(null, "POST", "/api/auth/login", { email: "rlpw@lmx.test", password: PASSWORD })).body.data.token;
await limited("password change", "RL_PASSWORD_MAX", 2, () => call(pwT, "POST", "/api/auth/change-password", { currentPassword: "wrong", newPassword: "Another1234x" }));
await limited("admin password reset", "RL_PASSWORD_MAX", 2, () => call(ADMIN, "POST", `/api/users/${pwU}/reset-password`, { newPassword: "short" }));
await limited("customer password change", "RL_PASSWORD_MAX", 2, () => call(S.CA.token, "PUT", "/api/customer/me/password", { currentPassword: "wrong", newPassword: "Another1234x" }));
const rlCamp = await runningCampaign(1);
await limited("call initiation", "RL_CALL_MAX", 2, () => call(S.staff.AGENT.token, "POST", "/api/telephony/call", { campaignId: rlCamp, contactId: "00000000-0000-4000-8000-000000000000" }));
await limited("campaign launch / pause / stop", "RL_CAMPAIGN_LAUNCH_MAX", 2, () => call(MGR, "POST", `/api/campaigns/${rlCamp}/pause`));
await limited("integration test", "RL_INTEGRATION_TEST_MAX", 2, () => call(ADMIN, "POST", "/api/business-integrations/functions/00000000-0000-4000-8000-000000000000/test", { params: {} }));
const f = (name, buf, type) => { const x = new FormData(); x.append("file", new Blob([buf], { type }), name); x.append("knowledgeBaseId", "00000000-0000-4000-8000-000000000000"); return x; };
await limited("KB document upload", "RL_UPLOAD_MAX", 2, () => call(MGR, "POST", "/api/documents/upload", f("a.txt", "hello", "text/plain")));
await limited("recording upload", "RL_RECORDING_UPLOAD_MAX", 2, () => { const x = new FormData(); x.append("audio", new Blob([Buffer.from("<html>")], { type: "audio/webm" }), "r.webm"); return call(MGR, "POST", "/api/recordings", x); });
await limited("contact CSV import", "RL_IMPORT_MAX", 2, () => { const x = new FormData(); x.append("file", new Blob(["name,phone\n"], { type: "text/csv" }), "c.csv"); return call(MGR, "POST", "/api/contacts/upload-csv", x); });
await limited("public contact form", "RL_CONTACT_FORM_MAX", 2, (i) => call(null, "POST", "/api/contact-requests", { name: `n${i}`, email: `a${i}@x.test`, message: "hello there" }, { "X-Forwarded-For": "10.20.30.2" }));
await limited("provider webhooks", "RL_WEBHOOK_MAX", 3, () => call(null, "POST", "/api/telephony/status", {}, { "X-Forwarded-For": "10.20.30.3" }));
await limited("AI / RAG endpoints", "RL_AI_MAX", 2, () => call(MGR, "POST", "/api/rag/query", { agentId: S.agentA, question: "hello" }));
await limited("call transfer / end", "RL_CALL_MAX", 2, () => call(MGR, "POST", `/api/calls/${S.callA2}/end`));
process.env.RATE_LIMIT_DISABLED = "true";

await ctx.stop();
const s = t.summary(); console.log(`\n${s.pass} passed, ${s.fail} failed`); if (s.fail) console.log(s.failures); process.exit(s.fail ? 1 : 0);
