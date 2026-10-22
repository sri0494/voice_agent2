// VoiceCallSession — transport-agnostic conversation for ONE live phone call over a raw audio stream.
//   caller audio (PCM16 mono) -> energy VAD -> Sarvam STT -> [consent | conversationOrchestrator (Gemini)] -> Sarvam TTS -> caller audio
// It mirrors the Twilio TwiML flow in routes/telephonyVoice.js (consent first, then turns, max duration, transfer/end) so both
// providers behave identically. The WebSocket protocol (Exotel) lives in exotelStream.js; this class only needs sendAudio()/endStream().
import { query } from "../../db/pool.js";
import { processConversationTurn } from "../conversation/conversationOrchestrator.js";
import { publishCallUpdate } from "../liveCalls.js";
import { logger } from "../../utils/logger.js";
import { rms, chunkPcm } from "./audio.js";

const YES = /\b(yes|yeah|yep|ok|okay|sure|agree|agreed|haan|ha|han|theek hai|avunu|sare|sari|oppukuntanu)\b|అవును|సరే|ఒప్పుకుంటాను|హాన్|हाँ|हां|ठीक है/i;
const NO = /\b(no|nope|nahi|nahin|never|dont|don.?t|do not|kaadu|vaddu|ledu)\b|కాదు|వద్దు|లేదు|नहीं|नही/i;
export const isConsentGranted = (said) => YES.test(said) && !NO.test(said);   // anything unclear counts as NOT granted

// Test hook: the real orchestrator needs the full production schema (conversation_sessions etc.), which the test fixture lacks.
let turnFn = processConversationTurn;
export function __setTurnFnForTests(f) { if (process.env.NODE_ENV !== "test") throw new Error("test hook"); turnFn = f || processConversationTurn; }

const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);

export class VoiceCallSession {
  constructor({ callId, stt, tts, sendAudio, endStream, sampleRate = 16000, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), vad = {} }) {
    Object.assign(this, { callId, stt, tts, sendAudio, endStream, sampleRate, now, sleep });
    this.vad = {
      rms: num(vad.rms ?? process.env.VOICE_VAD_RMS, 500), silenceMs: num(vad.silenceMs ?? process.env.VOICE_SILENCE_MS, 800),
      minSpeechMs: num(vad.minSpeechMs, 300), maxUtteranceMs: num(vad.maxUtteranceMs, 15000),
    };
    this.state = "new"; this.call = null; this.chain = Promise.resolve(); this.closed = false; this.consentGranted = null;
    this.buf = []; this.bufMs = 0; this.speechMs = 0; this.silenceMs = 0; this.deafUntil = 0; this.lastActivity = now(); this.reprompts = 0;
  }

  bytesToMs(n) { return (n / 2 / this.sampleRate) * 1000; }

  async load() {
    const { rows } = await query(
      `SELECT c.*, a.greeting, a.language, a.transfer_number, a.max_call_duration_sec, a.id AS agent_id,
              a.recording_enabled, a.recording_consent, a.recording_consent_message
       FROM calls c JOIN agents a ON a.id = c.agent_id WHERE c.id = $1`, [this.callId]);
    this.call = rows[0] || null; return this.call;
  }

  async log(speaker, content) {
    const { rows } = await query(`SELECT COALESCE(MAX(sequence),0)+1 AS n FROM call_messages WHERE call_id = $1`, [this.callId]);
    await query(`INSERT INTO call_messages (call_id, speaker, content, sequence) VALUES ($1,$2,$3,$4)`, [this.callId, speaker, content, rows[0].n]);
  }

  /** Speak `text` to the caller and mute our own listening until the audio has finished playing. */
  async say(text, { log = true } = {}) {
    if (this.closed || !text) return 0;
    if (log) await this.log("AI", text).catch((e) => logger.warn("voice_transcript_log_failed", { callId: this.callId, error: e.message }));   // a transcript problem must never drop the call
    let out;
    try { out = await this.tts.synthesize(text, { language: this.call?.language || "Telugu", sampleRate: this.sampleRate }); }
    catch (e) { logger.error("voice_tts_failed", { callId: this.callId, error: e.message }); return 0; }
    const pcm = out?.pcm;
    if (!pcm?.length) return 0;                                  // mock TTS: nothing to play
    for (const c of chunkPcm(pcm)) this.sendAudio(c);
    const ms = this.bytesToMs(pcm.length);
    this.deafUntil = this.now() + ms + 400;
    this.buf = []; this.bufMs = 0; this.speechMs = 0; this.silenceMs = 0; this.lastActivity = this.deafUntil;
    return ms;
  }

  async start() {
    if (!(await this.load())) { logger.warn("voice_call_not_found", { callId: this.callId }); this.endStream?.(); return false; }
    await query(`UPDATE calls SET status = 'Connected', updated_at = now() WHERE id = $1 AND status IN ('Ringing','Connected')`, [this.callId]);
    publishCallUpdate(this.callId);
    const c = this.call;
    if (c.recording_enabled && c.recording_consent === "REQUIRED" && !c.consent_status) {
      this.state = "consent";
      await this.say(c.recording_consent_message || "This call may be recorded. Do you agree to continue? Please say yes or no.");
    } else {
      this.state = "chat";
      await this.say(c.greeting || "Hello, how can I help you today?");
    }
    return true;
  }

  /** Feed caller audio (PCM16 mono). Cheap: does energy VAD, and queues a turn when the caller stops talking. */
  onAudio(pcm) {
    if (this.closed || !pcm?.length) return;
    const t = this.now(); if (t < this.deafUntil) return;
    const ms = this.bytesToMs(pcm.length);
    if (rms(pcm) >= this.vad.rms) {
      this.buf.push(pcm); this.bufMs += ms; this.speechMs += ms; this.silenceMs = 0; this.lastActivity = t;
    } else if (this.buf.length) {
      this.buf.push(pcm); this.bufMs += ms; this.silenceMs += ms;
    }
    if (this.buf.length && (this.silenceMs >= this.vad.silenceMs || this.bufMs >= this.vad.maxUtteranceMs)) {
      const audio = Buffer.concat(this.buf), enough = this.speechMs >= this.vad.minSpeechMs;
      this.buf = []; this.bufMs = 0; this.speechMs = 0; this.silenceMs = 0;
      if (enough) this.enqueue(() => this.handleAudio(audio));
    }
  }

  enqueue(fn) { this.chain = this.chain.then(fn).catch((e) => logger.error("voice_turn_failed", { callId: this.callId, error: e.message })); return this.chain; }

  async handleAudio(audio) {
    let text = "";
    try { ({ text } = await this.stt.transcribe(audio, { language: this.call?.language || "Telugu", pcm: true, sampleRate: this.sampleRate })); }
    catch (e) { logger.error("voice_stt_failed", { callId: this.callId, error: e.message }); }
    if (!text) return;                                            // noise / nothing recognised: keep listening
    await this.handleText(text);
  }

  /** One caller utterance (already transcribed). Public so it can be driven without audio. */
  async handleText(text) {
    if (this.closed || !this.call) return;
    if (await this.overLimit()) return;
    if (this.state === "consent") return this.handleConsent(text);
    return this.handleTurn(text);
  }

  async overLimit() {
    const started = this.call?.started_at ? new Date(this.call.started_at).getTime() : this.startedAt || (this.startedAt = this.now());
    if ((this.now() - started) / 1000 <= (this.call.max_call_duration_sec || 600)) return false;
    await this.finish("Completed", "We've reached the maximum call time. Thank you. Goodbye.");
    return true;
  }

  async handleConsent(said) {
    const granted = isConsentGranted(said); this.consentGranted = granted;
    await this.log("CUSTOMER", said);
    await query(`UPDATE calls SET consent_status = $2, consent_at = now(), consent_method = 'VOICE_PROMPT', updated_at = now()
                 WHERE id = $1 AND consent_status IS NULL`, [this.callId, granted ? "GRANTED" : "DECLINED"]);
    this.state = "chat";
    const greeting = this.call.greeting || "Hello, how can I help you today?";
    await this.say(granted ? greeting : `Understood, this call will not be recorded. ${greeting}`);
  }

  async handleTurn(said) {
    const { rows: msgs } = await query(`SELECT speaker, content FROM call_messages WHERE call_id = $1 ORDER BY sequence ASC`, [this.callId]);
    await this.log("CUSTOMER", said);
    const result = await turnFn({
      agentId: this.call.agent_id, callId: this.callId, customerText: said,
      conversationHistory: msgs.map((m) => ({ role: m.speaker === "AI" ? "assistant" : "user", content: m.content })),
    });
    await query(`UPDATE calls SET intent = $2, sentiment = $3, ai_resolved = $4, updated_at = now() WHERE id = $1`,
      [this.callId, result.intent, result.sentiment, result.next_action !== "transfer"]);
    if (result.next_action === "transfer") {
      // Exotel has no documented server-side transfer: we mark the call Transferred, say the hand-off line and end the stream;
      // the Exotel flow must route onward (Connect applet) after the Voicebot applet.
      return this.finish("Transferred", result.response);
    }
    if (result.next_action === "end_call" || result.next_action === "complete_survey") return this.finish("Completed", result.response);
    await this.say(result.response);
  }

  /** Periodic housekeeping (called ~1/s by the transport): hard max-duration + one gentle re-prompt after long silence. */
  async tick() {
    if (this.closed || !this.call || this.state === "new") return;
    this.enqueue(async () => {
      if (this.closed || (await this.overLimit())) return;
      if (this.now() > this.deafUntil && this.now() - this.lastActivity > num(process.env.VOICE_IDLE_MS, 12000)) {
        if (this.reprompts >= 2) return this.finish("Completed", "I couldn't hear you, so I'll end the call now. Goodbye.");
        this.reprompts++; await this.say("Sorry, I didn't catch that. Could you say that again?", { log: false }); this.lastActivity = this.now();
      }
    });
  }

  async finish(status, farewell) {
    if (this.closed) return;
    const ms = await this.say(farewell);
    this.closed = true;
    const terminal = status === "Completed";
    await query(`UPDATE calls SET status = $2, ended_at = CASE WHEN $3 THEN now() ELSE ended_at END, updated_at = now() WHERE id = $1
                 AND (CASE status WHEN 'Completed' THEN 4 WHEN 'Failed' THEN 4 WHEN 'Missed' THEN 4 ELSE 1 END) < 4`, [this.callId, status, terminal]);
    publishCallUpdate(this.callId);
    await this.sleep(ms + 300);                                   // let the farewell finish playing before the stream is closed
    try { this.endStream?.(); } catch { /* socket already closed */ }
  }

  /** Transport closed (caller hung up or we ended). Nothing terminal is forced here: Exotel's status callback is the source of truth. */
  close() { this.closed = true; this.buf = []; }
}
