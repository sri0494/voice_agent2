import { useEffect, useState } from "react";
import * as api from "../services/api.js";
import StatusBadge from "../components/StatusBadge.jsx";
import { LoadingState, ErrorState, EmptyState } from "../components/DataState.jsx";

export default function PhoneNumbers() {
  const [numbers, setNumbers] = useState([]);
  const [agents, setAgents] = useState([]);
  const [state, setState] = useState("loading");
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ number: "", provider: "", agentId: "" });
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setState("loading");
    try {
      const [n, a] = await Promise.all([api.getPhoneNumbers(), api.getAgents()]);
      setNumbers(n);
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
      await api.createPhoneNumber(form);
      setForm({ number: "", provider: "", agentId: "" });
      setShowForm(false);
      load();
    } catch (err) {
      alert(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleAssign = async (id, agentId) => {
    await api.updatePhoneNumber(id, { agentId: agentId || null });
    load();
  };

  if (state === "loading") return <LoadingState label="Loading phone numbers..." />;
  if (state === "error") return <ErrorState onRetry={load} />;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12 }}>
        <div>
          <div className="section-title">Phone Numbers</div>
          <div className="section-sub">Assign numbers to AI agents for inbound and outbound calling</div>
        </div>
        <button className="btn btn-primary" onClick={() => setShowForm((v) => !v)}>+ Add Number</button>
      </div>

      {showForm && (
        <form className="card" onSubmit={handleCreate} style={{ marginBottom: 16, maxWidth: 460 }}>
          <div className="form-group"><label>Phone Number</label><input className="input" required placeholder="+91XXXXXXXXXX" value={form.number} onChange={(e) => setForm({ ...form, number: e.target.value })} /></div>
          <div className="form-group"><label>Provider (informational)</label><input className="input" placeholder="e.g. Exotel" value={form.provider} onChange={(e) => setForm({ ...form, provider: e.target.value })} /></div>
          <div className="form-group">
            <label>Assign AI Agent</label>
            <select className="input" value={form.agentId} onChange={(e) => setForm({ ...form, agentId: e.target.value })}>
              <option value="">None</option>
              {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </div>
          <button className="btn btn-primary" disabled={saving}>{saving ? "Adding..." : "Add Number"}</button>
        </form>
      )}

      <div className="card" style={{ marginBottom: 20, background: "var(--bg-elevated)" }}>
        <div style={{ fontSize: 12.5, color: "var(--text-secondary)" }}>
          ⚠️ Adding a number here registers it in LeoMox's routing table, but actual call
          delivery still depends on your <strong>TELEPHONY_PROVIDER</strong> being configured
          with a real vendor. In mock mode, numbers are for planning/testing the agent
          assignment flow only.
        </div>
      </div>

      {numbers.length === 0 ? (
        <EmptyState message="No phone numbers added yet." />
      ) : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Number</th><th>Provider</th><th>Assigned Agent</th><th>Inbound</th><th>Outbound</th><th>Status</th></tr></thead>
            <tbody>
              {numbers.map((n) => (
                <tr key={n.id}>
                  <td style={{ fontWeight: 600 }}>{n.number}</td>
                  <td>{n.provider || "—"}</td>
                  <td>
                    <select className="input" style={{ padding: "4px 8px", fontSize: 12 }} value={n.agent_id || ""} onChange={(e) => handleAssign(n.id, e.target.value)}>
                      <option value="">Unassigned</option>
                      {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                    </select>
                  </td>
                  <td>{n.inbound_enabled ? "✅" : "—"}</td>
                  <td>{n.outbound_enabled ? "✅" : "—"}</td>
                  <td><StatusBadge status={n.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
