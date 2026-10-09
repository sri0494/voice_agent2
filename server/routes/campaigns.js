import { Router } from "express";
import { query } from "../db/pool.js";
import { requireAuth, requireStaff } from "../middleware/auth.js";
import { rbac, R } from "../middleware/rbac.js";
import { campaignLaunchLimiter } from "../middleware/rateLimit.js";
import { audit } from "../services/audit.js";
import { ApiError } from "../middleware/errorHandler.js";

const router = Router();
router.use(requireAuth, requireStaff, rbac({
  read: R.STAFF, write: R.MANAGERS, remove: R.ADMINS,
  rules: [{ method: "POST", path: /^\/[^/]+\/(pause|stop)$/, roles: R.OPERATORS }],   // starting/resuming (dialing) stays MANAGER+
}));
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const needUuid = (v) => { if (!UUID_RE.test(String(v))) throw new ApiError(400, "Invalid campaign ID"); return v; };

router.get("/", async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT c.*, a.name AS agent_name,
        (SELECT COUNT(*) FROM contacts WHERE campaign_id = c.id) AS contact_count,
        (SELECT COUNT(*) FROM calls WHERE campaign_id = c.id) AS call_count
       FROM campaigns c
       LEFT JOIN agents a ON a.id = c.agent_id
       ORDER BY c.created_at DESC`
    );
    res.json({ success: true, data: rows, message: "Success" });
  } catch (err) { next(err); }
});

router.get("/:id", async (req, res, next) => {
  try {
    needUuid(req.params.id);
    const { rows } = await query(
      `SELECT c.*, a.name AS agent_name FROM campaigns c LEFT JOIN agents a ON a.id = c.agent_id WHERE c.id = $1`,
      [req.params.id]
    );
    if (!rows[0]) throw new ApiError(404, "Campaign not found");

    const { rows: stats } = await query(
      `SELECT status, COUNT(*) AS count FROM calls WHERE campaign_id = $1 GROUP BY status`,
      [req.params.id]
    );
    res.json({ success: true, data: { ...rows[0], callStats: stats }, message: "Success" });
  } catch (err) { next(err); }
});

router.post("/", async (req, res, next) => {
  try {
    const b = req.body;
    if (!b.name || !b.type) throw new ApiError(400, "Campaign name and type are required");
    const { rows } = await query(
      `INSERT INTO campaigns (name, type, description, language, agent_id, knowledge_base_id, status,
                               start_date, end_date, retry_attempts, calling_hours, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [b.name, b.type, b.description || null, b.language || "English", b.agentId || null, b.knowledgeBaseId || null,
       "Draft", b.startDate || null, b.endDate || null, b.retryAttempts ?? 2,
       JSON.stringify(b.callingHours || { start: "09:00", end: "19:00", days: ["MON","TUE","WED","THU","FRI"] }),
       req.user.id]
    );
    await audit(req, { action: "campaign_create", resource: "campaign", resourceId: rows[0].id });
    res.status(201).json({ success: true, data: rows[0], message: "Campaign created" });
  } catch (err) { next(err); }
});

router.put("/:id", async (req, res, next) => {
  try {
    const b = req.body;
    const { rows } = await query(
      `UPDATE campaigns SET
        name = COALESCE($2, name), type = COALESCE($3, type), description = COALESCE($4, description),
        language = COALESCE($5, language), agent_id = COALESCE($6, agent_id),
        knowledge_base_id = COALESCE($7, knowledge_base_id), start_date = COALESCE($8, start_date),
        end_date = COALESCE($9, end_date), retry_attempts = COALESCE($10, retry_attempts),
        calling_hours = COALESCE($11, calling_hours), updated_at = now()
       WHERE id = $1 RETURNING *`,
      [req.params.id, b.name, b.type, b.description, b.language, b.agentId, b.knowledgeBaseId,
       b.startDate, b.endDate, b.retryAttempts, b.callingHours ? JSON.stringify(b.callingHours) : null]
    );
    if (!rows[0]) throw new ApiError(404, "Campaign not found");
    await audit(req, { action: "campaign_update", resource: "campaign", resourceId: req.params.id });
    res.json({ success: true, data: rows[0], message: "Campaign updated" });
  } catch (err) { next(err); }
});

// Allowed lifecycle (enforced atomically in SQL, not just in the UI):
//   Draft -> Running -> Paused <-> Running -> Completed (set by the dialer);  Draft/Running/Paused -> Cancelled.
//   Completed -> Running is allowed only when new PENDING contacts exist.  Cancelled is final.
const FROM = {
  Running: ["Draft", "Ready", "Scheduled", "Paused", "Completed"],
  Paused: ["Running"],
  Cancelled: ["Draft", "Ready", "Scheduled", "Running", "Paused"],
};
const ACTION = { Running: "campaign_launch", Paused: "campaign_pause", Cancelled: "campaign_stop" };

async function setStatus(req, res, next, status) {
  try {
    needUuid(req.params.id);
    if (status === "Running") {
      const { rows: campaignRows } = await query(`SELECT * FROM campaigns WHERE id = $1`, [req.params.id]);
      const campaign = campaignRows[0];
      if (!campaign) throw new ApiError(404, "Campaign not found");
      if (!campaign.agent_id) {
        throw new ApiError(400, "This campaign has no AI Agent assigned. Edit the campaign and select an agent before starting it.");
      }
      const { rows: contactCountRows } = await query(
        `SELECT COUNT(*) FROM contacts WHERE campaign_id = $1 AND status = 'PENDING'`,
        [req.params.id]
      );
      if (Number(contactCountRows[0].count) === 0) {
        throw new ApiError(400, "This campaign has no pending contacts to call. Upload a contact list first.");
      }
    }

    // One atomic statement: the row only changes if it is currently in a state that may move to `status`.
    const { rows } = await query(
      `UPDATE campaigns SET status = $2, updated_at = now() WHERE id = $1 AND status = ANY($3::text[]) RETURNING id, status`,
      [req.params.id, status, FROM[status]]
    );
    if (!rows[0]) {
      const { rows: cur } = await query(`SELECT status FROM campaigns WHERE id = $1`, [req.params.id]);
      if (!cur[0]) throw new ApiError(404, "Campaign not found");
      throw new ApiError(409, `A ${cur[0].status} campaign cannot be changed to ${status}`);
    }
    await audit(req, { action: ACTION[status], resource: "campaign", resourceId: req.params.id, meta: { to: status } });
    res.json({ success: true, data: rows[0], message: `Campaign ${status.toLowerCase()}` });
  } catch (err) { next(err); }
}

router.post("/:id/start", campaignLaunchLimiter, (req, res, next) => setStatus(req, res, next, "Running"));
router.post("/:id/pause", campaignLaunchLimiter, (req, res, next) => setStatus(req, res, next, "Paused"));
router.post("/:id/resume", campaignLaunchLimiter, (req, res, next) => setStatus(req, res, next, "Running"));
router.post("/:id/stop", campaignLaunchLimiter, (req, res, next) => setStatus(req, res, next, "Cancelled"));

router.delete("/:id", async (req, res, next) => {
  try {
    needUuid(req.params.id);
    const { rowCount } = await query(`DELETE FROM campaigns WHERE id = $1 AND status <> 'Running'`, [req.params.id]);
    if (!rowCount) {
      const { rows } = await query(`SELECT status FROM campaigns WHERE id = $1`, [req.params.id]);
      throw rows[0] ? new ApiError(409, "Stop or pause a running campaign before deleting it") : new ApiError(404, "Campaign not found");
    }
    await audit(req, { action: "campaign_delete", resource: "campaign", resourceId: req.params.id });
    res.json({ success: true, data: null, message: "Campaign deleted" });
  } catch (err) { next(err); }
});

export default router;
