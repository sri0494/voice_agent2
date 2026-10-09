import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import * as api from "../services/api.js";
import StatusBadge from "../components/StatusBadge.jsx";
import { LoadingState, ErrorState, EmptyState } from "../components/DataState.jsx";

export default function LiveCalls() {
  const [calls, setCalls] = useState([]);
  const [state, setState] = useState("loading");
  const wsRef = useRef(null);

  const load = async () => {
    setState("loading");
    try {
      const data = await api.getLiveCalls();
      setCalls(data);
      setState("ready");
    } catch {
      setState("error");
    }
  };

  useEffect(() => {
    load();

    // Prefer WebSocket push updates over polling; fall back to a slow poll
    // if the socket can't connect (e.g. behind certain proxies).
    try {
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${proto}//${window.location.host}/ws/live-calls`);
      wsRef.current = ws;
      ws.onmessage = () => load();
      ws.onerror = () => {};
    } catch {
      /* ignore, poll fallback below covers it */
    }

    const poll = setInterval(load, 15000);
    return () => {
      clearInterval(poll);
      wsRef.current?.close();
    };
  }, []);

  const handleEnd = async (id) => {
    await api.endCall(id);
    load();
  };
  const handleTransfer = async (id) => {
    const toNumber = prompt("Transfer to number:");
    if (!toNumber) return;
    await api.transferCall(id, toNumber);
    load();
  };

  if (state === "loading") return <LoadingState label="Loading live calls..." />;
  if (state === "error") return <ErrorState onRetry={load} />;

  return (
    <div>
      <div className="section-title">Live Calls</div>
      <div className="section-sub">Calls currently in progress — updates automatically</div>

      {calls.length === 0 ? (
        <EmptyState message="No live calls right now." />
      ) : (
        <div className="grid grid-cols-2">
          {calls.map((c) => (
            <div key={c.id} className="card live-card">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <Link to={`/calls/${c.id}`} style={{ fontWeight: 700, color: "var(--cyan)" }}>{c.customer_name || c.phone}</Link>
                <StatusBadge status={c.status} />
              </div>
              <div style={{ fontSize: 12.5, color: "var(--text-secondary)", marginBottom: 10 }}>
                {c.campaign_name || "Inbound"} · {c.agent_name || "—"} · {c.language}
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button className="btn btn-sm" onClick={() => handleTransfer(c.id)}>↪ Transfer</button>
                <button className="btn btn-sm btn-danger" onClick={() => handleEnd(c.id)}>⏹ End Call</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
