// Test harness: real HTTP server on the REAL app, real Postgres (TEST_DATABASE_URL) or in-process PGlite.
// Everything runs inside a throw-away schema; your public schema is never touched.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const here = path.dirname(fileURLToPath(import.meta.url));
export const root = path.resolve(here, "..");

export async function boot() {
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = "test-secret-test-secret-test-secret-123456";
  process.env.RATE_LIMIT_DISABLED = "true";
  process.env.STORAGE_PROVIDER = process.env.STORAGE_PROVIDER || "local";
  process.env.STORAGE_LOCAL_DIR = path.join(root, ".test-recordings");
  process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
  process.env.PUBLIC_BASE_URL = "https://leomox.test";
  process.env.WS_REVALIDATE_MS = "400";
  process.env.WEBHOOK_INGEST_SYNC = "true";
  process.env.RECORDING_MAX_MB = "1";
  process.env.MAX_CSV_ROWS = "50";
  process.env.RECORDING_URL_ALLOWLIST = "api.twilio.test";

  const state = { mode: "postgres", cleanup: [] };
  let baseUrl = process.env.TEST_DATABASE_URL;
  if (!baseUrl) {                                  // portable mode: in-process Postgres (single connection)
    const { PGlite } = await import("@electric-sql/pglite");
    const { vector } = await import("@electric-sql/pglite-pgvector");
    const { PGLiteSocketServer } = await import("@electric-sql/pglite-socket");
    const db = await PGlite.create({ extensions: { vector } });
    const srv = new PGLiteSocketServer({ db, port: 54329, host: "127.0.0.1" });
    await srv.start();
    baseUrl = "postgresql://postgres:postgres@127.0.0.1:54329/postgres";
    process.env.PG_POOL_MAX = "1";
    process.env.DIALER_ADVISORY_LOCK = "false";
    state.mode = "pglite";
    state.cleanup.push(async () => { await srv.stop(); await db.close(); });
  }
  const schemaName = `lmx_test_${crypto.randomBytes(4).toString("hex")}`;
  const { default: pg } = await import("pg");
  const admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  await admin.query(`CREATE EXTENSION IF NOT EXISTS vector`);
  await admin.query(`CREATE SCHEMA ${schemaName}`);
  await admin.end();
  const sep = baseUrl.includes("?") ? "&" : "?";
  process.env.DATABASE_URL = `${baseUrl}${sep}options=${encodeURIComponent(`-c search_path=${schemaName},public`)}`;

  // schema + the real migrations (through the real runner)
  const { runMigrations } = await import("../server/db/migrate.js");
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  await c.query(fs.readFileSync(path.join(here, "fixtures/schema.sql"), "utf8"));
  await runMigrations(c, path.join(root, "db/migrations"), () => {});
  await c.end();

  const { createApp } = await import("../server/app.js");
  const { attachLiveCallsServer, closeLiveCallsServer } = await import("../server/services/liveCalls.js");
  const server = http.createServer(createApp());
  attachLiveCallsServer(server);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const { pool, query } = await import("../server/db/pool.js");

  const ctx = {
    mode: state.mode, base: `http://127.0.0.1:${port}`, port, query, pool, server,
    async stop() {
      try {
        const acts = (await query(`SELECT DISTINCT action FROM audit_logs`)).rows.map((r) => r.action);
        fs.mkdirSync(path.join(root, ".test-results"), { recursive: true });
        fs.writeFileSync(path.join(root, ".test-results", `${path.basename(process.argv[1])}.audit.json`), JSON.stringify(acts));
      } catch { /* best effort */ }
      closeLiveCallsServer();
      await new Promise((r) => server.close(r));
      try { await pool.end(); } catch { /* connection already closed */ }
      if (state.mode === "postgres") {                  // in portable mode the whole in-process database is thrown away
        const a = new pg.Client({ connectionString: baseUrl }); await a.connect();
        await a.query(`DROP SCHEMA ${schemaName} CASCADE`); await a.end();
      }
      for (const f of state.cleanup) await f();
      fs.rmSync(process.env.STORAGE_LOCAL_DIR, { recursive: true, force: true });
    },
  };
  return ctx;
}

export function makeRunner(ctx) {
  let pass = 0, fail = 0; const failures = [];
  const check = (name, cond, extra = "") => {
    cond ? pass++ : (fail++, failures.push(name));
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  <-- " + extra}`);
  };
  const call = async (token, method, p, body, extraHeaders = {}) => {
    const isForm = typeof FormData !== "undefined" && body instanceof FormData;
    const r = await fetch(ctx.base + p, {
      method, redirect: "manual",
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body && !isForm ? { "content-type": "application/json" } : {}), ...extraHeaders },
      body: body ? (isForm ? body : JSON.stringify(body)) : undefined,
    });
    const ct = r.headers.get("content-type") || "";
    const out = ct.includes("json") ? await r.json().catch(() => null) : ct.includes("text") ? await r.text() : Buffer.from(await r.arrayBuffer());
    return { status: r.status, body: out, headers: r.headers };
  };
  return { check, call, summary: () => ({ pass, fail, failures }) };
}
