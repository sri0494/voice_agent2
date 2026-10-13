// Exotel Voicebot / AgentStream WebSocket endpoint:  wss://<PUBLIC_BASE_URL host>/ws/exotel?token=<TELEPHONY_WEBHOOK_SECRET>
// Protocol (Exotel): inbound JSON events connected | start | media | dtmf | mark | stop; we reply with media | mark | clear.
// Audio is raw PCM16 mono (8k/16k/24k), base64 in media.payload; outbound chunks must be multiples of 320 bytes.
// Authentication: the shared secret is required (query ?token= or Basic-auth password in the wss URL). Without a configured
// secret the endpoint refuses every connection. The call is resolved from the start event's call_sid (calls.provider_call_id).
import { WebSocketServer } from "ws";
import crypto from "node:crypto";
import { query } from "../../db/pool.js";
import { createSTTProvider } from "../speech/SpeechToTextProvider.js";
import { createTTSProvider } from "../speech/TextToSpeechProvider.js";
import { registerUpgrade, refuseUpgrade } from "../wsRouter.js";
import { VoiceCallSession } from "./VoiceCallSession.js";
import { logger } from "../../utils/logger.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_STREAMS = Number(process.env.VOICE_MAX_STREAMS) || 50;
const ALLOWED_RATES = new Set([8000, 16000, 24000]);
let wss = null; let deps = null; const live = new Set();

export function __setVoiceDepsForTests(d) { if (process.env.NODE_ENV !== "test") throw new Error("test hook"); deps = d; }
const getDeps = () => deps || (deps = { stt: createSTTProvider(), tts: createTTSProvider() });

const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

export function streamAuthorized(req, url, secret = process.env.TELEPHONY_WEBHOOK_SECRET) {
  if (!secret) return false;
  const q = url.searchParams.get("token"); if (q && safeEq(q, secret)) return true;
  const m = /^Basic (.+)$/i.exec(String(req.headers.authorization || ""));
  if (m) { const pass = Buffer.from(m[1], "base64").toString().split(":").slice(1).join(":"); if (pass && safeEq(pass, secret)) return true; }
  return false;
}

async function resolveCall(callSid, customCallId) {
  for (let i = 0; i < 10; i++) {                                  // the stream can start before placeCall() has stored the CallSid
    const { rows } = await query(`SELECT id, status FROM calls WHERE provider_call_id = $1`, [String(callSid || "")]);
    if (rows[0]) return rows[0];
    if (customCallId && UUID_RE.test(String(customCallId))) {       // fallback: our own id passed as a custom parameter; only if it has no CallSid yet
      const r = await query(`SELECT id, status FROM calls WHERE id = $1 AND (provider_call_id IS NULL OR provider_call_id = $2)`, [customCallId, String(callSid || "")]);
      if (r.rows[0] && i >= 3) return r.rows[0];
    }
    await new Promise((r) => setTimeout(r, Number(process.env.VOICE_RESOLVE_WAIT_MS) || 300));
  }
  return null;
}

export function attachExotelStreamServer(server, { path = "/ws/exotel" } = {}) {
  wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
  registerUpgrade(server, path, async (req, socket, head) => {
    let url; try { url = new URL(req.url, "http://localhost"); } catch { return socket.destroy(); }
    if (!streamAuthorized(req, url)) return refuseUpgrade(socket, 401, "Unauthorized");
    if (live.size >= MAX_STREAMS) return refuseUpgrade(socket, 503, "Too many active voice streams");
    wss.handleUpgrade(req, socket, head, (ws) => handleConnection(ws));
  });
  return wss;
}

export function closeExotelStreamServer() { for (const s of live) { try { s.ws.close(); } catch { /* ignore */ } } live.clear(); try { wss?.close(); } catch { /* ignore */ } wss = null; }

function handleConnection(ws) {
  const entry = { ws, session: null }; live.add(entry);
  let streamSid = null, ticker = null, starting = false;
  const send = (obj) => { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); };

  const onStart = async (msg) => {
    if (starting || entry.session) return; starting = true;
    const s = msg.start || {}; streamSid = s.stream_sid || msg.stream_sid;
    const callRow = await resolveCall(s.call_sid, s.custom_parameters?.call_id || s.custom_parameters?.callId);
    if (!callRow) { logger.warn("voice_stream_unknown_call", { callSid: s.call_sid }); return ws.close(1008, "unknown call"); }
    if (["Completed", "Failed", "Missed"].includes(callRow.status)) return ws.close(1008, "call already finished");
    const rate = Number(s.media_format?.sample_rate) || Number(process.env.EXOTEL_STREAM_SAMPLE_RATE) || 16000;
    if (!ALLOWED_RATES.has(rate)) { logger.warn("voice_stream_bad_rate", { rate }); return ws.close(1008, "unsupported sample rate"); }
    const { stt, tts } = getDeps();
    entry.session = new VoiceCallSession({
      callId: callRow.id, stt, tts, sampleRate: rate,
      sendAudio: (pcm) => send({ event: "media", stream_sid: streamSid, media: { payload: pcm.toString("base64") } }),
      endStream: () => ws.close(1000, "call finished"),
    });
    ticker = setInterval(() => entry.session?.tick(), 1000); ticker.unref?.();
    await entry.session.start();
  };

  ws.on("message", (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
    switch (msg.event) {
      case "start": onStart(msg).catch((e) => { logger.error("voice_stream_start_failed", { error: e.message }); ws.close(1011, "error"); }); break;
      case "media": { const p = msg.media?.payload; if (p && entry.session) entry.session.onAudio(Buffer.from(p, "base64")); break; }
      case "stop": ws.close(1000, "stopped"); break;
      default: break;                                              // connected | dtmf | mark: nothing to do
    }
  });
  ws.on("close", () => { clearInterval(ticker); entry.session?.close(); live.delete(entry); });
  ws.on("error", (e) => logger.warn("voice_stream_error", { error: e.message }));
}
