import { Router } from "express";
import { query } from "../db/pool.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { ApiError } from "../middleware/errorHandler.js";
import { contactFormLimiter } from "../middleware/rateLimit.js";

const router = Router();

// Public: anyone can submit the "Contact Us" / "Get in Touch" form.
router.post("/", contactFormLimiter, async (req, res, next) => {
  try {
    const { name, email, phone, company, subject, message } = req.body || {};
    if (req.body?.website) return res.status(201).json({ success: true, data: null, message: "Thanks — we'll be in touch shortly." });   // honeypot field: bots fill it, people never see it
    const tooLong = (v, n) => v && String(v).length > n;
    if (tooLong(name, 120) || tooLong(email, 200) || tooLong(phone, 30) || tooLong(company, 160) || tooLong(subject, 200) || tooLong(message, 5000)) throw new ApiError(422, "One of the fields is too long");
    if (!name || !email || !message) throw new ApiError(400, "Name, email, and message are required");
    const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRe.test(email)) throw new ApiError(400, "Invalid email address");

    const { rows } = await query(
      `INSERT INTO contact_requests (name, email, phone, company, subject, message)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [name, email, phone || null, company || null, subject || null, message]
    );
    res.status(201).json({ success: true, data: rows[0], message: "Thanks — we'll be in touch shortly." });
  } catch (err) { next(err); }
});

// Admin: view/manage submissions.
router.get("/", requireAuth, requireRole("SUPER_ADMIN", "ADMIN", "MANAGER"), async (req, res, next) => {
  try {
    const { status } = req.query;
    const { rows } = status
      ? await query(`SELECT * FROM contact_requests WHERE status = $1 ORDER BY created_at DESC`, [status])
      : await query(`SELECT * FROM contact_requests ORDER BY created_at DESC`);
    res.json({ success: true, data: rows, message: "Success" });
  } catch (err) { next(err); }
});

router.put("/:id", requireAuth, requireRole("SUPER_ADMIN", "ADMIN", "MANAGER"), async (req, res, next) => {
  try {
    const { status } = req.body;
    const { rows } = await query(
      `UPDATE contact_requests SET status = COALESCE($2,status), updated_at = now() WHERE id = $1 RETURNING *`,
      [req.params.id, status]
    );
    if (!rows[0]) throw new ApiError(404, "Contact request not found");
    res.json({ success: true, data: rows[0], message: "Updated" });
  } catch (err) { next(err); }
});

export default router;
