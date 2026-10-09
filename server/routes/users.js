import { Router } from "express";
import bcrypt from "bcryptjs";
import { query } from "../db/pool.js";
import { requireAuth, requireRole, requireStaff, STAFF_ROLES } from "../middleware/auth.js";
import { ApiError } from "../middleware/errorHandler.js";
import { passwordLimiter } from "../middleware/rateLimit.js";
import { audit } from "../services/audit.js";

const router = Router();
const ADMIN_ROLES = ["SUPER_ADMIN", "ADMIN"];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.use(requireAuth, requireStaff, requireRole(...ADMIN_ROLES));

// Privilege-escalation guard: SUPER_ADMIN manages every staff role; ADMIN manages only MANAGER / AGENT / VIEWER.
// (Customer logins are managed under /api/clients, never here.)
const MANAGEABLE = { SUPER_ADMIN: STAFF_ROLES, ADMIN: ["MANAGER", "AGENT", "VIEWER"] };
const canManage = (actorRole, targetRole) => (MANAGEABLE[actorRole] || []).includes(String(targetRole).toUpperCase());
const needUuid = (v) => { if (!UUID_RE.test(String(v))) throw new ApiError(400, "Invalid user ID"); return v; };
const checkPassword = (p) => {
  if (typeof p !== "string" || p.length < 8) throw new ApiError(400, "Password must be at least 8 characters");
  if (Buffer.byteLength(p) > 72) throw new ApiError(400, "Password is too long (max 72 bytes)");
};

async function loadTarget(req) {
  needUuid(req.params.id);
  const { rows } = await query(`SELECT id, role FROM users WHERE id = $1`, [req.params.id]);
  if (!rows[0]) throw new ApiError(404, "User not found");
  if (!canManage(req.user.role, rows[0].role)) throw new ApiError(403, "You cannot manage a user with this role");
  return rows[0];
}

router.get("/", async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, name, email, phone, agent_id, role, status, client_id, last_login_at, created_at FROM users ORDER BY created_at DESC`);
    res.json({ success: true, data: rows, message: "Success" });
  } catch (err) { next(err); }
});

router.post("/", async (req, res, next) => {
  try {
    const { name, email, phone, agentId, role = "AGENT", password } = req.body || {};
    if (!name || !email || !password) throw new ApiError(400, "Name, email, and password are required");
    if (!/^\S+@\S+\.\S+$/.test(String(email))) throw new ApiError(422, "A valid email is required");
    if (!STAFF_ROLES.includes(String(role).toUpperCase())) throw new ApiError(422, `Role must be one of ${STAFF_ROLES.join(", ")}`);
    if (!canManage(req.user.role, role)) throw new ApiError(403, "You cannot create a user with this role");
    checkPassword(password);

    const { rows } = await query(
      `INSERT INTO users (name, email, phone, agent_id, role, password_hash)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, name, email, phone, agent_id, role, status, created_at`,
      [String(name).trim(), String(email).toLowerCase().trim(), phone || null, agentId || null, String(role).toUpperCase(), await bcrypt.hash(password, 10)]);
    await audit(req, { action: "user_create", resource: "user", resourceId: rows[0].id, meta: { role: rows[0].role } });
    res.status(201).json({ success: true, data: rows[0], message: "User created" });
  } catch (err) {
    if (err.code === "23505") return next(new ApiError(409, "A user with this email already exists"));
    next(err);
  }
});

router.put("/:id", async (req, res, next) => {
  try {
    const target = await loadTarget(req);
    const { name, phone, agentId, role, status } = req.body || {};
    const selfEdit = target.id === req.user.id;
    if (selfEdit && (role !== undefined || status !== undefined)) throw new ApiError(403, "You cannot change your own role or status");
    if (role !== undefined) {
      if (!STAFF_ROLES.includes(String(role).toUpperCase())) throw new ApiError(422, `Role must be one of ${STAFF_ROLES.join(", ")}`);
      if (!canManage(req.user.role, role)) throw new ApiError(403, "You cannot assign this role");
    }
    if (status !== undefined && !["ACTIVE", "DISABLED"].includes(String(status).toUpperCase())) throw new ApiError(422, "Status must be ACTIVE or DISABLED");

    const { rows } = await query(
      `UPDATE users SET name = COALESCE($2, name), phone = COALESCE($3, phone), agent_id = COALESCE($4, agent_id),
              role = COALESCE($5, role), status = COALESCE($6, status), updated_at = now()
       WHERE id = $1 RETURNING id, name, email, phone, agent_id, role, status`,
      [req.params.id, name, phone, agentId, role ? String(role).toUpperCase() : null, status ? String(status).toUpperCase() : null]);
    await audit(req, { action: role !== undefined ? "permission_change" : "user_update", resource: "user", resourceId: req.params.id, meta: { role, status } });
    res.json({ success: true, data: rows[0], message: "User updated" });
  } catch (err) { next(err); }
});

router.post("/:id/disable", async (req, res, next) => {
  try {
    const target = await loadTarget(req);
    if (target.id === req.user.id) throw new ApiError(403, "You cannot disable your own account");
    const { rows } = await query(`UPDATE users SET status = 'DISABLED', updated_at = now() WHERE id = $1 RETURNING id, status`, [req.params.id]);
    await audit(req, { action: "user_disable", resource: "user", resourceId: req.params.id });
    res.json({ success: true, data: rows[0], message: "User disabled" });     // requireAuth re-checks status on every request: access ends immediately
  } catch (err) { next(err); }
});

router.post("/:id/reset-password", passwordLimiter, async (req, res, next) => {
  try {
    await loadTarget(req);
    checkPassword(req.body?.newPassword);
    await query(
      `UPDATE users SET password_hash = $2, password_changed_at = date_trunc('second', now()), updated_at = now() WHERE id = $1`,
      [req.params.id, await bcrypt.hash(req.body.newPassword, 10)]);       // all of that user's existing sessions stop working
    await audit(req, { action: "password_reset", resource: "user", resourceId: req.params.id });
    res.json({ success: true, data: null, message: "Password reset" });
  } catch (err) { next(err); }
});

export default router;
