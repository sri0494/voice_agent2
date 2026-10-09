import { Router } from "express";
import { query } from "../db/pool.js";
import { requireAuth, requireStaff } from "../middleware/auth.js";
import { rbac, R } from "../middleware/rbac.js";
import { audit } from "../services/audit.js";
import { aiLimiter } from "../middleware/rateLimit.js";
import { ApiError } from "../middleware/errorHandler.js";
import { processConversationTurn } from "../services/conversation/conversationOrchestrator.js";

const router = Router();
router.use(requireAuth, requireStaff, rbac({ read: R.STAFF, write: R.OPERATORS }));

// Core orchestration endpoint (spec section 29). This is what a real
// telephony/STT integration calls per customer utterance during a live
// call, and what the Agent Testing Playground (section 35) calls when
// you type a test message in the UI.
router.post("/process", aiLimiter, async (req, res, next) => {
  try {
    const { agentId, callId, sessionId, customerText, conversationHistory } = req.body;
    if (!agentId || !customerText) throw new ApiError(400, "agentId and customerText are required");

    const result = await processConversationTurn({
      agentId,
      callId: callId || null,
      sessionId: sessionId || null,
      customerText,
      conversationHistory: conversationHistory || [],
    });
    res.json({ success: true, data: result, message: "Success" });
  } catch (err) { next(err); }
});

// Live/complete conversation view: full event-by-event analysis for a session
// (intent, sentiment, topic, entities per turn) — powers the section 11
// real-time conversation screen.
router.get("/sessions/:sessionId", async (req, res, next) => {
  try {
    const { rows: sessionRows } = await query(`SELECT * FROM conversation_sessions WHERE id = $1`, [req.params.sessionId]);
    if (!sessionRows[0]) throw new ApiError(404, "Session not found");

    const { rows: events } = await query(
      `SELECT * FROM conversation_events WHERE session_id = $1 ORDER BY sequence ASC`,
      [req.params.sessionId]
    );
    res.json({ success: true, data: { ...sessionRows[0], events }, message: "Success" });
  } catch (err) { next(err); }
});

router.get("/calls/:callId/session", async (req, res, next) => {
  try {
    const { rows } = await query(`SELECT * FROM conversation_sessions WHERE call_id = $1`, [req.params.callId]);
    if (!rows[0]) return res.json({ success: true, data: null, message: "No conversation session for this call" });
    const { rows: events } = await query(
      `SELECT * FROM conversation_events WHERE session_id = $1 ORDER BY sequence ASC`,
      [rows[0].id]
    );
    res.json({ success: true, data: { ...rows[0], events }, message: "Success" });
  } catch (err) { next(err); }
});

export default router;
