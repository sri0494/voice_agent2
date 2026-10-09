import { Router } from "express";
import crypto from "crypto";
import { query } from "../db/pool.js";
import { requireAuth, requireStaff } from "../middleware/auth.js";
import { rbac, R } from "../middleware/rbac.js";
import { ApiError } from "../middleware/errorHandler.js";
import { callLimiter, webhookLimiter } from "../middleware/rateLimit.js";
import { createTelephonyProvider } from "../services/telephony/TelephonyProvider.js";
import { placeOutboundCall } from "../services/telephony/placeCall.js";
import { ingestRecordingFromUrl } from "../services/recordings.js";
import { publishCallUpdate } from "../services/liveCalls.js";
import { audit } from "../services/audit.js";
import { validateTwilioSignature } from "../utils/twilioSignature.js";
import { logger } from "../utils/logger.js";

const router = Router();
const telephonyProvider = createTelephonyProvider();
const activeProviderName = (process.env.TELEPHONY_PROVIDER || "mock").toLowerCase();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REPLAY_WINDOW_SEC = 5 * 60;

// Webhook authentication.
//  - twilio:  X-Twilio-Signature (HMAC-SHA1 over URL + params).
//  - others (and mock in PRODUCTION): HMAC-SHA256 over "<timestamp>.<json body>" using TELEPHONY_WEBHOOK_SECRET,
//    with X-Webhook-Timestamp inside a 5-minute window (replay protection).
//  - mock outside production: accepted (nothing external calls these endpoints in development).
function validateWebhookSignature(req) {
  if (activeProviderName === "twilio") return validateTwilioSignature(req, process.env.TELEPHONY_API_SECRET);
  if (telephonyProvider.isMock() && process.env.NODE_ENV !== "production") return true;
  const secret = process.env.TELEPHONY_WEBHOOK_SECRET;
  const signature = String(req.headers["x-webhook-signature"] || "");
  const ts = Number(req.headers["x-webhook-timestamp"]);
  if (!secret || !signature || !Number.isFinite(ts)) return false;
  if (Math.abs(Date.now() / 1000 - ts) > REPLAY_WINDOW_SEC) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${ts}.${JSON.stringify(req.body)}`).digest("hex");
  try { return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected)); } catch { return false; }
}

// Maps each real provider's own status vocabulary to LeoMox's internal one.
function mapProviderStatus(status) {
  if (activeProviderName === "twilio") {
    const map = {
      queued: "Ringing", ringing: "Ringing", "in-progress": "Connected",
      completed: "Completed", busy: "Failed", failed: "Failed",
      "no-answer": "Missed", canceled: "Failed",
    };
    return map[status] || status;
  }
  return status;
}

// --- Authenticated: place an outbound call for a contact within a campaign ---
router.post("/call", requireAuth, requireStaff, rbac({ write: R.OPERATORS }), callLimiter, async (req, res, next) => {
  try {
    const { campaignId, contactId } = req.body || {};
    if (!UUID_RE.test(String(campaignId)) || !UUID_RE.test(String(contactId))) throw new ApiError(400, "campaignId and contactId are required");
    const { rows: campaignRows } = await query(`SELECT * FROM campaigns WHERE id = $1`, [campaignId]);
    const campaign = campaignRows[0];
    if (!campaign) throw new ApiError(404, "Campaign not found");
    if (!campaign.agent_id) throw new ApiError(400, "This campaign has no AI Agent assigned");
    const { rows: ownRows } = await query(`SELECT 1 FROM contacts WHERE id = $1 AND campaign_id = $2`, [contactId, campaignId]);
    if (!ownRows[0]) throw new ApiError(404, "Contact not found in this campaign");

    const { call, mock } = await placeOutboundCall({ campaignId, contactId, agentId: campaign.agent_id });
    await audit(req, { action: "call_initiate", resource: "call", resourceId: call.id, meta: { campaignId, mock } });

    res.status(201).json({
      success: true,
      data: { ...call, mock },
      message: mock ? "Mock call created — configure TELEPHONY_PROVIDER for real calls" : "Call initiated",
    });
  } catch (err) {
    if (err.message === "Contact not found") return next(new ApiError(404, err.message));
    next(err instanceof ApiError ? err : new ApiError(502, "Telephony error: the call could not be placed"));
  }
});

// --- Public webhooks (called by the telephony provider; always signature-checked and rate-limited) ---
router.post("/webhook", webhookLimiter, async (req, res, next) => {
  try {
    if (!validateWebhookSignature(req)) throw new ApiError(401, "Invalid webhook signature");
    logger.info("telephony_webhook", { event: req.body?.CallStatus || req.body?.status || "event" });
    res.json({ success: true, data: null, message: "Webhook received" });
  } catch (err) { next(err); }
});

// Call lifecycle only moves FORWARD: Ringing < Connected/Live < Transferred < Completed/Failed/Missed.
// A late or duplicate webhook can therefore never regress a finished call, double-count analytics or re-finish a contact.
const RANK_SQL = (v) => `(CASE ${v} WHEN 'Ringing' THEN 1 WHEN 'Connected' THEN 2 WHEN 'Live' THEN 2 WHEN 'Transferred' THEN 3 ELSE 4 END)`;
const TERMINAL = ["Completed", "Failed", "Missed"];

router.post("/status", webhookLimiter, async (req, res, next) => {
  try {
    if (!validateWebhookSignature(req)) throw new ApiError(401, "Invalid webhook signature");

    const providerCallId = req.body.CallSid || req.body.providerCallId;
    const rawStatus = req.body.CallStatus || req.body.status;
    const durationRaw = req.body.CallDuration ?? req.body.durationSec ?? null;
    const durationSec = durationRaw !== null && Number.isFinite(Number(durationRaw)) ? Math.max(0, Math.round(Number(durationRaw))) : null;
    const status = rawStatus ? mapProviderStatus(String(rawStatus)) : null;

    if (providerCallId && status) {
      const { rows: updatedCalls } = await query(
        `UPDATE calls SET status = $2, duration_sec = COALESCE($3, duration_sec),
          ended_at = CASE WHEN $2 = ANY($4::text[]) THEN now() ELSE ended_at END, updated_at = now()
         WHERE provider_call_id = $1 AND ${RANK_SQL("status")} < ${RANK_SQL("$2")}
         RETURNING id, contact_id`,
        [String(providerCallId), status, durationSec, TERMINAL]
      );
      const call = updatedCalls[0];
      if (call) {
        logger.info("call_status_updated", { providerCallId, status });
        if (call.contact_id && TERMINAL.includes(status)) {
          await query(
            `UPDATE contacts SET status = $2, last_call_at = now(), outcome = $3, updated_at = now() WHERE id = $1`,
            [call.contact_id, status === "Completed" ? "DONE" : "FAILED", status]
          );
        }
        publishCallUpdate(call.id);
      } else {
        logger.info("call_status_ignored", { providerCallId, status, reason: "duplicate, out-of-order or unknown call" });
      }
    }
    res.status(200).send("");
  } catch (err) { next(err); }
});

// Recording callback: Twilio posts CallSid, RecordingUrl, RecordingDuration. Duplicate deliveries are ignored.
router.post("/recording", webhookLimiter, async (req, res, next) => {
  try {
    if (!validateWebhookSignature(req)) throw new ApiError(401, "Invalid webhook signature");

    const providerCallId = req.body.CallSid || req.body.providerCallId;
    const recordingUrl = req.body.RecordingUrl || req.body.recordingUrl;
    const d = Number(req.body.RecordingDuration ?? req.body.durationSec);
    const durationSec = Number.isFinite(d) ? Math.round(d) : null;

    const { rows } = await query(`SELECT id FROM calls WHERE provider_call_id = $1`, [String(providerCallId || "")]);
    if (rows[0] && recordingUrl) {
      const callId = rows[0].id;
      await query(
        `INSERT INTO call_recordings (call_id, url, duration_sec)
         SELECT $1, $2, $3 WHERE NOT EXISTS (SELECT 1 FROM call_recordings WHERE call_id = $1 AND url = $2)`,
        [callId, String(recordingUrl), durationSec]);
      // Copy the audio into OUR private bucket (consent + retention rules apply there). Twilio media needs Basic auth.
      const headers = activeProviderName === "twilio"
        ? { Authorization: `Basic ${Buffer.from(`${process.env.TELEPHONY_API_KEY}:${process.env.TELEPHONY_API_SECRET}`).toString("base64")}` } : {};
      const job = ingestRecordingFromUrl({
        callId, url: String(recordingUrl), headers, durationSec,
        fetchUrl: activeProviderName === "twilio" && !/\.(mp3|wav)$/i.test(String(recordingUrl)) ? `${recordingUrl}.mp3` : null,
      }).catch((e) => logger.warn("recording_ingest_skipped", { callId, reason: e.message }));
      if (process.env.WEBHOOK_INGEST_SYNC === "true") await job;
    }
    res.status(200).send("");
  } catch (err) { next(err); }
});

export default router;
