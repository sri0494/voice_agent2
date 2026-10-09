import { Router } from "express";
import { query } from "../db/pool.js";
import { requireAuth, requireStaff } from "../middleware/auth.js";
import { rbac, R } from "../middleware/rbac.js";
import { audit } from "../services/audit.js";
import { callLimiter } from "../middleware/rateLimit.js";
import { publishCallUpdate } from "../services/liveCalls.js";
import { ApiError } from "../middleware/errorHandler.js";
import { createTelephonyProvider } from "../services/telephony/TelephonyProvider.js";

const router = Router();
router.use(requireAuth, requireStaff, rbac({
  read: R.STAFF, write: R.MANAGERS,
  rules: [{ method: "POST", path: /^\/[^/]+\/(transfer|end)$/, roles: R.OPERATORS }],   // AGENT may transfer / end calls; VIEWER may not
}));
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const E164 = /^\+?[1-9]\d{7,14}$/;
const needUuid = (v) => { if (!UUID_RE.test(String(v))) throw new ApiError(400, "Invalid call ID"); return v; };
const telephonyProvider = createTelephonyProvider();

router.get("/", async (req, res, next) => {
  try {
    const { status, campaignId, agentId } = req.query;
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
    if (campaignId) needUuid(campaignId);
    if (agentId) needUuid(agentId);
    const conditions = [];
    const params = [];
    if (status) { params.push(status); conditions.push(`c.status = $${params.length}`); }
    if (campaignId) { params.push(campaignId); conditions.push(`c.campaign_id = $${params.length}`); }
    if (agentId) { params.push(agentId); conditions.push(`c.agent_id = $${params.length}`); }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(limit);

    const { rows } = await query(
      `SELECT c.*, camp.name AS campaign_name, a.name AS agent_name
       FROM calls c
       LEFT JOIN campaigns camp ON camp.id = c.campaign_id
       LEFT JOIN agents a ON a.id = c.agent_id
       ${where}
       ORDER BY c.created_at DESC LIMIT $${params.length}`,
      params
    );
    res.json({ success: true, data: rows, message: "Success" });
  } catch (err) { next(err); }
});

// Live calls: currently-active call states only.
router.get("/live", async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT c.*, camp.name AS campaign_name, a.name AS agent_name
       FROM calls c
       LEFT JOIN campaigns camp ON camp.id = c.campaign_id
       LEFT JOIN agents a ON a.id = c.agent_id
       WHERE c.status IN ('Ringing','Connected','Live','Transferred')
       ORDER BY c.created_at DESC`
    );
    res.json({ success: true, data: rows, message: "Success" });
  } catch (err) { next(err); }
});

router.get("/:id", async (req, res, next) => {
  try {
    needUuid(req.params.id);
    const { rows } = await query(
      `SELECT c.*, camp.name AS campaign_name, a.name AS agent_name
       FROM calls c
       LEFT JOIN campaigns camp ON camp.id = c.campaign_id
       LEFT JOIN agents a ON a.id = c.agent_id
       WHERE c.id = $1`,
      [req.params.id]
    );
    if (!rows[0]) throw new ApiError(404, "Call not found");

    const { rows: messages } = await query(
      `SELECT * FROM call_messages WHERE call_id = $1 ORDER BY sequence ASC`,
      [req.params.id]
    );
    const { rows: recordings } = await query(`SELECT * FROM call_recordings WHERE call_id = $1`, [req.params.id]);

    res.json({ success: true, data: { ...rows[0], messages, recordings }, message: "Success" });
  } catch (err) { next(err); }
});

router.post("/:id/transfer", callLimiter, async (req, res, next) => {
  try {
    needUuid(req.params.id);
    const { rows } = await query(
      `SELECT c.*, a.transfer_number, a.transfer_enabled FROM calls c LEFT JOIN agents a ON a.id = c.agent_id WHERE c.id = $1`, [req.params.id]);
    const call = rows[0];
    if (!call) throw new ApiError(404, "Call not found");
    if (!call.provider_call_id) throw new ApiError(400, "Call has no active provider session");
    // Toll-fraud guard: only the agent's configured transfer number, unless an admin names another valid number.
    const requested = req.body?.toNumber ? String(req.body.toNumber).replace(/[\s()-]/g, "") : null;
    const target = requested && R.ADMINS.includes(req.user.role) ? requested : call.transfer_number;
    if (requested && !R.ADMINS.includes(req.user.role) && requested !== call.transfer_number) throw new ApiError(403, "Only the agent's configured transfer number can be used");
    if (!target || !E164.test(target)) throw new ApiError(422, "A valid transfer number is required");

    const result = await telephonyProvider.transfer(call.provider_call_id, target);
    await query(`UPDATE calls SET status = 'Transferred', updated_at = now() WHERE id = $1`, [req.params.id]);
    publishCallUpdate(req.params.id);
    await audit(req, { action: "call_transfer", resource: "call", resourceId: req.params.id });
    res.json({ success: true, data: result, message: "Call transfer initiated" });
  } catch (err) { next(err); }
});

router.post("/:id/end", callLimiter, async (req, res, next) => {
  try {
    needUuid(req.params.id);
    const { rows } = await query(`SELECT * FROM calls WHERE id = $1`, [req.params.id]);
    const call = rows[0];
    if (!call) throw new ApiError(404, "Call not found");

    if (call.provider_call_id) await telephonyProvider.hangup(call.provider_call_id);
    await query(
      `UPDATE calls SET status = 'Completed', ended_at = now(), updated_at = now() WHERE id = $1`,
      [req.params.id]
    );
    publishCallUpdate(req.params.id);
    await audit(req, { action: "call_end", resource: "call", resourceId: req.params.id });
    res.json({ success: true, data: null, message: "Call ended" });
  } catch (err) { next(err); }
});

export default router;
