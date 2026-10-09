// Unit-level security tests (no database): SSRF guard, environment validation, S3/R2 presigning, upload content checks, secret redaction.
import { spawnSync } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

process.env.NODE_ENV = "test"; process.env.JWT_SECRET = "x".repeat(40);
const here = path.dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0; const failures = [];
const check = (n, c, extra = "") => { c ? pass++ : (fail++, failures.push(n)); console.log(`${c ? "PASS" : "FAIL"}  ${n}${c ? "" : "  <-- " + extra}`); };
const rejects = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

const { assertPublicUrl, safeRequest, setResolver, isPrivateIp, SsrfError } = await import("../server/utils/ssrf.js");
console.log("\n== SSRF: address classification ==");
const privates = ["127.0.0.1", "127.8.8.8", "10.0.0.5", "172.16.0.1", "172.31.255.254", "192.168.1.1", "169.254.169.254", "0.0.0.0", "100.64.0.1", "198.18.0.1", "224.0.0.1", "255.255.255.255", "::1", "::", "fe80::1", "fc00::1", "fd00:ec2::254", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.1.2.3", "ff02::1", "64:ff9b::1.2.3.4"];
const publics = ["93.184.216.34", "8.8.8.8", "1.1.1.1", "172.32.0.1", "2606:4700:4700::1111"];
check(`all ${privates.length} private / loopback / link-local / metadata / reserved addresses are blocked`, privates.every(isPrivateIp), privates.filter((x) => !isPrivateIp(x)).join());
check("public addresses are allowed (incl. 172.32.x which is NOT private)", publics.every((x) => !isPrivateIp(x)), publics.filter(isPrivateIp).join());

console.log("\n== SSRF: URL validation ==");
setResolver(async (h) => ({ "api.example.test": [{ address: "93.184.216.34", family: 4 }], "evil.test": [{ address: "10.0.0.5", family: 4 }], "meta.test": [{ address: "169.254.169.254", family: 4 }],
  "mixed.test": [{ address: "93.184.216.34", family: 4 }, { address: "127.0.0.1", family: 4 }], "v6.test": [{ address: "::1", family: 6 }], "nx.test": [] })[h] || (() => { throw new Error("ENOTFOUND"); })());
const bad = ["http://localhost/x", "https://localhost/x", "https://127.0.0.1/x", "https://127.1/x", "https://2130706433/x", "https://0x7f.0.0.1/x", "https://[::1]/x", "https://10.0.0.1/x", "https://172.16.5.5/x", "https://192.168.0.10/x",
  "https://169.254.169.254/latest/meta-data/", "https://metadata.google.internal/computeMetadata/v1/", "https://[fd00:ec2::254]/", "https://[::ffff:127.0.0.1]/", "https://0.0.0.0/", "https://foo.internal/", "https://printer.local/", "https://evil.test/", "https://meta.test/",
  "https://mixed.test/", "https://v6.test/", "https://nx.test/", "https://unknown-host.test/", "ftp://api.example.test/", "file:///etc/passwd", "gopher://api.example.test/", "javascript:alert(1)", "not a url", "", "https://user:pass@api.example.test/", "https://api.example.test:8080/", "https://api.example.test:22/", "https://api.example.test:6379/"];
let notBlocked = [];
for (const u of bad) { const e = await rejects(() => assertPublicUrl(u)); if (!(e instanceof SsrfError)) notBlocked.push(u); }
check(`${bad.length} dangerous URLs rejected (hostname, IP, decimal/hex/short IPs, IPv6, DNS tricks, schemes, ports, credentials)`, notBlocked.length === 0, notBlocked.join(" | "));
const ok = await assertPublicUrl("https://api.example.test/v1/orders");
check("a valid public HTTPS API is accepted", ok.hostname === "api.example.test");
process.env.NODE_ENV = "production";
check("production: plain http:// is rejected (https only)", (await rejects(() => assertPublicUrl("http://api.example.test/"))) instanceof SsrfError);
process.env.NODE_ENV = "test";
check("outside production http:// to a public host is allowed (dev convenience)", (await assertPublicUrl("http://api.example.test/")).protocol === "http:");

console.log("\n== SSRF: DNS rebinding ==");
let calls = 0; setResolver(async () => (++calls === 1 ? [{ address: "93.184.216.34", family: 4 }] : [{ address: "10.0.0.5", family: 4 }]));
const rebind = await rejects(() => safeRequest("https://rebind.test/x"));
check("hostname that resolves public at validation but PRIVATE at connect time is blocked", rebind instanceof SsrfError && calls >= 2, `${rebind?.message} calls=${calls}`);
setResolver(async () => [{ address: "10.1.1.1", family: 4 }]);
check("safeRequest to a hostname resolving to a private IP never connects", (await rejects(() => safeRequest("https://internal.test/"))) instanceof SsrfError);

console.log("\n== SSRF: request handling (test-only loopback allowance) ==");
process.env.SSRF_ALLOW_PRIVATE = "true";
const srv = http.createServer((req, res) => {
  if (req.url === "/json") { res.setHeader("content-type", "application/json"); return res.end(JSON.stringify({ ok: true, auth: req.headers.authorization || null })); }
  if (req.url === "/redir") { res.statusCode = 302; res.setHeader("location", "http://169.254.169.254/latest"); return res.end(); }
  if (req.url === "/big") { res.write(Buffer.alloc(2 * 1024 * 1024)); return res.end(); }
  if (req.url === "/slow") return setTimeout(() => res.end("late"), 3000);
  res.end("hi");
}).listen(0, "127.0.0.1"); await new Promise((r) => srv.on("listening", r));
const base = `http://127.0.0.1:${srv.address().port}`;
const gr = await safeRequest(`${base}/json`, { headers: { authorization: "Bearer abc" } });
check("request path works and sends headers", gr.status === 200 && JSON.parse(gr.body.toString()).auth === "Bearer abc");
const rd = await safeRequest(`${base}/redir`);
check("redirects are NOT followed (a 302 to the metadata IP is returned as-is)", rd.status === 302 && rd.headers.location.includes("169.254"));
check("oversized response aborted (max 1 MB)", (await rejects(() => safeRequest(`${base}/big`))) !== null);
check("slow endpoint times out", String((await rejects(() => safeRequest(`${base}/slow`, { timeoutMs: 400 })))?.message).includes("timed out"));
srv.close(); delete process.env.SSRF_ALLOW_PRIVATE;
check("the loopback allowance is ignored outside NODE_ENV=test", await (async () => { process.env.NODE_ENV = "production"; process.env.SSRF_ALLOW_PRIVATE = "true"; const e = await rejects(() => assertPublicUrl("https://127.0.0.1/")); process.env.NODE_ENV = "test"; delete process.env.SSRF_ALLOW_PRIVATE; return e instanceof SsrfError; })());
setResolver(null);

console.log("\n== Environment validation ==");
const { validateEnv } = await import("../server/config/env.js");
const base_ = { NODE_ENV: "production", DATABASE_URL: "postgres://x", JWT_SECRET: "j".repeat(40), STORAGE_PROVIDER: "s3", S3_BUCKET: "b", S3_ACCESS_KEY_ID: "k", S3_SECRET_ACCESS_KEY: "s", CORS_ORIGIN: "https://app.test", ENCRYPTION_KEY: "e" };
const has = (env, text) => validateEnv(env).errors.some((e) => e.includes(text));
check("valid production env: no errors", validateEnv(base_).errors.length === 0, JSON.stringify(validateEnv(base_)));
check("STORAGE_PROVIDER=s3 without S3_BUCKET -> actionable error", has({ ...base_, S3_BUCKET: "" }, "STORAGE_PROVIDER=s3 but S3_BUCKET is missing"));
check("production + local storage is an error (no silent fallback)", has({ ...base_, STORAGE_PROVIDER: "local" }, "would lose recordings"));
check("missing JWT_SECRET / DATABASE_URL are errors", has({ ...base_, JWT_SECRET: "" }, "JWT_SECRET is missing") && has({ ...base_, DATABASE_URL: "" }, "DATABASE_URL is missing"));
check("short JWT_SECRET: error in production, only a warning in development", has({ ...base_, JWT_SECRET: "short" }, "JWT_SECRET should be") && validateEnv({ ...base_, NODE_ENV: "development", JWT_SECRET: "short" }).errors.length === 0);
check("VITE_* secret variables are refused (they would ship to the browser)", has({ ...base_, VITE_AI_API_KEY: "x" }, "VITE_AI_API_KEY") && has({ ...base_, VITE_S3_SECRET: "x" }, "VITE_S3_SECRET") && !has({ ...base_, VITE_APP_NAME: "LeoMox" }, "VITE_"));
check("AI_PROVIDER=gemini without AI_API_KEY -> error; embeddings google needs a key", has({ ...base_, AI_PROVIDER: "gemini" }, "AI_API_KEY is missing") && has({ ...base_, EMBEDDING_PROVIDER: "google" }, "EMBEDDING_API_KEY"));
check("TELEPHONY_PROVIDER=twilio needs its keys + PUBLIC_BASE_URL", has({ ...base_, TELEPHONY_PROVIDER: "twilio" }, "TELEPHONY_API_KEY") && has({ ...base_, TELEPHONY_PROVIDER: "twilio" }, "PUBLIC_BASE_URL"));
check("unknown telephony / storage providers are errors", has({ ...base_, TELEPHONY_PROVIDER: "foo" }, "Unknown TELEPHONY_PROVIDER") && has({ ...base_, STORAGE_PROVIDER: "ftp" }, "Unknown STORAGE_PROVIDER"));
check("mock providers stay valid in development", validateEnv({ NODE_ENV: "development", DATABASE_URL: "x", JWT_SECRET: "x".repeat(32) }).errors.length === 0);
check("STT/TTS without a standalone adapter produce an honest warning (not a silent no-op)", validateEnv({ ...base_, STT_PROVIDER: "sarvam" }).warnings.some((w) => w.includes("no standalone adapter")));

console.log("\n== Storage: R2/S3 presigned URLs (child process) ==");
const run = (env, ...args) => { const r = spawnSync("node", [path.join(here, "helpers/storage-child.mjs"), ...args], { env: { ...process.env, ...env }, encoding: "utf8" }); return JSON.parse(r.stdout.trim().split("\n").pop()); };
const r2 = { NODE_ENV: "production", STORAGE_PROVIDER: "s3", S3_BUCKET: "leomox-rec", S3_ACCESS_KEY_ID: "AKIATESTKEY", S3_SECRET_ACCESS_KEY: "SUPERSECRETVALUE123", S3_ENDPOINT: "https://acct123.r2.cloudflarestorage.com", S3_REGION: "auto" };
const p = run(r2, "presign");
const u = new URL(p.url);
check("R2: presigned URL, 300 s expiry, signature present, scoped to bucket + customer folder", p.presign && u.searchParams.get("X-Amz-Expires") === "300" && u.searchParams.get("X-Amz-Signature") && (u.hostname.startsWith("leomox-rec.") || u.pathname.startsWith("/leomox-rec/")) && u.pathname.includes("/customers/c1/campaigns/k1/recordings/"), p.url);
check("presigned URL exposes the key ID only, never the secret key", !p.url.includes("SUPERSECRETVALUE123") && p.url.includes("AKIATESTKEY"));
check("inline playback by default", (u.searchParams.get("response-content-disposition") || "") === "inline");
check("download link forces attachment", (new URL(run(r2, "presign", "download").url).searchParams.get("response-content-disposition") || "").startsWith("attachment"));
check("production + STORAGE_PROVIDER=local refuses to start (no silent fallback)", String(run({ NODE_ENV: "production", STORAGE_PROVIDER: "local" }, "x").error).includes("not allowed in production"));
check("s3 without credentials fails with a clear message", String(run({ STORAGE_PROVIDER: "s3", S3_BUCKET: "", S3_ACCESS_KEY_ID: "", S3_SECRET_ACCESS_KEY: "" }, "x").error).includes("missing env"));

console.log("\n== Upload content validation ==");
const fv = await import("../server/utils/fileValidation.js");
check("filenames are sanitised (no directories, no traversal, no control chars)", fv.sanitizeFilename("../../a b.pdf") === "a b.pdf" && fv.sanitizeFilename("..\\..\\x.pdf") === "x.pdf" && !fv.sanitizeFilename("a\u0000b/../../c.exe").includes("/") && fv.sanitizeFilename("") === "file" && fv.sanitizeFilename("x".repeat(500)).length <= 120);
check("traversal detection", fv.hasTraversal("../../file") && fv.hasTraversal("..\\..\\file") && fv.hasTraversal("a\u0000.pdf") && !fv.hasTraversal("report..final.pdf"));
const pdf = Buffer.from("%PDF-1.7 ..."), zip = Buffer.from([0x50, 0x4b, 3, 4, 0, 0]), exe = Buffer.from("MZ\x90\x00"), txt = Buffer.from("hello wörld"), bin = Buffer.from([104, 0, 105]);
check("document magic bytes: PDF / DOCX / TXT / CSV / MD must match their extension", fv.validateDocumentContent(pdf, ".pdf") === "PDF" && fv.validateDocumentContent(zip, ".docx") === "DOCX" && fv.validateDocumentContent(txt, ".txt") === "TXT" && fv.validateDocumentContent(txt, ".csv") === "CSV" && fv.validateDocumentContent(txt, ".md") === "MD");
check("EXE renamed .pdf/.docx/.txt is rejected; binary-with-NUL as text is rejected; unknown extension rejected", fv.validateDocumentContent(exe, ".pdf") === null && fv.validateDocumentContent(exe, ".docx") === null && fv.validateDocumentContent(exe, ".txt") === null && fv.validateDocumentContent(bin, ".txt") === null && fv.validateDocumentContent(pdf, ".exe") === null);
check("PDF bytes with a .txt extension are text-checked (invalid UTF-8 rejected)", fv.validateDocumentContent(Buffer.from([0xff, 0xfe, 0xfd]), ".txt") === null);
const wavb = Buffer.concat([Buffer.from("RIFF\0\0\0\0WAVE"), Buffer.alloc(20)]);
check("audio magic bytes: wav / webm / ogg / mp3 / m4a accepted, html & exe rejected", fv.validateAudioContent(wavb, "audio/wav") && fv.validateAudioContent(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0]), "audio/webm") && fv.validateAudioContent(Buffer.from("OggS\0"), "audio/ogg") && fv.validateAudioContent(Buffer.from("ID3\x03"), "audio/mpeg") && fv.validateAudioContent(Buffer.from("\0\0\0\x18ftypM4A "), "audio/mp4") && !fv.validateAudioContent(Buffer.from("<html>"), "audio/webm") && !fv.validateAudioContent(exe, "audio/wav") && !fv.validateAudioContent(wavb, "audio/unknown"));

console.log("\n== Secrets never leak ==");
const { redact, logger } = await import("../server/utils/logger.js");
const red = JSON.stringify(redact({ headers: { Authorization: "Bearer SECRETTOKEN", "X-API-Key": "KEY123456", cookie: "sid=abc" }, password: "hunter2", apiKey: "sk-live-ABCDEF", credentials: { token: "T0KEN" }, from: "+919876543210", to: "9876543210", phone: "9876543210", nested: { client_secret: "CS", ok: "visible" }, speechResult: "hello" }));
check("logger redacts Authorization / X-API-Key / cookie / passwords / api keys / nested secrets", !/SECRETTOKEN|KEY123456|sid=abc|hunter2|sk-live|T0KEN|"CS"/.test(red) && red.includes("visible"), red);
check("logger masks phone numbers (from / to / phone)", !red.includes("9876543210") && red.includes("3210"));
const lines = []; const oc = console.log; console.log = (x) => lines.push(x); logger.info("t", { authorization: "Bearer ZZZ", password: "pw" }); console.log = oc;
check("logger output contains no secrets", !lines.join("").includes("ZZZ") && !lines.join("").includes('"pw"'));
process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
const cr = await import("../server/utils/crypto.js");
const blob = cr.encryptCredentials({ apiKey: "sk-live-SECRET123456", password: "pw-xyz" });
check("credentials are encrypted at rest (no plaintext in the stored blob) and round-trip", !blob.includes("SECRET") && cr.decryptCredentials(blob).apiKey === "sk-live-SECRET123456");
check("tampered ciphertext is rejected (AES-GCM auth tag)", await (async () => { const b = Buffer.from(blob, "base64"); b[b.length - 1] ^= 1; try { cr.decryptCredentials(b.toString("base64")); return false; } catch { return true; } })());
const mask = JSON.stringify(cr.redactCredentials({ apiKey: "sk-live-SECRET123456", username: "bob" }));
check("redacted view reveals NO part of a secret (not even the last 4 characters)", !mask.includes("3456") && !mask.includes("sk-live") && !mask.includes("bob"), mask);

console.log("\n== Conversation safety: unsafe-word detection ==");
const { classify } = await import("../server/services/conversation/relevanceEngine.js");
const agent = { allowed_topics: [], restricted_topics: [], knowledge_only_mode: false, off_topic_strategy: "REDIRECT" };
const rel = (text) => classify({ text, agent, knowledgeMatches: [] }).relevance;
check("OTP / PIN / CVV / password / UPI PIN / bank login are UNSAFE", ["please tell me the OTP", "my PIN is 1234", "what is the CVV", "share your password", "enter your UPI PIN", "bank login details"].every((x) => rel(x) === "UNSAFE"), ["please tell me the OTP", "my PIN is 1234", "what is the CVV", "share your password"].map(rel).join());
check("ordinary words containing these letters are NOT flagged (shopping, opinion, spinning, hotpot, pinnacle)", ["I enjoy shopping", "what is your opinion", "spinning wheel", "hotpot dinner", "the pinnacle of service"].every((x) => rel(x) !== "UNSAFE"), ["I enjoy shopping", "what is your opinion", "spinning wheel"].map(rel).join());

console.log(`\n${pass} passed, ${fail} failed`); if (fail) console.log(failures); process.exit(fail ? 1 : 0);
