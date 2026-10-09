import { Router } from "express";
import { query } from "../db/pool.js";
import { requireAuth, requireStaff, requireRole } from "../middleware/auth.js";
import { rbac, R } from "../middleware/rbac.js";
import { audit } from "../services/audit.js";
import { ApiError } from "../middleware/errorHandler.js";

const router = Router();
router.use(requireAuth, requireStaff, rbac({ read: R.STAFF, write: R.ADMINS }));

router.get("/", async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT p.*, a.name AS agent_name FROM phone_numbers p
       LEFT JOIN agents a ON a.id = p.agent_id ORDER BY p.created_at DESC`
    );
    res.json({ success: true, data: rows, message: "Success" });
  } catch (err) { next(err); }
});

router.post("/", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
  try {
    const b = req.body;
    if (!b.number) throw new ApiError(400, "Phone number is required");
    const { rows } = await query(
      `INSERT INTO phone_numbers (number, provider, agent_id, inbound_enabled, outbound_enabled,
                                    business_hours, recording_enabled, voicemail_enabled)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [b.number, b.provider || null, b.agentId || null, b.inboundEnabled !== false, b.outboundEnabled !== false,
       JSON.stringify(b.businessHours || { start: "09:00", end: "19:00", days: ["MON","TUE","WED","THU","FRI"] }),
       b.recordingEnabled !== false, !!b.voicemailEnabled]
    );
    res.status(201).json({ success: true, data: rows[0], message: "Phone number added" });
  } catch (err) {
    if (err.code === "23505") return next(new ApiError(409, "This phone number is already registered"));
    next(err);
  }
});

router.put("/:id", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
  try {
    const b = req.body;
    const { rows } = await query(
      `UPDATE phone_numbers SET
        agent_id = COALESCE($2, agent_id), inbound_enabled = COALESCE($3, inbound_enabled),
        outbound_enabled = COALESCE($4, outbound_enabled), status = COALESCE($5, status),
        recording_enabled = COALESCE($6, recording_enabled), voicemail_enabled = COALESCE($7, voicemail_enabled),
        updated_at = now()
       WHERE id = $1 RETURNING *`,
      [req.params.id, b.agentId, b.inboundEnabled, b.outboundEnabled, b.status, b.recordingEnabled, b.voicemailEnabled]
    );
    if (!rows[0]) throw new ApiError(404, "Phone number not found");
    res.json({ success: true, data: rows[0], message: "Phone number updated" });
  } catch (err) { next(err); }
});

router.delete("/:id", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
  try {
    const { rowCount } = await query(`DELETE FROM phone_numbers WHERE id = $1`, [req.params.id]);
    if (!rowCount) throw new ApiError(404, "Phone number not found");
    res.json({ success: true, data: null, message: "Phone number removed" });
  } catch (err) { next(err); }
});

export default router;
