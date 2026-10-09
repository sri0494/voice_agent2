// placeCall.js: the single place that actually places an outbound call (manual "Call" button AND the campaign dialer).
//
// Duplicate-call protection: a contact is CLAIMED with one atomic UPDATE (PENDING -> DIALING) before any call is made,
// so two dialer workers, a double-clicked "Call" button, or a restart can never dial the same contact twice.
// A partial unique index on calls(contact_id) for in-flight calls is the database-level backstop (migration 004).
import { query } from "../../db/pool.js";
import { ApiError } from "../../middleware/errorHandler.js";
import { createTelephonyProvider } from "../telephony/TelephonyProvider.js";
import { logger } from "../../utils/logger.js";
import { publishCallUpdate } from "../liveCalls.js";

let telephonyProvider = createTelephonyProvider();
// Test hook: lets the test-suite inject a failing provider. Refuses to work outside NODE_ENV=test.
export function __setTelephonyProviderForTests(p) {
  if (process.env.NODE_ENV !== "test") throw new Error("test hook");
  telephonyProvider = p || createTelephonyProvider();
}

/** Atomically claim ONE contact. Returns the contact row, or null if someone else already holds it. */
export async function claimContact(contactId, { from = ["PENDING", "FAILED", "DONE"] } = {}) {
  const { rows } = await query(
    `UPDATE contacts SET status = 'DIALING', call_attempts = call_attempts + 1, dial_started_at = now(), updated_at = now()
     WHERE id = $1 AND status = ANY($2::text[]) RETURNING *`, [contactId, from]);
  return rows[0] || null;
}

/** Atomically claim up to `limit` PENDING contacts of a RUNNING campaign (FOR UPDATE SKIP LOCKED: concurrent workers get disjoint rows). */
export async function claimBatch(campaignId, maxAttempts, limit) {
  const { rows } = await query(
    `WITH picked AS (
       SELECT id FROM contacts
       WHERE campaign_id = $1 AND status = 'PENDING' AND call_attempts < $2
         AND EXISTS (SELECT 1 FROM campaigns WHERE id = $1 AND status = 'Running')
       ORDER BY created_at ASC LIMIT $3 FOR UPDATE SKIP LOCKED)
     UPDATE contacts c SET status = 'DIALING', call_attempts = c.call_attempts + 1, dial_started_at = now(), updated_at = now()
     FROM picked WHERE c.id = picked.id RETURNING c.*`, [campaignId, maxAttempts, limit]);
  return rows;
}

async function releaseContact(contactId, campaignId, reason) {
  const { rows } = await query(`SELECT retry_attempts FROM campaigns WHERE id = $1`, [campaignId]);
  const max = rows[0]?.retry_attempts || 2;
  await query(
    `UPDATE contacts SET status = CASE WHEN call_attempts < $2 THEN 'PENDING' ELSE 'FAILED' END, outcome = $3, updated_at = now()
     WHERE id = $1 AND status = 'DIALING'`, [contactId, max, reason]);
}

export async function placeOutboundCall({ campaignId, contactId, agentId, claimed = false }) {
  let contact;
  if (claimed) {
    const { rows } = await query(`SELECT * FROM contacts WHERE id = $1 AND status = 'DIALING'`, [contactId]);
    contact = rows[0];
    if (!contact) throw new ApiError(409, "Contact is not in the DIALING state");
  } else {
    contact = await claimContact(contactId);
    if (!contact) {
      const { rows } = await query(`SELECT 1 FROM contacts WHERE id = $1`, [contactId]);
      throw rows[0] ? new ApiError(409, "This contact is already being called") : new ApiError(404, "Contact not found");
    }
  }

  let call;
  try {
    const { rows: callRows } = await query(
      `INSERT INTO calls (campaign_id, contact_id, agent_id, direction, phone, language, status, started_at)
       VALUES ($1,$2,$3,'OUTBOUND',$4,$5,'Ringing', now()) RETURNING *`,
      [campaignId, contactId, agentId, contact.phone, contact.language]);
    call = callRows[0];
  } catch (err) {
    await releaseContact(contactId, campaignId, "Call could not be created");
    if (err.code === "23505") throw new ApiError(409, "This contact already has a call in progress");   // DB backstop
    throw err;
  }

  let result;
  try {
    // Record from the first second only when the agent records AND no consent prompt is required (the consent flow starts it later).
    const { rows: ag } = await query(`SELECT recording_enabled, recording_consent FROM agents WHERE id = $1`, [agentId]);
    const record = Boolean(ag[0]?.recording_enabled) && ag[0]?.recording_consent !== "REQUIRED";
    result = await telephonyProvider.makeCall({ to: contact.phone, from: process.env.TELEPHONY_PHONE_NUMBER, campaignId, agentId, callId: call.id, record });
  } catch (providerErr) {
    await query(`UPDATE calls SET status = 'Failed', updated_at = now() WHERE id = $1`, [call.id]);
    await releaseContact(contactId, campaignId, "Call placement failed");
    logger.error("call_placement_failed", { callId: call.id, error: providerErr.message });
    publishCallUpdate(call.id);
    throw providerErr;
  }

  const { rows: updatedRows } = await query(
    `UPDATE calls SET status = $2, provider_call_id = $3, updated_at = now() WHERE id = $1 RETURNING *`,
    [call.id, result.status, result.providerCallId]);
  await query(`UPDATE contacts SET status = 'QUEUED', updated_at = now() WHERE id = $1 AND status = 'DIALING'`, [contactId]);
  publishCallUpdate(call.id);
  return { call: updatedRows[0], mock: result.mock !== false };
}
