import { Router } from "express";
import { query } from "../db/pool.js";
import { requireAuth, requireStaff } from "../middleware/auth.js";
import { rbac, R } from "../middleware/rbac.js";
import { audit } from "../services/audit.js";
import { ApiError } from "../middleware/errorHandler.js";

const router = Router();
router.use(requireAuth, requireStaff, rbac({ read: R.STAFF, write: R.MANAGERS }));

// GET/PUT the conversation-intelligence config fields added in migration 003
// (objective, allowed/restricted topics, off-topic handling, extraction
// fields). Kept as its own endpoint, separate from the core agent CRUD in
// agents.js, so this patch never has to touch that already-working route.
router.get("/:agentId", async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, primary_objective, allowed_topics, restricted_topics, required_information,
              off_topic_strategy, max_off_topic_turns, knowledge_only_mode, confidence_threshold,
              conversation_style, extraction_fields
       FROM agents WHERE id = $1`,
      [req.params.agentId]
    );
    if (!rows[0]) throw new ApiError(404, "Agent not found");
    res.json({ success: true, data: rows[0], message: "Success" });
  } catch (err) { next(err); }
});

router.put("/:agentId", async (req, res, next) => {
  try {
    const b = req.body;
    const { rows } = await query(
      `UPDATE agents SET
        primary_objective = COALESCE($2, primary_objective),
        allowed_topics = COALESCE($3, allowed_topics),
        restricted_topics = COALESCE($4, restricted_topics),
        required_information = COALESCE($5, required_information),
        off_topic_strategy = COALESCE($6, off_topic_strategy),
        max_off_topic_turns = COALESCE($7, max_off_topic_turns),
        knowledge_only_mode = COALESCE($8, knowledge_only_mode),
        confidence_threshold = COALESCE($9, confidence_threshold),
        conversation_style = COALESCE($10, conversation_style),
        extraction_fields = COALESCE($11, extraction_fields),
        updated_at = now()
       WHERE id = $1
       RETURNING id, primary_objective, allowed_topics, restricted_topics, required_information,
                 off_topic_strategy, max_off_topic_turns, knowledge_only_mode, confidence_threshold,
                 conversation_style, extraction_fields`,
      [req.params.agentId,
       b.primaryObjective ?? null,
       b.allowedTopics ?? null,
       b.restrictedTopics ?? null,
       b.requiredInformation ?? null,
       b.offTopicStrategy ?? null,
       b.maxOffTopicTurns ?? null,
       b.knowledgeOnlyMode ?? null,
       b.confidenceThreshold ?? null,
       b.conversationStyle ?? null,
       b.extractionFields ? JSON.stringify(b.extractionFields) : null]
    );
    if (!rows[0]) throw new ApiError(404, "Agent not found");
    res.json({ success: true, data: rows[0], message: "Conversation intelligence settings saved" });
  } catch (err) { next(err); }
});

export default router;
