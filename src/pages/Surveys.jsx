import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import * as api from "../services/api.js";
import StatusBadge from "../components/StatusBadge.jsx";
import { LoadingState, ErrorState, EmptyState } from "../components/DataState.jsx";

export default function Surveys() {
  const [surveys, setSurveys] = useState([]);
  const [agents, setAgents] = useState([]);
  const [state, setState] = useState("loading");
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: "", description: "", agentId: "" });
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setState("loading");
    try {
      const [s, a] = await Promise.all([api.getSurveys(), api.getAgents()]);
      setSurveys(s);
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
      await api.createSurvey(form);
      setForm({ name: "", description: "", agentId: "" });
      setShowForm(false);
      load();
    } catch (err) {
      alert(err.message);
    } finally {
      setSaving(false);
    }
  };

  if (state === "loading") return <LoadingState label="Loading surveys..." />;
  if (state === "error") return <ErrorState onRetry={load} />;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12 }}>
        <div>
          <div className="section-title">Surveys</div>
          <div className="section-sub">Build conversational surveys with conditional questions</div>
        </div>
        <button className="btn btn-primary" onClick={() => setShowForm((v) => !v)}>+ New Survey</button>
      </div>

      {showForm && (
        <form className="card" onSubmit={handleCreate} style={{ marginBottom: 16, maxWidth: 460 }}>
          <div className="form-group"><label>Survey Name</label><input className="input" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
          <div className="form-group"><label>Description</label><textarea className="input" rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></div>
          <div className="form-group">
            <label>Linked AI Agent</label>
            <select className="input" value={form.agentId} onChange={(e) => setForm({ ...form, agentId: e.target.value })}>
              <option value="">None yet</option>
              {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </div>
          <button className="btn btn-primary" disabled={saving}>{saving ? "Creating..." : "Create Survey"}</button>
        </form>
      )}

      {surveys.length === 0 ? (
        <EmptyState message="No surveys yet." />
      ) : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Name</th><th>Agent</th><th>Questions</th><th>Responses</th><th>Status</th></tr></thead>
            <tbody>
              {surveys.map((s) => (
                <tr key={s.id}>
                  <td><Link to={`/surveys/${s.id}`} style={{ color: "var(--cyan)", fontWeight: 600 }}>{s.name}</Link></td>
                  <td>{s.agent_name || "—"}</td>
                  <td>{s.question_count}</td>
                  <td>{s.response_count}</td>
                  <td><StatusBadge status={s.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
