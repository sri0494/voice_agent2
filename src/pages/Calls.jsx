import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import * as api from "../services/api.js";
import StatusBadge from "../components/StatusBadge.jsx";
import { LoadingState, ErrorState, EmptyState } from "../components/DataState.jsx";

const STATUSES = ["", "Ringing", "Connected", "Live", "Transferred", "Completed", "Failed", "Missed"];

export default function Calls() {
  const [calls, setCalls] = useState([]);
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");
  const [state, setState] = useState("loading");

  const load = async () => {
    setState("loading");
    try {
      const data = await api.getCalls(status ? { status } : {});
      setCalls(data);
      setState("ready");
    } catch {
      setState("error");
    }
  };

  useEffect(() => { load(); }, [status]);

  const shown = calls.filter((c) => {
    const t = q.trim().toLowerCase();
    return !t || [c.customer_name, c.phone, c.campaign_name, c.agent_name].some((v) => String(v || "").toLowerCase().includes(t));
  });

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", flexWrap: "wrap", gap: 12, marginBottom: 16 }}>
        <div>
          <div className="section-title">Calls</div>
          <div className="section-sub">All calls across campaigns and agents</div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input className="input" style={{ width: 220 }} placeholder="Search name, phone, campaign..." value={q} onChange={(e) => setQ(e.target.value)} />
          <select className="input" style={{ width: 180 }} value={status} onChange={(e) => setStatus(e.target.value)}>
            {STATUSES.map((s) => <option key={s} value={s}>{s || "All Statuses"}</option>)}
          </select>
        </div>
      </div>

      {state === "loading" && <LoadingState label="Loading calls..." />}
      {state === "error" && <ErrorState onRetry={load} />}
      {state === "ready" && shown.length === 0 && <EmptyState message="No calls found." />}

      {state === "ready" && shown.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Customer</th><th>Campaign</th><th>Agent</th><th>Language</th><th>Duration</th><th>Status</th><th>Sentiment</th><th>Rec.</th><th>Started</th></tr>
            </thead>
            <tbody>
              {shown.map((c) => (
                <tr key={c.id}>
                  <td><Link to={`/calls/${c.id}`} style={{ color: "var(--cyan)", fontWeight: 600 }}>{c.customer_name || c.phone}</Link></td>
                  <td>{c.campaign_name || "—"}</td>
                  <td>{c.agent_name || "—"}</td>
                  <td>{c.language || "—"}</td>
                  <td>{c.duration_sec ? `${Math.floor(c.duration_sec / 60)}m ${c.duration_sec % 60}s` : "—"}</td>
                  <td><StatusBadge status={c.status} /></td>
                  <td>{c.sentiment ? <StatusBadge status={c.sentiment} /> : "—"}</td>
                  <td title={c.recording_count > 0 ? `${c.recording_count} recording(s)` : "No recording"}>{c.recording_count > 0 ? <Link to={`/calls/${c.id}`} style={{ textDecoration: "none" }}>🎙️ {c.recording_count}</Link> : "—"}</td>
                  <td>{c.started_at || c.created_at ? new Date(c.started_at || c.created_at).toLocaleString() : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
