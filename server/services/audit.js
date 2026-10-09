// Security audit trail on the existing audit_logs table (columns added by migration 004).
// Never throws: an audit failure must not break the request, but it is logged loudly.
// Never stores passwords, tokens, API keys or credentials (meta is redacted and size-capped).
import { query } from "../db/pool.js";
import { logger, redact } from "../utils/logger.js";

export async function audit(req, { action, resource = null, resourceId = null, result = "success", meta = null, actor = null }) {
  try {
    const user = actor || req?.user || {};
    const safeMeta = meta ? JSON.stringify(redact(meta)).slice(0, 4000) : null;
    await query(
      `INSERT INTO audit_logs (actor_id, actor_role, action, resource, resource_id, result, ip, user_agent, meta)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
      [user.id || null, user.role || null, action, resource, resourceId ? String(resourceId) : null, result,
       req?.ip || null, (req?.headers?.["user-agent"] || "").slice(0, 300) || null, safeMeta]
    );
  } catch (err) {
    logger.error("audit_write_failed", { action, error: err.message });
  }
}

/** Startup self-check so a mismatching audit_logs table is noticed at deploy, not during an incident. */
export async function verifyAuditTable() {
  try {
    await query(`INSERT INTO audit_logs (action, resource, result) VALUES ('audit_selftest','system','success')`);
    await query(`DELETE FROM audit_logs WHERE action = 'audit_selftest' AND resource = 'system'`);
    return { ok: true };
  } catch (err) {
    logger.error("audit_table_not_writable", { error: err.message, hint: "run `npm run db:migrate`; if audit_logs has extra NOT NULL columns, give them defaults" });
    return { ok: false, error: err.message };
  }
}
