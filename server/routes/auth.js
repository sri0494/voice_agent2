import { Router } from "express";
import bcrypt from "bcryptjs";
import { query } from "../db/pool.js";
import { signToken } from "../utils/jwt.js";
import { requireAuth, requireAuthNoTouch, requireAuthForLogout, authenticateToken, bearerToken } from "../middleware/auth.js";
import { createSession, revokeSession, revokeAllForUser, sessionConfig } from "../services/sessions.js";
import { authLimiter, loginAccountLimiter, passwordLimiter } from "../middleware/rateLimit.js";
import { ApiError } from "../middleware/errorHandler.js";
import { audit } from "../services/audit.js";
import { logger } from "../utils/logger.js";

const router = Router();
const sessionInfo = (absoluteRemainingSec) => {
  const c = sessionConfig();
  return { idleTimeoutSec: c.idleSec, absoluteRemainingSec, tabLivenessSec: c.livenessSec, pingEverySec: 45 };
};
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
    const sess = await createSession(req, user.id);          // server-side session; its id rides inside the JWT
    const token = signToken({ id: user.id, role, client_id: user.client_id || null, sid: sess.sid }, { expiresInSec: sess.expiresInSec });
    await audit(req, { action: "login_success", resource: "user", resourceId: user.id, actor: { id: user.id, role } });
    logger.info("user_login", { userId: user.id });

    res.json({
      success: true,
      data: { token, session: sessionInfo(sess.expiresInSec), user: { id: user.id, name: user.name, email: user.email, role, ...(role === "CUSTOMER" ? { client_id: user.client_id } : {}) } },
      message: "Login successful",
    });
  } catch (err) { next(err); }
});

// Logout revokes THIS session on the server (other tabs/devices keep theirs). It is tolerant: an already expired or revoked session
// still gets a 200, because the browser clears its own state either way.
router.post("/logout", requireAuthForLogout, async (req, res, next) => {
  try {
    const { sid, user } = req.logout;
    if (sid) await revokeSession(sid, "LOGOUT");
    if (user) { req.user = user; await audit(req, { action: "logout", resource: "user", resourceId: user.id }); }
    res.json({ success: true, data: null, message: "Logged out" });
  } catch (err) { next(err); }
});

// Session heartbeat from an open tab (about every 45 s). Never extends the absolute lifetime.
//   { active: true }  -> the user interacted since the last ping: resets the inactivity timer
//   { active: false } -> tab is merely open: refreshes tab liveness only
router.post("/session/ping", requireAuthNoTouch, async (req, res, next) => {
  try {
    const active = req.body?.active === true;
    const info = await authenticateToken(bearerToken(req), { touch: active ? "activity" : "seen" });
    const c = sessionConfig();
    res.json({ success: true, data: { idleRemainingSec: info.session?.idleRemainingSec ?? c.idleSec, absoluteRemainingSec: info.session?.absoluteRemainingSec ?? null, idleTimeoutSec: c.idleSec }, message: "OK" });
  } catch (err) { next(err); }
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
    // Every other session of this user ends; this one continues under a fresh session + token.
    await revokeAllForUser(req.user.id, "PASSWORD_CHANGED");
    const sess = await createSession(req, req.user.id);
    res.json({ success: true, data: { token: signToken({ id: req.user.id, role: req.user.role, client_id: req.user.client_id, sid: sess.sid }, { expiresInSec: sess.expiresInSec }), session: sessionInfo(sess.expiresInSec) }, message: "Password updated" });
  } catch (err) { next(err); }
});

export default router;
