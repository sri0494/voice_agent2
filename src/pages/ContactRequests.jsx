import { useEffect, useState } from "react";
import * as api from "../services/api.js";
import StatusBadge from "../components/StatusBadge.jsx";
import { LoadingState, ErrorState, EmptyState } from "../components/DataState.jsx";

const STATUSES = ["New", "In Progress", "Resolved", "Closed"];

export default function ContactRequests() {
  const [requests, setRequests] = useState([]);
  const [state, setState] = useState("loading");
  const [filter, setFilter] = useState("");

  const load = async () => {
    setState("loading");
    try {
      setRequests(await api.getContactRequests(filter || undefined));
      setState("ready");
    } catch {
      setState("error");
    }
  };

  useEffect(() => { load(); }, [filter]);

  const handleStatusChange = async (id, status) => {
    await api.updateContactRequest(id, status);
    load();
  };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", flexWrap: "wrap", gap: 12, marginBottom: 16 }}>
        <div>
          <div className="section-title">Contact Requests</div>
          <div className="section-sub">Submissions from the "Get in Touch" form</div>
        </div>
        <select className="input" style={{ width: 180 }} value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="">All Statuses</option>
          {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>

      {state === "loading" && <LoadingState label="Loading requests..." />}
      {state === "error" && <ErrorState onRetry={load} />}
      {state === "ready" && requests.length === 0 && <EmptyState message="No contact requests yet." />}

      {state === "ready" && requests.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Name</th><th>Email</th><th>Phone</th><th>Subject</th><th>Message</th><th>Status</th><th>Received</th></tr></thead>
            <tbody>
              {requests.map((r) => (
                <tr key={r.id}>
                  <td>{r.name}</td>
                  <td>{r.email}</td>
                  <td>{r.phone || "—"}</td>
                  <td>{r.subject || "—"}</td>
                  <td style={{ maxWidth: 260, whiteSpace: "normal" }}>{r.message}</td>
                  <td>
                    <select className="input" style={{ padding: "4px 8px", fontSize: 12 }} value={r.status} onChange={(e) => handleStatusChange(r.id, e.target.value)}>
                      {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </td>
                  <td>{new Date(r.created_at).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
