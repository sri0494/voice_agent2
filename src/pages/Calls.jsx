import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import * as api from "../services/api.js";
import StatusBadge from "../components/StatusBadge.jsx";
import { LoadingState, ErrorState, EmptyState } from "../components/DataState.jsx";

const STATUSES = ["", "Ringing", "Connected", "Live", "Transferred", "Completed", "Failed", "Missed"];

export default function Calls() {
  const [calls, setCalls] = useState([]);
  const [status, setStatus] = useState("");
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

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", flexWrap: "wrap", gap: 12, marginBottom: 16 }}>
        <div>
          <div className="section-title">Calls</div>
          <div className="section-sub">All calls across campaigns and agents</div>
        </div>
        <select className="input" style={{ width: 200 }} value={status} onChange={(e) => setStatus(e.target.value)}>
          {STATUSES.map((s) => <option key={s} value={s}>{s || "All Statuses"}</option>)}
        </select>
      </div>

      {state === "loading" && <LoadingState label="Loading calls..." />}
      {state === "error" && <ErrorState onRetry={load} />}
      {state === "ready" && calls.length === 0 && <EmptyState message="No calls found." />}

      {state === "ready" && calls.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Customer</th><th>Campaign</th><th>Agent</th><th>Language</th><th>Duration</th><th>Status</th><th>Sentiment</th></tr>
            </thead>
            <tbody>
              {calls.map((c) => (
                <tr key={c.id}>
                  <td><Link to={`/calls/${c.id}`} style={{ color: "var(--cyan)", fontWeight: 600 }}>{c.customer_name || c.phone}</Link></td>
                  <td>{c.campaign_name || "—"}</td>
                  <td>{c.agent_name || "—"}</td>
                  <td>{c.language || "—"}</td>
                  <td>{c.duration_sec ? `${Math.floor(c.duration_sec / 60)}m ${c.duration_sec % 60}s` : "—"}</td>
                  <td><StatusBadge status={c.status} /></td>
                  <td>{c.sentiment ? <StatusBadge status={c.sentiment} /> : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
