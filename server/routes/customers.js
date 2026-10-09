import { Router } from "express";
import { query } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";
import { requireStaff } from "../middleware/auth.js";
import { rbac, R } from "../middleware/rbac.js";
import { audit } from "../services/audit.js";
import { ApiError } from "../middleware/errorHandler.js";

const router = Router();
router.use(requireAuth, requireStaff, rbac({ read: R.STAFF, write: R.MANAGERS, remove: R.ADMINS })); // CUSTOMER logins can never use this router

const PHONE_RE = /^[6-9]\d{9}$|^\+91[6-9]\d{9}$/;

// Turn raw Postgres errors into clear messages (and log the real cause on the server).
function toApiError(err) {
  if (err instanceof ApiError) return err;
  const field = (err.detail || "").match(/Key \((.+?)\)=/)?.[1]?.replace(/_/g, " ");
  switch (err.code) {
    case "23505": return new ApiError(409, `A customer with this ${field || "value"} already exists`);
    case "23503": return new ApiError(409, "Related record not found, or this customer is still linked to other records (e.g. calls)");
    case "23502": return new ApiError(400, `Missing required value${err.column ? `: ${err.column}` : ""}`);
    case "23514": return new ApiError(400, `Invalid value (${err.constraint || "check constraint"})`);
    case "22P02": return new ApiError(400, "Invalid value or ID format");
    default:
      // e.g. 42703 = column does not exist -> shows up in your Render/terminal logs
      console.error("[customers] DB error", err.code, err.message, err.detail || "");
      return err;
  }
}

// camelCase request field -> column. Only these can be updated via PUT.
const UPDATE_FIELDS = {
  firstName: "first_name", lastName: "last_name", mobile: "mobile", alternateMobile: "alternate_mobile",
  email: "email", customerCode: "customer_code", address: "address", city: "city", state: "state",
  country: "country", pinCode: "pin_code", customerType: "customer_type", companyName: "company_name",
  customerCategory: "customer_category", assignedAgentId: "assigned_agent_id", status: "status",
  dateOfBirth: "date_of_birth", preferredLanguage: "preferred_language",
  communicationPreference: "communication_preference", notes: "notes", tags: "tags",
};
// Columns that must never be set to NULL: fallback value (undefined = reject).
const NOT_NULL = { firstName: undefined, mobile: undefined, status: "Active", country: "India", preferredLanguage: "English", tags: [] };

router.get("/", async (req, res, next) => {
  try {
    const { status, q } = req.query;
    const conditions = [];
    const params = [];
    if (status) { params.push(status); conditions.push(`c.status = $${params.length}`); }
    if (q) {
      params.push(`%${q}%`);
      conditions.push(`(c.first_name ILIKE $${params.length} OR c.last_name ILIKE $${params.length} OR c.mobile ILIKE $${params.length} OR c.email ILIKE $${params.length})`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const { rows } = await query(
      `SELECT c.*, a.name AS assigned_agent_name FROM customers c
       LEFT JOIN agents a ON a.id = c.assigned_agent_id
       ${where} ORDER BY c.created_at DESC LIMIT 500`,
      params
    );
    res.json({ success: true, data: rows, message: "Success" });
  } catch (err) { next(toApiError(err)); }
});

router.get("/:id", async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT c.*, a.name AS assigned_agent_name FROM customers c
       LEFT JOIN agents a ON a.id = c.assigned_agent_id WHERE c.id = $1`,
      [req.params.id]
    );
    if (!rows[0]) throw new ApiError(404, "Customer not found");

    // Full profile: call history, transcripts summary, notes/tags already on the row.
    const { rows: calls } = await query(
      `SELECT id, status, intent, sentiment, outcome, ai_summary, duration_sec, started_at, ended_at
       FROM calls WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [req.params.id]
    );

    res.json({ success: true, data: { ...rows[0], calls }, message: "Success" });
  } catch (err) { next(toApiError(err)); }
});

router.post("/", async (req, res, next) => {
  try {
    const b = req.body;
    b.mobile = String(b.mobile || "").replace(/\s+/g, "");
    if (b.alternateMobile) b.alternateMobile = String(b.alternateMobile).replace(/\s+/g, "");
    if (!b.firstName || !b.mobile) throw new ApiError(400, "First name and mobile are required");
    if (!PHONE_RE.test(b.mobile)) throw new ApiError(400, "Invalid Indian mobile number format");
    if (b.alternateMobile && !PHONE_RE.test(b.alternateMobile)) throw new ApiError(400, "Invalid alternate mobile number format");

    const { rows } = await query(
      `INSERT INTO customers (first_name, last_name, mobile, alternate_mobile, email, customer_code,
                               address, city, state, country, pin_code, customer_type, company_name,
                               customer_category, assigned_agent_id, status, date_of_birth,
                               preferred_language, communication_preference, notes, tags, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
       RETURNING *`,
      [b.firstName, b.lastName || null, b.mobile, b.alternateMobile || null, b.email || null,
       b.customerCode || null, b.address || null, b.city || null, b.state || null, b.country || "India",
       b.pinCode || null, b.customerType || null, b.companyName || null, b.customerCategory || null,
       b.assignedAgentId || null, b.status || "Active", b.dateOfBirth || null,
       b.preferredLanguage || "English", b.communicationPreference || null, b.notes || null,
       b.tags || [], req.user.id]
    );
    res.status(201).json({ success: true, data: rows[0], message: "Customer created" });
  } catch (err) { next(toApiError(err)); }
});

router.put("/:id", async (req, res, next) => {
  try {
    const b = req.body || {};
    const { rows: existing } = await query(`SELECT mobile, alternate_mobile FROM customers WHERE id = $1`, [req.params.id]);
    if (!existing[0]) throw new ApiError(404, "Customer not found");

    const sets = [];
    const params = [req.params.id];
    for (const [key, column] of Object.entries(UPDATE_FIELDS)) {
      if (!Object.prototype.hasOwnProperty.call(b, key)) continue; // field not sent -> leave unchanged
      let value = b[key];
      if (typeof value === "string") value = value.trim();
      if (key === "mobile" || key === "alternateMobile") value = value ? String(value).replace(/\s+/g, "") : value;
      if (value === "" || value === undefined) value = null;      // empty input clears the field

      if (value === null && key in NOT_NULL) {
        if (NOT_NULL[key] === undefined) throw new ApiError(400, `${key === "firstName" ? "First name" : "Mobile"} cannot be empty`);
        value = NOT_NULL[key];
      }
      if (key === "tags") value = Array.isArray(value) ? value : [];

      // Only validate phone format when the number actually changed (old records stay editable)
      if (key === "mobile" && value !== existing[0].mobile && !PHONE_RE.test(value)) throw new ApiError(400, "Invalid Indian mobile number format");
      if (key === "alternateMobile" && value && value !== existing[0].alternate_mobile && !PHONE_RE.test(value)) throw new ApiError(400, "Invalid alternate mobile number format");

      params.push(value);
      sets.push(`${column} = $${params.length}`);
    }
    if (!sets.length) throw new ApiError(400, "No fields to update");

    const { rows } = await query(
      `UPDATE customers SET ${sets.join(", ")}, updated_at = now() WHERE id = $1 RETURNING *`,
      params
    );
    res.json({ success: true, data: rows[0], message: "Customer updated" });
  } catch (err) { next(toApiError(err)); }
});

router.delete("/:id", async (req, res, next) => {
  try {
    const { rowCount } = await query(`DELETE FROM customers WHERE id = $1`, [req.params.id]);
    if (!rowCount) throw new ApiError(404, "Customer not found");
    res.json({ success: true, data: null, message: "Customer deleted" });
  } catch (err) { next(toApiError(err)); }
});

// Convert a Public Contact into a Customer (spec section 5).
router.post("/convert-from-contact/:contactId", async (req, res, next) => {
  try {
    const { rows: contactRows } = await query(`SELECT * FROM contacts WHERE id = $1`, [req.params.contactId]);
    const contact = contactRows[0];
    if (!contact) throw new ApiError(404, "Contact not found");
    if (contact.converted_to_customer_id) throw new ApiError(409, "Contact already converted to a customer");

    const nameParts = (contact.name || "").trim().split(" ");
    const firstName = nameParts[0] || "Unknown";
    const lastName = nameParts.slice(1).join(" ") || null;

    const { rows: customerRows } = await query(
      `INSERT INTO customers (first_name, last_name, mobile, email, city, state, country,
                               preferred_language, tags, notes, status, source_contact_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'Active',$11,$12) RETURNING *`,
      [firstName, lastName, contact.phone, contact.email, contact.city, contact.state,
       contact.country || "India", contact.language, contact.tags || [], contact.notes,
       contact.id, req.user.id]
    );

    await query(`UPDATE contacts SET converted_to_customer_id = $2 WHERE id = $1`, [contact.id, customerRows[0].id]);

    res.status(201).json({ success: true, data: customerRows[0], message: "Contact converted to customer" });
  } catch (err) { next(toApiError(err)); }
});

export default router;
