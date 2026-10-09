// Admin: Customer (client) management. Mounted at /api/clients.
// Read: SUPER_ADMIN, ADMIN, MANAGER.  Write: SUPER_ADMIN, ADMIN.
import { Router } from "express";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { query } from "../db/pool.js";
import { requireAuth, requireStaff } from "../middleware/auth.js";
import { audit } from "../services/audit.js";
import { passwordLimiter } from "../middleware/rateLimit.js";
import { ApiError } from "../middleware/errorHandler.js";
import { PERMISSIONS, PERMISSION_GROUPS, normalizePermissions } from "../services/permissions.js";
import * as data from "../services/clientData.js";

const router = Router();
router.use(requireAuth, requireStaff);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const READ = ["SUPER_ADMIN", "ADMIN", "MANAGER"];
const WRITE = ["SUPER_ADMIN", "ADMIN"];

// Role is always read from the database (authoritative), not from the token.
const allow = (roles) => (req, res, next) =>
  roles.includes(req.user?.role) ? next() : next(new ApiError(403, "Forbidden"));
const wrap = (fn) => (req, res, next) => fn(req, res).catch((e) => next(dbError(e)));
const ok = (res, d, message = "Success", status = 200) => res.status(status).json({ success: true, data: d, message });

function dbError(err) {
  if (err instanceof ApiError) return err;
  if (err.code === "23505") return new ApiError(409, "That email is already in use");
  if (err.code === "23514") return new ApiError(400, "Invalid value (check the users.role constraint allows 'CUSTOMER')");
  if (err.code === "22P02") return new ApiError(400, "Invalid value or ID format");
  console.error("[clients] DB error", err.code, err.message);
  return err;
}
const uuid = (v, label = "ID") => { if (!UUID_RE.test(String(v))) throw new ApiError(400, `Invalid ${label}`); return String(v); };
const tempPassword = () => crypto.randomBytes(9).toString("base64url");

// Match the casing already used in users.status (e.g. "Active" / "ACTIVE" / "active").
const styleLike = (sample, word) => (sample === sample.toUpperCase() ? word.toUpperCase() : sample[0] === sample[0].toUpperCase() ? word[0].toUpperCase() + word.slice(1) : word);
async function statusWord(word) {
  const { rows } = await query(`SELECT status FROM users WHERE lower(status) = 'active' LIMIT 1`);
  return styleLike(rows[0]?.status || "active", word);
}

async function getClient(id) {
  uuid(id, "customer ID");
  const { rows } = await query(`SELECT * FROM clients WHERE id = $1`, [id]);
  if (!rows[0]) throw new ApiError(404, "Customer not found");
  return rows[0];
}

router.get("/permissions", allow(READ), wrap(async (req, res) => ok(res, { all: PERMISSIONS, groups: PERMISSION_GROUPS })));

router.get("/", allow(READ), wrap(async (req, res) => {
  const { rows } = await query(
    `SELECT c.*,
       (SELECT count(*)::int FROM campaigns ca WHERE ca.client_id = c.id) AS campaigns,
       (SELECT count(*)::int FROM users u WHERE u.client_id = c.id) AS logins
     FROM clients c ORDER BY c.created_at DESC LIMIT 500`);
  ok(res, rows);
}));

router.post("/", allow(WRITE), wrap(async (req, res) => {
  const b = req.body || {};
  if (!String(b.name || "").trim()) throw new ApiError(400, "Customer name is required");
  const { rows } = await query(
    `INSERT INTO clients (name, company_name, email, phone, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [String(b.name).trim(), b.companyName || null, b.email || null, b.phone || null, req.user.id]);
  await audit(req, { action: "customer_account_create", resource: "client", resourceId: rows[0].id });
  ok(res, rows[0], "Customer created", 201);
}));

router.get("/:id", allow(READ), wrap(async (req, res) => {
  const client = await getClient(req.params.id);
  const [perms, users, campaigns] = await Promise.all([
    query(`SELECT permission FROM client_permissions WHERE client_id = $1 ORDER BY permission`, [client.id]),
    query(`SELECT id, name, email, phone, status, last_login_at, created_at FROM users WHERE client_id = $1 ORDER BY created_at`, [client.id]),
    query(`SELECT id, name, status, type, created_at FROM campaigns WHERE client_id = $1 ORDER BY created_at DESC`, [client.id]),
  ]);
  ok(res, { ...client, permissions: perms.rows.map((r) => r.permission), logins: users.rows, campaigns: campaigns.rows });
}));

router.put("/:id", allow(WRITE), wrap(async (req, res) => {
  await getClient(req.params.id);
  const b = req.body || {};
  if (b.status !== undefined && !["Active", "Inactive"].includes(b.status)) throw new ApiError(400, 'status must be "Active" or "Inactive"');
  if (b.name !== undefined && !String(b.name).trim()) throw new ApiError(400, "Customer name cannot be empty");
  const { rows } = await query(
    `UPDATE clients SET name = COALESCE($2, name), company_name = COALESCE($3, company_name), email = COALESCE($4, email),
            phone = COALESCE($5, phone), status = COALESCE($6, status), updated_at = now()
     WHERE id = $1 RETURNING *`,
    [req.params.id, b.name?.trim() ?? null, b.companyName ?? null, b.email ?? null, b.phone ?? null, b.status ?? null]);
  await audit(req, { action: "customer_account_update", resource: "client", resourceId: req.params.id, meta: { status: b.status } });
  ok(res, rows[0], "Customer updated");
}));

// Deletes the customer account and its logins. Campaigns/contacts/calls are KEPT and simply become unassigned.
router.delete("/:id", allow(WRITE), wrap(async (req, res) => {
  await getClient(req.params.id);
  await query(`DELETE FROM users WHERE client_id = $1 AND upper(role) = 'CUSTOMER'`, [req.params.id]);
  await query(`DELETE FROM clients WHERE id = $1`, [req.params.id]);
  await audit(req, { action: "customer_account_delete", resource: "client", resourceId: req.params.id });
  ok(res, null, "Customer deleted");
}));

// ---- permissions ----
router.put("/:id/permissions", allow(WRITE), wrap(async (req, res) => {
  await getClient(req.params.id);
  const { permissions, error } = normalizePermissions(req.body?.permissions);
  if (error) throw new ApiError(400, error);
  await query(`DELETE FROM client_permissions WHERE client_id = $1 AND permission <> ALL($2::text[])`, [req.params.id, permissions]);
  await query(`INSERT INTO client_permissions (client_id, permission) SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING`, [req.params.id, permissions]);
  await audit(req, { action: "permission_change", resource: "client", resourceId: req.params.id, meta: { permissions } });
  ok(res, { permissions }, "Permissions saved");
}));

// ---- customer logins ----
router.post("/:id/login", passwordLimiter, allow(WRITE), wrap(async (req, res) => {
  const client = await getClient(req.params.id);
  const b = req.body || {};
  const email = String(b.email || "").trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(email)) throw new ApiError(400, "A valid email is required");
  if (b.password && String(b.password).length < 8) throw new ApiError(400, "Password must be at least 8 characters");
  const password = b.password ? String(b.password) : tempPassword();
  const { rows } = await query(
    `INSERT INTO users (name, email, phone, password_hash, role, status, client_id, created_at, updated_at)
     VALUES ($1,$2,$3,$4,'CUSTOMER',$5,$6, now(), now()) RETURNING id, name, email, role, status, client_id`,
    [String(b.name || client.name).trim(), email, b.phone || null, await bcrypt.hash(password, 10), await statusWord("active"), client.id]);
  await audit(req, { action: "user_create", resource: "user", resourceId: rows[0].id, meta: { role: "CUSTOMER", clientId: client.id } });
  ok(res, { user: rows[0], ...(b.password ? {} : { temporaryPassword: password }) }, "Customer login created", 201);
}));

router.post("/:id/users/:userId/reset-password", passwordLimiter, allow(WRITE), wrap(async (req, res) => {
  const password = tempPassword();
  const { rows } = await query(
    `UPDATE users SET password_hash = $1, password_changed_at = date_trunc('second', now()), updated_at = now()
     WHERE id = $2 AND client_id = $3 AND upper(role) = 'CUSTOMER' RETURNING id`,
    [await bcrypt.hash(password, 10), uuid(req.params.userId, "user ID"), uuid(req.params.id, "customer ID")]);
  if (!rows[0]) throw new ApiError(404, "Customer login not found");
  await audit(req, { action: "password_reset", resource: "user", resourceId: req.params.userId });
  ok(res, { temporaryPassword: password }, "Password reset");
}));

router.put("/:id/users/:userId/status", allow(WRITE), wrap(async (req, res) => {
  const active = req.body?.active;
  if (typeof active !== "boolean") throw new ApiError(400, "active must be true or false");
  const { rows } = await query(
    `UPDATE users SET status = $1, updated_at = now() WHERE id = $2 AND client_id = $3 AND upper(role) = 'CUSTOMER' RETURNING id, status`,
    [await statusWord(active ? "active" : "inactive"), uuid(req.params.userId, "user ID"), uuid(req.params.id, "customer ID")]);
  if (!rows[0]) throw new ApiError(404, "Customer login not found");
  await audit(req, { action: "user_update", resource: "user", resourceId: req.params.userId, meta: { active } });
  ok(res, rows[0], active ? "Login activated" : "Login deactivated");
}));

router.delete("/:id/users/:userId", allow(WRITE), wrap(async (req, res) => {
  const { rowCount } = await query(
    `DELETE FROM users WHERE id = $1 AND client_id = $2 AND upper(role) = 'CUSTOMER'`,
    [uuid(req.params.userId, "user ID"), uuid(req.params.id, "customer ID")]);
  if (!rowCount) throw new ApiError(404, "Customer login not found");
  await audit(req, { action: "user_delete", resource: "user", resourceId: req.params.userId });
  ok(res, null, "Login deleted");
}));

// ---- campaign assignment ----
router.post("/:id/campaigns", allow(WRITE), wrap(async (req, res) => {
  await getClient(req.params.id);
  const ids = req.body?.campaignIds;
  if (!Array.isArray(ids) || !ids.length) throw new ApiError(400, "campaignIds must be a non-empty array");
  ids.forEach((i) => uuid(i, "campaign ID"));
  const { rows } = await query(`UPDATE campaigns SET client_id = $1, updated_at = now() WHERE id = ANY($2::uuid[]) RETURNING id`, [req.params.id, ids]);
  await audit(req, { action: "campaign_assign", resource: "client", resourceId: req.params.id, meta: { count: rows.length } });
  ok(res, { assigned: rows.length }, "Campaigns assigned");
}));

router.delete("/:id/campaigns/:campaignId", allow(WRITE), wrap(async (req, res) => {
  const { rowCount } = await query(
    `UPDATE campaigns SET client_id = NULL, updated_at = now() WHERE id = $1 AND client_id = $2`,
    [uuid(req.params.campaignId, "campaign ID"), uuid(req.params.id, "customer ID")]);
  if (!rowCount) throw new ApiError(404, "Campaign is not assigned to this customer");
  await audit(req, { action: "campaign_unassign", resource: "client", resourceId: req.params.id, meta: { campaignId: req.params.campaignId } });
  ok(res, null, "Campaign unassigned");
}));

// ---- usage / calls / analytics for one customer (same queries the customer sees) ----
const ALL = new Set(PERMISSIONS);
router.get("/:id/usage", allow(READ), wrap(async (req, res) => { await getClient(req.params.id); ok(res, await data.dashboard(req.params.id, ALL)); }));
router.get("/:id/analytics", allow(READ), wrap(async (req, res) => { await getClient(req.params.id); ok(res, await data.analytics(req.params.id)); }));
router.get("/:id/calls", allow(READ), wrap(async (req, res) => {
  await getClient(req.params.id);
  ok(res, await data.listCalls(req.params.id, {
    status: req.query.status ? String(req.query.status) : null,
    limit: Math.min(parseInt(req.query.limit, 10) || 50, 200), offset: Math.max(parseInt(req.query.offset, 10) || 0, 0),
  }));
}));

export default router;
