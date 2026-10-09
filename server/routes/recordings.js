// STAFF recording API (mounted at /api/recordings). There is NO public/unauthenticated recording endpoint:
// every route needs a valid session, a staff role, and (for playback) an authorised, short-lived link.
// Customers use /api/customer/recordings/* (permission + ownership checked there).
import { Router } from "express";
import multer from "multer";
import { query } from "../db/pool.js";
import { requireAuth, requireStaff } from "../middleware/auth.js";
import { rbac, R } from "../middleware/rbac.js";
import { ApiError } from "../middleware/errorHandler.js";
import { recordingUploadLimiter } from "../middleware/rateLimit.js";
import { audit } from "../services/audit.js";
import { hasTraversal } from "../utils/fileValidation.js";
import { saveRecording, publicRow, playbackFor, streamLocal, getRecordingRow, deleteRecordingFully, MAX_BYTES } from "../services/recordings.js";

const router = Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.use(requireAuth, requireStaff, rbac({ read: R.STAFF, write: R.OPERATORS, remove: R.MANAGERS }));

const upload = multer({
  storage: multer.memoryStorage(), preservePath: true, limits: { fileSize: MAX_BYTES, files: 1, fields: 8 },
  fileFilter: (req, file, cb) => (hasTraversal(file.originalname) ? cb(new ApiError(400, "Invalid file name")) : cb(null, true)),
});
const receive = (req, res, next) => upload.single("audio")(req, res, (err) => {
  if (!err) return next();
  next(err.code === "LIMIT_FILE_SIZE" ? new ApiError(413, "Recording too large") : err instanceof ApiError ? err : new ApiError(400, "Upload rejected"));
});

async function findRecording(id) {
  if (!UUID_RE.test(id)) throw new ApiError(404, "Recording not found");
  const rec = await getRecordingRow(id);
  if (!rec) throw new ApiError(404, "Recording not found");
  return rec;
}
// Staff may play every recording; DOWNLOAD is limited to managers and above.
const canDownload = (req) => R.MANAGERS.includes(req.user.role);

router.post("/", recordingUploadLimiter, receive, async (req, res, next) => {
  try {
    if (!req.file) throw new ApiError(400, 'Audio file is required (form field "audio")');
    const callId = req.body.callId || null;
    if (callId) {
      if (!UUID_RE.test(callId)) throw new ApiError(400, "Invalid call ID");
      const { rows } = await query(`SELECT 1 FROM calls WHERE id = $1`, [callId]);
      if (!rows[0]) throw new ApiError(404, "Call not found");
    }
    const d = Math.round(Number(req.body.durationSec));
    const saved = await saveRecording({
      callId, buffer: req.file.buffer, contentType: req.file.mimetype, durationSec: d > 0 && d < 86400 ? d : null,
      source: req.body.source === "browser" ? "browser" : "upload", userId: req.user.id,
    });
    await audit(req, { action: "recording_upload", resource: "recording", resourceId: saved.id });
    res.status(201).json({ success: true, data: saved, message: "Recording saved" });
  } catch (err) { next(err); }
});

router.get("/", async (req, res, next) => {
  try {
    const { callId } = req.query;
    if (callId && !UUID_RE.test(callId)) throw new ApiError(400, "Invalid call ID");
    const { rows } = await query(
      `SELECT * FROM call_recording_files WHERE ($1::uuid IS NULL OR call_id = $1::uuid) ORDER BY created_at DESC LIMIT 200`, [callId || null]);
    res.json({ success: true, data: rows.map(publicRow), message: "Success" });
  } catch (err) { next(err); }
});

router.get("/:id/url", async (req, res, next) => {
  try {
    const rec = await findRecording(req.params.id);
    const download = req.query.download === "1";
    if (download && !canDownload(req)) throw new ApiError(403, "You do not have permission to download recordings");
    const out = await playbackFor(rec, { download, streamPath: `/api/recordings/${rec.id}/stream` });
    await audit(req, { action: download ? "recording_download" : "recording_play", resource: "recording", resourceId: rec.id });
    res.json({ success: true, data: out, message: "Success" });
  } catch (err) { next(err); }
});

// Local-disk (development) streaming. Authenticated with the normal Authorization header; the web app plays it via fetch -> blob.
router.get("/:id/stream", async (req, res, next) => {
  try {
    const rec = await findRecording(req.params.id);
    const download = req.query.download === "1";
    if (download && !canDownload(req)) throw new ApiError(403, "You do not have permission to download recordings");
    await audit(req, { action: download ? "recording_download" : "recording_play", resource: "recording", resourceId: rec.id });
    await streamLocal(req, res, rec, { download });
  } catch (err) { next(err); }
});

router.delete("/:id", async (req, res, next) => {
  try {
    const rec = await findRecording(req.params.id);
    await deleteRecordingFully(rec);
    await audit(req, { action: "recording_delete", resource: "recording", resourceId: rec.id });
    res.json({ success: true, data: null, message: "Recording deleted" });
  } catch (err) { next(err); }
});

export default router;
