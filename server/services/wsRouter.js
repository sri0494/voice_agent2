// One 'upgrade' listener per HTTP server, dispatching by pathname. Two WebSocketServers must never both listen on the same
// server directly (each would destroy the other's connections), so every socket endpoint registers here instead.
const routes = new WeakMap();

export function registerUpgrade(server, path, handler) {
  let map = routes.get(server);
  if (!map) {
    map = new Map();
    routes.set(server, map);
    server.on("upgrade", (req, socket, head) => {
      let pathname;
      try { pathname = new URL(req.url, "http://localhost").pathname; } catch { return socket.destroy(); }
      const h = map.get(pathname);
      if (!h) return socket.destroy();               // unknown socket path
      Promise.resolve(h(req, socket, head)).catch(() => socket.destroy());
    });
  }
  map.set(path, handler);
}

export function refuseUpgrade(socket, status, message) {
  const text = { 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 503: "Service Unavailable" }[status] || "Error";
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Type: application/json\r\n\r\n${JSON.stringify({ success: false, message })}`);
  socket.destroy();
}
