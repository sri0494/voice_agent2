// Exotel + Sarvam: provider request shape, speech adapters, token-authenticated webhooks, voice-stream auth and a full spoken turn.
process.env.TELEPHONY_PROVIDER = "exotel";
process.env.TELEPHONY_API_KEY = "exo-key"; process.env.TELEPHONY_API_SECRET = "exo-token"; process.env.EXOTEL_ACCOUNT_SID = "acme1";
process.env.EXOTEL_FLOW_URL = "http://my.exotel.com/acme1/exoml/start_voice/123"; process.env.TELEPHONY_PHONE_NUMBER = "08012345678";
process.env.TELEPHONY_WEBHOOK_SECRET = "s3cret-s3cret-s3cret-s3cret-0123";
process.env.VOICE_RESOLVE_WAIT_MS = "50"; process.env.VOICE_VAD_RMS = "500"; process.env.VOICE_IDLE_MS = "600000";
import WebSocket from "ws";
import { boot, makeRunner } from "./harness.mjs";
import { seed } from "./fixtures.mjs";

const ctx = await boot(); const t = makeRunner(ctx); const { check } = t;
const S = await seed(ctx, t); const q = ctx.query; const SECRET = process.env.TELEPHONY_WEBHOOK_SECRET;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { ExotelProvider } = await import("../server/services/telephony/TelephonyProvider.js");
const { SarvamSTTProvider } = await import("../server/services/speech/SpeechToTextProvider.js");
const { SarvamTTSProvider } = await import("../server/services/speech/TextToSpeechProvider.js");
const { pcm16ToWav, wavToPcm16, chunkPcm, rms } = await import("../server/services/voice/audio.js");
const { validateEnv } = await import("../server/config/env.js");
const { __setVoiceDepsForTests } = await import("../server/services/voice/exotelStream.js");
const { isConsentGranted, __setTurnFnForTests } = await import("../server/services/voice/VoiceCallSession.js");
const turns = []; let nextAction = "continue";
__setTurnFnForTests(async (a) => { turns.push(a); return { response: `reply to: ${a.customerText}`, intent: "survey_answer", sentiment: "Positive", next_action: nextAction }; });

console.log("\n== Audio helpers ==");
const pcm = Buffer.alloc(6400); for (let i = 0; i < 3200; i++) pcm.writeInt16LE(Math.round(Math.sin(i / 5) * 8000), i * 2);
const back = wavToPcm16(pcm16ToWav(pcm, 16000));
check("WAV wrap/unwrap round-trips PCM16 and sample rate", back.pcm.equals(pcm) && back.sampleRate === 16000);
check("every outbound chunk is a multiple of 320 bytes (Exotel rule)", chunkPcm(Buffer.alloc(7001)).every((c) => c.length % 320 === 0) && chunkPcm(Buffer.alloc(7001)).length === 3);
check("silence has ~0 energy, a loud tone is above the VAD threshold", rms(Buffer.alloc(3200)) === 0 && rms(pcm) > 500);
check("non-WAV input is rejected", (() => { try { wavToPcm16(Buffer.from("nope")); return false; } catch { return true; } })());
check("consent: yes/avunu/అవును granted; no/ledu/unclear declined", isConsentGranted("yes") && isConsentGranted("avunu") && isConsentGranted("అవును") && !isConsentGranted("no") && !isConsentGranted("ledu") && !isConsentGranted("hmm what") && !isConsentGranted("yes no"));

console.log("\n== ExotelProvider ==");
let seen = null;
const fakeFetch = async (url, init) => { seen = { url, init }; return { ok: true, status: 200, json: async () => ({ Call: { Sid: "EXO123", Status: "queued" } }) }; };
const exo = new ExotelProvider({ apiKey: "k", apiToken: "tk", accountSid: "acme1", subdomain: "api.in.exotel.com", fromNumber: "08012345678", flowUrl: process.env.EXOTEL_FLOW_URL, publicBaseUrl: "https://leomox.test/", webhookSecret: SECRET, fetchImpl: fakeFetch });
const r = await exo.makeCall({ to: "+919876500009", callId: "call-1" });
const body = new URLSearchParams(seen.init.body);
check("makeCall posts to the account's Calls/connect.json on the configured host", seen.url === "https://api.in.exotel.com/v1/Accounts/acme1/Calls/connect.json" && seen.init.method === "POST");
check("makeCall uses Basic auth key:token", seen.init.headers.Authorization === `Basic ${Buffer.from("k:tk").toString("base64")}`);
check("makeCall sends From=customer, CallerId=ExoPhone, flow Url, CustomField=callId", body.get("From") === "+919876500009" && body.get("CallerId") === "08012345678" && body.get("Url") === process.env.EXOTEL_FLOW_URL && body.get("CustomField") === "call-1");
check("StatusCallback points at /api/telephony/status with the secret token", body.get("StatusCallback") === `https://leomox.test/api/telephony/status?token=${encodeURIComponent(SECRET)}`);
check("returns the real CallSid and mock=false", r.providerCallId === "EXO123" && r.mock === false && !exo.isMock());
check("missing config is refused at construction", (() => { try { new ExotelProvider({ apiKey: "k" }); return false; } catch (e) { return /EXOTEL_ACCOUNT_SID/.test(e.message); } })());
const failing = new ExotelProvider({ apiKey: "k", apiToken: "t", accountSid: "a", fromNumber: "1", flowUrl: "u", publicBaseUrl: "https://x", webhookSecret: SECRET, fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ RestException: { Message: "bad auth" } }) }) });
check("API errors surface as exceptions (dialer then releases the contact)", await failing.makeCall({ to: "1" }).then(() => false, (e) => /401/.test(e.message)));
check("hangup/transfer are honestly unsupported", await exo.hangup().then(() => false, () => true) && await exo.transfer().then(() => false, () => true));

console.log("\n== Sarvam adapters ==");
let sreq = null;
const stt = new SarvamSTTProvider({ apiKey: "sk", fetchImpl: async (url, init) => { sreq = { url, init }; return { ok: true, json: async () => ({ transcript: " అవును ", language_code: "te-IN" }) }; } });
const tr = await stt.transcribe(pcm, { language: "Telugu", pcm: true, sampleRate: 16000 });
check("STT: POST /speech-to-text with api-subscription-key, te-IN, WAV multipart", sreq.url === "https://api.sarvam.ai/speech-to-text" && sreq.init.headers["api-subscription-key"] === "sk" && sreq.init.body.get("language_code") === "te-IN" && sreq.init.body.get("file").type === "audio/wav");
check("STT: returns trimmed transcript", tr.text === "అవును");
const wavOut = pcm16ToWav(pcm, 16000); let treq = null;
const tts = new SarvamTTSProvider({ apiKey: "sk", fetchImpl: async (url, init) => { treq = { url, init }; return { ok: true, json: async () => ({ audios: [wavOut.toString("base64")] }) }; } });
const sp = await tts.synthesize("నమస్కారం", { language: "Telugu", sampleRate: 16000 });
const tb = JSON.parse(treq.init.body);
check("TTS: POST /text-to-speech with te-IN, model and sample rate", treq.url === "https://api.sarvam.ai/text-to-speech" && tb.target_language_code === "te-IN" && tb.speech_sample_rate === 16000 && tb.model && treq.init.headers["api-subscription-key"] === "sk");
check("TTS: returns raw PCM16 at the requested rate", sp.pcm.equals(pcm) && sp.sampleRate === 16000);
check("TTS: text is capped at 1500 chars", (await tts.synthesize("a".repeat(3000)).then(() => JSON.parse(treq.init.body).text.length === 1500)));
check("STT/TTS refuse to start without an API key", (() => { try { new SarvamSTTProvider({}); return false; } catch { return true; } })() && (() => { try { new SarvamTTSProvider({}); return false; } catch { return true; } })());
check("Sarvam errors surface (no silent empty transcript)", await new SarvamSTTProvider({ apiKey: "k", fetchImpl: async () => ({ ok: false, status: 429, text: async () => "slow down" }) }).transcribe(pcm, { pcm: true }).then(() => false, (e) => /429/.test(e.message)));

console.log("\n== Environment validation ==");
const base = { NODE_ENV: "production", DATABASE_URL: "x", JWT_SECRET: "j".repeat(40), STORAGE_PROVIDER: "s3", S3_BUCKET: "b", S3_ACCESS_KEY_ID: "a", S3_SECRET_ACCESS_KEY: "s", CORS_ORIGIN: "https://x" };
const good = { ...base, TELEPHONY_PROVIDER: "exotel", TELEPHONY_API_KEY: "k", TELEPHONY_API_SECRET: "s", EXOTEL_ACCOUNT_SID: "a", EXOTEL_FLOW_URL: "u", TELEPHONY_PHONE_NUMBER: "1", PUBLIC_BASE_URL: "https://x", TELEPHONY_WEBHOOK_SECRET: SECRET, STT_PROVIDER: "sarvam", TTS_PROVIDER: "sarvam", STT_API_KEY: "k", TTS_API_KEY: "k", RECORDING_URL_ALLOWLIST: "recordings.exotel.com" };
check("complete exotel + sarvam config is valid", validateEnv(good).errors.length === 0);
const part = validateEnv({ ...good, EXOTEL_FLOW_URL: "", TELEPHONY_WEBHOOK_SECRET: "" });
check("exotel without EXOTEL_FLOW_URL / secret does NOT stop the site from booting; it warns by name", part.errors.length === 0 && part.warnings.some((w) => w.includes("EXOTEL_FLOW_URL")) && part.warnings.some((w) => w.includes("TELEPHONY_WEBHOOK_SECRET")));
{ const keep = process.env.EXOTEL_FLOW_URL; delete process.env.EXOTEL_FLOW_URL; process.env.TELEPHONY_PROVIDER = "exotel";
  const { createTelephonyProvider } = await import("../server/services/telephony/TelephonyProvider.js"); const quiet = console.error; console.error = () => {};
  const un = createTelephonyProvider(); console.error = quiet; let msg = ""; try { await un.makeCall({ to: "+919876500009" }); } catch (e) { msg = e.message; }
  check("missing EXOTEL_FLOW_URL at runtime: provider is created (no crash) and a call attempt says exactly what to set", msg.includes("EXOTEL_FLOW_URL") && !un.isMock());
  process.env.EXOTEL_FLOW_URL = keep; }
check("sarvam without a key is an error", validateEnv({ ...good, STT_API_KEY: "" }).errors.some((e) => /STT_PROVIDER=sarvam/.test(e)));
check("exotel with mock speech warns", validateEnv({ ...good, STT_PROVIDER: "mock" }).warnings.some((w) => /sarvam/.test(w)));
check("unknown STT provider is an error", validateEnv({ ...good, STT_PROVIDER: "foo" }).errors.length === 1);

console.log("\n== Webhooks (token-authenticated, forward-only) ==");
let n = 0;
async function newCall(extra = {}) {
  const sid = `EXO_${Date.now()}_${n++}`;
  const id = (await q(`INSERT INTO calls (campaign_id, agent_id, customer_name, phone, status, direction, provider_call_id, started_at)
    VALUES ($1,$2,'Voice Test','9876500001',$3,'OUTBOUND',$4, now()) RETURNING id`, [S.campA1, S.agentA, extra.status || "Ringing", sid])).rows[0].id;
  return { id, sid };
}
const hook = (path, form, token = SECRET) => fetch(`${ctx.base}/api/telephony/${path}${token === null ? "" : `?token=${encodeURIComponent(token)}`}`, {
  method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form).toString() });
const st = async (id) => (await q(`SELECT status, duration_sec, ended_at FROM calls WHERE id = $1`, [id])).rows[0];
const c1 = await newCall();
check("status without token -> 401", (await hook("status", { CallSid: c1.sid, Status: "completed" }, null)).status === 401);
check("status with wrong token -> 401", (await hook("status", { CallSid: c1.sid, Status: "completed" }, "wrong")).status === 401);
check("a rejected callback changed nothing", (await st(c1.id)).status === "Ringing");
await hook("status", { CallSid: c1.sid, Status: "in-progress" });
check("in-progress -> Connected", (await st(c1.id)).status === "Connected");
await hook("status", { CallSid: c1.sid, Status: "completed", Duration: "42" });
const done = await st(c1.id);
check("completed -> Completed with duration and end time", done.status === "Completed" && done.duration_sec === 42 && done.ended_at);
await hook("status", { CallSid: c1.sid, Status: "in-progress" });
check("a late/duplicate callback never regresses a finished call", (await st(c1.id)).status === "Completed");
const c2 = await newCall(); await hook("status", { CallSid: c2.sid, Status: "no-answer" });
const c3 = await newCall(); await hook("status", { CallSid: c3.sid, Status: "busy" });
check("no-answer -> Missed, busy -> Failed", (await st(c2.id)).status === "Missed" && (await st(c3.id)).status === "Failed");
check("unknown CallSid is accepted quietly (no data leak, no crash)", (await hook("status", { CallSid: "nope", Status: "completed" })).status === 200);

console.log("\n== Recording consent on Exotel recordings ==");
const rec = (id) => q(`SELECT 1 FROM call_recordings WHERE call_id = $1`, [id]).then((x) => x.rows.length);
const d1 = await newCall(), g1 = await newCall();
await q(`UPDATE agents SET recording_enabled = true, recording_consent = 'REQUIRED' WHERE id = $1`, [S.agentA]);
await q(`UPDATE calls SET consent_status = 'DECLINED' WHERE id = $1`, [d1.id]); await q(`UPDATE calls SET consent_status = 'GRANTED' WHERE id = $1`, [g1.id]);
await hook("status", { CallSid: d1.sid, Status: "completed", RecordingUrl: "https://recordings.exotel.test/a.mp3" });
await hook("status", { CallSid: g1.sid, Status: "completed", RecordingUrl: "https://recordings.exotel.test/b.mp3" });
check("declined caller: Exotel recording is NOT stored", (await rec(d1.id)) === 0);
check("consenting caller: recording URL is recorded for ingestion", (await rec(g1.id)) === 1);
check("no recording is kept in our bucket for the declined call", (await q(`SELECT 1 FROM call_recording_files WHERE call_id = $1`, [d1.id])).rows.length === 0);

console.log("\n== Voice stream: authentication ==");
const wsUrl = (qs = "") => `ws://127.0.0.1:${ctx.port}/ws/exotel${qs}`;
function open(url, opts) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, opts); const c = { ws, status: null, frames: [], closed: null };
    ws.on("open", () => { c.status = 101; resolve(c); });
    ws.on("unexpected-response", (req, res) => { c.status = res.statusCode; resolve(c); });
    ws.on("error", () => { if (c.status === null) { c.status = 0; resolve(c); } });
    ws.on("message", (m) => c.frames.push(JSON.parse(m.toString())));
    ws.on("close", (code) => { c.closed = code; });
  });
}
check("no token -> 401", (await open(wsUrl())).status === 401);
check("wrong token -> 401", (await open(wsUrl("?token=wrong"))).status === 401);
check("a JWT (staff token) is not accepted as the stream secret", (await open(wsUrl(`?token=${S.admin}`))).status === 401);
const basic = await open(`ws://x:${encodeURIComponent(SECRET)}@127.0.0.1:${ctx.port}/ws/exotel`);
check("Basic-auth password is accepted", basic.status === 101); basic.ws.close();
const tokOk = await open(wsUrl(`?token=${encodeURIComponent(SECRET)}`));
check("?token= is accepted", tokOk.status === 101);
tokOk.ws.send(JSON.stringify({ event: "start", start: { stream_sid: "s0", call_sid: "NO_SUCH_CALL", media_format: { sample_rate: 16000 } } }));
await sleep(900);
check("a start event for an unknown call closes the stream", tokOk.closed !== null);
check("live-calls socket still works next to the voice socket (shared upgrade router)", (await open(`ws://127.0.0.1:${ctx.port}/ws/live-calls`, ["leomox.v1", S.admin])).status === 101);
check("an unknown socket path is dropped", (await open(`ws://127.0.0.1:${ctx.port}/ws/other`)).status === 0);

console.log("\n== Voice stream: a spoken conversation ==");
const said = []; const spoken = [];
__setVoiceDepsForTests({
  stt: { transcribe: async (audio, o) => { said.push({ bytes: audio.length, o }); return { text: said.next?.shift() ?? "hello" }; } },
  tts: { synthesize: async (text) => { spoken.push(text); return { pcm: Buffer.alloc(3200), sampleRate: 16000 }; } },
});
const loud = Buffer.alloc(3200); for (let i = 0; i < 1600; i++) loud.writeInt16LE(i % 2 ? 6000 : -6000, i * 2);
const silent = Buffer.alloc(3200);
const frame = (b) => JSON.stringify({ event: "media", stream_sid: "s1", media: { payload: b.toString("base64") } });
async function speak(c) { for (let i = 0; i < 5; i++) c.ws.send(frame(loud)); for (let i = 0; i < 10; i++) c.ws.send(frame(silent)); }
const media = (c) => c.frames.filter((f) => f.event === "media");

const cc = await newCall(); await q(`UPDATE calls SET consent_status = NULL WHERE id = $1`, [cc.id]);
await q(`UPDATE agents SET recording_enabled = true, recording_consent = 'REQUIRED', recording_consent_message = 'Consent please', greeting = 'Namaskaram GREETING' WHERE id = $1`, [S.agentA]);
said.next = ["avunu", "my blood pressure is fine"];
const v = await open(wsUrl(`?token=${encodeURIComponent(SECRET)}`));
v.ws.send(JSON.stringify({ event: "connected" }));
v.ws.send(JSON.stringify({ event: "start", start: { stream_sid: "s1", call_sid: cc.sid, media_format: { encoding: "raw/pcm16", sample_rate: 16000 } } }));
await sleep(800);
check("call becomes Connected and the consent prompt is spoken first", (await st(cc.id)).status === "Connected" && spoken[0] === "Consent please");
check("audio frames are base64 PCM16, multiples of 320 bytes, tagged with the stream_sid", media(v).length > 0 && media(v).every((f) => f.stream_sid === "s1" && Buffer.from(f.media.payload, "base64").length % 320 === 0));
await speak(v); await sleep(900);
const afterConsent = (await q(`SELECT consent_status, consent_method FROM calls WHERE id = $1`, [cc.id])).rows[0];
check("caller's 'avunu' is transcribed (Telugu, PCM) and stored as GRANTED / VOICE_PROMPT", afterConsent.consent_status === "GRANTED" && afterConsent.consent_method === "VOICE_PROMPT" && said[0].o.language === "Telugu" && said[0].o.pcm === true);
check("the greeting is spoken after consent", spoken.includes("Namaskaram GREETING"));
await sleep(700); await speak(v); await sleep(1500);
const msgs = (await q(`SELECT speaker, content FROM call_messages WHERE call_id = $1 ORDER BY sequence`, [cc.id])).rows;
check("the next utterance goes through the orchestrator and both sides are logged in order", msgs.some((m) => m.speaker === "CUSTOMER" && m.content === "my blood pressure is fine") && msgs.at(-1).speaker === "AI" && spoken.length >= 3);
check("orchestrator received this agent, call and the prior history", turns[0]?.agentId === S.agentA && turns[0]?.callId === cc.id && turns[0].conversationHistory.some((m) => m.role === "assistant"));
check("sequence numbers stay unique per call", new Set((await q(`SELECT sequence FROM call_messages WHERE call_id = $1`, [cc.id])).rows.map((r) => r.sequence)).size === msgs.length);

console.log("\n== Voice stream: limits, noise, hang-up ==");
const ai = (await q(`SELECT intent, sentiment FROM calls WHERE id = $1`, [cc.id])).rows[0];
check("intent and sentiment are saved on the call", ai.intent === "survey_answer" && ai.sentiment === "Positive");
const quiet = spoken.length; for (let i = 0; i < 20; i++) v.ws.send(frame(silent)); await sleep(300);
check("silence / noise below the threshold triggers no STT call and no reply", spoken.length === quiet);
await q(`UPDATE agents SET recording_consent = 'NOT_REQUIRED', max_call_duration_sec = 60 WHERE id = $1`, [S.agentA]);
const ml = await newCall(); await q(`UPDATE calls SET started_at = now() - interval '1 hour' WHERE id = $1`, [ml.id]);
said.next = ["anything"];
const vm = await open(wsUrl(`?token=${encodeURIComponent(SECRET)}`));
vm.ws.send(JSON.stringify({ event: "start", start: { stream_sid: "sm", call_sid: ml.sid, media_format: { sample_rate: 16000 } } }));
await sleep(900); await speak(vm); await sleep(2500);
check("max call duration is enforced: call Completed and the stream closed by the server", (await st(ml.id)).status === "Completed" && vm.closed !== null && !turns.some((x) => x.callId === ml.id));
const hu = await newCall(); const v2 = await open(wsUrl(`?token=${encodeURIComponent(SECRET)}`));
v2.ws.send(JSON.stringify({ event: "start", start: { stream_sid: "s2", call_sid: hu.sid, media_format: { sample_rate: 16000 } } })); await sleep(600);
v2.ws.send(JSON.stringify({ event: "stop" })); await sleep(300);
check("caller hanging up (stop) closes the stream but does not force a final status (Exotel's callback decides)", v2.closed !== null && (await st(hu.id)).status === "Connected");
const fin2 = await newCall(); await q(`UPDATE calls SET status = 'Completed' WHERE id = $1`, [fin2.id]);
const v3 = await open(wsUrl(`?token=${encodeURIComponent(SECRET)}`));
v3.ws.send(JSON.stringify({ event: "start", start: { stream_sid: "s3", call_sid: fin2.sid, media_format: { sample_rate: 16000 } } })); await sleep(600);
check("a stream for an already-finished call is refused", v3.closed !== null && spoken.at(-1) !== undefined && media(v3).length === 0);
const v4 = await open(wsUrl(`?token=${encodeURIComponent(SECRET)}`)); const bad = await newCall();
v4.ws.send(JSON.stringify({ event: "start", start: { stream_sid: "s4", call_sid: bad.sid, media_format: { sample_rate: 44100 } } })); await sleep(600);
check("an unsupported sample rate is refused", v4.closed !== null);
v4.ws.send("not json"); v.ws.close();

console.log("\n== Voice stream: survey completion and transfer ==");
await q(`UPDATE agents SET recording_consent = 'NOT_REQUIRED', max_call_duration_sec = 600 WHERE id = $1`, [S.agentA]);
for (const [action, want] of [["complete_survey", "Completed"], ["transfer", "Transferred"]]) {
  const x = await newCall(); nextAction = action; said.next = ["done"];
  const w = await open(wsUrl(`?token=${encodeURIComponent(SECRET)}`));
  w.ws.send(JSON.stringify({ event: "start", start: { stream_sid: "sx", call_sid: x.sid, media_format: { sample_rate: 8000 } } }));
  await sleep(1000); await speak(w); await sleep(2500);
  const row = await st(x.id);
  check(`${action}: farewell spoken, status ${want}, stream closed by the server`, row.status === want && w.closed !== null && spoken.includes("reply to: done"));
  if (action === "complete_survey") check("completed survey call has an end time", Boolean(row.ended_at));
}

await ctx.stop();
const { pass, fail, failures } = t.summary();
console.log(`\n${pass} passed, ${fail} failed`); if (fail) { console.log("FAIL:", failures.join(" | ")); process.exit(1); }
