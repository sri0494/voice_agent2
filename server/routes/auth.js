import { Router } from "express";
import bcrypt from "bcryptjs";
import { query } from "../db/pool.js";
import { signToken } from "../utils/jwt.js";
import { requireAuth } from "../middleware/auth.js";
import { authLimiter, loginAccountLimiter, passwordLimiter } from "../middleware/rateLimit.js";
import { ApiError } from "../middleware/errorHandler.js";
import { audit } from "../services/audit.js";
import { logger } from "../utils/logger.js";

const router = Router();
const isActive = (status) => status == null || String(status).trim().toLowerCase() === "active";
// A real bcrypt hash of a random string: lets us spend the same time for unknown e-mails (no user-enumeration timing signal).
const DUMMY_HASH = bcrypt.hashSync("not-a-real-password-" + Math.random(), 10);

router.post("/login", authLimiter, loginAccountLimiter, async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    if (typeof email !== "string" || typeof password !== "string" || !email || !password) throw new ApiError(400, "Email and password are required");
    const normalized = email.toLowerCase().trim();

    const { rows } = await query(
      `SELECT u.*, c.status AS client_status FROM users u LEFT JOIN clients c ON c.id = u.client_id WHERE u.email = $1`, [normalized]);
    const user = rows[0];
    const valid = await bcrypt.compare(password, user?.password_hash || DUMMY_HASH);
    const role = String(user?.role || "").toUpperCase();
    const blocked = !user || !valid || !isActive(user.status)
      || (role === "CUSTOMER" && (!user.client_id || String(user.client_status || "").toLowerCase() !== "active"));
    if (blocked) {
      await audit(req, { action: "login_failure", resource: "user", resourceId: user?.id, result: "failure", actor: { id: user?.id, role: user?.role }, meta: { email: normalized } });
      throw new ApiError(401, "Invalid email or password");
    }

    await query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [user.id]);
    const token = signToken({ id: user.id, role, client_id: user.client_id || null });
    await audit(req, { action: "login_success", resource: "user", resourceId: user.id, actor: { id: user.id, role } });
    logger.info("user_login", { userId: user.id });

    res.json({
      success: true,
      data: { token, user: { id: user.id, name: user.name, email: user.email, role, ...(role === "CUSTOMER" ? { client_id: user.client_id } : {}) } },
      message: "Login successful",
    });
  } catch (err) { next(err); }
});

router.post("/logout", requireAuth, async (req, res) => {
  // JWTs are stateless: the client discards the token. Changing the password invalidates all older tokens.
  await audit(req, { action: "logout", resource: "user", resourceId: req.user.id });
  res.json({ success: true, data: null, message: "Logged out" });
});

router.get("/me", requireAuth, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, name, email, phone, agent_id, role, status, client_id, last_login_at, created_at FROM users WHERE id = $1`, [req.user.id]);
    if (!rows[0]) throw new ApiError(404, "User not found");
    res.json({ success: true, data: rows[0], message: "Success" });
  } catch (err) { next(err); }
});

router.post("/change-password", requireAuth, passwordLimiter, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (typeof currentPassword !== "string" || typeof newPassword !== "string" || newPassword.length < 8) throw new ApiError(400, "New password must be at least 8 characters");
    if (Buffer.byteLength(newPassword) > 72) throw new ApiError(400, "Password is too long (max 72 bytes)");
    if (newPassword === currentPassword) throw new ApiError(400, "New password must be different from the current one");

    const { rows } = await query(`SELECT password_hash FROM users WHERE id = $1`, [req.user.id]);
    if (!rows[0] || !(await bcrypt.compare(currentPassword, rows[0].password_hash))) {
      await audit(req, { action: "password_change", resource: "user", resourceId: req.user.id, result: "failure" });
      throw new ApiError(401, "Current password is incorrect");
    }
    // password_changed_at invalidates every token issued before now (other devices, stolen tokens); a fresh token keeps this session.
    await query(`UPDATE users SET password_hash = $2, password_changed_at = date_trunc('second', now()), updated_at = now() WHERE id = $1`, [req.user.id, await bcrypt.hash(newPassword, 10)]);
    await audit(req, { action: "password_change", resource: "user", resourceId: req.user.id });
    res.json({ success: true, data: { token: signToken({ id: req.user.id, role: req.user.role, client_id: req.user.client_id }) }, message: "Password updated" });
  } catch (err) { next(err); }
});

export default router;
