import { useEffect, useState } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import * as api from "../services/api.js";
import { updateCustomer } from "../services/http.js";
import StatusBadge from "../components/StatusBadge.jsx";
import { LoadingState, ErrorState } from "../components/DataState.jsx";
import CustomerForm, { customerToForm } from "../components/CustomerForm.jsx";
import VoiceRecorder from "../components/VoiceRecorder.jsx";
import RecordingList from "../components/RecordingList.jsx";

export default function CustomerDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [customer, setCustomer] = useState(null);
  const [agents, setAgents] = useState([]);
  const [state, setState] = useState("loading");
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setState("loading");
    try {
      const [c, a] = await Promise.all([api.getCustomer(id), api.getAgents()]);
      setCustomer(c);
      setAgents(a);
      setState("ready");
    } catch {
      setState("error");
    }
  };

  useEffect(() => { load(); }, [id]);

  const handleDelete = async () => {
    const name = `${customer.first_name} ${customer.last_name || ""}`.trim();
    if (!confirm(`Delete customer "${name}"? This cannot be undone.`)) return;
    try {
      await api.deleteCustomer(id);
      navigate("/customers");
    } catch (err) {
      alert(err.message);
    }
  };

  const handleSave = async (payload) => {
    setSaving(true);
    try {
      await updateCustomer(id, payload);
      setEditing(false);
      await load();
    } catch (err) {
      alert(err.message);
    } finally {
      setSaving(false);
    }
  };

  if (state === "loading") return <LoadingState label="Loading customer..." />;
  if (state === "error") return <ErrorState onRetry={load} />;

  return (
    <div>
      <Link to="/customers" style={{ color: "var(--text-secondary)", fontSize: 13 }}>← Back to Customers</Link>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 8 }}>
        <div className="section-title" style={{ marginBottom: 0 }}>{customer.first_name} {customer.last_name || ""}</div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <StatusBadge status={customer.status} />
          <button className="btn btn-sm" onClick={() => setEditing((v) => !v)}>{editing ? "Close Edit" : "Edit Customer"}</button>
          <button className="btn btn-sm btn-danger" onClick={handleDelete}>Delete Customer</button>
        </div>
      </div>
      <div className="section-sub">{customer.mobile} · {customer.email || "no email"} · {customer.city || "—"}</div>

      {editing && (
        <div style={{ marginTop: 16 }}>
          <CustomerForm
            initial={customerToForm(customer, agents)}
            agents={agents}
            isEditing
            saving={saving}
            onSubmit={handleSave}
            onCancel={() => setEditing(false)}
          />
        </div>
      )}

      <div className="grid grid-cols-2" style={{ alignItems: "flex-start" }}>
        <div className="card">
          <div style={{ fontWeight: 700, marginBottom: 12 }}>Customer Information</div>
          <Row label="Mobile" value={customer.mobile} />
          <Row label="Alternate Mobile" value={customer.alternate_mobile || "—"} />
          <Row label="Email" value={customer.email || "—"} />
          <Row label="Customer ID" value={customer.customer_code || "—"} />
          <Row label="Company" value={customer.company_name || "—"} />
          <Row label="Category" value={customer.customer_category || "—"} />
          <Row label="Preferred Language" value={customer.preferred_language || "—"} />
          <Row label="Assigned Agent" value={customer.assigned_agent_name || "—"} />
          <Row label="Tags" value={customer.tags?.length ? customer.tags.join(", ") : "—"} />
          {customer.notes && (
            <div style={{ marginTop: 10, fontSize: 13, color: "var(--text-secondary)" }}>
              <div style={{ fontWeight: 600, marginBottom: 4, color: "var(--text-primary)" }}>Notes</div>
              {customer.notes}
            </div>
          )}
        </div>

        <div className="card">
          <div style={{ fontWeight: 700, marginBottom: 12 }}>Call History</div>
          {!customer.calls?.length ? (
            <div style={{ fontSize: 13, color: "var(--text-secondary)" }}>No calls yet with this customer.</div>
          ) : (
            customer.calls.map((call) => (
              <div key={call.id} style={{ padding: "10px 0", borderBottom: "1px solid var(--border)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>{call.intent || "General"}</span>
                  <StatusBadge status={call.status} />
                </div>
                <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                  {call.started_at ? new Date(call.started_at).toLocaleDateString() : "—"} · {call.outcome || "No outcome recorded"}
                </div>
                {call.ai_summary && <div style={{ fontSize: 12.5, marginTop: 4 }}>{call.ai_summary}</div>}
                <CallRecordings callId={call.id} />
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "7px 0", borderBottom: "1px solid var(--border)", fontSize: 13.5 }}>
      <span style={{ color: "var(--text-secondary)" }}>{label}</span>
      <span style={{ fontWeight: 600, textAlign: "right" }}>{value}</span>
    </div>
  );
}

// Expandable per-call panel: record a voice note / call audio and play back saved recordings.
function CallRecordings({ callId }) {
  const [open, setOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  return (
    <div style={{ marginTop: 6 }}>
      <button type="button" className="btn btn-sm" onClick={() => setOpen((v) => !v)}>
        {open ? "Hide recordings" : "Recordings"}
      </button>
      {open && (
        <div style={{ marginTop: 6 }}>
          <VoiceRecorder callId={callId} onSaved={() => setRefreshKey((k) => k + 1)} />
          <RecordingList callId={callId} refreshKey={refreshKey} />
        </div>
      )}
    </div>
  );
}
