import { verifyToken, userIdFromClaims } from "../utils/jwt.js";
import { query } from "../db/pool.js";
import { ApiError } from "./errorHandler.js";
import { logger } from "../utils/logger.js";

export const STAFF_ROLES = ["SUPER_ADMIN", "ADMIN", "MANAGER", "AGENT", "VIEWER"];
export const ALL_ROLES = [...STAFF_ROLES, "CUSTOMER"];

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
export async function authenticateToken(token) {
  if (!token) throw new ApiError(401, "Authentication required");
  let decoded;
  try { decoded = verifyToken(token); } catch { throw new ApiError(401, "Invalid or expired session"); }
  const id = userIdFromClaims(decoded);
  if (!id) {
    logger.error("[portal] JWT has no recognisable user id claim");
    throw new ApiError(401, "Invalid or expired session");
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
    if (err.code === "22P02") throw new ApiError(401, "Invalid or expired session");
    throw err;
  }
  const u = rows[0];
  if (!u || !isActive(u.status)) throw new ApiError(401, "Invalid or expired session");
  if (u.password_changed_at && decoded.iat < Math.floor(new Date(u.password_changed_at).getTime() / 1000)) {
    throw new ApiError(401, "Your password was changed. Please sign in again.");
  }
  const role = String(u.role || "").toUpperCase();
  if (role === "CUSTOMER" && (!u.client_id || String(u.client_status || "").toLowerCase() !== "active")) {
    throw new ApiError(403, "This customer account is inactive");
  }
  return { id: u.id, email: u.email, name: u.name, role, client_id: u.client_id || null, exp: decoded.exp };
}

/** 401 when not authenticated. Sets req.user = { id, email, name, role, client_id }. */
export async function requireAuth(req, res, next) {
  try {
    req.user = await authenticateToken(bearerToken(req));
    next();
  } catch (err) { next(err); }
}

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
