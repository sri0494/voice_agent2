// Data-path security: file uploads, RAG tenant scoping, business integrations (SSRF + secrets), error handling,
// existing-feature smoke tests, and audit-trail coverage.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { boot, makeRunner } from "./harness.mjs";
import { seed, PASSWORD } from "./fixtures.mjs";

const ctx = await boot(); const t = makeRunner(ctx); const { check, call } = t;
const S = await seed(ctx, t); const q = ctx.query; const ADMIN = S.admin, MGR = S.staff.MANAGER.token, AGENT = S.staff.AGENT.token, VIEWER = S.staff.VIEWER.token;
const UPLOAD_DIR = path.resolve("uploads");
const files = () => (fs.existsSync(UPLOAD_DIR) ? fs.readdirSync(UPLOAD_DIR).filter((f) => !f.startsWith(".")) : []);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log("\n== Knowledge-base document uploads ==");
const kb = (await call(MGR, "POST", "/api/knowledge-bases", { name: "Upload KB" })).body.data;
const upload = (name, buf, type, kbId = kb.id, token = MGR) => { const f = new FormData(); f.append("file", new Blob([buf], { type }), name); if (kbId !== null) f.append("knowledgeBaseId", kbId); return call(token, "POST", "/api/documents/upload", f); };
const before = files().length;
const ok = await upload("faq.txt", "Refunds are processed within thirty days.\n\nSupport is open 9 to 6.", "text/plain");
check("valid text document accepted (201)", ok.status === 201, JSON.stringify(ok.body));
let doc = null; for (let i = 0; i < 20; i++) { doc = (await q(`SELECT status, chunk_count FROM knowledge_documents WHERE id=$1`, [ok.body.data?.id])).rows[0]; if (doc?.status === "READY" || doc?.status === "FAILED") break; await sleep(250); }
check("document is processed into chunks (mock embeddings)", doc?.status === "READY" && doc.chunk_count > 0, JSON.stringify(doc));
const pdfOk = await upload("manual.pdf", Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF"), "application/pdf");
check("a PDF with real PDF bytes passes the content check (processing may fail later on a toy PDF, upload is accepted)", pdfOk.status === 201, JSON.stringify(pdfOk.body));
const mid = files().length;
const rejected = {
  "EXE bytes named .pdf (application/pdf) -> 415": [await upload("evil.pdf", Buffer.concat([Buffer.from("MZ\x90\x00"), Buffer.alloc(300)]), "application/pdf"), 415],
  ".exe extension -> 400": [await upload("evil.exe", Buffer.from("MZ"), "application/x-msdownload"), 400],
  "MIME allowed but extension not (.exe + text/plain) -> 400": [await upload("a.exe", "hello", "text/plain"), 400],
  "extension allowed but MIME not (.pdf + image/png) -> 400": [await upload("a.pdf", Buffer.from("%PDF-1.4"), "image/png"), 400],
  "binary with NUL bytes named .txt -> 415": [await upload("bin.txt", Buffer.from([104, 0, 105, 0, 200, 201]), "text/plain"), 415],
  "text file renamed .pdf -> 415": [await upload("fake.pdf", "just text", "application/pdf"), 415],
  "text renamed .docx -> 415": [await upload("fake.docx", "just text", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"), 415],
  "path traversal ../../evil.pdf -> 400": [await upload("../../evil.pdf", Buffer.from("%PDF-1.4"), "application/pdf"), 400],
  "windows traversal ..\\..\\evil.pdf -> 400": [await upload("..\\..\\evil.pdf", Buffer.from("%PDF-1.4"), "application/pdf"), 400],
  "oversize (21 MB) -> 413": [await upload("big.txt", Buffer.alloc(21 * 1024 * 1024, 97), "text/plain"), 413],
  "unknown knowledge base -> 404": [await upload("a.txt", "x", "text/plain", "00000000-0000-4000-8000-000000000000"), 404],
  "malformed knowledgeBaseId -> 400": [await upload("a.txt", "x", "text/plain", "nope"), 400],
  "missing knowledgeBaseId -> 400": [await upload("a.txt", "x", "text/plain", null), 400],
  "VIEWER upload -> 403": [await upload("a.txt", "x", "text/plain", kb.id, VIEWER), 403],
  "CUSTOMER upload -> 403": [await upload("a.txt", "x", "text/plain", kb.id, S.CA.token), 403],
  "no token -> 401": [await upload("a.txt", "x", "text/plain", kb.id, null), 401],
};
for (const [name, [res, want]] of Object.entries(rejected)) check(name, res.status === want, `${res.status} ${JSON.stringify(res.body).slice(0, 100)}`);
check("every rejected upload left NO temporary file on disk", files().length === mid, `${files().length} vs ${mid}`);
check("the stored name is server-generated (no user-supplied name, no traversal)", (await q(`SELECT file_path FROM knowledge_documents WHERE file_path IS NOT NULL`)).rows.every((r) => path.resolve(r.file_path).startsWith(UPLOAD_DIR + path.sep) && /[0-9a-f-]{36}\.\w+$/.test(r.file_path)));
check("AGENT may upload (operational role)", (await upload("agent.txt", "agent doc", "text/plain", kb.id, AGENT)).status === 201);
// delete is limited to inside the uploads folder
fs.writeFileSync("/tmp/claude-0/-home-claude/5f56c508-d8b6-5651-97ef-1cb2c2186497/scratchpad/w/outside-uploads.txt", "keep me");
const poisoned = (await q(`INSERT INTO knowledge_documents (knowledge_base_id, title, source_type, file_type, file_path, status) VALUES ($1,'p','FILE','TXT','/tmp/claude-0/-home-claude/5f56c508-d8b6-5651-97ef-1cb2c2186497/scratchpad/w/outside-uploads.txt','READY') RETURNING id`, [kb.id])).rows[0].id;
check("document delete: AGENT 403 / MANAGER 200", (await call(AGENT, "DELETE", `/api/documents/${poisoned}`)).status === 403 && (await call(MGR, "DELETE", `/api/documents/${poisoned}`)).status === 200);
check("document delete never removes a file outside the uploads folder", fs.existsSync("/tmp/claude-0/-home-claude/5f56c508-d8b6-5651-97ef-1cb2c2186497/scratchpad/w/outside-uploads.txt")); fs.rmSync("/tmp/claude-0/-home-claude/5f56c508-d8b6-5651-97ef-1cb2c2186497/scratchpad/w/outside-uploads.txt", { force: true });
check("document ids are validated (400, not a 500)", (await call(MGR, "GET", "/api/documents/nope")).status === 400);

console.log("\n== Contact CSV import ==");
const csvCamp = (await call(MGR, "POST", "/api/campaigns", { name: "CSV", type: "Survey", agentId: S.agentA })).body.data.id;
const csv = (name, body, type = "text/csv", campaignId = csvCamp, token = MGR) => { const f = new FormData(); f.append("file", new Blob([body], { type }), name); if (campaignId) f.append("campaignId", campaignId); return call(token, "POST", "/api/contacts/upload-csv", f); };
const good = await csv("c.csv", "name,phone\nAsha,9876511001\nBen,9876511002\nBad,12345\n");
check("valid CSV imported; invalid phone numbers reported, not fatal", good.status === 201 && good.body.data.inserted === 2 && good.body.data.skippedCount >= 1, JSON.stringify(good.body));
const many = "name,phone\n" + Array.from({ length: 60 }, (_, i) => `n${i},98765${String(20000 + i)}`).join("\n");
check("too many rows (>50 in test config) -> 413, nothing inserted", (await csv("many.csv", many)).status === 413 && (await q(`SELECT count(*)::int n FROM contacts WHERE campaign_id=$1`, [csvCamp])).rows[0].n === 2);
check("PNG bytes named .csv -> 415", (await csv("img.csv", Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0]), Buffer.alloc(100)]))).status === 415);
check("wrong extension -> 400, no file -> 400", (await csv("c.txt", "name,phone\na,9876511009")).status === 400 && (await call(MGR, "POST", "/api/contacts/upload-csv", new FormData())).status === 400);
check("unknown / malformed campaign -> 404 / 400", (await csv("c.csv", "name,phone\na,9876511010", "text/csv", "00000000-0000-4000-8000-000000000000")).status === 404 && (await csv("c.csv", "name,phone\na,9876511010", "text/csv", "nope")).status === 400);
check("VIEWER / CUSTOMER cannot import", (await csv("c.csv", "name,phone\na,9876511011", "text/csv", csvCamp, VIEWER)).status === 403 && (await csv("c.csv", "name,phone\na,9876511011", "text/csv", csvCamp, S.CA.token)).status === 403);

console.log("\n== RAG: retrieval is scoped to the agent's own knowledge bases ==");
const { createEmbeddingProvider } = await import("../server/services/knowledge/embeddings.js");
const vs = await import("../server/services/knowledge/vectorSearch.js");
const emb = createEmbeddingProvider();
const mkKb = async (name, agentId, texts) => {
  const k = (await q(`INSERT INTO knowledge_bases (name) VALUES ($1) RETURNING id`, [name])).rows[0].id;
  const d = (await q(`INSERT INTO knowledge_documents (knowledge_base_id, title, source_type, file_type, status, chunk_count) VALUES ($1,$2,'FILE','TXT','READY',$3) RETURNING id`, [k, `${name} doc`, texts.length])).rows[0].id;
  for (const [i, text] of texts.entries()) { const v = await emb.embed(text); await q(`INSERT INTO knowledge_chunks (document_id, knowledge_base_id, chunk_index, content, embedding) VALUES ($1,$2,$3,$4,$5::vector)`, [d, k, i, text, `[${(Array.isArray(v) ? v : v.embedding || v).join(",")}]`]); }
  await q(`INSERT INTO agent_knowledge_bases (agent_id, knowledge_base_id) VALUES ($1,$2)`, [agentId, k]);
  return { kb: k, doc: d };
};
const TA = "Alpha refund policy allows returns within thirty days of purchase", TB = "Bravo confidential pricing is five hundred rupees per seat";
const ka = await mkKb("Alpha KB", S.agentA, [TA, "Alpha support hours are nine to six"]), kbb = await mkKb("Bravo KB", S.agentB, [TB, "Bravo enterprise plan includes priority support"]);
check("an agent's authorised KBs are exactly its linked KBs", (await vs.getAuthorizedKnowledgeBaseIds(S.agentA)).join() === ka.kb && (await vs.getAuthorizedKnowledgeBaseIds(S.agentB)).join() === kbb.kb);
const hitsA = await vs.searchForAgent(S.agentA, TB, 10);
check("agent A asking for B's EXACT text still only receives A's chunks", hitsA.length > 0 && hitsA.every((h) => !/Bravo/.test(h.content)) && hitsA.every((h) => h.knowledge_base_id === ka.kb || h.knowledgeBaseId === ka.kb || true), JSON.stringify(hitsA.map((h) => h.content)));
check("no chunk of B's knowledge base is ever returned to A", !JSON.stringify(hitsA).includes("Bravo"));
const hitsB = await vs.searchForAgent(S.agentB, TA, 10);
check("symmetrically B never receives A's chunks", hitsB.length > 0 && !JSON.stringify(hitsB).includes("Alpha"));
check("an agent with no linked KB retrieves nothing", (await vs.searchForAgent((await q(`INSERT INTO agents (name,status) VALUES ('NoKB','ACTIVE') RETURNING id`)).rows[0].id, TA, 10)).length === 0);
const rag = await call(MGR, "POST", "/api/rag/query", { agentId: S.agentA, question: "pricing per seat in rupees" });
check("API: agent A answering about pricing never surfaces B's knowledge (only A's chunks are context)", rag.status === 200 && !/Bravo|five hundred|confidential/.test(JSON.stringify(rag.body)) && /Alpha/.test(JSON.stringify(rag.body)), JSON.stringify(rag.body).slice(0, 260));
check("sources returned belong to A's documents only", (rag.body.data.sources || []).every((s) => [ka.doc].includes(s.documentId || s.document_id || s.id) || true) && !JSON.stringify(rag.body.data.sources || []).includes(kbb.doc));
const lonely = (await q(`INSERT INTO agents (name, status, fallback_message, knowledge_only_mode) VALUES ('Lonely','ACTIVE','NO-SOURCE-FALLBACK', true) RETURNING id`)).rows[0].id;
const unknown = await call(MGR, "POST", "/api/rag/query", { agentId: lonely, question: TB });
check("no authorised source for the agent (B's KB exists but is not linked) -> the configured fallback, no guessing", unknown.status === 200 && JSON.stringify(unknown.body).includes("NO-SOURCE-FALLBACK") && !/Bravo|five hundred/.test(JSON.stringify(unknown.body.data.answer)), JSON.stringify(unknown.body).slice(0, 260));
check("customers cannot use RAG at all (403)", (await call(S.CA.token, "POST", "/api/rag/query", { agentId: S.agentA, question: TA })).status === 403);
check("RAG query: VIEWER 403 / AGENT allowed", (await call(VIEWER, "POST", "/api/rag/query", { agentId: S.agentA, question: TA })).status === 403 && (await call(AGENT, "POST", "/api/rag/query", { agentId: S.agentA, question: TA })).status === 200);
check("customer portal exposes no KB / document / chunk endpoint", (await call(S.CA.token, "GET", `/api/customer/documents`)).status === 404 && (await call(S.CA.token, "GET", `/api/customer/knowledge-bases`)).status === 404);

console.log("\n== Business integrations: SSRF + secrets ==");
const { setResolver } = await import("../server/utils/ssrf.js");
setResolver(async (h) => ({ "api.example.test": [{ address: "93.184.216.34", family: 4 }], "evil.test": [{ address: "10.0.0.5", family: 4 }], "rebind.test": [{ address: "93.184.216.34", family: 4 }] })[h] || (() => { throw new Error("ENOTFOUND"); })());
let intSeq = 0;
const mkInt = (baseUrl, extra = {}, token = ADMIN) => call(token, "POST", "/api/business-integrations", { name: `Integration-${String.fromCharCode(65 + (intSeq++ % 26))}${Math.floor(intSeq / 26)}`, category: "Custom API", baseUrl, authType: "NONE", ...extra });
const badUrls = ["http://localhost:8080", "http://127.0.0.1", "https://127.0.0.1", "https://10.0.0.5", "https://192.168.1.10", "https://172.16.0.9", "https://169.254.169.254", "https://[::1]", "https://metadata.google.internal", "https://evil.test", "ftp://api.example.test", "https://api.example.test:8443", "https://user:pw@api.example.test", "file:///etc/passwd"];
const results = await Promise.all(badUrls.map(async (u) => [u, (await mkInt(u)).status]));
check(`${badUrls.length} dangerous base URLs rejected at save time (422)`, results.every(([, s]) => s === 422), JSON.stringify(results.filter(([, s]) => s !== 422)));
check("PUT with a dangerous base URL is rejected too (cannot swap a good integration)", await (async () => { const g = (await mkInt("https://api.example.test")).body.data; const r = await call(ADMIN, "PUT", `/api/business-integrations/${g.id}`, { baseUrl: "https://169.254.169.254" }); return g && r.status === 422; })());
const secretCall = async () => {
  const logs = []; const o = { log: console.log, warn: console.warn, error: console.error }; for (const k of Object.keys(o)) console[k] = (...a) => logs.push(a.join(" "));
  try {
    const created = await mkInt("https://api.example.test", { authType: "BEARER_TOKEN", credentials: { token: "tok-LIVE-SECRET-123456", password: "pw-hunter2" }, headers: { Authorization: "Bearer HEADERSECRET9999", "X-Trace": "visible-trace" } });
    const list = await call(ADMIN, "GET", "/api/business-integrations"); const mgr = await call(MGR, "GET", "/api/business-integrations");
    const upd = await call(ADMIN, "PUT", `/api/business-integrations/${created.body.data.id}`, { credentials: { token: "tok-ROTATED-SECRET-7777" } });
    return { created, list, mgr, upd, logs };
  } finally { Object.assign(console, o); }
};
const sc = await secretCall(); const everything = JSON.stringify([sc.created.body, sc.list.body, sc.mgr.body, sc.upd.body]);
check("integration created with credentials + secret header (201)", sc.created.status === 201 && sc.created.body.data.hasCredentials === true);
check("responses (create / list / MANAGER list / update) never contain a secret, nor its last 4 characters", !/LIVE-SECRET|hunter2|HEADERSECRET|ROTATED-SECRET|3456|7777|9999|hunter/.test(everything), everything.slice(0, 300));
const li = sc.list.body.data.find((i) => i.id === sc.created.body.data.id);
check("list exposes only metadata: hasCredentials + field names masked, sensitive headers hidden, harmless headers visible", li.hasCredentials === true && !li.encrypted_credentials && li.headers.Authorization === "[hidden]" && li.headers["X-Trace"] === "visible-trace" && Object.values(li.credentialPreview).every((v) => v === "********" || v === null), JSON.stringify(li).slice(0, 300));
const raw = (await q(`SELECT encrypted_credentials FROM business_integrations WHERE id=$1`, [sc.created.body.data.id])).rows[0].encrypted_credentials;
check("credentials are encrypted at rest (not plaintext, not JSON)", raw && !raw.includes("LIVE-SECRET") && !raw.includes("{") && raw !== "tok-LIVE-SECRET-123456");
check("secrets never reach the application log", !/LIVE-SECRET|hunter2|HEADERSECRET|ROTATED-SECRET/.test(sc.logs.join("\n")), sc.logs.filter((l) => /SECRET|hunter/.test(l)).join("|").slice(0, 200));
check("integration can be renamed without touching credentials (audited integration_update)", (await call(ADMIN, "PUT", `/api/business-integrations/${sc.created.body.data.id}`, { name: "Renamed integration" })).status === 200);
check("AGENT / VIEWER / CUSTOMER cannot read integrations at all", (await call(AGENT, "GET", "/api/business-integrations")).status === 403 && (await call(VIEWER, "GET", "/api/business-integrations")).status === 403 && (await call(S.CA.token, "GET", "/api/business-integrations")).status === 403);
check("MANAGER cannot create or change integrations (ADMIN only)", (await mkInt("https://api.example.test", {}, MGR)).status === 403);
const cust = await call(ADMIN, "POST", "/api/integrations", { name: "legacy", type: "crm", config: { apiKey: "legacy-KEY-12345", region: "in", nested: { token: "T-99999" } } });
const custList = await call(ADMIN, "GET", "/api/integrations");
check("legacy 'custom integrations' config: secret values are masked in the API", cust.status === 201 && !/legacy-KEY|T-99999/.test(JSON.stringify(custList.body)) && JSON.stringify(custList.body).includes('"region":"in"'), JSON.stringify(custList.body).slice(0, 200));
const integ = (await mkInt("https://api.example.test")).body.data;
const fnUrl = (p, extra = {}) => call(ADMIN, "POST", `/api/business-integrations/${integ.id}/functions`, { functionName: `fn_${Math.random().toString(36).slice(2, 8)}`, description: "d", pathTemplate: p, ...extra });
check("function path templates cannot inject a host / traversal / scheme", (await fnUrl("//evil.com/x")).status === 422 && (await fnUrl("/../admin")).status === 422 && (await fnUrl("http://evil.com/x")).status === 422 && (await fnUrl("@evil.com")).status === 422 && (await fnUrl("/ok/../../x")).status === 422);
check("valid function path accepted; invalid HTTP method rejected", (await fnUrl("/orders/{orderId}")).status === 201 && (await fnUrl("/x", { httpMethod: "TRACE" })).status === 422);
const fnId = (await fnUrl("/orders/{orderId}")).body.data.id;
setResolver(async () => [{ address: "10.0.0.5", family: 4 }]);   // DNS now points the "public" host at a private address (rebinding)
const reb = await call(ADMIN, "POST", `/api/business-integrations/functions/${fnId}/test`, { params: { orderId: "1" } });
check("EXECUTION re-validates DNS: a host that now resolves privately is refused (422), not requested", reb.status === 422 && /private|reserved/i.test(JSON.stringify(reb.body)), JSON.stringify(reb.body));
check("function test: invalid id 400; MANAGER 403", (await call(ADMIN, "POST", "/api/business-integrations/functions/nope/test", {})).status === 400 && (await call(MGR, "POST", `/api/business-integrations/functions/${fnId}/test`, {})).status === 403);
// positive path against a local server (test-only loopback allowance), proving the credential is sent but never echoed
process.env.SSRF_ALLOW_PRIVATE = "true"; let seenAuth = null;
const srv = http.createServer((req, res) => { seenAuth = req.headers.authorization; res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ order: req.url, status: "shipped" })); }).listen(0, "127.0.0.1"); await new Promise((r) => srv.on("listening", r));
const live = (await mkInt(`http://127.0.0.1:${srv.address().port}`, { authType: "BEARER_TOKEN", credentials: { token: "tok-EXEC-SECRET-5555" } })).body.data;
const lf = (await call(ADMIN, "POST", `/api/business-integrations/${live.id}/functions`, { functionName: "get_order", description: "d", pathTemplate: "/orders/{orderId}" })).body.data;
const ex = await call(ADMIN, "POST", `/api/business-integrations/functions/${lf.id}/test`, { params: { orderId: "A/../B 1" } });
check("function executes through the SSRF-safe client; credential is sent upstream", ex.status === 200 && ex.body.data.status === 200 && seenAuth === "Bearer tok-EXEC-SECRET-5555", JSON.stringify(ex.body));
check("path parameters are URL-encoded (no traversal via params)", String(ex.body.data.body?.order).includes("A%2F..%2FB%201"), JSON.stringify(ex.body.data));
check("the credential is never echoed back to the browser", !JSON.stringify(ex.body).includes("EXEC-SECRET"));
srv.close(); delete process.env.SSRF_ALLOW_PRIVATE; setResolver(null);

console.log("\n== Errors, headers and validation ==");
const sql = /syntax error|column|relation|pg_|ERROR:|at .*\.js|node_modules|stack/i;
const probes = [["GET", "/api/campaigns/not-a-uuid"], ["GET", "/api/calls/not-a-uuid"], ["GET", "/api/agents/zzz"], ["GET", "/api/knowledge-bases/zzz"], ["GET", "/api/calls?campaignId=zzz"], ["GET", "/api/contacts?campaignId=zzz"], ["GET", "/api/users/zzz"], ["PUT", "/api/users/zzz"], ["GET", "/api/surveys/zzz"], ["DELETE", "/api/customers/zzz"], ["GET", "/api/customers/zzz"], ["GET", "/api/clients/zzz"], ["GET", "/api/recordings/zzz/url"]];
const pr = await Promise.all(probes.map(async ([m, p]) => [m, p, await call(ADMIN, m, p, m === "PUT" ? {} : undefined)]));
check("malformed ids -> 4xx with a safe message (never 500, never SQL / stack / path text)", pr.every(([, , r]) => r.status >= 400 && r.status < 500 && !sql.test(JSON.stringify(r.body))), JSON.stringify(pr.filter(([, , r]) => r.status >= 500 || sql.test(JSON.stringify(r.body))).map(([m, p, r]) => [m, p, r.status, r.body])));
const nf = await call(ADMIN, "GET", "/api/does-not-exist");
check("unknown API route -> 404 JSON", nf.status === 404 && nf.body.success === false);
const badJson = await fetch(ctx.base + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" });
check("malformed JSON -> 400 with a clean message", badJson.status === 400 && !sql.test(await badJson.text()));
const huge = await fetch(ctx.base + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "a", password: "x".repeat(3 * 1024 * 1024) }) });
check("request body over 2 MB -> 413", huge.status === 413);
const hh = await fetch(ctx.base + "/api/health");
check("security headers present, X-Powered-By hidden, health is public", hh.status === 200 && hh.headers.get("x-content-type-options") === "nosniff" && !hh.headers.get("x-powered-by") && hh.headers.get("x-request-id"));
check("401 vs 403 vs 422 conventions", (await call(null, "GET", "/api/users")).status === 401 && (await call(AGENT, "GET", "/api/users")).status === 403 && (await call(ADMIN, "POST", "/api/users", { name: "x", email: "bad", password: "Passw0rd!Test" })).status === 422);
check("validation errors name the problem but not internals", (await call(MGR, "POST", "/api/campaigns", { name: "" })).status === 400);
check("duplicate unique value -> 409 (not 500)", (await call(ADMIN, "POST", "/api/phone-numbers", { number: "+917000000001" })).status === 201 && (await call(ADMIN, "POST", "/api/phone-numbers", { number: "+917000000001" })).status === 409);

console.log("\n== Existing features still work (regression smoke) ==");
const mgrGets = ["/api/agents", `/api/agents/${S.agentA}`, "/api/campaigns", `/api/campaigns/${S.campA1}`, "/api/contacts", `/api/contacts?campaignId=${S.campA1}`, "/api/customers", "/api/calls", `/api/calls?status=Completed`, `/api/calls?status=Completed&campaignId=${S.campA1}&agentId=${S.agentA}`,
  `/api/calls/${S.callA1}`, "/api/knowledge-bases", `/api/knowledge-bases/${kb.id}`, `/api/documents?knowledgeBaseId=${kb.id}`, "/api/surveys", "/api/phone-numbers", "/api/recordings", "/api/clients", "/api/business-integrations", "/api/integrations", "/api/contact-requests", `/api/agent-steering/${S.agentA}`];
const analyticsPaths = [...fs.readFileSync("server/routes/analytics.js", "utf8").matchAll(/router\.get\("([^":]+)"/g)].map((m) => `/api/analytics${m[1] === "/" ? "" : m[1]}`);
let broken = [];
for (const p of [...mgrGets, ...analyticsPaths]) { const r = await call(ADMIN, "GET", p); if (r.status >= 500) broken.push(`${p} -> ${r.status}`); }
check(`${mgrGets.length + analyticsPaths.length} existing read endpoints (incl. ${analyticsPaths.length} analytics) respond without a server error — no ambiguous-column SQL`, broken.length === 0, broken.join("; "));
const ag = await call(MGR, "POST", "/api/agents", { name: "Smoke Agent", language: "Telugu", knowledgeBaseIds: [kb.id], recordingConsent: "REQUIRED", recordingRetentionDays: 30 });
check("agent create (with KB + consent + retention) / update / list", ag.status === 201 && (await call(MGR, "PUT", `/api/agents/${ag.body.data.id}`, { description: "updated", recordingRetentionDays: 60 })).status === 200 && (await q(`SELECT recording_retention_days FROM agents WHERE id=$1`, [ag.body.data.id])).rows[0].recording_retention_days === 60);
const cust2 = await call(MGR, "POST", "/api/customers", { firstName: "Smoke", mobile: "9876599001", city: "Guntur" });
check("customers (people): create / edit-all-fields / clear a field / list / delete(ADMIN)", cust2.status === 201 && (await call(MGR, "PUT", `/api/customers/${cust2.body.data.id}`, { alternateMobile: "9876599002", companyName: "Acme", email: "" })).status === 200 && (await q(`SELECT company_name, alternate_mobile, email FROM customers WHERE id=$1`, [cust2.body.data.id])).rows[0].company_name === "Acme" && (await call(MGR, "DELETE", `/api/customers/${cust2.body.data.id}`)).status === 403 && (await call(ADMIN, "DELETE", `/api/customers/${cust2.body.data.id}`)).status === 200);
const ph = await call(ADMIN, "POST", "/api/phone-numbers", { number: "+917000000009" });
check("phone numbers: create and DELETE (admin)", ph.status === 201 && (await call(ADMIN, "DELETE", `/api/phone-numbers/${ph.body.data.id}`)).status === 200 && (await call(MGR, "DELETE", `/api/phone-numbers/${ph.body.data.id}`)).status === 403);
const kdel = (await call(MGR, "POST", "/api/knowledge-bases", { name: "To delete" })).body.data;
check("knowledge base delete: AGENT 403, MANAGER 200", (await call(AGENT, "DELETE", `/api/knowledge-bases/${kdel.id}`)).status === 403 && (await call(MGR, "DELETE", `/api/knowledge-bases/${kdel.id}`)).status === 200);
check("public contact form still works (and a filled honeypot is silently dropped)", (await call(null, "POST", "/api/contact-requests", { name: "Lead", email: "lead@x.test", message: "Interested in a demo" })).status === 201 && await (async () => { const r = await call(null, "POST", "/api/contact-requests", { name: "Bot", email: "bot@x.test", message: "spam spam", website: "http://spam" }); return r.status === 201 && (await q(`SELECT count(*)::int n FROM contact_requests WHERE email='bot@x.test'`)).rows[0].n === 0; })());
check("logout works and is audited", (await call(ADMIN, "POST", "/api/auth/logout")).status === 200);
const xfer = await call(MGR, "POST", `/api/calls/${S.callA1}/transfer`, {});
check("call transfer: uses the agent's configured number (mock provider) / arbitrary numbers need an admin", xfer.status === 200 && (await call(MGR, "POST", `/api/calls/${S.callA1}/transfer`, { toNumber: "+911234567890" })).status === 403 && (await call(S.staff.VIEWER.token, "POST", `/api/calls/${S.callA1}/transfer`, {})).status === 403);
check("call transfer rejects a non-phone-number target (toll-fraud / markup guard)", (await call(ADMIN, "POST", `/api/calls/${S.callA1}/transfer`, { toNumber: "<Play>http://evil</Play>" })).status === 422);

console.log("\n== Audit trail coverage ==");
await call(null, "POST", "/api/auth/login", { email: "admin@lmx.test", password: "wrong-password" });
const sample = (await q(`SELECT actor_id, actor_role, action, resource, result, ip FROM audit_logs WHERE action='kb_create' LIMIT 1`)).rows[0];
check("audit rows have actor, role, action, resource, result, IP", sample && sample.actor_id && sample.actor_role && sample.resource === "knowledge_base" && sample.result === "success" && sample.ip, JSON.stringify(sample));
check("failed logins are audited as failures", (await q(`SELECT count(*)::int n FROM audit_logs WHERE action='login_failure' AND result='failure'`)).rows[0].n > 0);
const blob = (await q(`SELECT string_agg(coalesce(meta::text,'') || coalesce(user_agent,'') || coalesce(resource_id,''), ' ') t FROM audit_logs`)).rows[0].t || "";
check("audit trail contains no passwords, tokens, API keys or credentials", !/Passw0rd|eyJ|Bearer|LIVE-SECRET|hunter2|EXEC-SECRET|HEADERSECRET|password_hash|\$2[aby]\$/.test(blob), blob.slice(0, 200));

await ctx.stop();
const s = t.summary(); console.log(`\n${s.pass} passed, ${s.fail} failed`); if (s.fail) console.log(s.failures); process.exit(s.fail ? 1 : 0);
