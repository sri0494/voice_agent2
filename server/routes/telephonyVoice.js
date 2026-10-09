// telephonyVoice.js — the TwiML handlers Twilio actually calls during a
// live phone call. This is what makes a real Twilio call genuinely run
// LeoMox's conversation intelligence pipeline end-to-end: Twilio's own
// <Gather input="speech"> does speech-to-text, we run the transcribed text
// through conversationOrchestrator.js (the same pipeline the Testing
// Playground uses), and Twilio's <Say> speaks the response back — no
// separate paid STT/TTS vendor required.
//
// These endpoints are PUBLIC (no requireAuth) because Twilio calls them
// directly, but every request is validated via the real Twilio HMAC-SHA1
// signature (see utils/twilioSignature.js) before anything runs.
import { Router } from "express";
import { query } from "../db/pool.js";
import { ApiError } from "../middleware/errorHandler.js";
import { validateTwilioSignature } from "../utils/twilioSignature.js";
import { processConversationTurn } from "../services/conversation/conversationOrchestrator.js";
import { logger } from "../utils/logger.js";
import { webhookLimiter } from "../middleware/rateLimit.js";
import { publishCallUpdate } from "../services/liveCalls.js";
import { createTelephonyProvider } from "../services/telephony/TelephonyProvider.js";

const telephony = createTelephonyProvider();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const YES = /\b(yes|yeah|yep|ok|okay|sure|agree|agreed|haan|ha|han|theek hai|avunu|sare|sari|oppukuntanu)\b/i;
const NO = /\b(no|nope|nahi|nahin|never|dont|don.?t|do not|kaadu|vaddu|ledu)\b/i;

const router = Router();
router.use(webhookLimiter);

const LANGUAGE_TO_TWILIO_LOCALE = { English: "en-IN", Telugu: "te-IN", Hindi: "hi-IN" };

function escapeXml(text = "") {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function requireTwilioSignature(req, res) {
  if (!validateTwilioSignature(req, process.env.TELEPHONY_API_SECRET)) {
    res.status(401).send("Invalid signature");
    return false;
  }
  return true;
}

function sayAndGather({ text, actionUrl, locale }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" action="${actionUrl}" method="POST" speechTimeout="auto" language="${locale}">
    <Say language="${locale}">${escapeXml(text)}</Say>
  </Gather>
  <Say language="${locale}">We didn't hear anything. Goodbye.</Say>
  <Hangup/>
</Response>`;
}

function sayAndHangup({ text, locale }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="${locale}">${escapeXml(text)}</Say>
  <Hangup/>
</Response>`;
}

function sayAndDial({ text, toNumber, locale }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="${locale}">${escapeXml(text)}</Say>
  <Dial>${escapeXml(toNumber)}</Dial>
</Response>`;
}

async function loadCallAndAgent(callId) {
  if (!UUID_RE.test(String(callId))) return null;
  const { rows } = await query(
    `SELECT c.*, a.greeting, a.language, a.transfer_number, a.max_call_duration_sec, a.id AS agent_id,
            a.recording_enabled, a.recording_consent, a.recording_consent_message
     FROM calls c JOIN agents a ON a.id = c.agent_id WHERE c.id = $1`,
    [callId]
  );
  return rows[0];
}

async function logMessage(callId, speaker, content, sequence) {
  await query(
    `INSERT INTO call_messages (call_id, speaker, content, sequence) VALUES ($1,$2,$3,$4)`,
    [callId, speaker, content, sequence]
  );
}

// --- Initial call answer: Twilio hits this as soon as the call connects ---
router.post("/voice/:callId", async (req, res) => {
  if (!requireTwilioSignature(req, res)) return;
  res.set("Content-Type", "text/xml");

  try {
    const call = await loadCallAndAgent(req.params.callId);
    if (!call) return res.send(sayAndHangup({ text: "Sorry, this call could not be set up.", locale: "en-IN" }));

    await query(`UPDATE calls SET status = 'Connected', updated_at = now() WHERE id = $1 AND status IN ('Ringing','Connected')`, [call.id]);
    publishCallUpdate(call.id);

    const locale = LANGUAGE_TO_TWILIO_LOCALE[call.language] || "en-IN";

    // Recording consent (configurable per agent): ask first; the call is only recorded if the caller agrees.
    if (call.recording_enabled && call.recording_consent === "REQUIRED" && !call.consent_status) {
      const prompt = call.recording_consent_message || "This call may be recorded. Do you agree to continue? Please say yes or no.";
      return res.send(sayAndGather({
        text: prompt, locale,
        actionUrl: `${(process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "")}/api/telephony/voice/${call.id}/consent`,
      }));
    }
    const greeting = call.greeting || "Hello, how can I help you today?";
    await logMessage(call.id, "AI", greeting, 1);

    res.send(sayAndGather({
      text: greeting,
      actionUrl: `${(process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "")}/api/telephony/voice/${call.id}/respond`,
      locale,
    }));
  } catch (err) {
    logger.error("twilio_voice_initial_failed", { callId: req.params.callId, error: err.message });
    res.send(sayAndHangup({ text: "Sorry, something went wrong on our end.", locale: "en-IN" }));
  }
});

// --- Consent answer: stored on the call; recording starts ONLY after an explicit "yes" ---
router.post("/voice/:callId/consent", async (req, res) => {
  if (!requireTwilioSignature(req, res)) return;
  res.set("Content-Type", "text/xml");
  try {
    const call = await loadCallAndAgent(req.params.callId);
    if (!call) return res.send(sayAndHangup({ text: "Sorry, this call could not be found.", locale: "en-IN" }));
    const locale = LANGUAGE_TO_TWILIO_LOCALE[call.language] || "en-IN";
    const said = String(req.body.SpeechResult || "");
    const granted = YES.test(said) && !NO.test(said);                      // anything unclear counts as NOT granted
    await query(
      `UPDATE calls SET consent_status = $2, consent_at = now(), consent_method = 'VOICE_PROMPT', updated_at = now()
       WHERE id = $1 AND consent_status IS NULL`, [call.id, granted ? "GRANTED" : "DECLINED"]);
    if (granted && call.provider_call_id) {
      telephony.startRecording(call.provider_call_id).catch((e) => logger.warn("recording_start_failed", { callId: call.id, error: e.message }));
    }
    const greeting = call.greeting || "Hello, how can I help you today?";
    await logMessage(call.id, "AI", greeting, 1);
    res.send(sayAndGather({
      text: granted ? greeting : `Understood, this call will not be recorded. ${greeting}`, locale,
      actionUrl: `${(process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "")}/api/telephony/voice/${call.id}/respond`,
    }));
  } catch (err) {
    logger.error("twilio_voice_consent_failed", { callId: req.params.callId, error: err.message });
    res.send(sayAndHangup({ text: "Sorry, something went wrong on our end.", locale: "en-IN" }));
  }
});

// --- Every subsequent turn: Twilio posts the transcribed SpeechResult here ---
router.post("/voice/:callId/respond", async (req, res) => {
  if (!requireTwilioSignature(req, res)) return;
  res.set("Content-Type", "text/xml");

  const call = await loadCallAndAgent(req.params.callId);
  if (!call) return res.send(sayAndHangup({ text: "Sorry, this call could not be found.", locale: "en-IN" }));

  const locale = LANGUAGE_TO_TWILIO_LOCALE[call.language] || "en-IN";
  const actionUrl = `${(process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "")}/api/telephony/voice/${call.id}/respond`;
  const speechResult = req.body.SpeechResult;

  try {
    // Enforce the agent's configured max call duration as a hard stop,
    // independent of the conversation content.
    const elapsedSec = call.started_at ? (Date.now() - new Date(call.started_at).getTime()) / 1000 : 0;
    if (elapsedSec > (call.max_call_duration_sec || 600)) {
      await query(`UPDATE calls SET status = 'Completed', ended_at = now(), updated_at = now() WHERE id = $1`, [call.id]);
      publishCallUpdate(call.id);
      return res.send(sayAndHangup({ text: "We've reached the maximum call time. Thank you for calling. Goodbye.", locale }));
    }

    if (!speechResult) {
      // No speech detected — give one gentle re-prompt rather than hanging up immediately.
      return res.send(sayAndGather({ text: "Sorry, I didn't catch that. Could you say that again?", actionUrl, locale }));
    }

    const { rows: msgRows } = await query(`SELECT * FROM call_messages WHERE call_id = $1 ORDER BY sequence ASC`, [call.id]);
    const nextSequence = msgRows.length + 1;
    await logMessage(call.id, "CUSTOMER", speechResult, nextSequence);

    const conversationHistory = msgRows.map((m) => ({
      role: m.speaker === "AI" ? "assistant" : "user",
      content: m.content,
    }));

    const result = await processConversationTurn({
      agentId: call.agent_id,
      callId: call.id,
      customerText: speechResult,
      conversationHistory,
    });

    await logMessage(call.id, "AI", result.response, nextSequence + 1);
    await query(
      `UPDATE calls SET intent = $2, sentiment = $3, ai_resolved = $4, updated_at = now() WHERE id = $1`,
      [call.id, result.intent, result.sentiment, result.next_action !== "transfer"]
    );

    if (result.next_action === "transfer") {
      await query(`UPDATE calls SET status = 'Transferred', updated_at = now() WHERE id = $1`, [call.id]);
      publishCallUpdate(call.id);
      if (!call.transfer_number) {
        return res.send(sayAndHangup({ text: `${result.response} Unfortunately no transfer number is configured for this agent.`, locale }));
      }
      return res.send(sayAndDial({ text: result.response, toNumber: call.transfer_number, locale }));
    }

    if (result.next_action === "end_call" || result.next_action === "complete_survey") {
      await query(`UPDATE calls SET status = 'Completed', ended_at = now(), updated_at = now() WHERE id = $1`, [call.id]);
      publishCallUpdate(call.id);
      return res.send(sayAndHangup({ text: result.response, locale }));
    }

    res.send(sayAndGather({ text: result.response, actionUrl, locale }));
  } catch (err) {
    logger.error("twilio_voice_respond_failed", { callId: req.params.callId, error: err.message });
    res.send(sayAndHangup({ text: "Sorry, something went wrong on our end. We'll follow up with you shortly.", locale }));
  }
});

export default router;
