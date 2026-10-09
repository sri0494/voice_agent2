import { Router } from "express";
import { query } from "../db/pool.js";
import { requireAuth, requireStaff } from "../middleware/auth.js";
import { rbac, R } from "../middleware/rbac.js";
import { audit } from "../services/audit.js";
import { aiLimiter } from "../middleware/rateLimit.js";
import { ApiError } from "../middleware/errorHandler.js";
import { createAIProvider } from "../services/ai/AIProvider.js";

const router = Router();
router.use(requireAuth, requireStaff, rbac({ read: R.STAFF, write: R.MANAGERS, remove: R.ADMINS, rules: [{ method: "POST", path: /^\/[^/]+\/test$/, roles: R.OPERATORS }] }));

router.get("/", async (req, res, next) => {
  try {
    const { rows } = await query(`SELECT * FROM agents ORDER BY created_at DESC`);
    res.json({ success: true, data: rows, message: "Success" });
  } catch (err) { next(err); }
});

router.get("/:id", async (req, res, next) => {
  try {
    const { rows } = await query(`SELECT * FROM agents WHERE id = $1`, [req.params.id]);
    if (!rows[0]) throw new ApiError(404, "Agent not found");

    const { rows: kbs } = await query(
      `SELECT kb.id, kb.name FROM agent_knowledge_bases akb
       JOIN knowledge_bases kb ON kb.id = akb.knowledge_base_id
       WHERE akb.agent_id = $1`,
      [req.params.id]
    );
    res.json({ success: true, data: { ...rows[0], knowledgeBases: kbs }, message: "Success" });
  } catch (err) { next(err); }
});

const E164 = /^\+?[1-9]\d{7,14}$/;
const CONSENT = ["NOT_REQUIRED", "REQUIRED"];
function checkAgentBody(b) {
  if (b.transferNumber && !E164.test(String(b.transferNumber).replace(/[\s()-]/g, ""))) throw new ApiError(422, "transferNumber must be a valid phone number (E.164)");
  if (b.recordingConsent !== undefined && !CONSENT.includes(b.recordingConsent)) throw new ApiError(422, `recordingConsent must be one of ${CONSENT.join(", ")}`);
  if (b.recordingRetentionDays !== undefined && b.recordingRetentionDays !== null) {
    const d = Number(b.recordingRetentionDays);
    if (!Number.isInteger(d) || d < 1 || d > 3650) throw new ApiError(422, "recordingRetentionDays must be 1-3650, or null to keep recordings forever");
  }
  if (b.recordingConsentMessage && String(b.recordingConsentMessage).length > 500) throw new ApiError(422, "recordingConsentMessage is too long (max 500 characters)");
}
// Recording consent / retention are saved separately so an explicit null ("keep forever") is possible.
async function saveRecordingSettings(agentId, b) {
  const has = (k) => Object.prototype.hasOwnProperty.call(b, k);
  if (has("recordingConsent")) await query(`UPDATE agents SET recording_consent = $2 WHERE id = $1`, [agentId, b.recordingConsent]);
  if (has("recordingConsentMessage")) await query(`UPDATE agents SET recording_consent_message = $2 WHERE id = $1`, [agentId, b.recordingConsentMessage || null]);
  if (has("recordingRetentionDays")) await query(`UPDATE agents SET recording_retention_days = $2 WHERE id = $1`, [agentId, b.recordingRetentionDays === null ? null : Number(b.recordingRetentionDays)]);
}

router.post("/", async (req, res, next) => {
  try {
    const b = req.body;
    if (!b.name) throw new ApiError(400, "Agent name is required");
    checkAgentBody(b);
    const { rows } = await query(
      `INSERT INTO agents (name, description, status, language, voice, greeting, system_prompt, temperature,
                            fallback_message, transfer_enabled, transfer_number, max_call_duration_sec,
                            recording_enabled, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING *`,
      [b.name, b.description || null, b.status || "DRAFT", b.language || "English", b.voice || null,
       b.greeting || null, b.systemPrompt || null, b.temperature ?? 0.3,
       b.fallbackMessage || "I don't have enough information to answer that accurately. I can connect you with a human representative.",
       !!b.transferEnabled, b.transferNumber || null,
       b.maxCallDurationSec || 600, b.recordingEnabled !== false, req.user.id]
    );
    const agent = rows[0];
    await saveRecordingSettings(agent.id, b);

    if (Array.isArray(b.knowledgeBaseIds) && b.knowledgeBaseIds.length) {
      for (const kbId of b.knowledgeBaseIds) {
        await query(
          `INSERT INTO agent_knowledge_bases (agent_id, knowledge_base_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
          [agent.id, kbId]
        );
      }
    }
    await audit(req, { action: "agent_create", resource: "agent", resourceId: agent.id });
    res.status(201).json({ success: true, data: agent, message: "Agent created" });
  } catch (err) { next(err); }
});

router.put("/:id", async (req, res, next) => {
  try {
    const b = req.body;
    checkAgentBody(b);
    const { rows } = await query(
      `UPDATE agents SET
        name = COALESCE($2, name), description = COALESCE($3, description),
        status = COALESCE($4, status), language = COALESCE($5, language),
        voice = COALESCE($6, voice), greeting = COALESCE($7, greeting),
        system_prompt = COALESCE($8, system_prompt), temperature = COALESCE($9, temperature),
        fallback_message = COALESCE($10, fallback_message),
        transfer_enabled = COALESCE($11, transfer_enabled), transfer_number = COALESCE($12, transfer_number),
        max_call_duration_sec = COALESCE($13, max_call_duration_sec),
        recording_enabled = COALESCE($14, recording_enabled),
        agent_type = COALESCE($15, agent_type), business_name = COALESCE($16, business_name),
        gender = COALESCE($17, gender), personality = COALESCE($18, personality),
        updated_at = now()
       WHERE id = $1 RETURNING *`,
      [req.params.id, b.name, b.description, b.status, b.language, b.voice, b.greeting, b.systemPrompt,
       b.temperature, b.fallbackMessage, b.transferEnabled, b.transferNumber, b.maxCallDurationSec, b.recordingEnabled,
       b.agentType, b.businessName, b.gender, b.personality]
    );
    if (!rows[0]) throw new ApiError(404, "Agent not found");
    await saveRecordingSettings(req.params.id, b);

    if (b.systemPrompt) {
      await query(
        `INSERT INTO agent_prompts (agent_id, system_prompt, greeting, created_by) VALUES ($1,$2,$3,$4)`,
        [req.params.id, b.systemPrompt, b.greeting || null, req.user.id]
      );
    }

    if (Array.isArray(b.knowledgeBaseIds)) {
      await query(`DELETE FROM agent_knowledge_bases WHERE agent_id = $1`, [req.params.id]);
      for (const kbId of b.knowledgeBaseIds) {
        await query(`INSERT INTO agent_knowledge_bases (agent_id, knowledge_base_id) VALUES ($1,$2)`, [req.params.id, kbId]);
      }
    }
    await audit(req, { action: "agent_update", resource: "agent", resourceId: req.params.id });
    res.json({ success: true, data: rows[0], message: "Agent updated" });
  } catch (err) { next(err); }
});

router.delete("/:id", async (req, res, next) => {
  try {
    const { rowCount } = await query(`DELETE FROM agents WHERE id = $1`, [req.params.id]);
    if (!rowCount) throw new ApiError(404, "Agent not found");
    await audit(req, { action: "agent_delete", resource: "agent", resourceId: req.params.id });
    res.json({ success: true, data: null, message: "Agent deleted" });
  } catch (err) { next(err); }
});

// Test the agent's configured prompt against a sample message (no telephony involved).
router.post("/:id/test", aiLimiter, async (req, res, next) => {
  try {
    const { message } = req.body;
    const { rows } = await query(`SELECT * FROM agents WHERE id = $1`, [req.params.id]);
    const agent = rows[0];
    if (!agent) throw new ApiError(404, "Agent not found");

    const aiProvider = createAIProvider();
    const result = await aiProvider.generateResponse({
      systemPrompt: agent.system_prompt || "",
      context: "",
      temperature: agent.temperature,
      fallbackMessage: agent.fallback_message,
      messages: [{ role: "user", content: message || "Hello" }],
    });
    res.json({ success: true, data: result, message: "Test complete (no real call placed)" });
  } catch (err) { next(err); }
});

export default router;
