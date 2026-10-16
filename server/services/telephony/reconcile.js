// Safety net for calls whose status callback never arrived (wrong callback URL/token, Exotel retries exhausted, restart mid-call).
// Every minute: for calls still Ringing/Connected for a while, ask the provider what really happened and apply it.
// Forward-only (a finished call is never reopened). Also logs what the provider says, which makes "call hung up in 2 s" diagnosable.
import { query } from "../../db/pool.js";
import { logger } from "../../utils/logger.js";
import { publishCallUpdate } from "../liveCalls.js";
import { createTelephonyProvider } from "./TelephonyProvider.js";

const MAP = { queued: "Ringing", ringing: "Ringing", "in-progress": "Connected", in_progress: "Connected", completed: "Completed", busy: "Failed", failed: "Failed", "no-answer": "Missed", no_answer: "Missed", canceled: "Failed" };
const RANK = (v) => `(CASE ${v} WHEN 'Ringing' THEN 1 WHEN 'Live' THEN 2 WHEN 'Connected' THEN 2 WHEN 'Transferred' THEN 3 ELSE 4 END)`;
const TERMINAL = ["Completed", "Failed", "Missed"];

export async function reconcileStaleCalls({ provider = createTelephonyProvider(), minAgeSec = Number(process.env.CALL_RECONCILE_AFTER_SEC) || 90, limit = 20 } = {}) {
  if (!provider || provider.isMock?.() || typeof provider.getCallStatus !== "function") return 0;
  const { rows } = await query(
    `SELECT id, provider_call_id, status, contact_id FROM calls
      WHERE provider_call_id IS NOT NULL AND status IN ('Ringing','Connected','Live')
        AND updated_at < now() - make_interval(secs => $1) AND updated_at > now() - interval '2 days'
      ORDER BY updated_at LIMIT $2`, [minAgeSec, limit]);
  let changed = 0;
  for (const c of rows) {
    try {
      const info = await provider.getCallStatus(c.provider_call_id);
      const status = MAP[String(info?.status || "").toLowerCase()];
      logger.info("call_reconcile", { callId: c.id, ours: c.status, provider: info?.status, providerDurationSec: info?.duration ?? null });
      if (!status) continue;
      const dur = Number.isFinite(Number(info.duration)) ? Math.round(Number(info.duration)) : null;
      const r = await query(
        `UPDATE calls SET status = $2, duration_sec = COALESCE($3, duration_sec),
           ended_at = CASE WHEN $2 = ANY($4::text[]) THEN now() ELSE ended_at END, updated_at = now()
         WHERE id = $1 AND ${RANK("status")} < ${RANK("$2")} RETURNING id`, [c.id, status, dur, TERMINAL]);
      if (!r.rows[0]) continue;
      changed++;
      if (c.contact_id && TERMINAL.includes(status)) await query(`UPDATE contacts SET status = $2, last_call_at = now(), outcome = $3, updated_at = now() WHERE id = $1`, [c.contact_id, status === "Completed" ? "DONE" : "FAILED", status]);
      publishCallUpdate(c.id);
    } catch (e) { logger.warn("call_reconcile_failed", { callId: c.id, error: e.message }); }
  }
  return changed;
}

export function startCallReconciler() {
  const t = setInterval(() => reconcileStaleCalls().catch((e) => logger.warn("call_reconcile_error", { error: e.message })), 60 * 1000);
  t.unref?.(); return t;
}
