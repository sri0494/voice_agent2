#!/usr/bin/env node
// npm run test:security   (cross-platform: no shell scripts)
//   TEST_DATABASE_URL=postgres://...  -> runs on a real Postgres inside a throw-away schema (needs the pgvector extension); ALL tests run, including concurrent-worker races.
//   (not set)                         -> runs on an in-process Postgres (PGlite): everything except the multi-connection race tests.
// Your own tables are never touched. Add `--only access` to run one suite.
import { spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url)); const root = path.join(here, "..");
const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : null;
const suites = [
  ["units", "security.units.test.mjs", "SSRF, environment, storage presigning, upload content, secret redaction, unsafe-word detection"],
  ["access", "security.access.test.mjs", "authentication, role matrix, CUSTOMER vs admin APIs, tenant isolation (IDOR), permissions, assignment"],
  ["recordings", "security.recordings.test.mjs", "no public file endpoint, playback/download rules, uploads, consent, retention, webhooks"],
  ["ws", "security.ws.test.mjs", "WebSocket authentication, tenant-scoped events, session expiry"],
  ["ops", "security.ops.test.mjs", "dialer idempotency, state machines, webhook idempotency, rate limits"],
  ["data", "security.data.test.mjs", "uploads, RAG isolation, integrations (SSRF + secrets), errors, regression smoke, audit"],
  ["ui", "security.ui.test.mjs", "customer portal UI against the real backend (jsdom)"],
  ["audit-coverage", "audit-coverage.test.mjs", "every required audit action was written"],
];
const mode = process.env.TEST_DATABASE_URL ? "real PostgreSQL" : "in-process PGlite (race tests skipped)";
console.log(`LeoMox security tests | database: ${mode}\n`);
fs.rmSync(path.join(root, ".test-results"), { recursive: true, force: true });
const results = []; let failed = false;
for (const [name, file, what] of suites) {
  if (only && only !== name) continue;
  process.stdout.write(`${name.padEnd(15)} ${what}\n`);
  const r = spawnSync(process.execPath, [path.join(here, file)], { cwd: root, encoding: "utf8", env: process.env, maxBuffer: 64 * 1024 * 1024, timeout: 15 * 60 * 1000 });
  const out = `${r.stdout || ""}${r.stderr || ""}`.split("\n").filter((l) => !l.startsWith('{"level"'));
  const m = out.join("\n").match(/(\d+) passed, (\d+) failed/g)?.pop();
  const bad = out.filter((l) => l.startsWith("FAIL")); const skip = out.filter((l) => l.startsWith("SKIP"));
  const ok = r.status === 0 && m && !bad.length;
  if (!ok) { failed = true; out.filter((l) => /^FAIL|Error|error/.test(l)).slice(0, 12).forEach((l) => console.log(`   ${l.slice(0, 300)}`)); }
  skip.forEach((l) => console.log(`   ${l.slice(0, 200)}`));
  results.push([name, ok ? "PASS" : "FAIL", m || "no result (crashed?)"]);
  console.log(`   -> ${ok ? "PASS" : "FAIL"}  ${m || "no result"}\n`);
}
if (!only) {
  const a = spawnSync(process.execPath, [path.join(here, "audit.mjs")], { cwd: root, encoding: "utf8", env: { ...process.env, NODE_ENV: "test" } });
  const line = a.stdout.trim().split("\n").filter(Boolean);
  console.log(`endpoint audit   ${line[0]}\n   -> ${a.status === 0 ? "PASS" : "FAIL"}  ${line.at(-1)}\n`);
  if (a.status !== 0) { failed = true; line.filter((l) => /HIGH|MED/.test(l)).forEach((l) => console.log(`   ${l}`)); }
  results.push(["endpoint audit", a.status === 0 ? "PASS" : "FAIL", line[0]]);
}
console.log("Summary"); results.forEach(([n, s, d]) => console.log(`  ${s}  ${n.padEnd(16)} ${d}`));
console.log(failed ? "\nSECURITY TESTS FAILED" : "\nALL SECURITY TESTS PASSED");
process.exit(failed ? 1 : 0);
