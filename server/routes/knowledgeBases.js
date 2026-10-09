import { Router } from "express";
import { query } from "../db/pool.js";
import { requireAuth, requireStaff } from "../middleware/auth.js";
import { rbac, R } from "../middleware/rbac.js";
import { audit } from "../services/audit.js";
import { ApiError } from "../middleware/errorHandler.js";

const router = Router();
router.use(requireAuth, requireStaff, rbac({ read: R.STAFF, write: R.OPERATORS, remove: R.MANAGERS }));

router.get("/", async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT kb.*,
        (SELECT COUNT(*) FROM knowledge_documents WHERE knowledge_base_id = kb.id) AS document_count,
        (SELECT COALESCE(SUM(chunk_count),0) FROM knowledge_documents WHERE knowledge_base_id = kb.id) AS chunk_count
       FROM knowledge_bases kb ORDER BY kb.created_at DESC`
    );
    res.json({ success: true, data: rows, message: "Success" });
  } catch (err) { next(err); }
});

router.get("/:id", async (req, res, next) => {
  try {
    const { rows } = await query(`SELECT * FROM knowledge_bases WHERE id = $1`, [req.params.id]);
    if (!rows[0]) throw new ApiError(404, "Knowledge base not found");
    const { rows: docs } = await query(
      `SELECT id, title, source_type, file_type, status, chunk_count, error_message, created_at
       FROM knowledge_documents WHERE knowledge_base_id = $1 ORDER BY created_at DESC`,
      [req.params.id]
    );
    res.json({ success: true, data: { ...rows[0], documents: docs }, message: "Success" });
  } catch (err) { next(err); }
});

router.post("/", async (req, res, next) => {
  try {
    const { name, description } = req.body;
    if (!name) throw new ApiError(400, "Name is required");
    const { rows } = await query(
      `INSERT INTO knowledge_bases (name, description, created_by) VALUES ($1,$2,$3) RETURNING *`,
      [name, description || null, req.user.id]
    );
    await audit(req, { action: "kb_create", resource: "knowledge_base", resourceId: rows[0].id });
    res.status(201).json({ success: true, data: rows[0], message: "Knowledge base created" });
  } catch (err) { next(err); }
});

router.put("/:id", async (req, res, next) => {
  try {
    const { name, description } = req.body;
    const { rows } = await query(
      `UPDATE knowledge_bases SET name = COALESCE($2,name), description = COALESCE($3,description), updated_at = now()
       WHERE id = $1 RETURNING *`,
      [req.params.id, name, description]
    );
    if (!rows[0]) throw new ApiError(404, "Knowledge base not found");
    res.json({ success: true, data: rows[0], message: "Knowledge base renamed" });
  } catch (err) { next(err); }
});

router.delete("/:id", async (req, res, next) => {
  try {
    const { rowCount } = await query(`DELETE FROM knowledge_bases WHERE id = $1`, [req.params.id]);
    if (!rowCount) throw new ApiError(404, "Knowledge base not found");
    res.json({ success: true, data: null, message: "Knowledge base deleted" });
  } catch (err) { next(err); }
});

// Add a plain-text or FAQ entry directly (no file upload).
router.post("/:id/text", async (req, res, next) => {
  try {
    const { title, text } = req.body;
    if (!text) throw new ApiError(400, "Text content is required");
    const { rows } = await query(
      `INSERT INTO knowledge_documents (knowledge_base_id, title, source_type, raw_text, status)
       VALUES ($1,$2,'TEXT',$3,'PENDING') RETURNING *`,
      [req.params.id, title || "Untitled text entry", text]
    );
    const { processDocument } = await import("../services/knowledge/ingest.js");
    processDocument(rows[0].id).catch(() => {});
    res.status(201).json({ success: true, data: rows[0], message: "Text added, processing started" });
  } catch (err) { next(err); }
});

router.post("/:id/faq", async (req, res, next) => {
  try {
    const { question, answer } = req.body;
    if (!question || !answer) throw new ApiError(400, "Question and answer are required");
    const text = `Q: ${question}\nA: ${answer}`;
    const { rows } = await query(
      `INSERT INTO knowledge_documents (knowledge_base_id, title, source_type, raw_text, status)
       VALUES ($1,$2,'FAQ',$3,'PENDING') RETURNING *`,
      [req.params.id, question.slice(0, 120), text]
    );
    const { processDocument } = await import("../services/knowledge/ingest.js");
    processDocument(rows[0].id).catch(() => {});
    res.status(201).json({ success: true, data: rows[0], message: "FAQ added, processing started" });
  } catch (err) { next(err); }
});

export default router;
