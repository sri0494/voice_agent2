import net from "node:net";
import { v4 as uuid } from "uuid";
import { query } from "../db/pool.js";
import { ApiError } from "../middleware/errorHandler.js";
import { getStorage } from "./storage/index.js";
import { validateAudioContent } from "../utils/fileValidation.js";
import { logger } from "../utils/logger.js";
import { audit } from "./audit.js";

export const MAX_BYTES = (Number(process.env.RECORDING_MAX_MB) || 50) * 1024 * 1024;
export const PLAYBACK_TTL_SEC = 300; // signed playback/download links live 5 minutes

const EXT = {
  "audio/webm": "webm", "audio/ogg": "ogg", "audio/mpeg": "mp3", "audio/mp3": "mp3",
  "audio/wav": "wav", "audio/x-wav": "wav", "audio/wave": "wav",
  "audio/mp4": "m4a", "audio/x-m4a": "m4a", "audio/aac": "aac",
};
const EXT_TO_TYPE = { webm: "audio/webm", ogg: "audio/ogg", mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", aac: "audio/aac" };
export const normalizeType = (t) => String(t || "").split(";")[0].trim().toLowerCase();

// Never expose where or how a recording is stored.
export const publicRow = ({ storage_key, storage_provider, original_url, ...rest }) => rest;

/** Calls that belong to a customer's campaign live under customers/<id>/campaigns/<id>/recordings/. */
async function recordingContext(callId) {
  if (!callId) return {};
  const { rows } = await query(
    `SELECT c.campaign_id, c.consent_status, c.consent_at, c.consent_method, ca.client_id,
            ag.recording_enabled, ag.recording_consent, ag.recording_retention_days
     FROM calls c LEFT JOIN campaigns ca ON ca.id = c.campaign_id LEFT JOIN agents ag ON ag.id = c.agent_id
     WHERE c.id = $1`, [callId]);
  return rows[0] || {};
}

const retentionFor = (ctx) => {
  const d = ctx.recording_retention_days ?? (Number(process.env.RECORDING_RETENTION_DAYS) || null);
  return d && d > 0 ? d : null; // null = keep forever
};

function makeKey(ctx, ext) {
  if (ctx.client_id && ctx.campaign_id) return `customers/${ctx.client_id}/campaigns/${ctx.campaign_id}/recordings/${uuid()}.${ext}`;
  const d = new Date();
  return `recordings/${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${uuid()}.${ext}`;
}

/** Store a recording buffer in object storage and record it in the DB. Idempotent per (call, originalUrl). */
export async function saveRecording({ callId = null, buffer, contentType, durationSec = null, source = "upload", userId = null, originalUrl = null }) {
  const type = normalizeType(contentType);
  const ext = EXT[type];
  if (!ext) throw new ApiError(415, `Unsupported audio type: ${type || "unknown"}`);
  if (!buffer?.length) throw new ApiError(400, "Empty recording");
  if (buffer.length > MAX_BYTES) throw new ApiError(413, `Recording too large (max ${MAX_BYTES / 1024 / 1024} MB)`);
  if (!validateAudioContent(buffer.subarray(0, 32), type)) throw new ApiError(415, "File content does not match the audio type");

  const ctx = await recordingContext(callId);
  if (source === "telephony" && ctx.recording_consent === "REQUIRED" && ctx.consent_status !== "GRANTED") {
    throw new ApiError(409, "Recording consent was not granted for this call");
  }
  const days = retentionFor(ctx);
  const storage = await getStorage();
  const key = makeKey(ctx, ext);
  await storage.put(key, buffer, type);
  try {
    const { rows } = await query(
      `INSERT INTO call_recording_files
         (call_id, source, storage_provider, storage_key, content_type, size_bytes, duration_sec, original_url, created_by,
          retention_days, expires_at, consent_status, consent_at, consent_method)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, CASE WHEN $10::int IS NULL THEN NULL ELSE now() + ($10::int * interval '1 day') END, $11,$12,$13)
       ON CONFLICT (call_id, original_url) WHERE original_url IS NOT NULL DO NOTHING
       RETURNING *`,
      [callId, source, storage.name, key, type, buffer.length, durationSec, originalUrl, userId ? String(userId) : null,
       days, ctx.consent_status || null, ctx.consent_at || null, ctx.consent_method || null]);
    if (!rows[0]) {                                   // duplicate delivery of the same provider recording
      await storage.remove(key).catch(() => {});
      const { rows: existing } = await query(`SELECT * FROM call_recording_files WHERE call_id = $1 AND original_url = $2`, [callId, originalUrl]);
      return { ...publicRow(existing[0]), duplicate: true };
    }
    return publicRow(rows[0]);
  } catch (err) {
    await storage.remove(key).catch(() => {});
    throw err;
  }
}

function isPrivateHost(host) {
  const h = host.toLowerCase();
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (net.isIPv4(h)) {
    const [a, b] = h.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (net.isIPv6(h)) return h === "::1" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80");
  return false;
}

/** Copy a provider-hosted recording into our own private bucket (call AFTER the webhook signature is verified). */
export async function ingestRecordingFromUrl({ callId, url, headers = {}, durationSec = null, fetchUrl = null }) {
  const u = new URL(fetchUrl || url);
  if (u.protocol !== "https:") throw new ApiError(400, "Recording URL must use https");
  const allow = (process.env.RECORDING_URL_ALLOWLIST || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const host = u.hostname.toLowerCase();
  if (allow.length ? !allow.some((h) => host === h || host.endsWith(`.${h}`)) : isPrivateHost(host)) throw new ApiError(400, "Recording host not allowed");
  if (callId) {
    const { rows } = await query(`SELECT 1 FROM call_recording_files WHERE call_id = $1 AND original_url = $2`, [callId, url]);
    if (rows[0]) return { duplicate: true };
  }
  const res = await fetch(u, { headers, redirect: "follow" });
  if (!res.ok) throw new ApiError(502, `Could not download recording (HTTP ${res.status})`);
  if (Number(res.headers.get("content-length")) > MAX_BYTES) throw new ApiError(413, "Recording too large");
  const buffer = Buffer.from(await res.arrayBuffer());
  let type = normalizeType(res.headers.get("content-type"));
  if (!EXT[type]) type = EXT_TO_TYPE[u.pathname.split(".").pop().toLowerCase()] || type;
  return saveRecording({ callId, buffer, contentType: type, durationSec, source: "telephony", originalUrl: url });
}

export async function getRecordingRow(id) {
  const { rows } = await query(`SELECT * FROM call_recording_files WHERE id = $1`, [id]);
  return rows[0] || null;
}

/**
 * Caller MUST have authenticated, authorised and ownership-checked the recording first.
 * s3/R2 -> 5-minute presigned URL.  local (dev) -> the authenticated stream endpoint named by `streamPath`.
 */
export async function playbackFor(rec, { download = false, streamPath }) {
  const storage = await getStorage();
  if (rec.storage_provider !== storage.name) throw new ApiError(409, `Recording is stored in "${rec.storage_provider}" but the server uses "${storage.name}"`);
  if (storage.supportsPresign) {
    const url = await storage.getSignedUrl(rec.storage_key, { expiresIn: PLAYBACK_TTL_SEC, contentType: rec.content_type, download, filename: `recording-${rec.id}.${rec.storage_key.split(".").pop()}` });
    return { mode: "presigned", url, expiresIn: PLAYBACK_TTL_SEC };
  }
  return { mode: "stream", url: `${streamPath}${download ? "?download=1" : ""}`, expiresIn: PLAYBACK_TTL_SEC };
}

/** Local-disk streaming with Range support (development storage). */
export async function streamLocal(req, res, rec, { download = false } = {}) {
  const storage = await getStorage();
  if (storage.supportsPresign || rec.storage_provider !== storage.name) throw new ApiError(404, "Recording not found");
  const size = await storage.stat(rec.storage_key);
  let start = 0, end = size - 1, status = 200;
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
  if (m && (m[1] || m[2])) {
    if (m[1] === "") start = Math.max(0, size - Number(m[2]));
    else { start = Number(m[1]); if (m[2]) end = Math.min(Number(m[2]), size - 1); }
    if (start > end || start >= size) { res.status(416).set("Content-Range", `bytes */${size}`).end(); return; }
    status = 206;
    res.set("Content-Range", `bytes ${start}-${end}/${size}`);
  }
  res.status(status).set({
    "Content-Type": rec.content_type, "Content-Length": end - start + 1, "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
    ...(download ? { "Content-Disposition": `attachment; filename="recording-${rec.id}.${rec.storage_key.split(".").pop()}"` } : {}),
  });
  await new Promise((resolve, reject) => storage.createReadStream(rec.storage_key, { start, end }).on("error", reject).on("end", resolve).pipe(res));
}

export async function deleteRecordingFully(rec) {
  await query(`DELETE FROM call_recording_files WHERE id = $1`, [rec.id]);
  const storage = await getStorage();
  await storage.remove(rec.storage_key).catch((e) => logger.error("recording_object_delete_failed", { recordingId: rec.id, error: e.message }));
}

/** Retention job: removes expired recordings (object + row) and audits each deletion. Rows are only ever selected by expires_at. */
export async function purgeExpiredRecordings({ batch = 200 } = {}) {
  const { rows } = await query(
    `SELECT r.*, ca.client_id FROM call_recording_files r
     LEFT JOIN calls c ON c.id = r.call_id LEFT JOIN campaigns ca ON ca.id = c.campaign_id
     WHERE r.expires_at IS NOT NULL AND r.expires_at < now() ORDER BY r.expires_at ASC LIMIT $1`, [batch]);
  let deleted = 0;
  for (const rec of rows) {
    try {
      await deleteRecordingFully(rec);
      await audit(null, { action: "recording_retention_delete", resource: "recording", resourceId: rec.id, actor: { role: "SYSTEM" }, meta: { clientId: rec.client_id, expiredAt: rec.expires_at } });
      deleted++;
    } catch (err) { logger.error("recording_purge_failed", { recordingId: rec.id, error: err.message }); }
  }
  return deleted;
}

export function startRetentionJob(intervalMs = 6 * 60 * 60 * 1000) {
  const run = () => purgeExpiredRecordings().then((n) => n && logger.info("recordings_purged", { count: n })).catch((e) => logger.error("retention_job_failed", { error: e.message }));
  setTimeout(run, 60 * 1000);
  return setInterval(run, intervalMs);
}
