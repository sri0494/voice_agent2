import { useEffect, useRef, useState } from "react";
import { useParams, Link } from "react-router-dom";
import * as api from "../services/api.js";
import StatusBadge from "../components/StatusBadge.jsx";
import { LoadingState, ErrorState } from "../components/DataState.jsx";

export default function CampaignDetail() {
  const { id } = useParams();
  const [campaign, setCampaign] = useState(null);
  const [contacts, setContacts] = useState([]);
  const [state, setState] = useState("loading");
  const fileInput = useRef(null);
  const [uploading, setUploading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);

  const load = async () => {
    setState("loading");
    try {
      const [c, contactList] = await Promise.all([api.getCampaign(id), api.getContacts(id)]);
      setCampaign(c);
      setContacts(contactList);
      setState("ready");
    } catch {
      setState("error");
    }
  };

  useEffect(() => { load(); }, [id]);

  const handleUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const result = await api.uploadContactsCsv(file, id);
      alert(`Imported ${result.inserted} contacts (${result.skippedCount} skipped)`);
      load();
    } catch (err) {
      alert(err.message);
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  const handleCall = async (contactId) => {
    try {
      await api.placeCall(id, contactId);
      alert("Call initiated");
    } catch (err) {
      alert(err.message);
    }
  };

  const doAction = async (action) => {
    const fn = { start: api.startCampaign, pause: api.pauseCampaign, resume: api.resumeCampaign, stop: api.stopCampaign }[action];
    setActionLoading(true);
    try {
      await fn(id);
      await load();
    } catch (err) {
      alert(err.message);
    } finally {
      setActionLoading(false);
    }
  };

  if (state === "loading") return <LoadingState label="Loading campaign..." />;
  if (state === "error") return <ErrorState onRetry={load} />;

  return (
    <div>
      <Link to="/campaigns" style={{ color: "var(--text-secondary)", fontSize: 13 }}>← Back to Campaigns</Link>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 8, marginBottom: 4, flexWrap: "wrap", gap: 10 }}>
        <div className="section-title" style={{ marginBottom: 0 }}>{campaign.name}</div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <StatusBadge status={campaign.status} />
          {campaign.status !== "Running" && campaign.status !== "Completed" && campaign.status !== "Cancelled" && (
            <button className="btn btn-sm btn-primary" disabled={actionLoading} onClick={() => doAction(campaign.status === "Paused" ? "resume" : "start")}>
              {actionLoading ? "..." : "▶ Start"}
            </button>
          )}
          {campaign.status === "Running" && (
            <>
              <button className="btn btn-sm" disabled={actionLoading} onClick={() => doAction("pause")}>{actionLoading ? "..." : "⏸ Pause"}</button>
              <button className="btn btn-sm btn-danger" disabled={actionLoading} onClick={() => doAction("stop")}>⏹ Stop</button>
            </>
          )}
        </div>
      </div>
      <div className="section-sub">{campaign.type} · {campaign.language} · Agent: {campaign.agent_name || "—"}</div>
      {!campaign.agent_name && (
        <div className="card" style={{ marginBottom: 14, borderColor: "var(--amber)", background: "var(--bg-elevated)" }}>
          <span style={{ color: "var(--amber)", fontSize: 12.5 }}>⚠️ No AI Agent assigned — this campaign can't be started until you edit it and select one.</span>
        </div>
      )}
      {contacts.length === 0 && (
        <div className="card" style={{ marginBottom: 14, borderColor: "var(--amber)", background: "var(--bg-elevated)" }}>
          <span style={{ color: "var(--amber)", fontSize: 12.5 }}>⚠️ No contacts uploaded yet — upload a CSV below before starting.</span>
        </div>
      )}

      <div className="grid grid-cols-3" style={{ marginBottom: 20 }}>
        <div className="card"><div className="label" style={{ color: "var(--text-secondary)", fontSize: 12 }}>Retry Attempts</div><div style={{ fontSize: 22, fontWeight: 700 }}>{campaign.retry_attempts}</div></div>
        <div className="card"><div className="label" style={{ color: "var(--text-secondary)", fontSize: 12 }}>Contacts</div><div style={{ fontSize: 22, fontWeight: 700 }}>{contacts.length}</div></div>
        <div className="card"><div className="label" style={{ color: "var(--text-secondary)", fontSize: 12 }}>Calling Hours</div><div style={{ fontSize: 14, fontWeight: 600, marginTop: 4 }}>{campaign.calling_hours?.start} – {campaign.calling_hours?.end}</div></div>
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <div style={{ fontWeight: 600 }}>Contacts</div>
        <div>
          <input ref={fileInput} type="file" accept=".csv" onChange={handleUpload} style={{ display: "none" }} />
          <button className="btn btn-sm" onClick={() => fileInput.current?.click()} disabled={uploading}>
            {uploading ? "Uploading..." : "⬆ Upload CSV"}
          </button>
        </div>
      </div>

      {contacts.length === 0 ? (
        <div className="card">No contacts yet. Upload a CSV with columns: name, phone, email, language.</div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Name</th><th>Phone</th><th>Status</th><th>Attempts</th><th>Outcome</th><th></th></tr></thead>
            <tbody>
              {contacts.map((c) => (
                <tr key={c.id}>
                  <td>{c.name || "—"}</td>
                  <td>{c.phone}</td>
                  <td><StatusBadge status={c.status} /></td>
                  <td>{c.call_attempts}</td>
                  <td>{c.outcome || "—"}</td>
                  <td><button className="btn btn-sm" onClick={() => handleCall(c.id)}>📞 Call</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
