import { verifyToken, userIdFromClaims, readExpiredToken } from "../utils/jwt.js";
import { query } from "../db/pool.js";
import { ApiError } from "./errorHandler.js";
import { logger } from "../utils/logger.js";
import { validateSession, sessionError } from "../services/sessions.js";

export const STAFF_ROLES = ["SUPER_ADMIN", "ADMIN", "MANAGER", "AGENT", "VIEWER"];
export const ALL_ROLES = [...STAFF_ROLES, "CUSTOMER"];

// A 401 that means "this login is over" carries a machine-readable code so the browser can sign out and show the right message.
const dead = (msg, reason = "REVOKED") => { const e = new ApiError(401, msg); e.errorCode = "SESSION_EXPIRED"; e.reason = reason; return e; };
const isActive = (status) => status == null || String(status).trim().toLowerCase() === "active";

export function bearerToken(req) {
  const h = req.headers.authorization || "";
  return h.startsWith("Bearer ") ? h.slice(7).trim() : null;
}

/**
 * Verifies a JWT and loads the user from the DATABASE (never trusts role/status inside the token).
 * Used by requireAuth and by the WebSocket upgrade. Throws ApiError(401|403).
 * A disabled user, an inactive customer account, or a token issued before the last password change
 * stops working immediately.
 */
export async function authenticateToken(token, { touch = "seen" } = {}) {
  if (!token) throw new ApiError(401, "Authentication required");
  let decoded;
  try { decoded = verifyToken(token); } catch { throw sessionError("ABSOLUTE"); }
  const id = userIdFromClaims(decoded);
  if (!id) {
    logger.error("[portal] JWT has no recognisable user id claim");
    throw dead("Invalid or expired session");
  }
  let rows;
  try {
    ({ rows } = await query(
      `SELECT u.id, u.email, u.name, u.role, u.status, u.client_id, u.password_changed_at, c.status AS client_status
       FROM users u LEFT JOIN clients c ON c.id = u.client_id
       WHERE u.id::text = $1`,
      [String(id)]
    ));
  } catch (err) {
    if (err.code === "22P02") throw dead("Invalid or expired session");
    throw err;
  }
  const u = rows[0];
  if (!u || !isActive(u.status)) throw dead("Invalid or expired session");
  if (u.password_changed_at && decoded.iat < Math.floor(new Date(u.password_changed_at).getTime() / 1000)) {
    throw dead("Your password was changed. Please sign in again.");
  }
  // Server-side session: not revoked, within the absolute lifetime, inactivity timeout and tab liveness window.
  const session = await validateSession(decoded.sid, u.id, touch);
  const role = String(u.role || "").toUpperCase();
  if (role === "CUSTOMER" && (!u.client_id || String(u.client_status || "").toLowerCase() !== "active")) {
    throw new ApiError(403, "This customer account is inactive");
  }
  return { id: u.id, email: u.email, name: u.name, role, client_id: u.client_id || null, exp: decoded.exp, sid: decoded.sid || null, session };
}

/**
 * 401 when not authenticated. Sets req.user = { id, email, name, role, client_id, sid }.
 * Session touch: reads (GET/HEAD) only mark the tab as open ("seen"), so dashboards that poll in the background can never keep a
 * session alive forever; state-changing requests count as user activity and reset the inactivity timer.
 */
const makeRequireAuth = (fixedTouch) => async (req, res, next) => {
  try {
    const touch = fixedTouch || (["GET", "HEAD", "OPTIONS"].includes(req.method) ? "seen" : "activity");
    req.user = await authenticateToken(bearerToken(req), { touch });
    next();
  } catch (err) { next(err); }
};
export const requireAuth = makeRequireAuth(null);
export const requireAuthNoTouch = makeRequireAuth("none");   // session ping/status: the handler decides what counts

/** Usage: requireRole("SUPER_ADMIN", "ADMIN"). 401 if unauthenticated, 403 if the role is not allowed. */
export function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) return next(new ApiError(401, "Authentication required"));
    if (!allowedRoles.includes(req.user.role)) return next(new ApiError(403, "You do not have permission to perform this action"));
    next();
  };
}

/** Second layer on every admin router: a CUSTOMER can never use it. */
export function requireStaff(req, res, next) {
  if (!req.user) return next(new ApiError(401, "Authentication required"));
  if (!STAFF_ROLES.includes(req.user.role)) return next(new ApiError(403, "You do not have permission to perform this action"));
  next();
}

/**
 * Logout only: needs a token whose signature is genuine, but accepts one whose session already expired or was revoked
 * (the browser still has to be able to sign out). Sets req.logout = { sid, user|null }.
 */
export async function requireAuthForLogout(req, res, next) {
  try {
    const token = bearerToken(req);
    if (!token) throw new ApiError(401, "Authentication required");
    const claims = readExpiredToken(token);
    if (!claims) throw new ApiError(401, "Authentication required");
    let user = null;
    try { user = await authenticateToken(token, { touch: "none" }); } catch { /* already over */ }
    req.logout = { sid: claims.sid || null, user };
    next();
  } catch (err) { next(err); }
}
