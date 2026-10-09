import { Router } from "express";
import { query } from "../db/pool.js";
import { requireAuth, requireStaff } from "../middleware/auth.js";
import { rbac, R } from "../middleware/rbac.js";
import { audit } from "../services/audit.js";
import { aiLimiter } from "../middleware/rateLimit.js";
import { ApiError } from "../middleware/errorHandler.js";
import { answerWithRAG } from "../services/knowledge/rag.js";

const router = Router();
router.use(requireAuth, requireStaff, rbac({ read: R.STAFF, write: R.OPERATORS }));

// Lets an admin test "what would the AI say" for a given agent + question,
// without placing a real call. Powers the "Test Agent" button in the UI.
router.post("/query", aiLimiter, async (req, res, next) => {
  try {
    const { agentId, question } = req.body;
    if (!agentId || !question) throw new ApiError(400, "agentId and question are required");

    const { rows: agentRows } = await query(`SELECT * FROM agents WHERE id = $1`, [agentId]);
    const agent = agentRows[0];
    if (!agent) throw new ApiError(404, "Agent not found");

    const { rows: kbRows } = await query(
      `SELECT knowledge_base_id FROM agent_knowledge_bases WHERE agent_id = $1`,
      [agentId]
    );
    const knowledgeBaseIds = kbRows.map((r) => r.knowledge_base_id);

    const result = await answerWithRAG({ question, knowledgeBaseIds, agent });
    res.json({ success: true, data: result, message: "Success" });
  } catch (err) { next(err); }
});

export default router;
