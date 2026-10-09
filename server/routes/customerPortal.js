// Customer Portal API. Mounted at /api/customer.
// SECURITY MODEL: the client comes ONLY from users.client_id (req.portal.clientId).
// Nothing the browser sends (query, body, headers) can change which client's data is read or written.
import { Router } from "express";
import bcrypt from "bcryptjs";
import { query } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";
import { ApiError } from "../middleware/errorHandler.js";
import { requireCustomer, requireCustomerPermission as requirePermission, requireAnyPermission } from "../middleware/portal.js";
import { moduleFlags } from "../services/permissions.js";
import { playbackFor, streamLocal, getRecordingRow } from "../services/recordings.js";
import { audit } from "../services/audit.js";
import { passwordLimiter } from "../middleware/rateLimit.js";
import { signToken } from "../utils/jwt.js";
import * as data from "../services/clientData.js";

const router = Router();

// Works for ANY authenticated user (the frontend uses it to choose admin app vs customer portal). Returns only the caller's own role.
router.get("/role", requireAuth, async (req, res, next) => {
  try {
    const { rows } = await query(`SELECT role FROM users WHERE id = $1`, [req.user?.id]);
    if (!rows[0]) throw new ApiError(401, "Session is no longer valid");
    res.json({ success: true, data: { role: String(rows[0].role).toUpperCase() }, message: "Success" });
  } catch (err) { next(err); }
});

router.use(requireAuth, requireCustomer);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PHONE_RE = /^[6-9]\d{9}$|^\+91[6-9]\d{9}$/;

const uuid = (v, label) => { if (!UUID_RE.test(String(v))) throw new ApiError(400, `Invalid ${label}`); return String(v); };
const optUuid = (v, label) => (v ? uuid(v, label) : null);
const optDate = (v, label) => { if (!v) return null; const t = Date.parse(v); if (Number.isNaN(t)) throw new ApiError(400, `Invalid ${label}`); return new Date(t).toISOString(); };
const maskPhone = (p) => { const s = String(p ?? ""); return s.length > 5 ? `${s.slice(0, 2)}${"*".repeat(s.length - 5)}${s.slice(-3)}` : s ? "*".repeat(s.length) : s; };
const page = (req) => ({
  limit: Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200),
  offset: Math.max(parseInt(req.query.offset, 10) || 0, 0),
});

function dbError(err) {
  if (err instanceof ApiError) return err;
  if (err.code === "23503") return new ApiError(409, "This item is still linked to other records (e.g. calls) and cannot be deleted");
  if (err.code === "22P02") return new ApiError(400, "Invalid value or ID format");
  console.error("[portal] DB error", err.code, err.message);
  return err;
}
const wrap = (fn) => (req, res, next) => fn(req, res).catch((e) => next(dbError(e)));
const ok = (res, d, message = "Success", status = 200) => res.status(status).json({ success: true, data: d, message });

// ---- ownership guards: 404 if it doesn't exist, 403 if it belongs to someone else ----
const mine = (req, row) => { if (row.client_id !== req.portal.clientId) throw new ApiError(403, "Forbidden"); return row; };
async function ownedCampaign(req, id) {
  uuid(id, "campaign ID");
  const { rows } = await query(`SELECT * FROM campaigns WHERE id = $1`, [id]);
  if (!rows[0]) throw new ApiError(404, "Campaign not found");
  return mine(req, rows[0]);
}
async function ownedContact(req, id) {
  uuid(id, "contact ID");
  const { rows } = await query(`SELECT ct.*, ca.client_id FROM contacts ct LEFT JOIN campaigns ca ON ca.id = ct.campaign_id WHERE ct.id = $1`, [id]);
  if (!rows[0]) throw new ApiError(404, "Contact not found");
  return mine(req, rows[0]);
}
async function ownedCall(req, id) {
  uuid(id, "call ID");
  const { rows } = await query(
    `SELECT c.*, ca.client_id, ca.name AS campaign_name FROM calls c LEFT JOIN campaigns ca ON ca.id = c.campaign_id WHERE c.id = $1`, [id]);
  if (!rows[0]) throw new ApiError(404, "Call not found");
  return mine(req, rows[0]);
}
async function ownedRecording(req, id) {
  uuid(id, "recording ID");
  const { rows } = await query(
    `SELECT r.id, ca.client_id FROM call_recording_files r
     LEFT JOIN calls c ON c.id = r.call_id LEFT JOIN campaigns ca ON ca.id = c.campaign_id WHERE r.id = $1`, [id]);
  if (!rows[0]) throw new ApiError(404, "Recording not found");
  return mine(req, rows[0]);
}

function buildUpdate(body, map, firstIndex) {
  const sets = [], params = [];
  for (const [key, col] of Object.entries(map)) {
    if (!Object.prototype.hasOwnProperty.call(body, key)) continue;
    let v = typeof body[key] === "string" ? body[key].trim() : body[key];
    if (v === "") v = null;
    params.push(v);
    sets.push(`${col} = $${firstIndex + params.length - 1}`);
  }
  return { sets, params };
}

// ---------------- profile ----------------
router.get("/me", wrap(async (req, res) => {
  const p = req.portal;
  ok(res, {
    user: { id: p.userId, name: p.name, email: p.email, role: "CUSTOMER" },
    customer: { id: p.clientId, name: p.clientName, companyName: p.companyName },
    permissions: moduleFlags(p.permissions),   // module toggles (drives the sidebar)
    actions: [...p.permissions],               // fine-grained: campaigns_create, recordings_download, ...
  });
}));

router.put("/me/password", passwordLimiter, requirePermission("settings_view"), wrap(async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword || String(newPassword).length < 8) throw new ApiError(400, "New password must be at least 8 characters");
  const { rows } = await query(`SELECT password_hash FROM users WHERE id = $1`, [req.portal.userId]);
  if (!rows[0] || !(await bcrypt.compare(String(currentPassword), rows[0].password_hash))) throw new ApiError(400, "Current password is incorrect");
  // password_changed_at invalidates every older token (other devices / stolen tokens); the new token below keeps THIS session.
  await query(`UPDATE users SET password_hash = $1, password_changed_at = date_trunc('second', now()), updated_at = now() WHERE id = $2`, [await bcrypt.hash(String(newPassword), 10), req.portal.userId]);
  await audit(req, { action: "password_change", resource: "user", resourceId: req.portal.userId });
  ok(res, { token: signToken({ id: req.portal.userId, role: "CUSTOMER", client_id: req.portal.clientId }) }, "Password updated");
}));

// ---------------- dashboard (only modules the customer may see) ----------------
router.get("/dashboard", requirePermission("dashboard"), wrap(async (req, res) => {
  ok(res, { clientName: req.portal.companyName || req.portal.clientName, ...(await data.dashboard(req.portal.clientId, req.portal.permissions)) });
}));

// ---------------- dropdown helpers / agents ----------------
router.get("/campaign-options", requireAnyPermission("campaigns_view", "contacts_view", "calls_view", "recordings_view", "analytics_view"),
  wrap(async (req, res) => ok(res, await data.listCampaignOptions(req.portal.clientId))));

router.get("/agents", requirePermission("agents_view"), wrap(async (req, res) => ok(res, await data.listAgents(req.portal.clientId))));

// ---------------- campaigns ----------------
const CAMPAIGN_FIELDS = { name: "name", type: "type", description: "description", language: "language", startDate: "start_date", endDate: "end_date" };

router.get("/campaigns", requirePermission("campaigns_view"), wrap(async (req, res) => {
  const { limit, offset } = page(req);
  const { rows } = await query(
    `SELECT ca.id, ca.name, ca.type, ca.description, ca.language, ca.status, ca.start_date, ca.end_date, ca.created_at,
            (SELECT count(*)::int FROM contacts ct WHERE ct.campaign_id = ca.id) AS contacts,
            (SELECT count(*)::int FROM calls c WHERE c.campaign_id = ca.id) AS calls
     FROM campaigns ca WHERE ca.client_id = $1 ORDER BY ca.created_at DESC LIMIT $2 OFFSET $3`,
    [req.portal.clientId, limit, offset]);
  ok(res, rows);
}));

router.get("/campaigns/:id", requirePermission("campaigns_view"), wrap(async (req, res) => {
  const c = await ownedCampaign(req, req.params.id);
  const { client_id, created_by, agent_id, knowledge_base_id, ...safe } = c;
  ok(res, safe);
}));

router.post("/campaigns", requirePermission("campaigns_create"), wrap(async (req, res) => {
  const b = req.body || {};
  if (!String(b.name || "").trim()) throw new ApiError(400, "Campaign name is required");
  const start = optDate(b.startDate, "start date"), end = optDate(b.endDate, "end date");
  // client_id is forced from the login. agent / knowledge base are attached by an admin.
  const { rows } = await query(
    `INSERT INTO campaigns (name, type, description, language, start_date, end_date, client_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, name, type, description, language, status, start_date, end_date, created_at`,
    [String(b.name).trim(), b.type || null, b.description || null, b.language || null, start, end, req.portal.clientId, req.portal.userId]);
  await audit(req, { action: "campaign_create", resource: "campaign", resourceId: rows[0].id, meta: { clientId: req.portal.clientId } });
  ok(res, rows[0], "Campaign created", 201);
}));

router.put("/campaigns/:id", requirePermission("campaigns_edit"), wrap(async (req, res) => {
  await ownedCampaign(req, req.params.id);
  const b = req.body || {};
  if (Object.prototype.hasOwnProperty.call(b, "name") && !String(b.name || "").trim()) throw new ApiError(400, "Campaign name cannot be empty");
  if (b.startDate) b.startDate = optDate(b.startDate, "start date");
  if (b.endDate) b.endDate = optDate(b.endDate, "end date");
  const { sets, params } = buildUpdate(b, CAMPAIGN_FIELDS, 3);
  if (!sets.length) throw new ApiError(400, "No fields to update");
  const { rows } = await query(
    `UPDATE campaigns SET ${sets.join(", ")}, updated_at = now() WHERE id = $1 AND client_id = $2
     RETURNING id, name, type, description, language, status, start_date, end_date`, [req.params.id, req.portal.clientId, ...params]);
  await audit(req, { action: "campaign_update", resource: "campaign", resourceId: req.params.id, meta: { clientId: req.portal.clientId } });
  ok(res, rows[0], "Campaign updated");
}));

router.delete("/campaigns/:id", requirePermission("campaigns_delete"), wrap(async (req, res) => {
  await ownedCampaign(req, req.params.id);
  await query(`DELETE FROM campaigns WHERE id = $1 AND client_id = $2`, [req.params.id, req.portal.clientId]);
  await audit(req, { action: "campaign_delete", resource: "campaign", resourceId: req.params.id, meta: { clientId: req.portal.clientId } });
  ok(res, null, "Campaign deleted");
}));

// ---------------- contacts / call lists ----------------
const CONTACT_FIELDS = { name: "name", phone: "phone", email: "email", language: "language", city: "city", notes: "notes" };
const checkPhone = (v) => { if (v && !PHONE_RE.test(String(v).replace(/\s+/g, ""))) throw new ApiError(400, "Invalid Indian mobile number format"); };

router.get("/contacts", requirePermission("contacts_view"), wrap(async (req, res) => {
  const { limit, offset } = page(req);
  const campaignId = optUuid(req.query.campaignId, "campaign ID");
  if (campaignId) await ownedCampaign(req, campaignId);
  const { rows } = await query(
    `SELECT ct.id, ct.campaign_id, ca.name AS campaign_name, ct.name, ct.phone, ct.email, ct.language, ct.city, ct.status,
            ct.call_attempts, ct.last_call_at, ct.outcome, ct.notes, ct.created_at
     FROM contacts ct JOIN campaigns ca ON ca.id = ct.campaign_id
     WHERE ca.client_id = $1 AND ($2::uuid IS NULL OR ct.campaign_id = $2::uuid)
     ORDER BY ct.created_at DESC LIMIT $3 OFFSET $4`, [req.portal.clientId, campaignId, limit, offset]);
  ok(res, rows);
}));

router.post("/contacts", requirePermission("contacts_create"), wrap(async (req, res) => {
  const b = req.body || {};
  await ownedCampaign(req, uuid(b.campaignId, "campaign ID"));
  if (!String(b.name || "").trim() || !b.phone) throw new ApiError(400, "Name and phone are required");
  checkPhone(b.phone);
  const { rows } = await query(
    `INSERT INTO contacts (campaign_id, name, phone, email, language, city, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, campaign_id, name, phone, email, language, city, status, notes, created_at`,
    [b.campaignId, String(b.name).trim(), String(b.phone).replace(/\s+/g, ""), b.email || null, b.language || null, b.city || null, b.notes || null]);
  ok(res, rows[0], "Contact added", 201);
}));

router.put("/contacts/:id", requirePermission("contacts_edit"), wrap(async (req, res) => {
  const existing = await ownedContact(req, req.params.id);
  const b = req.body || {};
  if (b.phone) { checkPhone(b.phone); b.phone = String(b.phone).replace(/\s+/g, ""); }
  if (Object.prototype.hasOwnProperty.call(b, "name") && !String(b.name || "").trim()) throw new ApiError(400, "Name cannot be empty");
  const { sets, params } = buildUpdate(b, CONTACT_FIELDS, 2);
  if (!sets.length) throw new ApiError(400, "No fields to update");
  const { rows } = await query(
    `UPDATE contacts SET ${sets.join(", ")}, updated_at = now() WHERE id = $1
     RETURNING id, campaign_id, name, phone, email, language, city, status, notes`, [existing.id, ...params]);
  ok(res, rows[0], "Contact updated");
}));

router.delete("/contacts/:id", requirePermission("contacts_delete"), wrap(async (req, res) => {
  const existing = await ownedContact(req, req.params.id);
  await query(`DELETE FROM contacts WHERE id = $1`, [existing.id]);
  ok(res, null, "Contact deleted");
}));

// ---------------- calls ----------------
const filters = (req) => ({
  status: req.query.status ? String(req.query.status) : null,
  campaignId: optUuid(req.query.campaignId, "campaign ID"),
  from: optDate(req.query.from, "from date"),
  to: optDate(req.query.to, "to date"),
});

router.get("/calls", requirePermission("calls_view"), wrap(async (req, res) => {
  const f = filters(req);
  if (f.campaignId) await ownedCampaign(req, f.campaignId);
  const rows = await data.listCalls(req.portal.clientId, { ...f, ...page(req) });
  const rec = req.portal.permissions.has("recordings_view");
  ok(res, rows.map(({ phone, has_recording, ...r }) => ({ ...r, phone: maskPhone(phone), ...(rec ? { has_recording } : {}) })));
}));

router.get("/calls/:id", requirePermission("calls_view"), wrap(async (req, res) => {
  const c = await ownedCall(req, req.params.id);
  const { client_id, provider_call_id, agent_id, phone_number_id, customer_id, contact_id, ...safe } = c;
  ok(res, { ...safe, phone: maskPhone(safe.phone) });
}));

// ---------------- recordings ----------------
router.get("/recordings", requirePermission("recordings_view"), wrap(async (req, res) => {
  const campaignId = optUuid(req.query.campaignId, "campaign ID");
  if (campaignId) await ownedCampaign(req, campaignId);
  const rows = await data.listRecordings(req.portal.clientId, { campaignId, ...page(req) });
  ok(res, rows.map((r) => ({ ...r, phone: maskPhone(r.phone) })));
}));

// Order of checks: authenticated -> CUSTOMER -> recordings_view -> recording belongs to THIS customer -> only then a link is created.
router.get("/recordings/:id/url", requirePermission("recordings_view"), wrap(async (req, res) => {
  const owned = await ownedRecording(req, req.params.id);
  const rec = await getRecordingRow(owned.id);
  const streamPath = `/api/customer/recordings/${rec.id}/stream`;
  const out = await playbackFor(rec, { download: false, streamPath });
  if (req.portal.permissions.has("recordings_download")) {
    out.downloadUrl = (await playbackFor(rec, { download: true, streamPath })).url;
  }
  await audit(req, { action: "recording_play", resource: "recording", resourceId: rec.id, meta: { clientId: req.portal.clientId } });
  ok(res, out);
}));

// Local-disk (development) storage only: an authenticated stream; production uses presigned R2/S3 URLs instead.
router.get("/recordings/:id/stream", requirePermission("recordings_view"), async (req, res, next) => {
  try {
    const owned = await ownedRecording(req, req.params.id);
    const download = req.query.download === "1";
    if (download && !req.portal.permissions.has("recordings_download")) throw new ApiError(403, "You do not have permission to download recordings");
    const rec = await getRecordingRow(owned.id);
    await audit(req, { action: download ? "recording_download" : "recording_play", resource: "recording", resourceId: rec.id, meta: { clientId: req.portal.clientId } });
    await streamLocal(req, res, rec, { download });
  } catch (err) { next(dbError(err)); }
});


// ---------------- analytics & reports ----------------
router.get("/analytics", requirePermission("analytics_view"), wrap(async (req, res) => {
  ok(res, await data.analytics(req.portal.clientId, { from: optDate(req.query.from, "from date"), to: optDate(req.query.to, "to date") }));
}));

router.get("/reports/summary", requirePermission("reports_view"), wrap(async (req, res) => {
  ok(res, await data.analytics(req.portal.clientId, { from: optDate(req.query.from, "from date"), to: optDate(req.query.to, "to date") }));
}));

const csvCell = (v) => {
  let s = v == null ? "" : v instanceof Date ? v.toISOString() : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;                       // block spreadsheet formula injection
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
router.get("/reports/calls.csv", requirePermission("reports_view"), wrap(async (req, res) => {
  const f = filters(req);
  if (f.campaignId) await ownedCampaign(req, f.campaignId);
  const rows = await data.listCalls(req.portal.clientId, { ...f, limit: 10000, offset: 0 });
  const cols = ["created_at", "campaign_name", "customer_name", "phone", "direction", "language", "status", "sentiment", "intent", "outcome", "duration_sec", "ai_summary"];
  const csv = [cols.join(","), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(","))].join("\r\n");
  await audit(req, { action: "report_export", resource: "calls_csv", meta: { clientId: req.portal.clientId, rows: rows.length } });
  res.set({ "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="calls-report.csv"' }).send(csv);
}));

export default router;
