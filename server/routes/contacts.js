import { Router } from "express";
import multer from "multer";
import { parse } from "csv-parse/sync";
import { query } from "../db/pool.js";
import { requireAuth, requireStaff } from "../middleware/auth.js";
import { rbac, R } from "../middleware/rbac.js";
import { importLimiter } from "../middleware/rateLimit.js";
import { audit } from "../services/audit.js";
import { looksLikeCsv, hasTraversal } from "../utils/fileValidation.js";
import { ApiError } from "../middleware/errorHandler.js";

const router = Router();
router.use(requireAuth, requireStaff, rbac({ read: R.STAFF, write: R.OPERATORS, remove: R.MANAGERS }));
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const needUuid = (v, what = "ID") => { if (!UUID_RE.test(String(v))) throw new ApiError(400, `Invalid ${what}`); return v; };
const MAX_CSV_ROWS = Number(process.env.MAX_CSV_ROWS) || 5000;

const upload = multer({
  storage: multer.memoryStorage(),
  preservePath: true,
  limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 10 }, // 5MB
  fileFilter: (req, file, cb) => {
    if (hasTraversal(file.originalname) || !/\.csv$/i.test(file.originalname) || !["text/csv", "application/vnd.ms-excel", "text/plain", "application/csv"].includes(file.mimetype)) {
      return cb(new ApiError(400, "Only CSV files are allowed"));
    }
    cb(null, true);
  },
});
const receiveCsv = (req, res, next) => upload.single("file")(req, res, (err) => {
  if (!err) return next();
  next(err.code === "LIMIT_FILE_SIZE" ? new ApiError(413, "CSV too large (max 5 MB)") : err instanceof ApiError ? err : new ApiError(400, "Upload rejected"));
});

const PHONE_RE = /^[6-9]\d{9}$|^\+91[6-9]\d{9}$/; // basic Indian mobile validation

router.get("/", async (req, res, next) => {
  try {
    const { campaignId } = req.query;
    if (campaignId) needUuid(campaignId, "campaignId");
    const { rows } = campaignId
      ? await query(`SELECT * FROM contacts WHERE campaign_id = $1 ORDER BY created_at DESC`, [campaignId])
      : await query(`SELECT * FROM contacts ORDER BY created_at DESC LIMIT 500`);
    res.json({ success: true, data: rows, message: "Success" });
  } catch (err) { next(err); }
});

router.post("/", async (req, res, next) => {
  try {
    const b = req.body;
    if (!b.phone) throw new ApiError(400, "Phone is required");
    if (!PHONE_RE.test(b.phone)) throw new ApiError(400, "Invalid Indian phone number format");
    if (b.campaignId) {
      needUuid(b.campaignId, "campaignId");
      const c = await query(`SELECT 1 FROM campaigns WHERE id = $1`, [b.campaignId]);
      if (!c.rows[0]) throw new ApiError(404, "Campaign not found");
    }
    const { rows } = await query(
      `INSERT INTO contacts (campaign_id, name, phone, email, language) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [b.campaignId || null, b.name || null, b.phone, b.email || null, b.language || "English"]
    );
    res.status(201).json({ success: true, data: rows[0], message: "Contact created" });
  } catch (err) { next(err); }
});

router.post("/upload-csv", importLimiter, receiveCsv, async (req, res, next) => {
  try {
    if (!req.file) throw new ApiError(400, "CSV file is required");
    if (!looksLikeCsv(req.file.buffer.subarray(0, 65536), req.file.originalname)) throw new ApiError(415, "File content is not valid CSV text");
    const { campaignId } = req.body;
    if (campaignId) {
      needUuid(campaignId, "campaignId");
      const c = await query(`SELECT 1 FROM campaigns WHERE id = $1`, [campaignId]);
      if (!c.rows[0]) throw new ApiError(404, "Campaign not found");
    }
    let records;
    try { records = parse(req.file.buffer.toString("utf-8"), { columns: true, skip_empty_lines: true, trim: true, relax_column_count: true }); }
    catch { throw new ApiError(422, "The CSV could not be parsed"); }
    if (records.length > MAX_CSV_ROWS) throw new ApiError(413, `Too many rows (max ${MAX_CSV_ROWS} per import)`);

    let inserted = 0;
    const skipped = [];
    for (const r of records) {
      const phone = (r.phone || r.Phone || "").replace(/\s+/g, "");
      if (!PHONE_RE.test(phone)) {
        skipped.push({ row: r, reason: "invalid phone" });
        continue;
      }
      await query(
        `INSERT INTO contacts (campaign_id, name, phone, email, language) VALUES ($1,$2,$3,$4,$5)`,
        [campaignId || null, r.name || r.Name || null, phone, r.email || r.Email || null, r.language || r.Language || "English"]
      );
      inserted++;
    }
    await audit(req, { action: "contacts_import", resource: "campaign", resourceId: campaignId || null, meta: { inserted, skipped: skipped.length } });
    res.status(201).json({
      success: true,
      data: { inserted, skippedCount: skipped.length, skipped: skipped.slice(0, 20) },
      message: `${inserted} contacts imported`,
    });
  } catch (err) { next(err); }
});

router.delete("/:id", async (req, res, next) => {
  try {
    const { rowCount } = await query(`DELETE FROM contacts WHERE id = $1`, [req.params.id]);
    if (!rowCount) throw new ApiError(404, "Contact not found");
    res.json({ success: true, data: null, message: "Contact deleted" });
  } catch (err) { next(err); }
});

export default router;
