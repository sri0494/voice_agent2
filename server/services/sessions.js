// Server-side login sessions. All state is in PostgreSQL (table auth_sessions), so it works on any number of Render instances
// and every decision uses the database clock (now()), never an instance's local clock.
//
//  * absolute lifetime   AUTH_ABSOLUTE_TIMEOUT_HOURS (default 8)  : fixed at login, never extended
//  * inactivity timeout  AUTH_IDLE_TIMEOUT_MIN       (default 15) : reset only by meaningful activity (see touch modes)
//  * tab liveness        AUTH_TAB_LIVENESS_SEC       (default 180, 0 = off): an open tab pings every ~45 s; a session nobody has
//                        pinged for this long belonged to a closed tab and is refused. Not extended by background polling alone.
import crypto from "node:crypto";
import { query } from "../db/pool.js";
import { ApiError } from "../middleware/errorHandler.js";
import { logger } from "../utils/logger.js";

const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) >= 0 && v !== "" && v != null ? Number(v) : d);
export const sessionConfig = () => ({
  idleSec: Math.round(num(process.env.AUTH_IDLE_TIMEOUT_MIN, 15) * 60) || 900,
  absoluteSec: Math.round(num(process.env.AUTH_ABSOLUTE_TIMEOUT_HOURS, 8) * 3600) || 28800,
  livenessSec: Math.round(num(process.env.AUTH_TAB_LIVENESS_SEC, 180)),
  requireSession: process.env.AUTH_REQUIRE_SESSION !== "false",     // false only to accept pre-session tokens during a rollout/tests
});

const REASON_TEXT = {
  IDLE: "Your session has expired due to inactivity. Please log in again.",
  ABSOLUTE: "Your session has expired. Please log in again.",
  TAB_CLOSED: "Your session has expired. Please log in again.",
  REVOKED: "You have been logged out. Please log in again.",
  MISSING: "Your session has expired. Please log in again.",
};
export const sessionError = (reason) => {
  const e = new ApiError(401, REASON_TEXT[reason] || REASON_TEXT.MISSING);
  e.errorCode = "SESSION_EXPIRED"; e.reason = reason; return e;
};

export async function createSession(req, userId) {
  const { absoluteSec } = sessionConfig();
  const id = crypto.randomUUID();
  const { rows } = await query(
    `INSERT INTO auth_sessions (id, user_id, expires_at, ip, user_agent)
     VALUES ($1, $2, now() + make_interval(secs => $3), $4, $5) RETURNING expires_at`,
    [id, String(userId), absoluteSec, req?.ip || null, String(req?.headers?.["user-agent"] || "").slice(0, 300) || null]);
  return { sid: id, expiresAt: rows[0].expires_at, expiresInSec: absoluteSec };
}

/**
 * Validates the session named by a verified JWT. touch: "none" | "seen" (open tab, e.g. a GET/poll) | "activity" (user action).
 * Throws a 401 SESSION_EXPIRED error with a reason; returns { idleRemainingSec, absoluteRemainingSec, livenessRemainingSec }.
 */
export async function validateSession(sid, userId, touch = "seen") {
  const cfg = sessionConfig();
  if (!sid) { if (cfg.requireSession) throw sessionError("MISSING"); return null; }
  let row;
  try {
    ({ rows: [row] } = await query(
      `SELECT revoked_at, revoked_reason,
              (now() >= expires_at) AS abs_expired,
              GREATEST(0, EXTRACT(EPOCH FROM (expires_at - now())))::int AS abs_left,
              GREATEST(0, $3 - EXTRACT(EPOCH FROM (now() - last_activity_at)))::int AS idle_left,
              GREATEST(0, $4 - EXTRACT(EPOCH FROM (now() - last_seen_at)))::int AS live_left
         FROM auth_sessions WHERE id = $1 AND user_id = $2`, [String(sid), String(userId), cfg.idleSec, cfg.livenessSec]));
  } catch (err) { if (err.code === "22P02") throw sessionError("MISSING"); throw err; }       // malformed sid
  if (!row) throw sessionError("MISSING");                                                    // unknown sid, or a sid of another user
  if (row.revoked_at) throw sessionError("REVOKED");
  const expire = async (reason) => {
    await query(`UPDATE auth_sessions SET revoked_at = now(), revoked_reason = $2 WHERE id = $1 AND revoked_at IS NULL`, [sid, reason]).catch(() => {});
    throw sessionError(reason);
  };
  if (row.abs_expired) await expire("ABSOLUTE");
  if (row.idle_left <= 0) await expire("IDLE");
  if (cfg.livenessSec > 0 && row.live_left <= 0) await expire("TAB_CLOSED");

  if (touch !== "none") {
    // Throttled: a passive "seen" write happens at most every 10 s per session; an activity write is immediate.
    await query(
      touch === "activity"
        ? `UPDATE auth_sessions SET last_seen_at = now(), last_activity_at = now() WHERE id = $1 AND revoked_at IS NULL`
        : `UPDATE auth_sessions SET last_seen_at = now() WHERE id = $1 AND revoked_at IS NULL AND last_seen_at < now() - interval '10 seconds'`,
      [sid]).catch((e) => logger.warn("session_touch_failed", { error: e.message }));
  }
  return {
    idleRemainingSec: touch === "activity" ? cfg.idleSec : row.idle_left,
    absoluteRemainingSec: row.abs_left,
    livenessRemainingSec: cfg.livenessSec > 0 ? cfg.livenessSec : null,
  };
}

export async function revokeSession(sid, reason = "LOGOUT") {
  if (!sid) return 0;
  try { const r = await query(`UPDATE auth_sessions SET revoked_at = now(), revoked_reason = $2 WHERE id = $1 AND revoked_at IS NULL`, [String(sid), reason]); return r.rowCount; }
  catch (err) { if (err.code === "22P02") return 0; throw err; }
}
export const revokeAllForUser = async (userId, reason = "PASSWORD_CHANGED") =>
  (await query(`UPDATE auth_sessions SET revoked_at = now(), revoked_reason = $2 WHERE user_id = $1 AND revoked_at IS NULL`, [String(userId), reason])).rowCount;

/** Delete sessions that ended more than 7 days ago (keeps the table small). */
export const purgeOldSessions = async () =>
  (await query(`DELETE FROM auth_sessions WHERE COALESCE(revoked_at, expires_at) < now() - interval '7 days'`)).rowCount;

export function startSessionCleanup() {
  const t = setInterval(() => purgeOldSessions().catch((e) => logger.warn("session_cleanup_failed", { error: e.message })), 60 * 60 * 1000);
  t.unref?.(); return t;
}
