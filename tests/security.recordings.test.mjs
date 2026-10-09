// Recording privacy: no public file endpoint, authorised short-lived playback, download permission, upload validation,
// consent, retention, webhook idempotency and authentication, audit trail.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { boot, makeRunner } from "./harness.mjs";
import { seed, PASSWORD, ALL_PERMS, WAV } from "./fixtures.mjs";

const ctx = await boot(); const t = makeRunner(ctx); const { check, call } = t;
const S = await seed(ctx, t); const q = ctx.query;
const A = S.CA.token, B = S.CB.token, ADMIN = S.admin;
const { saveRecording, purgeExpiredRecordings } = await import("../server/services/recordings.js");

console.log("\n== No public recording endpoint ==");
const rid = S.recA.id;
check("GET /api/recordings/:id/file (no auth) -> 401, no data", (await call(null, "GET", `/api/recordings/${rid}/file`)).status === 401);
check("GET /api/recordings/:id/file?exp=..&sig=.. (old signed-link style) -> 401", (await call(null, "GET", `/api/recordings/${rid}/file?exp=9999999999&sig=abc`)).status === 401);
check("the /file route no longer exists even for an admin (404)", (await call(ADMIN, "GET", `/api/recordings/${rid}/file`)).status === 404);
check("/url without a token -> 401", (await call(null, "GET", `/api/recordings/${rid}/url`)).status === 401);
check("/stream without a token -> 401 (a ?token= query parameter is NOT accepted)", (await call(null, "GET", `/api/recordings/${rid}/stream`)).status === 401 && (await call(null, "GET", `/api/recordings/${rid}/stream?token=${ADMIN}`)).status === 401);
const sources = ["server/routes/recordings.js", "server/routes/customerPortal.js", "server/services/recordings.js"].map((f) => fs.readFileSync(path.join(ctx.root ?? path.resolve(process.cwd()), f), "utf8")).join("\n");
check("source contains no HMAC link signing / public file route any more", !/signFile|verifyFile|\/:id\/file/.test(sources));

console.log("\n== Staff playback / download ==");
for (const role of ["VIEWER", "AGENT", "MANAGER"]) {
  const u = await call(S.staff[role].token, "GET", `/api/recordings/${rid}/url`);
  check(`${role}: playback link = authenticated stream path (local storage), 5-minute expiry`, u.status === 200 && u.body.data.mode === "stream" && u.body.data.expiresIn === 300 && !JSON.stringify(u.body).includes("storage_key"));
}
const st = await call(S.staff.VIEWER.token, "GET", `/api/recordings/${rid}/stream`);
check("authenticated stream returns the audio bytes", st.status === 200 && Buffer.isBuffer(st.body) && st.body.length === WAV.length && st.headers.get("content-type") === "audio/wav" && st.headers.get("cache-control").includes("no-store"));
const rg = await call(S.staff.VIEWER.token, "GET", `/api/recordings/${rid}/stream`, null, { Range: "bytes=10-19" });
check("Range request -> 206 with Content-Range (player seeking)", rg.status === 206 && rg.headers.get("content-range") === `bytes 10-19/${WAV.length}` && rg.body.length === 10);
check("bad Range -> 416", (await call(S.staff.VIEWER.token, "GET", `/api/recordings/${rid}/stream`, null, { Range: "bytes=999999-" })).status === 416);
check("VIEWER / AGENT cannot download (403)", (await call(S.staff.VIEWER.token, "GET", `/api/recordings/${rid}/url?download=1`)).status === 403 && (await call(S.staff.AGENT.token, "GET", `/api/recordings/${rid}/stream?download=1`)).status === 403);
const dl = await call(S.staff.MANAGER.token, "GET", `/api/recordings/${rid}/stream?download=1`);
check("MANAGER can download: Content-Disposition attachment", dl.status === 200 && (dl.headers.get("content-disposition") || "").startsWith("attachment"));
check("expired JWT on stream -> 401", (await call(S.jwtFor(S.staff.ADMIN.id, {}, { expiresIn: -5 }), "GET", `/api/recordings/${rid}/stream`)).status === 401);
check("unknown / malformed recording id -> 404 / 404", (await call(ADMIN, "GET", "/api/recordings/00000000-0000-4000-8000-000000000000/url")).status === 404 && (await call(ADMIN, "GET", "/api/recordings/xyz/url")).status === 404);

console.log("\n== Customer playback ==");
const cu = await call(A, "GET", `/api/customer/recordings/${rid}/url`);
check("A: own recording link; download link present because recordings_download granted", cu.status === 200 && cu.body.data.url === `/api/customer/recordings/${rid}/stream` && cu.body.data.downloadUrl.endsWith("?download=1") && !JSON.stringify(cu.body).includes("customers/"));
const cs = await call(A, "GET", `/api/customer/recordings/${rid}/stream`);
check("A: authenticated stream returns audio", cs.status === 200 && cs.body.length === WAV.length);
check("A without a token -> 401", (await call(null, "GET", `/api/customer/recordings/${rid}/stream`)).status === 401);
check("A -> B recording url / stream / download = 403", (await call(A, "GET", `/api/customer/recordings/${S.recB.id}/url`)).status === 403 && (await call(A, "GET", `/api/customer/recordings/${S.recB.id}/stream`)).status === 403 && (await call(A, "GET", `/api/customer/recordings/${S.recB.id}/stream?download=1`)).status === 403);
check("B -> A recording = 403 (reverse direction)", (await call(B, "GET", `/api/customer/recordings/${rid}/url`)).status === 403);
check("A: customer download returns attachment", ((await call(A, "GET", `/api/customer/recordings/${rid}/stream?download=1`)).headers.get("content-disposition") || "").startsWith("attachment"));
const setPerms = (perms) => call(ADMIN, "PUT", `/api/clients/${S.CA.client.id}/permissions`, { permissions: perms });
await setPerms(ALL_PERMS.filter((p) => p !== "recordings_download"));
const noDl = await call(A, "GET", `/api/customer/recordings/${rid}/url`);
check("view-only customer: NO download link, and ?download=1 -> 403", noDl.status === 200 && !noDl.body.data.downloadUrl && (await call(A, "GET", `/api/customer/recordings/${rid}/stream?download=1`)).status === 403 && (await call(A, "GET", `/api/customer/recordings/${rid}/stream`)).status === 200);
await setPerms(ALL_PERMS.filter((p) => !p.startsWith("recordings")));
check("without recordings_view: list / url / stream all 403", (await call(A, "GET", "/api/customer/recordings")).status === 403 && (await call(A, "GET", `/api/customer/recordings/${rid}/url`)).status === 403 && (await call(A, "GET", `/api/customer/recordings/${rid}/stream`)).status === 403);
await setPerms(ALL_PERMS);
check("customer cannot DELETE or upload recordings (admin API)", (await call(A, "DELETE", `/api/recordings/${rid}`)).status === 403 && (await call(A, "POST", "/api/recordings", new FormData())).status === 403);
const keyA = (await q(`SELECT storage_key FROM call_recording_files WHERE id=$1`, [rid])).rows[0].storage_key;
check(`recording stored under the customer's own folder (${keyA.slice(0, 22)}...)`, keyA.startsWith(`customers/${S.CA.client.id}/campaigns/${S.campA1}/recordings/`));

console.log("\n== Upload validation ==");
const form = (buf, type, name = "rec.wav", extra = {}) => { const f = new FormData(); f.append("audio", new Blob([buf], { type }), name); for (const [k, v] of Object.entries(extra)) f.append(k, v); return f; };
const up = (buf, type, name, extra) => call(ADMIN, "POST", "/api/recordings", form(buf, type, name, extra));
check("valid wav accepted (201)", (await up(WAV, "audio/wav")).status === 201);
check("HTML disguised as audio/webm -> 415", (await up(Buffer.from("<html><script>alert(1)</script></html>"), "audio/webm")).status === 415);
check("EXE bytes labelled audio/wav -> 415", (await up(Buffer.concat([Buffer.from("MZ"), Buffer.alloc(500)]), "audio/wav", "evil.wav")).status === 415);
check("unsupported MIME type text/html -> 415", (await up(WAV, "text/html")).status === 415);
check("oversize (>1 MB limit) -> 413", (await up(Buffer.concat([WAV, Buffer.alloc(1.2 * 1024 * 1024)]), "audio/wav")).status === 413);
check("no file -> 400, bad callId -> 400, unknown call -> 404", (await call(ADMIN, "POST", "/api/recordings", new FormData())).status === 400 && (await up(WAV, "audio/wav", "r.wav", { callId: "xx" })).status === 400 && (await up(WAV, "audio/wav", "r.wav", { callId: "00000000-0000-4000-8000-000000000000" })).status === 404);
check("path-traversal filenames are rejected (400), even Windows-style", (await up(WAV, "audio/wav", "../../../etc/passwd.wav")).status === 400 && (await up(WAV, "audio/wav", "..\\..\\x.wav")).status === 400);
const okName = await up(WAV, "audio/wav", "my call (1).wav");
check("stored key is always server-generated (user filename never used)", okName.status === 201 && !(await q(`SELECT storage_key FROM call_recording_files WHERE id=$1`, [okName.body.data.id])).rows[0].storage_key.includes("my call"));
check("VIEWER cannot upload (403)", (await call(S.staff.VIEWER.token, "POST", "/api/recordings", form(WAV, "audio/wav"))).status === 403);
check("a failed upload leaves no orphan object in storage", await (async () => { const root = process.env.STORAGE_LOCAL_DIR; const count = (d) => fs.existsSync(d) ? fs.readdirSync(d, { recursive: true }).filter((f) => /\.(wav|webm)$/.test(f)).length : 0; return count(root) === (await q(`SELECT count(*)::int n FROM call_recording_files`)).rows[0].n; })());

console.log("\n== Consent (per-agent, configurable) ==");
check("agent API validates consent / retention / message", (await call(ADMIN, "PUT", `/api/agents/${S.agentA}`, { recordingConsent: "MAYBE" })).status === 422 && (await call(ADMIN, "PUT", `/api/agents/${S.agentA}`, { recordingRetentionDays: 0 })).status === 422 && (await call(ADMIN, "PUT", `/api/agents/${S.agentA}`, { recordingConsentMessage: "x".repeat(600) })).status === 422);
check("MANAGER can configure consent; AGENT cannot", (await call(S.staff.MANAGER.token, "PUT", `/api/agents/${S.agentA}`, { recordingConsent: "REQUIRED", recordingConsentMessage: "Calls are recorded. Do you agree?" })).status === 200 && (await call(S.staff.AGENT.token, "PUT", `/api/agents/${S.agentA}`, { recordingConsent: "NOT_REQUIRED" })).status === 403);
const ag = (await q(`SELECT recording_consent, recording_consent_message FROM agents WHERE id=$1`, [S.agentA])).rows[0];
check("consent settings saved (message is configurable, not hard-coded)", ag.recording_consent === "REQUIRED" && ag.recording_consent_message.includes("agree"));
const consentCall = (await q(`INSERT INTO calls (campaign_id, agent_id, phone, status) VALUES ($1,$2,'9876543210','Completed') RETURNING id`, [S.campA1, S.agentA])).rows[0].id;
let err = null; await saveRecording({ callId: consentCall, buffer: WAV, contentType: "audio/wav", source: "telephony", originalUrl: "https://api.twilio.test/c1" }).catch((e) => { err = e; });
check("consent REQUIRED + not granted: provider recording is NOT stored (409)", err?.statusCode === 409);
await q(`UPDATE calls SET consent_status='DECLINED', consent_at=now(), consent_method='VOICE_PROMPT' WHERE id=$1`, [consentCall]); err = null;
await saveRecording({ callId: consentCall, buffer: WAV, contentType: "audio/wav", source: "telephony", originalUrl: "https://api.twilio.test/c2" }).catch((e) => { err = e; });
check("consent DECLINED: not stored", err?.statusCode === 409);
await q(`UPDATE calls SET consent_status='GRANTED' WHERE id=$1`, [consentCall]);
const granted = await saveRecording({ callId: consentCall, buffer: WAV, contentType: "audio/wav", source: "telephony", originalUrl: "https://api.twilio.test/c3" });
check("consent GRANTED: stored with consent status / time / method", granted.consent_status === "GRANTED" && granted.consent_method === "VOICE_PROMPT" && granted.consent_at);
await call(ADMIN, "PUT", `/api/agents/${S.agentA}`, { recordingConsent: "NOT_REQUIRED" });

console.log("\n== Retention ==");
await call(ADMIN, "PUT", `/api/agents/${S.agentA}`, { recordingRetentionDays: 7 });
const keep = await saveRecording({ callId: S.callA2, buffer: WAV, contentType: "audio/wav" });
const days = (await q(`SELECT retention_days, round(extract(epoch FROM (expires_at - now()))/86400)::int AS d FROM call_recording_files WHERE id=$1`, [keep.id])).rows[0];
check("retention 7 days -> expires_at ~ now + 7 days", days.retention_days === 7 && days.d === 7, JSON.stringify(days));
await call(ADMIN, "PUT", `/api/agents/${S.agentA}`, { recordingRetentionDays: null });
const forever = await saveRecording({ callId: S.callA2, buffer: WAV, contentType: "audio/wav" });
check("retention 'forever' (null) -> expires_at NULL", (await q(`SELECT expires_at FROM call_recording_files WHERE id=$1`, [forever.id])).rows[0].expires_at === null);
const old = await saveRecording({ callId: S.callA2, buffer: WAV, contentType: "audio/wav" });
const oldKey = (await q(`SELECT storage_key FROM call_recording_files WHERE id=$1`, [old.id])).rows[0].storage_key;
await q(`UPDATE call_recording_files SET expires_at = now() - interval '1 hour' WHERE id = $1`, [old.id]);
const bBefore = (await q(`SELECT count(*)::int n FROM call_recording_files WHERE id=$1`, [S.recB.id])).rows[0].n;
const purged = await purgeExpiredRecordings();
check("cleanup job deletes ONLY expired recordings (object + row)", purged === 1 && !fs.existsSync(path.join(process.env.STORAGE_LOCAL_DIR, oldKey)) && (await q(`SELECT 1 FROM call_recording_files WHERE id=$1`, [old.id])).rows.length === 0);
check("non-expired, forever and other tenants' recordings untouched", (await q(`SELECT 1 FROM call_recording_files WHERE id=$1`, [keep.id])).rows.length === 1 && (await q(`SELECT 1 FROM call_recording_files WHERE id=$1`, [forever.id])).rows.length === 1 && bBefore === 1 && (await q(`SELECT 1 FROM call_recording_files WHERE id=$1`, [S.recB.id])).rows.length === 1);
check("retention deletion is audited", (await q(`SELECT 1 FROM audit_logs WHERE action='recording_retention_delete' AND resource_id=$1`, [old.id])).rows.length === 1);

console.log("\n== Telephony recording webhook: idempotent + authenticated ==");
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => String(url).startsWith("https://api.twilio.test/") ? new Response(WAV, { status: 200, headers: { "content-type": "audio/wav" } }) : realFetch(url, opts);
const wcall = (await q(`INSERT INTO calls (campaign_id, agent_id, phone, status, provider_call_id) VALUES ($1,$2,'9876543210','Completed','CAwebhook1') RETURNING id`, [S.campA1, S.agentA])).rows[0].id;
const hook = { CallSid: "CAwebhook1", RecordingUrl: "https://api.twilio.test/rec/RE1", RecordingDuration: "42" };
await call(null, "POST", "/api/telephony/recording", hook); await call(null, "POST", "/api/telephony/recording", hook); await call(null, "POST", "/api/telephony/recording", hook);
const n1 = (await q(`SELECT count(*)::int n FROM call_recording_files WHERE call_id=$1`, [wcall])).rows[0].n, n2 = (await q(`SELECT count(*)::int n FROM call_recordings WHERE call_id=$1`, [wcall])).rows[0].n;
check("duplicate webhook x3 -> exactly ONE recording (file table + legacy table)", n1 === 1 && n2 === 1, `${n1}/${n2}`);
check("recording webhook cannot name a tenant: ownership derives from the call", (await q(`SELECT storage_key FROM call_recording_files WHERE call_id=$1`, [wcall])).rows[0].storage_key.startsWith(`customers/${S.CA.client.id}/`));
globalThis.fetch = realFetch;
// production: webhooks need a signature
process.env.NODE_ENV = "production"; process.env.TELEPHONY_WEBHOOK_SECRET = "whsec-test-secret";
const sign = (body, ts = Math.floor(Date.now() / 1000), secret = "whsec-test-secret") => ({ "x-webhook-timestamp": String(ts), "x-webhook-signature": crypto.createHmac("sha256", secret).update(`${ts}.${JSON.stringify(body)}`).digest("hex") });
const body = { providerCallId: "CAnone", status: "Completed" };
check("production: unsigned webhook -> 401 (mock mode no longer accepts anything)", (await call(null, "POST", "/api/telephony/status", body)).status === 401);
check("production: wrong signature -> 401", (await call(null, "POST", "/api/telephony/status", body, sign(body, undefined, "other-secret"))).status === 401);
check("production: replayed (old timestamp) -> 401", (await call(null, "POST", "/api/telephony/status", body, sign(body, Math.floor(Date.now() / 1000) - 3600))).status === 401);
check("production: valid HMAC + fresh timestamp -> accepted", (await call(null, "POST", "/api/telephony/status", body, sign(body))).status === 200);
delete process.env.TELEPHONY_WEBHOOK_SECRET;
check("production without a webhook secret: always 401", (await call(null, "POST", "/api/telephony/status", body, sign(body))).status === 401);
process.env.NODE_ENV = "test";

console.log("\n== Audit trail ==");
await call(S.staff.MANAGER.token, "GET", `/api/recordings/${rid}/url?download=1`);
const del = await saveRecording({ callId: S.callA2, buffer: WAV, contentType: "audio/wav" });
await call(S.staff.MANAGER.token, "DELETE", `/api/recordings/${del.id}`);
const acts = (await q(`SELECT DISTINCT action FROM audit_logs`)).rows.map((r) => r.action);
check("recording play / download / upload / delete are audited", ["recording_play", "recording_download", "recording_upload", "recording_delete"].every((a) => acts.includes(a)), acts.join());
const row = (await q(`SELECT actor_id, actor_role, ip, result FROM audit_logs WHERE action='recording_play' AND actor_role='CUSTOMER' LIMIT 1`)).rows[0];
check("audit rows carry actor, role, IP and result", row && row.actor_id && row.actor_role === "CUSTOMER" && row.ip && row.result === "success", JSON.stringify(row));
const all = (await q(`SELECT string_agg(coalesce(meta::text,'') || coalesce(user_agent,''), ' ') t FROM audit_logs`)).rows[0].t || "";
check("audit records never contain tokens, passwords or secrets", !/Bearer|eyJ|Passw0rd|whsec/.test(all));

await ctx.stop();
const s = t.summary(); console.log(`\n${s.pass} passed, ${s.fail} failed`); if (s.fail) console.log(s.failures); process.exit(s.fail ? 1 : 0);
