import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import * as api from "../services/api.js";
import StatusBadge from "../components/StatusBadge.jsx";
import { LoadingState, ErrorState, EmptyState } from "../components/DataState.jsx";

const TYPES = ["Survey", "Outbound Sales", "Payment Reminder", "Appointment Reminder", "Grievance", "Customer Support", "Custom"];

export default function Campaigns() {
  const [campaigns, setCampaigns] = useState([]);
  const [agents, setAgents] = useState([]);
  const [state, setState] = useState("loading");
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: "", type: "Survey", language: "English", agentId: "" });
  const [saving, setSaving] = useState(false);
  const [actionLoading, setActionLoading] = useState(null);

  const load = async () => {
    setState("loading");
    try {
      const [c, a] = await Promise.all([api.getCampaigns(), api.getAgents()]);
      setCampaigns(c);
      setAgents(a);
      setState("ready");
    } catch {
      setState("error");
    }
  };

  useEffect(() => { load(); }, []);

  const handleCreate = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      await api.createCampaign(form);
      setShowForm(false);
      setForm({ name: "", type: "Survey", language: "English", agentId: "" });
      load();
    } catch (err) {
      alert(err.message);
    } finally {
      setSaving(false);
    }
  };

  const doAction = async (id, action) => {
    const fn = { start: api.startCampaign, pause: api.pauseCampaign, resume: api.resumeCampaign, stop: api.stopCampaign }[action];
    setActionLoading(id);
    try {
      await fn(id);
      await load();
    } catch (err) {
      alert(err.message);
    } finally {
      setActionLoading(null);
    }
  };

  if (state === "loading") return <LoadingState label="Loading campaigns..." />;
  if (state === "error") return <ErrorState onRetry={load} />;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12 }}>
        <div>
          <div className="section-title">Campaigns</div>
          <div className="section-sub">Outbound and survey campaigns across all AI agents</div>
        </div>
        <button className="btn btn-primary" onClick={() => setShowForm((v) => !v)}>+ New Campaign</button>
      </div>

      {showForm && (
        <form className="card" onSubmit={handleCreate} style={{ marginBottom: 20, maxWidth: 480 }}>
          <div className="form-group">
            <label>Campaign Name</label>
            <input className="input" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div className="form-group">
            <label>Type</label>
            <select className="input" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
              {TYPES.map((t) => <option key={t}>{t}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label>Language</label>
            <select className="input" value={form.language} onChange={(e) => setForm({ ...form, language: e.target.value })}>
              <option>English</option><option>Telugu</option><option>Hindi</option>
            </select>
          </div>
          <div className="form-group">
            <label>AI Agent</label>
            <select className="input" required value={form.agentId} onChange={(e) => setForm({ ...form, agentId: e.target.value })}>
              <option value="">Select agent</option>
              {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
            {agents.length === 0 && (
              <div style={{ fontSize: 11.5, color: "var(--amber)", marginTop: 4 }}>
                No agents exist yet — create one under AI Engine first.
              </div>
            )}
          </div>
          <button className="btn btn-primary" disabled={saving}>{saving ? "Creating..." : "Create Campaign"}</button>
        </form>
      )}

      {campaigns.length === 0 ? (
        <EmptyState message="No campaigns yet. Create your first campaign to get started." />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Name</th><th>Type</th><th>Agent</th><th>Status</th><th>Contacts</th><th>Calls</th><th>Actions</th></tr>
            </thead>
            <tbody>
              {campaigns.map((c) => (
                <tr key={c.id}>
                  <td><Link to={`/campaigns/${c.id}`} style={{ color: "var(--cyan)", fontWeight: 600 }}>{c.name}</Link></td>
                  <td>{c.type}</td>
                  <td>{c.agent_name || "—"}</td>
                  <td><StatusBadge status={c.status} /></td>
                  <td>{c.contact_count}</td>
                  <td>{c.call_count}</td>
                  <td>
                    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      <div style={{ display: "flex", gap: 6 }}>
                        {c.status !== "Running" && (
                          <button className="btn btn-sm" disabled={actionLoading === c.id} onClick={() => doAction(c.id, c.status === "Paused" ? "resume" : "start")}>
                            {actionLoading === c.id ? "..." : "▶ Start"}
                          </button>
                        )}
                        {c.status === "Running" && (
                          <button className="btn btn-sm" disabled={actionLoading === c.id} onClick={() => doAction(c.id, "pause")}>
                            {actionLoading === c.id ? "..." : "⏸ Pause"}
                          </button>
                        )}
                      </div>
                      {!c.agent_name && <div style={{ fontSize: 10.5, color: "var(--amber)" }}>No agent assigned</div>}
                      {c.agent_name && Number(c.contact_count) === 0 && <div style={{ fontSize: 10.5, color: "var(--amber)" }}>No contacts uploaded</div>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
