import jwt from "jsonwebtoken";
import { query } from "../db/pool.js";
import { ApiError } from "./errorHandler.js";
import { userIdFromClaims } from "../utils/jwt.js";
import { logger } from "../utils/logger.js";
import { bearerToken, requireStaff } from "./auth.js";

export { requireStaff };

/**
 * requireCustomer (use AFTER requireAuth on every /api/customer route)
 *   role CUSTOMER + linked, active customer account (requireAuth already re-checked the DB).
 * The tenant comes ONLY from req.user.client_id (= users.client_id); nothing in the request can change it.
 * Sets req.portal = { userId, clientId, permissions: Set, ... }
 */
export async function requireCustomer(req, res, next) {
  try {
    if (!req.user?.id) throw new ApiError(401, "Authentication required");
    if (req.user.role !== "CUSTOMER") throw new ApiError(403, "This area is for customer accounts only");
    if (!req.user.client_id) throw new ApiError(403, "This login is not linked to a customer account");
    const { rows } = await query(
      `SELECT c.name AS client_name, c.company_name, c.status AS client_status, u.name, u.email
       FROM users u JOIN clients c ON c.id = u.client_id WHERE u.id = $1`, [req.user.id]);
    const u = rows[0];
    if (!u || String(u.client_status).toLowerCase() !== "active") throw new ApiError(403, "This customer account is inactive");
    const { rows: perms } = await query(`SELECT permission FROM client_permissions WHERE client_id = $1`, [req.user.client_id]);
    req.portal = {
      userId: req.user.id, name: u.name, email: u.email,
      clientId: req.user.client_id, clientName: u.client_name, companyName: u.company_name,
      permissions: new Set(perms.map((p) => p.permission)),
    };
    next();
  } catch (err) { next(err); }
}
export const loadPortalUser = requireCustomer;

/** Server-side permission gate (all listed permissions required). */
export const requireCustomerPermission = (...needed) => (req, res, next) => {
  const missing = needed.filter((p) => !req.portal.permissions.has(p));
  if (missing.length) return next(new ApiError(403, "You do not have permission to use this feature"));
  next();
};
export const requirePermission = requireCustomerPermission;

export const requireAnyPermission = (...any) => (req, res, next) =>
  any.some((p) => req.portal.permissions.has(p)) ? next() : next(new ApiError(403, "You do not have permission to use this feature"));

/**
 * Defence in depth for ALL admin routers: a CUSTOMER token may only reach /api/customer/* and GET /api/auth/me.
 * Mount ONCE, before every other /api router. A verified token with no recognisable user id is REFUSED with 401 (fail closed).
 */
export async function blockCustomerOutsidePortal(req, res, next) {
  try {
    const p = req.path;
    if (req.method === "OPTIONS" || p === "/customer" || p.startsWith("/customer/")) return next();
    if (req.method === "GET" && p === "/auth/me") return next();
    const token = bearerToken(req);
    if (!token) return next();                                  // route-level requireAuth returns 401
    let payload;
    try { payload = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ["HS256"] }); } catch { return next(); }
    const id = userIdFromClaims(payload);
    if (id == null) {
      logger.error("[portal] JWT has no recognisable user id claim");
      return res.status(401).json({ success: false, message: "Invalid or expired session" });   // refused, never passed through
    }
    const { rows } = await query(`SELECT role FROM users WHERE id::text = $1`, [String(id)]);
    if (rows[0] && String(rows[0].role).toUpperCase() === "CUSTOMER") return res.status(403).json({ success: false, message: "Forbidden" });
    next();
  } catch (err) { next(err); }
}
