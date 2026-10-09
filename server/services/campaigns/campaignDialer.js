// campaignDialer.js — this is what was missing: previously, "Start Campaign"
// only flipped a status flag in the database and nothing ever actually
// called anyone. A lightweight interval-based dialer (started in
// server/index.js) now periodically scans Running campaigns and places
// calls for their pending contacts automatically.
//
// Deliberately simple: a small batch per tick, a global concurrency cap,
// and a naive calling-hours check using the server's local time. This is
// NOT a production-grade predictive dialer (no timezone-aware business
// hours, no jitter/backoff, no per-campaign concurrency limits) — it's
// built to be honest and correct for moderate volume, with clear
// extension points if you need more sophistication later.
import { query, getClient } from "../../db/pool.js";
import { placeOutboundCall, claimBatch } from "../telephony/placeCall.js";
import { publishCallUpdate } from "../liveCalls.js";
import { logger } from "../../utils/logger.js";

const MAX_CONCURRENT_LIVE_CALLS = 5;
const MAX_NEW_CALLS_PER_TICK = 3;
const MOCK_CALL_SIMULATED_DURATION_SEC = 15;

let tickInProgress = false;
const DIALER_LOCK_ID = 727001;                 // pg advisory lock: only ONE instance ticks at a time (safe with several Render instances)
const STALE_DIALING_MINUTES = 5;

// A contact stuck in DIALING (worker crashed between claim and call creation) goes back to the queue.
export async function releaseStaleDialing() {
  await query(
    `UPDATE contacts SET status = 'PENDING', call_attempts = GREATEST(call_attempts - 1, 0), updated_at = now()
     WHERE status = 'DIALING' AND dial_started_at < now() - ($1 || ' minutes')::interval
       AND NOT EXISTS (SELECT 1 FROM calls c WHERE c.contact_id = contacts.id AND c.status IN ('Ringing','Connected','Live'))`,
    [STALE_DIALING_MINUTES]);
}

// Mock calls never receive a real provider webhook (there's no real Twilio
// etc. calling back), so without this they'd sit as "Ringing" forever and
// eventually fill the dialer's concurrency cap. Real calls are unaffected —
// they resolve via the real /api/telephony/status webhook instead.
async function resolveStaleMockCalls() {
  const { rows: staleCalls } = await query(
    `SELECT id, contact_id FROM calls
     WHERE status IN ('Ringing','Connected')
       AND provider_call_id LIKE 'mock_%'
       AND started_at < now() - ($1 || ' seconds')::interval`,
    [MOCK_CALL_SIMULATED_DURATION_SEC]
  );
  for (const call of staleCalls) {
    const { rowCount } = await query(
      `UPDATE calls SET status = 'Completed', duration_sec = $2, ended_at = now(), updated_at = now()
       WHERE id = $1 AND status IN ('Ringing','Connected')`,
      [call.id, MOCK_CALL_SIMULATED_DURATION_SEC]
    );
    if (!rowCount) continue;                                    // another worker already resolved it
    publishCallUpdate(call.id);
    if (call.contact_id) {
      await query(`UPDATE contacts SET status = 'DONE', last_call_at = now(), outcome = 'Completed' WHERE id = $1`, [call.contact_id]);
    }
  }
}

function isWithinCallingHours(callingHours) {
  if (!callingHours || !callingHours.start || !callingHours.end) return true;
  const now = new Date();
  const days = callingHours.days || ["MON", "TUE", "WED", "THU", "FRI"];
  const dayNames = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
  if (!days.includes(dayNames[now.getDay()])) return false;

  const [startH, startM] = callingHours.start.split(":").map(Number);
  const [endH, endM] = callingHours.end.split(":").map(Number);
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  return nowMinutes >= startH * 60 + startM && nowMinutes <= endH * 60 + endM;
}

export async function runDialerTick({ force = false } = {}) {
  if (tickInProgress && !force) return; // avoid overlapping ticks if one runs long
  tickInProgress = true;
  let lockClient = null;

  try {
    if (process.env.DIALER_ADVISORY_LOCK !== "false") {
      lockClient = await getClient();
      const { rows } = await lockClient.query("SELECT pg_try_advisory_lock($1) AS ok", [DIALER_LOCK_ID]);
      if (!rows[0].ok) return;                                  // another instance is ticking
    }
    await releaseStaleDialing();
    await resolveStaleMockCalls();

    const { rows: liveCountRows } = await query(
      `SELECT COUNT(*) FROM calls WHERE status IN ('Ringing','Connected','Live')`
    );
    let capacityRemaining = MAX_CONCURRENT_LIVE_CALLS - Number(liveCountRows[0].count);
    if (capacityRemaining <= 0) return;

    const { rows: campaigns } = await query(
      `SELECT * FROM campaigns WHERE status = 'Running' AND agent_id IS NOT NULL`
    );

    for (const campaign of campaigns) {
      if (capacityRemaining <= 0) break;
      if (!isWithinCallingHours(campaign.calling_hours)) continue;

      // Atomic claim (PENDING -> DIALING, FOR UPDATE SKIP LOCKED): the same contact can never be picked twice.
      const pendingContacts = await claimBatch(campaign.id, campaign.retry_attempts || 2, Math.min(MAX_NEW_CALLS_PER_TICK, capacityRemaining));

      for (const contact of pendingContacts) {
        try {
          await placeOutboundCall({ campaignId: campaign.id, contactId: contact.id, agentId: campaign.agent_id, claimed: true });
          capacityRemaining -= 1;
          logger.info("dialer_call_placed", { campaignId: campaign.id, contactId: contact.id });
        } catch (err) {
          logger.error("dialer_call_failed", { campaignId: campaign.id, contactId: contact.id, error: err.message });
        }
        if (capacityRemaining <= 0) break;
      }

      // If every contact has now exhausted its retry attempts, auto-complete the campaign.
      const { rows: remainingRows } = await query(
        `SELECT COUNT(*) FROM contacts WHERE campaign_id = $1 AND status = 'PENDING' AND call_attempts < $2`,
        [campaign.id, campaign.retry_attempts || 2]
      );
      if (Number(remainingRows[0].count) === 0) {
        const { rows: anyPendingRows } = await query(
          `SELECT COUNT(*) FROM contacts WHERE campaign_id = $1 AND status IN ('PENDING','QUEUED','DIALING')`,
          [campaign.id]
        );
        if (Number(anyPendingRows[0].count) === 0) {
          await query(`UPDATE campaigns SET status = 'Completed', updated_at = now() WHERE id = $1 AND status = 'Running'`, [campaign.id]);
          logger.info("campaign_auto_completed", { campaignId: campaign.id });
        }
      }
    }
  } catch (err) {
    logger.error("dialer_tick_failed", { error: err.message });
  } finally {
    if (lockClient) {
      await lockClient.query("SELECT pg_advisory_unlock($1)", [DIALER_LOCK_ID]).catch(() => {});
      lockClient.release();
    }
    tickInProgress = false;
  }
}

export function startCampaignDialer(intervalMs = 30000) {
  logger.info("campaign_dialer_started", { intervalMs });
  return setInterval(runDialerTick, intervalMs);
}
