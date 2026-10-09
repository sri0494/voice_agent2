import { Router } from "express";
import { query } from "../db/pool.js";
import { requireAuth, requireRole, requireStaff } from "../middleware/auth.js";
import { rbac, R } from "../middleware/rbac.js";
import { ApiError } from "../middleware/errorHandler.js";
import { integrationTestLimiter } from "../middleware/rateLimit.js";
import { encryptCredentials, decryptCredentials, redactCredentials } from "../utils/crypto.js";
import { assertPublicUrl, SsrfError } from "../utils/ssrf.js";
import { audit } from "../services/audit.js";

const router = Router();
// Integrations hold business secrets: read = MANAGER+, write/test = ADMIN+ (agent tool allow-lists: MANAGER+).
router.use(requireAuth, requireStaff, rbac({
  read: R.MANAGERS, write: R.ADMINS,
  rules: [{ method: "PUT", path: /^\/agents\/[^/]+\/functions$/, roles: R.MANAGERS }],
}));

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const needUuid = (v, what = "ID") => { if (!UUID_RE.test(String(v))) throw new ApiError(400, `Invalid ${what}`); return v; };
const SENSITIVE_HEADER = /authorization|api[-_]?key|token|secret|cookie|password|signature/i;
// Custom headers may carry secrets: show the NAMES only, never the values of sensitive ones.
const maskHeaders = (h) => Object.fromEntries(Object.entries(h || {}).map(([k, v]) => [k, SENSITIVE_HEADER.test(k) ? "[hidden]" : v]));
// path templates may only be a path: no scheme/host injection ("//evil.com", "@host", "..").
const SAFE_PATH = /^\/(?!\/)[A-Za-z0-9._~!$&'()*+,;=:%/{}-]*$/;
async function checkBaseUrl(url) {
  if (!url) return;
  try { await assertPublicUrl(url); } catch (e) { if (e instanceof SsrfError) throw new ApiError(422, `Base URL rejected: ${e.message}`); throw e; }
}
const clampTimeout = (ms) => Math.min(Math.max(Number(ms) || 10000, 1000), 15000);

const CATEGORIES = ["CRM", "Database", "E-commerce", "Communication", "Payment", "Calendar", "Helpdesk", "Custom API"];
const AUTH_TYPES = ["API_KEY", "BEARER_TOKEN", "OAUTH2", "BASIC_AUTH", "NONE"];
const FUNCTION_NAME_RE = /^[a-z][a-z0-9_]*$/;

// List integrations — credentials are never returned, only a redacted view
// so the admin can confirm what's saved without re-exposing secrets.
router.get("/", async (req, res, next) => {
  try {
    const { rows } = await query(`SELECT * FROM business_integrations ORDER BY created_at DESC`);
    const withFunctions = await Promise.all(rows.map(async (integration) => {
      const { rows: functions } = await query(
        `SELECT id, function_name, description, http_method, path_template, input_schema
         FROM integration_functions WHERE integration_id = $1 ORDER BY created_at ASC`,
        [integration.id]
      );
      let redacted = {};
      try {
        redacted = redactCredentials(decryptCredentials(integration.encrypted_credentials));
      } catch {
        redacted = { note: "Set ENCRYPTION_KEY on the server to view credential status" };
      }
      const { encrypted_credentials, headers, ...safe } = integration;
      return { ...safe, headers: maskHeaders(headers), hasCredentials: Boolean(encrypted_credentials), credentialPreview: redacted, functions };
    }));
    res.json({ success: true, data: withFunctions, message: "Success" });
  } catch (err) { next(err); }
});

router.post("/", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
  try {
    const b = req.body;
    if (!b.name || !b.category) throw new ApiError(400, "Name and category are required");
    if (!CATEGORIES.includes(b.category)) throw new ApiError(400, `Category must be one of: ${CATEGORIES.join(", ")}`);
    if (b.authType && !AUTH_TYPES.includes(b.authType)) throw new ApiError(400, `Auth type must be one of: ${AUTH_TYPES.join(", ")}`);
    await checkBaseUrl(b.baseUrl);

    let encrypted = null;
    if (b.credentials && Object.keys(b.credentials).length > 0) {
      try {
        encrypted = encryptCredentials(b.credentials);
      } catch (err) {
        throw new ApiError(500, "Cannot store credentials: ENCRYPTION_KEY is missing or invalid on the server");
      }
    }

    const { rows } = await query(
      `INSERT INTO business_integrations (name, category, base_url, auth_type, encrypted_credentials,
                                            headers, timeout_ms, environment, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [b.name, b.category, b.baseUrl || null, b.authType || "NONE", encrypted,
       JSON.stringify(b.headers || {}), clampTimeout(b.timeoutMs), b.environment || "production",
       encrypted || b.authType === "NONE" ? "CONNECTED" : "DISCONNECTED", req.user.id]
    );
    const { encrypted_credentials, headers, ...safe } = rows[0];
    await audit(req, { action: "integration_create", resource: "integration", resourceId: rows[0].id, meta: { hasCredentials: Boolean(encrypted) } });
    res.status(201).json({ success: true, data: { ...safe, headers: maskHeaders(headers), hasCredentials: Boolean(encrypted_credentials) }, message: "Integration created" });
  } catch (err) { next(err); }
});

router.put("/:id", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
  try {
    needUuid(req.params.id, "integration ID");
    const b = req.body;
    if (b.baseUrl) await checkBaseUrl(b.baseUrl);
    let encrypted;
    if (b.credentials) {
      try {
        encrypted = encryptCredentials(b.credentials);
      } catch (err) {
        throw new ApiError(500, "Cannot store credentials: ENCRYPTION_KEY is missing or invalid on the server");
      }
    }
    const { rows } = await query(
      `UPDATE business_integrations SET
        name = COALESCE($2, name), base_url = COALESCE($3, base_url),
        auth_type = COALESCE($4, auth_type),
        encrypted_credentials = COALESCE($5, encrypted_credentials),
        headers = COALESCE($6, headers), status = COALESCE($7, status),
        updated_at = now()
       WHERE id = $1 RETURNING *`,
      [req.params.id, b.name, b.baseUrl, b.authType, encrypted,
       b.headers ? JSON.stringify(b.headers) : null, b.status]
    );
    if (!rows[0]) throw new ApiError(404, "Integration not found");
    const { encrypted_credentials, headers, ...safe } = rows[0];
    await audit(req, { action: b.credentials ? "credential_update" : "integration_update", resource: "integration", resourceId: req.params.id });
    res.json({ success: true, data: { ...safe, headers: maskHeaders(headers), hasCredentials: Boolean(encrypted_credentials) }, message: "Integration updated" });
  } catch (err) { next(err); }
});

router.delete("/:id", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
  try {
    needUuid(req.params.id, "integration ID");
    const { rowCount } = await query(`DELETE FROM business_integrations WHERE id = $1`, [req.params.id]);
    if (!rowCount) throw new ApiError(404, "Integration not found");
    await audit(req, { action: "integration_delete", resource: "integration", resourceId: req.params.id });
    res.json({ success: true, data: null, message: "Integration deleted" });
  } catch (err) { next(err); }
});

// --- Function / tool definitions on an integration ---
router.post("/:id/functions", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
  try {
    const b = req.body;
    if (!b.functionName || !FUNCTION_NAME_RE.test(b.functionName)) {
      throw new ApiError(400, "functionName must be lowercase letters, numbers, underscores, starting with a letter (e.g. get_customer)");
    }
    if (!b.description || !b.pathTemplate) throw new ApiError(400, "description and pathTemplate are required");
    needUuid(req.params.id, "integration ID");
    if (!SAFE_PATH.test(String(b.pathTemplate))) throw new ApiError(422, "pathTemplate must be a path starting with a single / (no host, no '//', no '..')");
    if (String(b.pathTemplate).split("/").includes("..")) throw new ApiError(422, "pathTemplate must not contain '..'");
    if (b.httpMethod && !["GET", "POST", "PUT", "PATCH", "DELETE"].includes(String(b.httpMethod).toUpperCase())) throw new ApiError(422, "Unsupported HTTP method");

    const { rows } = await query(
      `INSERT INTO integration_functions (integration_id, function_name, description, http_method, path_template, input_schema)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.params.id, b.functionName, b.description, b.httpMethod || "GET", b.pathTemplate, JSON.stringify(b.inputSchema || {})]
    );
    res.status(201).json({ success: true, data: rows[0], message: "Function added" });
  } catch (err) {
    if (err.code === "23505") return next(new ApiError(409, "A function with this name already exists on this integration"));
    next(err);
  }
});

router.delete("/functions/:functionId", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
  try {
    const { rowCount } = await query(`DELETE FROM integration_functions WHERE id = $1`, [req.params.functionId]);
    if (!rowCount) throw new ApiError(404, "Function not found");
    res.json({ success: true, data: null, message: "Function removed" });
  } catch (err) { next(err); }
});

// Test a function against the real external API with sample parameters.
router.post("/functions/:functionId/test", integrationTestLimiter, async (req, res, next) => {
  try {
    needUuid(req.params.functionId, "function ID");
    const { executeFunction } = await import("../services/integrations/functionExecutor.js");
    const result = await executeFunction(req.params.functionId, req.body?.params || {});
    await audit(req, { action: "integration_test", resource: "integration_function", resourceId: req.params.functionId });
    res.json({ success: true, data: result, message: "Function executed" });
  } catch (err) {
    next(err instanceof ApiError ? err : err instanceof SsrfError ? new ApiError(422, err.message) : new ApiError(502, "The integration request failed"));
  }
});

// --- Assign functions to an agent (explicit allow-list) ---
router.get("/agents/:agentId/functions", async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT f.id, f.function_name, f.description, f.http_method, f.path_template, i.name AS integration_name
       FROM agent_integration_functions aif
       JOIN integration_functions f ON f.id = aif.integration_function_id
       JOIN business_integrations i ON i.id = f.integration_id
       WHERE aif.agent_id = $1`,
      [req.params.agentId]
    );
    res.json({ success: true, data: rows, message: "Success" });
  } catch (err) { next(err); }
});

router.put("/agents/:agentId/functions", async (req, res, next) => {
  try {
    const { functionIds } = req.body; // full replace — array of integration_function_id
    if (!Array.isArray(functionIds)) throw new ApiError(400, "functionIds must be an array");
    needUuid(req.params.agentId, "agent ID");
    functionIds.forEach((f) => needUuid(f, "function ID"));

    await query(`DELETE FROM agent_integration_functions WHERE agent_id = $1`, [req.params.agentId]);
    for (const fid of functionIds) {
      await query(
        `INSERT INTO agent_integration_functions (agent_id, integration_function_id) VALUES ($1,$2)`,
        [req.params.agentId, fid]
      );
    }
    await audit(req, { action: "integration_update", resource: "agent_functions", resourceId: req.params.agentId, meta: { count: functionIds.length } });
    res.json({ success: true, data: null, message: "Agent tool access updated" });
  } catch (err) { next(err); }
});

export default router;
