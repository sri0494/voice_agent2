#!/usr/bin/env node
// Endpoint audit. Run from the project root:  node tests/audit.mjs
//  * Reads the REAL router registrations (app.use("/api/..", router)) from server/app.js (or server/index.js).
//    Router files that are never mounted are reported as NOT MOUNTED; prefixes are never guessed from file names.
//  * Writes ENDPOINT_AUDIT.md (full table + flags + SQL lint) and API_SECURITY_MATRIX.md.
//  * Exits 1 when a high-severity flag is found.
// Static analysis of source text: it finds what to review. The runtime proof lives in tests/security.*.test.mjs.
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const rd = (p) => fs.readFileSync(path.join(root, p), "utf8");
const has = (p) => fs.existsSync(path.join(root, p));
const walk = (dir) => (has(dir) ? fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() && e.name !== "node_modules" ? walk(`${dir}/${e.name}`) : e.name.endsWith(".js") ? [`${dir}/${e.name}`] : [])) : []);

// ---------- roles (single source of truth: the rbac middleware) ----------
let R = { STAFF: ["SUPER_ADMIN", "ADMIN", "MANAGER", "AGENT", "VIEWER"], ADMINS: ["SUPER_ADMIN", "ADMIN"], MANAGERS: ["SUPER_ADMIN", "ADMIN", "MANAGER"], OPERATORS: ["SUPER_ADMIN", "ADMIN", "MANAGER", "AGENT"], SA: "SUPER_ADMIN", ADMIN: "ADMIN", MGR: "MANAGER", AGENT: "AGENT", VIEWER: "VIEWER" };
const roleList = (token) => (token ? (Array.isArray(R[token.replace(/^R\./, "")]) ? R[token.replace(/^R\./, "")] : [R[token.replace(/^R\./, "")]].filter(Boolean)) : []);
const fmt = (roles) => (roles.length === 5 ? "all staff" : roles.length === 4 && !roles.includes("VIEWER") ? "SA/ADMIN/MGR/AGENT" : roles.length === 3 && roles.includes("MANAGER") ? "SA/ADMIN/MGR" : roles.length === 2 && roles.includes("ADMIN") ? "SA/ADMIN" : roles.join("/"));

// ---------- real mounts ----------
const mountFile = ["server/app.js", "server/index.js"].find((f) => has(f) && /app\.use\(\s*["']\/api/.test(rd(f)));
const mounts = new Map(); const order = []; let blockerIndex = -1, limiterIndex = -1, firstRouterIndex = -1;
if (mountFile) {
  const src = rd(mountFile);
  const imp = new Map([...src.matchAll(/import\s+(\w+)\s+from\s+["']\.\/routes\/([^"']+?)(?:\.js)?["']/g)].map((m) => [m[1], `server/routes/${m[2]}.js`]));
  [...src.matchAll(/app\.use\(\s*["'](\/api[^"']*)["']\s*,([^)]*)\)/g)].forEach((m, i) => {
    const names = m[2].split(",").map((s) => s.trim()).filter(Boolean);
    const router = names.find((n) => imp.has(n));
    order.push({ prefix: m[1], names, i });
    if (/blockCustomerOutsidePortal/.test(m[2])) blockerIndex = i;
    if (/apiLimiter/.test(m[2])) limiterIndex = i;
    if (router) { mounts.set(imp.get(router), { prefix: m[1], mountMw: names.filter((n) => n !== router).join(",") }); if (firstRouterIndex < 0) firstRouterIndex = i; }
  });
}
let rbacR = null; try { process.env.DATABASE_URL ||= "postgres://x"; rbacR = (await import(path.join(root, "server/middleware/rbac.js"))).R; if (rbacR) R = { ...R, ...rbacR }; } catch { /* keep defaults */ }

// ---------- parse routes ----------
const rows = []; const unmounted = [];
for (const file of walk("server/routes")) {
  if (!mounts.has(file)) { unmounted.push(file); continue; }
  const { prefix, mountMw } = mounts.get(file);
  const src = rd(file); const lines = src.split("\n");
  const starts = lines.map((l, i) => (/^\s*router\.(get|post|put|patch|delete)\(/.test(l) ? i : -1)).filter((i) => i >= 0);
  const useBlocks = [...src.matchAll(/router\.use\(([\s\S]*?)\);\n/g)].map((m) => ({ at: m.index, text: m[1] }));
  starts.forEach((s, k) => {
    const block = lines.slice(s, k + 1 < starts.length ? starts[k + 1] : lines.length).join("\n");
    const [, method0, rp] = /router\.(get|post|put|patch|delete)\(\s*["'`]([^"'`]*)["'`]/.exec(lines[s]);
    const method = method0.toUpperCase();
    const at = src.indexOf(lines[s]);
    const uses = useBlocks.filter((u) => u.at < at).map((u) => u.text).join(" , ");
    const head = block.split(/\n/)[0] + (block.split(/\n/)[1] && !/async|=>/.test(block.split(/\n/)[0]) ? block.split(/\n/)[1] : "");
    const chain = `${mountMw} , ${uses} , ${head}`;
    const full = prefix + (rp === "/" ? "" : rp);

    // authentication
    const sig = /validateWebhookSignature|requireTwilioSignature/.test(block) || /requireTwilioSignature/.test(chain);
    const auth = /requireAuth/.test(chain) ? "JWT" : sig ? "signature" : "none";
    // role
    let roles = null; const guards = [];
    if (/requireCustomer\b/.test(chain)) { roles = ["CUSTOMER"]; guards.push("requireCustomer"); }
    const rbText = `${uses} , ${head}`;
    const rb = /rbac\(\{([\s\S]*?)\}\)\s*(?:\)|,|;|$)/.exec(rbText) || /rbac\(\{([\s\S]*)\}\)/.exec(rbText);
    if (rb && !roles) {
      const pol = rb[1]; const g = (k) => roleList((new RegExp(`${k}:\\s*(R\\.\\w+)`).exec(pol) || [])[1]);
      const base = ["GET", "HEAD"].includes(method) ? g("read") : method === "DELETE" ? (g("remove").length ? g("remove") : g("write")) : g("write");
      roles = base.length ? base : R.STAFF;
      for (const m of pol.matchAll(/\{\s*method:\s*"(\w+)",\s*path:\s*(\/(?:\\\/|[^\n])*?\/[a-z]*),\s*roles:\s*(R\.\w+)\s*\}/g)) {
        const sample = rp.replace(/:\w+/g, "x"); let re; try { re = new RegExp(m[2].slice(1, m[2].lastIndexOf("/")), m[2].slice(m[2].lastIndexOf("/") + 1)); } catch { continue; }
        if (m[1] === method && re.test(sample)) roles = roleList(m[3]);
      }
      guards.push("rbac");
    }
    for (const m of chain.matchAll(/requireRole\(([^)]*)\)/g)) { const r = m[1].split(",").map((x) => x.replace(/["'\s.]/g, "").replace(/^R/, "")); const named = r.map((x) => R[x] || x).flat(); roles = named.length ? named.map((x) => x.replace(/^R/, "")).filter(Boolean) : roles; guards.push("requireRole"); }
    if (/allow\(WRITE\)/.test(chain)) { roles = R.ADMINS; guards.push("allow"); } else if (/allow\(READ\)/.test(chain)) { roles = R.MANAGERS; guards.push("allow"); }
    if (/requireStaff/.test(chain)) guards.push("requireStaff");
    if (/requireStaff/.test(chain) && !roles) roles = R.STAFF;
    if (/DELETE_ROLES|req\.user\??\.role/.test(block)) guards.push("role-in-handler");
    const role = auth === "none" ? "public" : auth === "signature" ? "provider webhook" : roles ? fmt(roles) : "any logged-in";
    // permission / scope / ownership / rate limit / audit
    const perm = [...chain.matchAll(/require(?:Customer)?(?:Any)?Permission\(([^)]*)\)/g)].map((m) => m[1].replace(/["'\s]/g, "")).join(";") || "—";
    const tenant = /portal\.clientId|owned(Campaign|Contact|Call|Recording)\(|client_id = \$/.test(block) ? "client_id (session)" : roles?.[0] === "CUSTOMER" ? "—" : auth === "none" ? "n/a" : "global (staff)";
    const owned = /owned(Campaign|Contact|Call|Recording)/.test(block) ? "yes" : /ca\.client_id = \$1|client_id = \$/.test(block) ? "yes (SQL)" : "—";
    const limiters = [...new Set([...`${chain} ${block.slice(0, 400)}`.matchAll(/\b(\w+Limiter)\b/g)].map((m) => m[1]))];
    const audited = /audit\(req/.test(block) ? "yes" : "—";
    // flags
    const flags = [];
    const isCustomerRoute = /^\/api\/customer(\/|$)/.test(full);
    const sensitive = method === "POST" && /login|password|call|upload|import|recordings$|\/test$|\/start$|\/stop$|\/pause$|\/resume$|contact-requests|webhook|\/status$|\/recording$|\/query$|\/process$|\/transfer$|\/end$/i.test(full);
    if (auth === "none" && !/\/auth\/login$|contact-requests$|health/.test(full)) flags.push("HIGH public endpoint");
    if (auth === "JWT" && !isCustomerRoute && !guards.includes("requireStaff") && !guards.includes("requireRole") && !guards.includes("allow") && !/\/auth\//.test(full)) flags.push("HIGH admin endpoint reachable by CUSTOMER at route level");
    if (isCustomerRoute && auth === "JWT" && !/\/role$/.test(full) && roles?.[0] !== "CUSTOMER") flags.push("HIGH customer endpoint without requireCustomer");
    if (isCustomerRoute && roles?.[0] === "CUSTOMER" && tenant === "—" && !/\/me(\/password)?$|\/role$/.test(full)) flags.push("HIGH customer endpoint without tenant scope");
    if (isCustomerRoute && roles?.[0] === "CUSTOMER" && perm === "—" && !/\/me(\/password)?$|\/role$/.test(full)) flags.push("MED customer endpoint without permission");
    if (isCustomerRoute && /recordings\/:id/.test(full) && owned === "—") flags.push("HIGH recording endpoint without ownership check");
    if (/recordings/.test(full) && !isCustomerRoute && auth === "none") flags.push("HIGH public recording endpoint");
    if (auth === "JWT" && !roles && !guards.length && !isCustomerRoute && !/^\/api\/auth\//.test(full)) flags.push("MED auth without role guard");
    if (auth === "JWT" && roles && roles.length === 5 && method !== "GET" && !/^\/api\/auth\//.test(full)) flags.push("MED write allowed for every staff role");
    if (sensitive && !limiters.length && !/\/auth\/logout$/.test(full)) flags.push("MED sensitive endpoint without a specific rate limit (global apiLimiter only)");
    rows.push({ full, method, file, auth, role, perm, tenant, owned, limiters: limiters.join(",") || "global", audited, flags });
  });
}

// ---------- global ordering checks ----------
const globalFlags = [];
if (!mountFile) globalFlags.push("HIGH no app.use(\"/api\", ...) registrations found");
else {
  if (blockerIndex < 0) globalFlags.push("HIGH blockCustomerOutsidePortal is not mounted");
  else if (firstRouterIndex >= 0 && blockerIndex > firstRouterIndex) globalFlags.push("HIGH blockCustomerOutsidePortal is mounted AFTER a router");
  if (limiterIndex < 0) globalFlags.push("MED apiLimiter is not mounted on /api");
}
for (const f of unmounted) globalFlags.push(`MED ${f} is not mounted anywhere (dead code or a missing app.use)`);

// ---------- SQL lint ----------
const AMBIG = "status|name|created_at|updated_at|id|language|notes|type|description";
const JOIN_RE = /\b(?:INNER\s+|LEFT\s+(?:OUTER\s+)?|RIGHT\s+|FULL\s+|CROSS\s+)?JOIN\s+[a-z_."]+(?:\s+(?:AS\s+)?[a-z_]+)?\s+ON\b/i;
const BARE = new RegExp(`(?<![\\w.$:])(${AMBIG})\\b(?=\\s*(=|<|>|!=|ILIKE|LIKE|IN\\b|IS\\b|,|\\)|\\s*$|\\s+(ASC|DESC)))`, "gi");
const lineOf = (src, idx) => src.slice(0, idx).split("\n").length;
const sqlFindings = []; const concat = [];
for (const f of walk("server")) {
  const src = rd(f); const hasJoin = [...src.matchAll(/`([^`]*)`/g)].some((m) => JOIN_RE.test(m[1]));
  for (const m of src.matchAll(/`([^`]*)`/g)) {
    const sql = m[1];
    if (JOIN_RE.test(sql) && /\b(SELECT|UPDATE|DELETE)\b/i.test(sql)) {
      const clause = sql.replace(/\$\{[^}]*\}/g, "X").split(/\bWHERE\b|\bORDER BY\b|\bGROUP BY\b|\bHAVING\b/i).slice(1).join(" ");
      for (const c of clause.matchAll(BARE)) sqlFindings.push({ file: f, line: lineOf(src, m.index), col: c[1] });
    }
    // string-built SQL: user input must only ever travel as $n parameters
    if (/\b(SELECT|INSERT|UPDATE|DELETE)\b[\s\S]*\$\{\s*req\.(body|query|params)/i.test(sql)) concat.push({ file: f, line: lineOf(src, m.index) });
  }
  if (hasJoin) for (const m of src.matchAll(/(?:conditions|where|filters|clauses)\w*\.push\(\s*[`"']([^`"']*)[`"']/gi)) for (const c of m[1].replace(/\$\{[^}]*\}/g, "X").matchAll(BARE)) sqlFindings.push({ file: f, line: lineOf(src, m.index), col: c[1] });
}
for (const f of sqlFindings) globalFlags.push(`MED ${f.file}:${f.line} unqualified "${f.col}" in a JOINed query (ambiguous column)`);
for (const f of concat) globalFlags.push(`HIGH ${f.file}:${f.line} request input interpolated into SQL text`);

// ---------- report ----------
const high = [...rows.flatMap((r) => r.flags.filter((x) => x.startsWith("HIGH")).map((x) => `${r.method} ${r.full}: ${x}`)), ...globalFlags.filter((x) => x.startsWith("HIGH"))];
const med = [...rows.flatMap((r) => r.flags.filter((x) => x.startsWith("MED")).map((x) => `${r.method} ${r.full}: ${x}`)), ...globalFlags.filter((x) => x.startsWith("MED"))];
const md = `# Endpoint audit (generated by tests/audit.mjs)

Source of truth: the real \`app.use("/api/...")\` registrations in \`${mountFile}\` and the router files under server/routes. Prefixes are not guessed.
${rows.length} endpoints in ${mounts.size} mounted routers. HIGH flags: **${high.length}**, MED flags: **${med.length}**.

## Global
- Mount order: apiLimiter -> blockCustomerOutsidePortal -> routers: ${blockerIndex >= 0 && (firstRouterIndex < 0 || blockerIndex < firstRouterIndex) ? "correct" : "**WRONG**"}
${globalFlags.length ? globalFlags.map((f) => `- ${f}`).join("\n") : "- no global flags"}

## Endpoints
| Method | Path | Auth | Role | Permission | Tenant scope | Ownership | Rate limit | Audit | Flags |
|---|---|---|---|---|---|---|---|---|---|
${rows.map((r) => `| ${r.method} | ${r.full} | ${r.auth} | ${r.role} | ${r.perm} | ${r.tenant} | ${r.owned} | ${r.limiters} | ${r.audited} | ${r.flags.join("; ") || "ok"} |`).join("\n")}

Notes: "global" rate limit = only the app-wide apiLimiter (300 requests / 15 min / IP). Static analysis cannot prove a handler
checks ownership correctly; tests/security.access.test.mjs does that over HTTP.
`;
fs.writeFileSync(path.join(root, "ENDPOINT_AUDIT.md"), md);
const matrix = `# API security matrix (generated by tests/audit.mjs from the router source)

| Endpoint | Auth | Role | Permission | Tenant scope | Ownership | Rate limit | Audit |
|---|---|---|---|---|---|---|---|
${rows.map((r) => `| ${r.method} ${r.full} | ${r.auth} | ${r.role} | ${r.perm} | ${r.tenant} | ${r.owned} | ${r.limiters} | ${r.audited} |`).join("\n")}

Legend: Auth = JWT (user re-loaded from the database on every request) / signature (provider webhook) / none (public).
Role = roles allowed by the router's rbac policy for that method; "CUSTOMER" = customer portal login (CUSTOMER role only).
Tenant scope "client_id (session)" = the customer comes from users.client_id, never from the request.
`;
fs.writeFileSync(path.join(root, "API_SECURITY_MATRIX.md"), matrix);
console.log(`${rows.length} endpoints in ${mounts.size} mounted routers | HIGH: ${high.length} | MED: ${med.length}`);
high.forEach((h) => console.log(`  HIGH ${h}`)); med.forEach((m) => console.log(`  MED  ${m}`));
console.log(high.length ? "AUDIT FAIL" : "AUDIT PASS (no high-severity findings)");
process.exit(high.length ? 1 : 0);
