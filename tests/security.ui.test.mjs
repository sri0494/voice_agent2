// Customer-portal UI against the REAL backend + database: role routing, permission-driven sidebar, authenticated recording
// playback (blob), live-calls WebSocket with the token protocol, token refresh. Runs the real React code in jsdom.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { JSDOM } from "jsdom";
import * as esbuild from "esbuild";
import { boot, makeRunner, root } from "./harness.mjs";
import { seed, ALL_PERMS } from "./fixtures.mjs";

const ctx = await boot(); const t = makeRunner(ctx); const { check, call } = t;
const S = await seed(ctx, t); const ADMIN = S.admin;
const { publishCallUpdate } = await import("../server/services/liveCalls.js");

// ---- bundle the real frontend (stand-ins only for components that live in YOUR repo: StatusBadge, DataState) ----
const tmp = path.join(root, "tests", ".tmp"); fs.mkdirSync(tmp, { recursive: true });
fs.writeFileSync(path.join(tmp, "entry.jsx"), `import { createRoot } from "react-dom/client"; import { act } from "react"; import { MemoryRouter } from "react-router-dom";
import CustomerGate from "../../src/portal/CustomerGate.jsx";
export * from "../../src/services/http.js";
export function mount(el, startAt = "/") { const r = createRoot(el); act(() => r.render(<MemoryRouter initialEntries={[startAt]}><CustomerGate><div id="admin-app">ADMIN APP (existing application)</div></CustomerGate></MemoryRouter>)); return r; }
export { act };`);
const stub = { name: "stub-repo-components", setup(b) {
  b.onResolve({ filter: /components\/(StatusBadge|DataState)\.jsx$/ }, (a) => (fs.existsSync(path.resolve(a.resolveDir, a.path)) ? null : { path: a.path, namespace: "stub" }));
  b.onLoad({ filter: /.*/, namespace: "stub" }, (a) => ({ loader: "jsx", resolveDir: path.join(root, "src"), contents: /StatusBadge/.test(a.path)
    ? "export default function StatusBadge({ status }) { return <span>{status}</span>; }"
    : "export const LoadingState = ({ label }) => <div>{label || 'Loading...'}</div>; export const ErrorState = ({ onRetry }) => <div>Something went wrong. <button onClick={onRetry}>Retry</button></div>; export const EmptyState = ({ message }) => <div>{message}</div>;" }));
} };
const out = path.join(tmp, "bundle.mjs");
await esbuild.build({ entryPoints: [path.join(tmp, "entry.jsx")], bundle: true, format: "esm", platform: "node", jsx: "automatic", loader: { ".jsx": "jsx" }, outfile: out, logLevel: "error",
  define: { "process.env.NODE_ENV": '"development"' }, plugins: [stub], nodePaths: [path.join(root, "node_modules")],
  banner: { js: "import {createRequire as __cr} from 'module'; const require = __cr(import.meta.url);" } });

// ---- simulated browser ----
const dom = new JSDOM(`<!doctype html><html><body><div id="root"></div></body></html>`, { url: `${ctx.base}/`, pretendToBeVisual: true });
for (const k of ["window", "document", "navigator", "localStorage", "sessionStorage", "HTMLElement", "Node", "MutationObserver", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "FormData", "HTMLMediaElement"]) {
  try { Object.defineProperty(globalThis, k, { value: dom.window[k], configurable: true, writable: true }); } catch {}
}
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.IS_REACT_ACT_ENVIRONMENT = true; dom.window.confirm = () => true; dom.window.alert = (m) => { globalThis.__alert = m; };
let blobs = 0; const revoked = []; URL.createObjectURL = () => `blob:test-${++blobs}`; URL.revokeObjectURL = (u) => revoked.push(u);
dom.window.HTMLMediaElement.prototype.play = () => Promise.resolve(); dom.window.HTMLMediaElement.prototype.pause = () => {};
const requested = []; const realFetch = globalThis.fetch;
globalThis.fetch = (url, opts) => { requested.push({ url: String(url), auth: opts?.headers?.Authorization || null }); return realFetch(String(url).startsWith("/") ? ctx.base + url : url, opts); };
const ui = await import(out); const { mount, act } = ui;

const text = () => document.body.textContent; const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (cond, ms = 5000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { await act(async () => { await sleep(120); }); if (cond()) return true; } return false; };
const nav = () => [...document.querySelectorAll("aside a")].map((a) => a.querySelector("span:last-child").textContent.trim());
let root_;
const start = async (token, at = "/") => {
  localStorage.clear(); requested.length = 0; blobs = 0; revoked.length = 0;
  if (root_) await act(async () => root_.unmount());
  document.body.innerHTML = '<div id="root"></div>';
  if (token) localStorage.setItem("leomox_session", JSON.stringify({ token, user: { x: 1 } }));   // unknown storage key on purpose
  root_ = mount(document.getElementById("root"), at);
};
const setPerms = (cl, perms) => call(ADMIN, "PUT", `/api/clients/${cl.client.id}/permissions`, { permissions: perms });
const click = async (el) => { await act(async () => { el.click(); }); };
const btn = (label) => [...document.querySelectorAll("button")].find((b) => b.textContent.trim().includes(label));

console.log("\n== Role routing ==");
await start(null); check("logged out: existing app (login page) renders", await waitFor(() => text().includes("ADMIN APP")));
await start(ADMIN); check("ADMIN -> existing admin application, no portal", await waitFor(() => text().includes("ADMIN APP")) && !document.querySelector("aside"));
await setPerms(S.CA, ["dashboard", "campaigns_view", "campaigns_create", "calls_view", "recordings_view", "recordings_download"]);
await start(S.CA.token, "/customers");
check("CUSTOMER on an ADMIN url -> customer portal, never the admin layout", await waitFor(() => !!document.querySelector("aside")) && !text().includes("ADMIN APP"));
check("sidebar = exactly the permitted modules (server-driven)", JSON.stringify(nav()) === JSON.stringify(["Dashboard", "Campaigns", "Recordings", "Call History"]), JSON.stringify(nav()));
check("redirected from the admin URL into the portal home with own data", await waitFor(() => text().includes("Welcome, Alpha Hospital Pvt") && text().includes("Alpha Patient Survey")) && !text().includes("Bravo"));
check("customer session made NO request outside /api/customer/*", requested.filter((r) => !r.url.includes("/api/customer/")).length === 0, JSON.stringify(requested.filter((r) => !r.url.includes("/api/customer/"))));
await start(S.CA.token, "/customer/analytics");
check("direct URL to a module the customer lacks (analytics) -> bounced home", await waitFor(() => text().includes("Welcome, Alpha Hospital Pvt")) && !text().includes("Calls per day"));
await start(S.CA.token); await sleep(300);
check("page refresh stays in the portal (never falls back to the admin layout)", await waitFor(() => !!document.querySelector("aside")) && !text().includes("ADMIN APP"));

console.log("\n== Authenticated recording playback ==");
await start(S.CA.token, "/customer/recordings");
check("recordings list shows only this customer's recording", await waitFor(() => !!btn("Play")) && document.querySelectorAll("tbody tr").length === 1 && !text().includes("B-SECRET"));
await click(btn("Play"));
check("Play: URL requested, then the STREAM fetched WITH the Authorization header (no public link)", await waitFor(() => requested.some((r) => r.url.endsWith("/stream"))) && requested.find((r) => r.url.endsWith("/stream")).auth === `Bearer ${S.CA.token}` && requested.some((r) => r.url.includes("/url")));
check("the player plays a blob: URL (the bytes never sit at a guessable address)", await waitFor(() => (document.querySelector("audio")?.getAttribute("src") || "").startsWith("blob:")));
check("customer with recordings_download sees a Download button", !!btn("Download"));
await click(btn("Close"));
check("closing the player releases the blob URL", revoked.length >= 1);
await setPerms(S.CA, ["dashboard", "campaigns_view", "calls_view", "recordings_view"]);
await start(S.CA.token, "/customer/recordings"); await waitFor(() => !!btn("Play")); await click(btn("Play")); await waitFor(() => document.querySelector("audio"));
check("view-only customer: NO Download button", !btn("Download"));
await setPerms(S.CA, ["dashboard", "campaigns_view", "calls_view"]);
await start(S.CA.token); await waitFor(() => !!document.querySelector("aside"));
check("recordings_view removed: Recordings disappears from the sidebar", !nav().includes("Recordings"));

console.log("\n== Live calls WebSocket from the browser code ==");
await setPerms(S.CA, ALL_PERMS);
await start(S.CA.token); await waitFor(() => !!document.querySelector("aside"));
const sock = ui.openLiveCallsSocket(); const msgs = []; sock.onmessage = (e) => msgs.push(JSON.parse(e.data));
check("socket opens with the leomox.v1 protocol (token not in the URL)", await waitFor(() => sock.readyState === 1) && sock.protocol === "leomox.v1" && !sock.url.includes("token"));
await publishCallUpdate(S.callA1); await publishCallUpdate(S.callB1); await sleep(400);
check("browser socket receives its OWN customer's call and never the other customer's", msgs.some((m) => m.type === "call_update" && m.call.id === S.callA1) && !msgs.some((m) => m.call?.id === S.callB1));
sock.close();
localStorage.clear(); const noTok = ui.openLiveCallsSocket(); let refused = false; noTok.onerror = () => { refused = true; };
check("without a token the handshake is refused by the server (never opens)", await waitFor(() => refused, 3000) && noTok.readyState !== 1);

console.log("\n== Token refresh after a password change ==");
localStorage.setItem("any_key", JSON.stringify({ token: "OLD.TOKEN.VALUE", user: 1 })); localStorage.setItem("plain", "OLD.TOKEN.VALUE"); localStorage.setItem("theme", "dark");
ui.replaceToken("OLD.TOKEN.VALUE", "NEW.TOKEN.VALUE");
check("replaceToken swaps the token wherever it is stored (plain or JSON) and leaves other settings alone", localStorage.getItem("plain") === "NEW.TOKEN.VALUE" && JSON.parse(localStorage.getItem("any_key")).token === "NEW.TOKEN.VALUE" && localStorage.getItem("theme") === "dark");
ui.clearAuth(); check("clearAuth removes the login but keeps unrelated settings (theme)", localStorage.getItem("plain") === null && localStorage.getItem("theme") === "dark");

console.log("\n== Inactive accounts ==");
await call(ADMIN, "PUT", `/api/clients/${S.CA.client.id}`, { status: "Inactive" });
await start(S.CA.token);
check("deactivated customer sees a clear message and never the admin app", await waitFor(() => /inactive/i.test(text())) && !text().includes("ADMIN APP"), text().slice(0, 160));
await call(ADMIN, "PUT", `/api/clients/${S.CA.client.id}`, { status: "Active" });

for (const c of []) c;
fs.rmSync(tmp, { recursive: true, force: true });
await ctx.stop();
const s = t.summary(); console.log(`\n${s.pass} passed, ${s.fail} failed`); if (s.fail) console.log(s.failures); process.exit(s.fail ? 1 : 0);
