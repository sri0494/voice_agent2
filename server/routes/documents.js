import { Router } from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";
import { query } from "../db/pool.js";
import { requireAuth, requireStaff } from "../middleware/auth.js";
import { rbac, R } from "../middleware/rbac.js";
import { uploadLimiter } from "../middleware/rateLimit.js";
import { audit } from "../services/audit.js";
import { sanitizeFilename, hasTraversal, validateDocumentContent, readHead } from "../utils/fileValidation.js";
import { ApiError } from "../middleware/errorHandler.js";
import { processDocument, reindexDocument } from "../services/knowledge/ingest.js";
import { searchRelevantChunks } from "../services/knowledge/vectorSearch.js";

const router = Router();
router.use(requireAuth, requireStaff, rbac({ read: R.STAFF, write: R.OPERATORS, remove: R.MANAGERS }));
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const needUuid = (v, what = "ID") => { if (!UUID_RE.test(String(v))) throw new ApiError(400, `Invalid ${what}`); return v; };

const UPLOAD_DIR = path.resolve("uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const ALLOWED_TYPES = { "application/pdf": "PDF", "text/plain": "TXT",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "DOCX",
  "text/csv": "CSV", "text/markdown": "MD" };
const ALLOWED_EXT = { ".pdf": "PDF", ".txt": "TXT", ".docx": "DOCX", ".csv": "CSV", ".md": "MD" };

// Stored under a server-generated name: the browser's filename never touches the filesystem.
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => cb(null, `${randomUUID()}${path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, "")}`),
});

const upload = multer({
  storage,
  preservePath: true,
  limits: { fileSize: 20 * 1024 * 1024, files: 1, fields: 10, parts: 12 }, // 20MB, one file
  fileFilter: (req, file, cb) => {
    if (hasTraversal(file.originalname)) return cb(new ApiError(400, "Invalid file name"));
    const ext = path.extname(file.originalname).toLowerCase();
    // BOTH the extension and the declared MIME type must be allowed (it used to be either one).
    if (!ALLOWED_EXT[ext] || !ALLOWED_TYPES[file.mimetype]) {
      return cb(new ApiError(400, "Unsupported file type. Allowed: PDF, TXT, DOCX, CSV, Markdown"));
    }
    cb(null, true);
  },
});
const receive = (req, res, next) => upload.single("file")(req, res, (err) => {
  if (!err) return next();
  next(err.code === "LIMIT_FILE_SIZE" ? new ApiError(413, "File too large (max 20 MB)") : err instanceof ApiError ? err : new ApiError(400, "Upload rejected"));
});
const discard = (p) => { try { if (p) fs.unlinkSync(p); } catch { /* already gone */ } };
// Only ever delete inside the upload directory.
const insideUploads = (p) => { const r = path.resolve(p); return r.startsWith(UPLOAD_DIR + path.sep); };

router.post("/upload", uploadLimiter, receive, async (req, res, next) => {
  try {
    if (!req.file) throw new ApiError(400, "File is required");
    const { knowledgeBaseId } = req.body;
    if (!knowledgeBaseId) throw new ApiError(400, "knowledgeBaseId is required");
    needUuid(knowledgeBaseId, "knowledgeBaseId");
    const kb = await query(`SELECT 1 FROM knowledge_bases WHERE id = $1`, [knowledgeBaseId]);
    if (!kb.rows[0]) throw new ApiError(404, "Knowledge base not found");

    const ext = path.extname(req.file.originalname).toLowerCase();
    // Never trust the browser: the file CONTENT must match its extension (magic bytes / valid UTF-8 text).
    const fileType = validateDocumentContent(readHead(req.file.path, 65536), ext);
    if (!fileType) throw new ApiError(415, "File content does not match its extension");
    req.file.originalname = sanitizeFilename(req.file.originalname);

    const { rows } = await query(
      `INSERT INTO knowledge_documents (knowledge_base_id, title, source_type, file_type, file_path, status)
       VALUES ($1,$2,'FILE',$3,$4,'PENDING') RETURNING *`,
      [knowledgeBaseId, req.file.originalname, fileType, req.file.path]
    );

    // Process asynchronously so the upload responds immediately.
    processDocument(rows[0].id).catch(() => {});

    await audit(req, { action: "kb_document_upload", resource: "knowledge_document", resourceId: rows[0].id, meta: { knowledgeBaseId } });
    res.status(201).json({ success: true, data: rows[0], message: "Document uploaded, processing started" });
  } catch (err) {
    discard(req.file?.path);                         // never leave a rejected upload on disk
    next(err);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    needUuid(req.params.id, "document ID");
    const { rows } = await query(`SELECT * FROM knowledge_documents WHERE id = $1`, [req.params.id]);
    if (!rows[0]) throw new ApiError(404, "Document not found");
    res.json({ success: true, data: rows[0], message: "Success" });
  } catch (err) { next(err); }
});

router.post("/:id/reindex", async (req, res, next) => {
  try {
    needUuid(req.params.id, "document ID");
    const { rows } = await query(`SELECT id FROM knowledge_documents WHERE id = $1`, [req.params.id]);
    if (!rows[0]) throw new ApiError(404, "Document not found");
    reindexDocument(req.params.id).catch(() => {});
    res.json({ success: true, data: null, message: "Re-indexing started" });
  } catch (err) { next(err); }
});

router.delete("/:id", async (req, res, next) => {
  try {
    needUuid(req.params.id, "document ID");
    const { rows } = await query(`SELECT file_path FROM knowledge_documents WHERE id = $1`, [req.params.id]);
    if (!rows[0]) throw new ApiError(404, "Document not found");
    await query(`DELETE FROM knowledge_documents WHERE id = $1`, [req.params.id]);
    if (rows[0].file_path && insideUploads(rows[0].file_path)) discard(rows[0].file_path);
    await audit(req, { action: "kb_document_delete", resource: "knowledge_document", resourceId: req.params.id });
    res.json({ success: true, data: null, message: "Document deleted" });
  } catch (err) { next(err); }
});

// Search documents/chunks within a knowledge base (used by KB search UI).
router.get("/", async (req, res, next) => {
  try {
    const { knowledgeBaseId, q } = req.query;
    if (!knowledgeBaseId) throw new ApiError(400, "knowledgeBaseId is required");
    needUuid(knowledgeBaseId, "knowledgeBaseId");

    if (q) {
      const chunks = await searchRelevantChunks(q, [knowledgeBaseId], 10);
      return res.json({ success: true, data: chunks, message: "Success" });
    }
    const { rows } = await query(
      `SELECT * FROM knowledge_documents WHERE knowledge_base_id = $1 ORDER BY created_at DESC`,
      [knowledgeBaseId]
    );
    res.json({ success: true, data: rows, message: "Success" });
  } catch (err) { next(err); }
});

export default router;
