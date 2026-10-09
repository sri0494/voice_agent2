// Live Calls WebSocket hub. Authenticated at upgrade time, tenant-scoped on every message.
//  - Token: Sec-WebSocket-Protocol "leomox.v1, <jwt>" (preferred; keeps the token out of URLs) or ?token= (WS_ALLOW_QUERY_TOKEN=false disables).
//  - Staff roles receive all call updates. CUSTOMER users need calls_view and only receive calls of THEIR client's campaigns.
//  - Sessions are re-validated every 30 s: expired JWT, disabled user, deactivated customer or changed password closes the socket.
import { WebSocketServer } from "ws";
import { authenticateToken } from "../middleware/auth.js";
import { ApiError } from "../middleware/errorHandler.js";
import { query } from "../db/pool.js";
import { logger } from "../utils/logger.js";

const PROTOCOL = "leomox.v1";
const MAX_SOCKETS_PER_USER = 10;
const clients = new Set(); // { ws, token, user, perms }
let wss = null;
let timer = null;

const maskPhone = (p) => { const s = String(p ?? ""); return s.length > 5 ? `${s.slice(0, 2)}${"*".repeat(s.length - 5)}${s.slice(-3)}` : s; };

function tokenFrom(req, url) {
  const proto = String(req.headers["sec-websocket-protocol"] || "").split(",").map((s) => s.trim()).filter(Boolean);
  const fromProto = proto.find((p) => p !== PROTOCOL);
  if (fromProto) return fromProto;
  if (process.env.WS_ALLOW_QUERY_TOKEN !== "false") return url.searchParams.get("token");
  return null;
}

async function loadPerms(clientId) {
  const { rows } = await query(`SELECT permission FROM client_permissions WHERE client_id = $1`, [clientId]);
  return new Set(rows.map((r) => r.permission));
}

function refuse(socket, status, message) {
  socket.write(`HTTP/1.1 ${status} ${status === 401 ? "Unauthorized" : "Forbidden"}\r\nConnection: close\r\nContent-Type: application/json\r\n\r\n${JSON.stringify({ success: false, message })}`);
  socket.destroy();
}

export function attachLiveCallsServer(server, { path = "/ws/live-calls" } = {}) {
  wss = new WebSocketServer({ noServer: true, handleProtocols: (protocols) => (protocols.has(PROTOCOL) ? PROTOCOL : false) });
  server.on("upgrade", async (req, socket, head) => {
    let url;
    try { url = new URL(req.url, "http://localhost"); } catch { return socket.destroy(); }
    if (url.pathname !== path) return socket.destroy();
    try {
      const token = tokenFrom(req, url);
      const user = await authenticateToken(token);
      let perms = null;
      if (user.role === "CUSTOMER") {
        perms = await loadPerms(user.client_id);
        if (!perms.has("calls_view")) throw new ApiError(403, "You do not have permission to view live calls");
      }
      wss.handleUpgrade(req, socket, head, (ws) => register(ws, token, user, perms));
    } catch (err) {
      refuse(socket, err.statusCode === 403 ? 403 : 401, err.statusCode ? err.message : "Authentication required");
    }
  });
  timer = setInterval(revalidate, Number(process.env.WS_REVALIDATE_MS) || 30000);
  timer.unref?.();
  return wss;
}

function register(ws, token, user, perms) {
  const mine = [...clients].filter((c) => c.user.id === user.id);
  if (mine.length >= MAX_SOCKETS_PER_USER) mine[0].ws.close(4429, "too many connections");
  const entry = { ws, token, user, perms };
  clients.add(entry);
  ws.on("close", () => clients.delete(entry));
  ws.on("error", () => clients.delete(entry));
  ws.send(JSON.stringify({ type: "connected", role: user.role }));
}

async function revalidate() {
  for (const c of [...clients]) {
    if (c.user.exp * 1000 <= Date.now()) { c.ws.close(4401, "session expired"); clients.delete(c); continue; }
    try {
      const u = await authenticateToken(c.token);       // disabled user / inactive customer / password change -> throws
      c.user = u;
      if (u.role === "CUSTOMER") {
        c.perms = await loadPerms(u.client_id);
        if (!c.perms.has("calls_view")) { c.ws.close(4403, "permission removed"); clients.delete(c); }
      }
    } catch { c.ws.close(4401, "session no longer valid"); clients.delete(c); }
  }
}

/** Called whenever a call changes state. The recipient list is decided HERE, server-side, per message. */
export async function publishCallUpdate(callId) {
  if (!wss || !clients.size || !callId) return;
  try {
    const { rows } = await query(
      `SELECT c.id, c.status, c.direction, c.customer_name, c.phone, c.language, c.duration_sec, c.started_at, c.ended_at,
              c.updated_at, c.campaign_id, camp.name AS campaign_name, camp.client_id
       FROM calls c LEFT JOIN campaigns camp ON camp.id = c.campaign_id WHERE c.id = $1`, [callId]);
    const call = rows[0];
    if (!call) return;
    const { client_id, ...pub } = call;
    for (const c of clients) {
      if (c.ws.readyState !== c.ws.OPEN) continue;
      if (c.user.role === "CUSTOMER") {
        if (!client_id || client_id !== c.user.client_id || !c.perms?.has("calls_view")) continue;   // never another tenant's call
        c.ws.send(JSON.stringify({ type: "call_update", call: { ...pub, phone: maskPhone(pub.phone) } }));
      } else {
        c.ws.send(JSON.stringify({ type: "call_update", call: pub }));
      }
    }
  } catch (err) { logger.error("live_call_publish_failed", { error: err.message }); }
}

export const liveClientCount = () => clients.size;
export function closeLiveCallsServer() { if (timer) clearInterval(timer); for (const c of clients) c.ws.terminate(); clients.clear(); wss?.close(); wss = null; }
