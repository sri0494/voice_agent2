#!/usr/bin/env node
// Wires the customer portal into the EXISTING files that this update cannot overwrite blindly.
// SAFE BY DEFAULT: without --apply it only prints what it WOULD change.
//   node scripts/wire-portal.mjs            # preview
//   node scripts/wire-portal.mjs --apply    # change files (a .bak copy of each is written first)
// It only edits a file when it recognises the exact pattern; otherwise it prints the manual snippet.
// It is idempotent: running it twice changes nothing the second time.
import fs from "node:fs";
import path from "node:path";

const apply = process.argv.includes("--apply");
const root = path.resolve(process.argv.find((a) => a.startsWith("--root="))?.slice(7) || ".");
const report = [];
const abs = (rel) => path.join(root, rel);
const exists = (rel) => fs.existsSync(abs(rel));

function lastImportEnd(src) {
  let end = 0;
  for (const m of src.matchAll(/^import\b[^;]*?["'][^"']+["'];?[ \t]*$/gm)) end = m.index + m[0].length;
  return end;
}
const addImports = (src, lines) => { const e = lastImportEnd(src); return src.slice(0, e) + "\n" + lines.join("\n") + src.slice(e); };

function edit(rel, fn) {
  if (!exists(rel)) { report.push([rel, "not found", "skipped"]); return; }
  const before = fs.readFileSync(abs(rel), "utf8");
  let result;
  try { result = fn(before); } catch (e) { result = { manual: `error: ${e.message}` }; }
  if (!result) return;
  if (result.done) { report.push([rel, "already done", ""]); return; }
  if (result.manual) { report.push([rel, "MANUAL STEP NEEDED", result.manual]); return; }
  if (apply) { fs.copyFileSync(abs(rel), abs(rel) + ".bak"); fs.writeFileSync(abs(rel), result.text); }
  report.push([rel, apply ? "patched" : "would patch", result.note]);
}

// ---------- 1. server/index.js : blocker + routers ----------
const SERVER_MANUAL = `add to server/index.js, BEFORE your other app.use("/api/...") lines:
    import { blockCustomerOutsidePortal } from "./middleware/portal.js";
    import customerPortalRouter from "./routes/customerPortal.js";
    import clientsRouter from "./routes/clients.js";
    import recordingsRouter from "./routes/recordings.js";
    app.use("/api", blockCustomerOutsidePortal);
    app.use("/api/customer", customerPortalRouter);
    app.use("/api/clients", clientsRouter);
    app.use("/api/recordings", recordingsRouter);`;
const serverFile = ["server/app.js", "server/index.js"].find(exists);
if (!serverFile) report.push(["server/index.js", "not found", "skipped"]);
else edit(serverFile, (src) => {
  if (src.includes("blockCustomerOutsidePortal") || (exists("server/app.js") && fs.readFileSync(abs("server/app.js"), "utf8").includes("blockCustomerOutsidePortal"))) return { done: true };
  const m = /^[ \t]*app\.use\(\s*["']\/api\/\w[^\n]*$/m.exec(src);
  if (!m) return { manual: SERVER_MANUAL };
  const hasRec = /recordings(Router)?\b.*\.js|["']\/api\/recordings["']/.test(src);
  const imports = [
    'import { blockCustomerOutsidePortal } from "./middleware/portal.js";',
    'import customerPortalRouter from "./routes/customerPortal.js";',
    'import clientsRouter from "./routes/clients.js";',
    ...(hasRec ? [] : ['import recordingsRouter from "./routes/recordings.js";']),
  ];
  const mounts = [
    "// Customer portal: a CUSTOMER login can never reach the admin APIs below (must stay before the other /api routers)",
    'app.use("/api", blockCustomerOutsidePortal);',
    'app.use("/api/customer", customerPortalRouter);',
    'app.use("/api/clients", clientsRouter);',
    ...(hasRec ? [] : ['app.use("/api/recordings", recordingsRouter);']),
    "",
  ];
  let text = src.slice(0, m.index) + mounts.join("\n") + src.slice(m.index);
  text = addImports(text, imports);
  return { text, note: "imports + blocker + /api/customer, /api/clients" + (hasRec ? "" : ", /api/recordings") };
});

// ---------- 2. existing staff-only routers: reject CUSTOMER at router level ----------
// public/webhook routers must stay reachable without a staff login; everything else gets the staff-only guard
const SKIP = /^(auth|telephony|public|health|contact-?requests?|customerPortal|clients|recordings)/i;
const routesDir = abs("server/routes");
if (fs.existsSync(routesDir)) {
  for (const f of fs.readdirSync(routesDir).filter((x) => x.endsWith(".js") && !SKIP.test(x))) {
    edit(`server/routes/${f}`, (src) => {
      if (src.includes("requireStaff")) return { done: true };
      if (!/^router\.use\(\s*requireAuth\s*\);/m.test(src)) return { manual: "no `router.use(requireAuth);` line: add `requireStaff` to its auth middleware yourself" };
      let text = src.replace(/^router\.use\(\s*requireAuth\s*\);/m, "router.use(requireAuth, requireStaff); // CUSTOMER logins can never use this router");
      const imp = /^import[^\n]*requireAuth[^\n]*$/m.exec(text);
      text = imp
        ? text.slice(0, imp.index + imp[0].length) + '\nimport { requireStaff } from "../middleware/portal.js";' + text.slice(imp.index + imp[0].length)
        : addImports(text, ['import { requireStaff } from "../middleware/portal.js";']);
      return { text, note: "router.use(requireAuth, requireStaff)" };
    });
  }
}

// ---------- 3. frontend: gate, admin routes, sidebar ----------
const GATE_IMPORT = 'import CustomerGate from "./portal/CustomerGate.jsx";';
let gated = false;
edit("src/main.jsx", (src) => {
  if (src.includes("CustomerGate")) { gated = true; return { done: true }; }
  if (!/<BrowserRouter/.test(src) || !/<App\s*\/>/.test(src)) return null; // router lives in App.jsx: handled below
  gated = true;
  return { text: addImports(src.replace(/<App\s*\/>/, "<CustomerGate><App /></CustomerGate>"), [GATE_IMPORT]), note: "wrapped <App /> in <CustomerGate>" };
});
edit("src/App.jsx", (src) => {
  let text = src, notes = [];
  if (!gated && !src.includes("CustomerGate")) {
    if (!/<Routes>[\s\S]*<\/Routes>/.test(src)) return { manual: "wrap your <Routes> (inside <BrowserRouter>) with <CustomerGate>…</CustomerGate> and import it from ./portal/CustomerGate.jsx" };
    text = text.replace(/<Routes>[\s\S]*<\/Routes>/, (b) => `<CustomerGate>\n${b}\n</CustomerGate>`);
    text = addImports(text, [GATE_IMPORT]); notes.push("wrapped <Routes> in <CustomerGate>");
  }
  if (!/\/customer-accounts/.test(text)) {
    const line = /^[ \t]*<Route\s+path=["']\/customers["'][^\n]*\/>[ \t]*$/m.exec(text);
    if (!line) return { manual: 'add <Route path="/customer-accounts" element={<AdminCustomers />} /> and <Route path="/recordings" element={<Recordings />} /> (imports from ./pages/AdminCustomers.jsx, ./pages/Recordings.jsx)' + (notes.length ? "" : "") };
    const mk = (p, name) => line[0].replace(/(["'])\/customers\1/, `$1${p}$1`).replace(/\bCustomers\b/g, name);
    const extra = [mk("/customer-accounts", "AdminCustomers"), ...(/path=["']\/recordings["']/.test(text) ? [] : [mk("/recordings", "Recordings")])];
    text = text.slice(0, line.index + line[0].length) + "\n" + extra.join("\n") + text.slice(line.index + line[0].length);
    text = addImports(text, ['import AdminCustomers from "./pages/AdminCustomers.jsx";', ...(/import Recordings\b/.test(text) ? [] : ['import Recordings from "./pages/Recordings.jsx";'])]);
    notes.push("routes /customer-accounts, /recordings");
  }
  return text === src ? { done: true } : { text, note: notes.join("; ") };
});
const sidebarFile = ["src/components/Sidebar.jsx", "src/layouts/Sidebar.jsx", "src/components/layout/Sidebar.jsx"].find(exists);
const SIDEBAR_MANUAL = 'add two menu items to your sidebar: path "/customer-accounts" labelled "Customer Accounts" and path "/recordings" labelled "Recordings"';
if (!sidebarFile) report.push(["src/components/Sidebar.jsx", "not found", SIDEBAR_MANUAL]);
else edit(sidebarFile, (src) => {
  if (src.includes("/customer-accounts")) return { done: true };
  const line = /^[ \t]*[^\n]*["']\/customers["'][^\n]*$/m.exec(src);
  if (!line || /\.map\(/.test(line[0])) return { manual: SIDEBAR_MANUAL };
  const emoji = /\p{Extended_Pictographic}\uFE0F?/u;
  const mk = (p, label, icon) => line[0].replace(/(["'])\/customers\1/, `$1${p}$1`).replace(/\bCustomers\b/, label).replace(emoji, icon);
  let text = src, add = [mk("/customer-accounts", "Customer Accounts", "🏢")];
  if (!/["']\/recordings["']/.test(src)) add.push(mk("/recordings", "Recordings", "🎙️"));
  const at = line.index + line[0].length;
  text = text.slice(0, at) + "\n" + add.join("\n") + text.slice(at);
  return { text, note: "menu items Customer Accounts, Recordings" };
});

// ---------- 4. Live Calls WebSocket must authenticate (token travels in the protocol header, not the URL) ----------
function* srcFiles(dir) {
  if (!fs.existsSync(abs(dir))) return;
  for (const e of fs.readdirSync(abs(dir), { withFileTypes: true })) {
    if (e.name === "node_modules") continue;
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) yield* srcFiles(rel); else if (/\.(jsx?|tsx?)$/.test(e.name)) yield rel;
  }
}
let wsFound = false;
for (const rel of srcFiles("src")) {
  const text = fs.existsSync(abs(rel)) ? fs.readFileSync(abs(rel), "utf8") : "";
  if (!/new WebSocket\(/.test(text)) continue;
  wsFound = true;
  edit(rel, (src) => {
    if (src.includes("openLiveCallsSocket")) return { done: true };
    const m = /new WebSocket\(((?:[^()]|\([^()]*\))*)\)/.exec(src);
    if (!m || !/live-calls/.test(m[1])) return { manual: "replace the Live Calls `new WebSocket(...)` with `openLiveCallsSocket()` (import it from services/http.js): the server now requires a token" };
    const depth = rel.split("/").length - 2;                      // src/pages/X.jsx -> ../services/http.js
    const importPath = `${depth <= 0 ? "." : Array(depth).fill("..").join("/")}/services/http.js`;
    return { text: addImports(src.replace(m[0], "openLiveCallsSocket()"), [`import { openLiveCallsSocket } from "${importPath}";`]), note: "Live Calls socket now sends the token (server refuses anonymous sockets)" };
  });
}
if (!wsFound) report.push(["src (Live Calls page)", "no WebSocket found", "if your Live Calls page opens /ws/live-calls, use openLiveCallsSocket() from services/http.js"]);

// ---------- report ----------
console.log(apply ? "\nWIRING RESULT (changes applied; originals saved as *.bak)\n" : "\nWIRING PREVIEW (nothing changed; add --apply to change files)\n");
for (const [file, status, note] of report) console.log(`${status.padEnd(20)} ${file}${note ? `\n${" ".repeat(21)}${note.split("\n").join("\n" + " ".repeat(21))}` : ""}`);
const manual = report.filter((r) => r[1] === "MANUAL STEP NEEDED" || r[1] === "not found");
console.log(manual.length ? `\n${manual.length} item(s) need a manual edit (see above).` : apply ? "\nAll wiring steps are in place. Now run: npm run build" : "\nNothing was changed. Run again with --apply to make these changes.");
