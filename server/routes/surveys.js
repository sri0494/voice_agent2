import { Router } from "express";
import { query } from "../db/pool.js";
import { requireAuth, requireStaff } from "../middleware/auth.js";
import { rbac, R } from "../middleware/rbac.js";
import { audit } from "../services/audit.js";
import { ApiError } from "../middleware/errorHandler.js";

const router = Router();
router.use(requireAuth, requireStaff, rbac({ read: R.STAFF, write: R.MANAGERS, rules: [{ method: "POST", path: /^\/[^/]+\/responses$/, roles: R.OPERATORS }] }));

const QUESTION_TYPES = ["Yes/No", "Rating 1-5", "Rating 1-10", "Multiple Choice", "Single Choice", "Free Text", "Voice Response", "Numeric", "Date", "Location", "Custom"];

router.get("/", async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT s.*, a.name AS agent_name,
        (SELECT COUNT(*) FROM survey_questions WHERE survey_id = s.id) AS question_count,
        (SELECT COUNT(DISTINCT COALESCE(call_id::text, contact_id::text, customer_id::text, id::text))
         FROM survey_responses WHERE survey_id = s.id) AS response_count
       FROM surveys s LEFT JOIN agents a ON a.id = s.agent_id ORDER BY s.created_at DESC`
    );
    res.json({ success: true, data: rows, message: "Success" });
  } catch (err) { next(err); }
});

router.get("/:id", async (req, res, next) => {
  try {
    const { rows } = await query(`SELECT * FROM surveys WHERE id = $1`, [req.params.id]);
    if (!rows[0]) throw new ApiError(404, "Survey not found");
    const { rows: questions } = await query(
      `SELECT * FROM survey_questions WHERE survey_id = $1 ORDER BY sequence ASC`,
      [req.params.id]
    );
    res.json({ success: true, data: { ...rows[0], questions }, message: "Success" });
  } catch (err) { next(err); }
});

router.post("/", async (req, res, next) => {
  try {
    const { name, description, agentId } = req.body;
    if (!name) throw new ApiError(400, "Survey name is required");
    const { rows } = await query(
      `INSERT INTO surveys (name, description, agent_id, created_by) VALUES ($1,$2,$3,$4) RETURNING *`,
      [name, description || null, agentId || null, req.user.id]
    );
    res.status(201).json({ success: true, data: rows[0], message: "Survey created" });
  } catch (err) { next(err); }
});

router.put("/:id", async (req, res, next) => {
  try {
    const { name, description, status, agentId } = req.body;
    const { rows } = await query(
      `UPDATE surveys SET name = COALESCE($2,name), description = COALESCE($3,description),
        status = COALESCE($4,status), agent_id = COALESCE($5,agent_id), updated_at = now()
       WHERE id = $1 RETURNING *`,
      [req.params.id, name ?? null, description ?? null, status ?? null, agentId ?? null]
    );
    if (!rows[0]) throw new ApiError(404, "Survey not found");
    res.json({ success: true, data: rows[0], message: "Survey updated" });
  } catch (err) { next(err); }
});

router.delete("/:id", async (req, res, next) => {
  try {
    const { rowCount } = await query(`DELETE FROM surveys WHERE id = $1`, [req.params.id]);
    if (!rowCount) throw new ApiError(404, "Survey not found");
    res.json({ success: true, data: null, message: "Survey deleted" });
  } catch (err) { next(err); }
});

// --- Questions ---
router.post("/:id/questions", async (req, res, next) => {
  try {
    const b = req.body;
    if (!b.questionText || !b.questionType) throw new ApiError(400, "questionText and questionType are required");
    if (!QUESTION_TYPES.includes(b.questionType)) throw new ApiError(400, `questionType must be one of: ${QUESTION_TYPES.join(", ")}`);

    const { rows: countRows } = await query(`SELECT COUNT(*) FROM survey_questions WHERE survey_id = $1`, [req.params.id]);
    const sequence = Number(countRows[0].count) + 1;

    const { rows } = await query(
      `INSERT INTO survey_questions (survey_id, sequence, question_text, question_type, options, condition_rule, required)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [req.params.id, sequence, b.questionText, b.questionType, JSON.stringify(b.options || []),
       b.conditionRule ? JSON.stringify(b.conditionRule) : null, b.required !== false]
    );
    res.status(201).json({ success: true, data: rows[0], message: "Question added" });
  } catch (err) { next(err); }
});

router.delete("/questions/:questionId", async (req, res, next) => {
  try {
    const { rowCount } = await query(`DELETE FROM survey_questions WHERE id = $1`, [req.params.questionId]);
    if (!rowCount) throw new ApiError(404, "Question not found");
    res.json({ success: true, data: null, message: "Question removed" });
  } catch (err) { next(err); }
});

// --- Responses ---
router.post("/:id/responses", async (req, res, next) => {
  try {
    const { questionId, callId, contactId, customerId, answerText, answerNumeric, sentiment } = req.body || {};
    if (!questionId) throw new ApiError(400, "questionId is required");
    // The question must belong to THIS survey; a response can only be attached to a real call.
    const q = await query(`SELECT 1 FROM survey_questions WHERE id = $1 AND survey_id = $2`, [questionId, req.params.id]);
    if (!q.rows[0]) throw new ApiError(404, "Question not found in this survey");
    if (callId) {
      const c = await query(`SELECT 1 FROM calls WHERE id = $1`, [callId]);
      if (!c.rows[0]) throw new ApiError(404, "Call not found");
    }
    // One answer per (survey, question, call): agent/webhook retries cannot create duplicates (unique index, migration 004).
    const { rows } = await query(
      `INSERT INTO survey_responses (survey_id, question_id, call_id, contact_id, customer_id, answer_text, answer_numeric, sentiment)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (survey_id, question_id, call_id) WHERE call_id IS NOT NULL DO NOTHING RETURNING *`,
      [req.params.id, questionId, callId || null, contactId || null, customerId || null,
       answerText || null, answerNumeric ?? null, sentiment || null]
    );
    if (!rows[0]) {
      const { rows: existing } = await query(`SELECT * FROM survey_responses WHERE survey_id = $1 AND question_id = $2 AND call_id = $3`, [req.params.id, questionId, callId]);
      return res.status(200).json({ success: true, data: existing[0], message: "Response already recorded" });
    }
    res.status(201).json({ success: true, data: rows[0], message: "Response recorded" });
  } catch (err) { next(err); }
});

// --- Results (spec section 23: survey analytics) ---
router.get("/:id/results", async (req, res, next) => {
  try {
    const { rows: questions } = await query(
      `SELECT * FROM survey_questions WHERE survey_id = $1 ORDER BY sequence ASC`,
      [req.params.id]
    );

    const questionResults = await Promise.all(questions.map(async (q) => {
      const { rows: stats } = await query(
        `SELECT
          COUNT(*) AS response_count,
          AVG(answer_numeric) AS avg_score,
          COUNT(*) FILTER (WHERE sentiment = 'Positive') AS positive_count,
          COUNT(*) FILTER (WHERE sentiment = 'Negative') AS negative_count
         FROM survey_responses WHERE question_id = $1`,
        [q.id]
      );
      const s = stats[0];
      const total = Number(s.response_count);
      return {
        questionId: q.id,
        questionText: q.question_text,
        responseCount: total,
        avgScore: s.avg_score ? Number(Number(s.avg_score).toFixed(2)) : null,
        positivePct: total ? Number(((Number(s.positive_count) / total) * 100).toFixed(1)) : 0,
        negativePct: total ? Number(((Number(s.negative_count) / total) * 100).toFixed(1)) : 0,
      };
    }));

    const { rows: overall } = await query(
      `SELECT COUNT(DISTINCT COALESCE(call_id::text, contact_id::text, customer_id::text, id::text)) AS total_responses,
        COUNT(*) FILTER (WHERE sentiment = 'Positive') AS positive,
        COUNT(*) FILTER (WHERE sentiment = 'Negative') AS negative,
        COUNT(*) FILTER (WHERE sentiment = 'Neutral') AS neutral
       FROM survey_responses WHERE survey_id = $1`,
      [req.params.id]
    );

    res.json({ success: true, data: { overall: overall[0], questions: questionResults }, message: "Success" });
  } catch (err) { next(err); }
});

export default router;
