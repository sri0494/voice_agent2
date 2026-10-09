import { useEffect, useState } from "react";
import * as api from "../services/api.js";
import StatusBadge from "../components/StatusBadge.jsx";
import { LoadingState, ErrorState, EmptyState } from "../components/DataState.jsx";

const CATEGORIES = ["CRM", "Database", "E-commerce", "Communication", "Payment", "Calendar", "Helpdesk", "Custom API"];
const AUTH_TYPES = ["API_KEY", "BEARER_TOKEN", "OAUTH2", "BASIC_AUTH", "NONE"];

export default function Integrations() {
  const [infra, setInfra] = useState(null);
  const [businessIntegrations, setBusinessIntegrations] = useState([]);
  const [state, setState] = useState("loading");
  const [showForm, setShowForm] = useState(false);
  const [expandedId, setExpandedId] = useState(null);

  const load = async () => {
    setState("loading");
    try {
      const [inf, biz] = await Promise.all([api.getIntegrations(), api.getBusinessIntegrations()]);
      setInfra(inf);
      setBusinessIntegrations(biz);
      setState("ready");
    } catch {
      setState("error");
    }
  };

  useEffect(() => { load(); }, []);

  if (state === "loading") return <LoadingState label="Loading integrations..." />;
  if (state === "error") return <ErrorState onRetry={load} />;

  return (
    <div>
      <div className="section-title">Integrations</div>
      <div className="section-sub">Core infrastructure providers and business system connectors (CRM, ERP, APIs)</div>

      <div style={{ fontWeight: 600, margin: "18px 0 10px" }}>Core Providers</div>
      <div className="grid grid-cols-3" style={{ marginBottom: 24 }}>
        {infra.builtIn.map((p) => (
          <div className="card" key={p.envVar}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
              <div style={{ fontWeight: 700, fontSize: 13.5 }}>{p.name}</div>
              <StatusBadge status={p.status} />
            </div>
            <div style={{ fontSize: 11.5, color: "var(--text-secondary)", marginBottom: 4 }}>Value: {p.value}</div>
            <div style={{ fontSize: 11.5, color: p.status === "ERROR" ? "var(--red)" : "var(--text-muted)" }}>
              {p.detail}
            </div>
          </div>
        ))}
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "18px 0 10px" }}>
        <div style={{ fontWeight: 600 }}>Business Integrations</div>
        <button className="btn btn-primary btn-sm" onClick={() => setShowForm((v) => !v)}>+ Add Integration</button>
      </div>

      {showForm && <AddIntegrationForm onSaved={() => { setShowForm(false); load(); }} onCancel={() => setShowForm(false)} />}

      {businessIntegrations.length === 0 ? (
        <EmptyState message="No business integrations yet. Add one to connect a CRM, ERP, or custom API." />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {businessIntegrations.map((integration) => (
            <IntegrationCard
              key={integration.id}
              integration={integration}
              expanded={expandedId === integration.id}
              onToggle={() => setExpandedId(expandedId === integration.id ? null : integration.id)}
              onChanged={load}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function AddIntegrationForm({ onSaved, onCancel }) {
  const [form, setForm] = useState({ name: "", category: "Custom API", baseUrl: "", authType: "API_KEY", credentials: {} });
  const [saving, setSaving] = useState(false);

  const setCred = (key, value) => setForm({ ...form, credentials: { ...form.credentials, [key]: value } });

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      await api.createBusinessIntegration(form);
      onSaved();
    } catch (err) {
      alert(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="card" onSubmit={handleSubmit} style={{ marginBottom: 16, maxWidth: 520 }}>
      <div className="form-group"><label>Integration Name</label><input className="input" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
      <div className="grid grid-cols-2">
        <div className="form-group">
          <label>Category</label>
          <select className="input" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
            {CATEGORIES.map((c) => <option key={c}>{c}</option>)}
          </select>
        </div>
        <div className="form-group">
          <label>Auth Type</label>
          <select className="input" value={form.authType} onChange={(e) => setForm({ ...form, authType: e.target.value, credentials: {} })}>
            {AUTH_TYPES.map((a) => <option key={a}>{a}</option>)}
          </select>
        </div>
      </div>
      <div className="form-group"><label>Base URL</label><input className="input" placeholder="https://api.example.com" value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} /></div>

      {form.authType === "API_KEY" && (
        <div className="form-group"><label>API Key</label><input className="input" type="password" onChange={(e) => setCred("apiKey", e.target.value)} /></div>
      )}
      {form.authType === "BEARER_TOKEN" && (
        <div className="form-group"><label>Bearer Token</label><input className="input" type="password" onChange={(e) => setCred("token", e.target.value)} /></div>
      )}
      {form.authType === "BASIC_AUTH" && (
        <div className="grid grid-cols-2">
          <div className="form-group"><label>Username</label><input className="input" onChange={(e) => setCred("username", e.target.value)} /></div>
          <div className="form-group"><label>Password</label><input className="input" type="password" onChange={(e) => setCred("password", e.target.value)} /></div>
        </div>
      )}
      {form.authType === "OAUTH2" && (
        <div className="form-group"><label>Access Token</label><input className="input" type="password" onChange={(e) => setCred("accessToken", e.target.value)} /></div>
      )}

      <div style={{ fontSize: 11.5, color: "var(--text-muted)", marginBottom: 12 }}>
        🔒 Credentials are encrypted (AES-256-GCM) before being stored and are never displayed again in plaintext.
      </div>

      <div style={{ display: "flex", gap: 8 }}>
        <button className="btn btn-primary" disabled={saving}>{saving ? "Saving..." : "Save Integration"}</button>
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

function IntegrationCard({ integration, expanded, onToggle, onChanged }) {
  const [showFnForm, setShowFnForm] = useState(false);
  const [fnForm, setFnForm] = useState({ functionName: "", description: "", httpMethod: "GET", pathTemplate: "" });
  const [testingId, setTestingId] = useState(null);
  const [testResult, setTestResult] = useState(null);

  const handleAddFunction = async (e) => {
    e.preventDefault();
    try {
      await api.addIntegrationFunction(integration.id, fnForm);
      setFnForm({ functionName: "", description: "", httpMethod: "GET", pathTemplate: "" });
      setShowFnForm(false);
      onChanged();
    } catch (err) {
      alert(err.message);
    }
  };

  const handleDeleteFunction = async (fnId) => {
    if (!confirm("Remove this function?")) return;
    await api.deleteIntegrationFunction(fnId);
    onChanged();
  };

  const handleDeleteIntegration = async () => {
    if (!confirm(`Delete integration "${integration.name}"? This also removes its functions.`)) return;
    await api.deleteBusinessIntegration(integration.id);
    onChanged();
  };

  const handleTest = async (fnId) => {
    setTestingId(fnId);
    setTestResult(null);
    try {
      const paramsInput = prompt('Test parameters as JSON, e.g. {"mobile":"9876543210"}', "{}");
      const params = paramsInput ? JSON.parse(paramsInput) : {};
      const result = await api.testIntegrationFunction(fnId, params);
      setTestResult({ fnId, ...result });
    } catch (err) {
      setTestResult({ fnId, error: err.message });
    } finally {
      setTestingId(null);
    }
  };

  return (
    <div className="card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer" }} onClick={onToggle}>
        <div>
          <div style={{ fontWeight: 700 }}>{integration.name} <span style={{ fontSize: 11, color: "var(--text-muted)", fontWeight: 400 }}>· {integration.category}</span></div>
          <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>{integration.base_url || "No base URL set"}</div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <StatusBadge status={integration.status} />
          <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>{expanded ? "▲" : "▼"}</span>
        </div>
      </div>

      {expanded && (
        <div style={{ marginTop: 14, borderTop: "1px solid var(--border)", paddingTop: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
            <div style={{ fontWeight: 600, fontSize: 13 }}>Functions / Tools</div>
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn btn-sm" onClick={() => setShowFnForm((v) => !v)}>+ Add Function</button>
              <button className="btn btn-sm btn-danger" onClick={handleDeleteIntegration}>Delete Integration</button>
            </div>
          </div>

          {showFnForm && (
            <form onSubmit={handleAddFunction} className="card" style={{ background: "var(--bg-elevated)", marginBottom: 12 }}>
              <div className="form-group"><label>Function Name (e.g. get_customer)</label><input className="input" required value={fnForm.functionName} onChange={(e) => setFnForm({ ...fnForm, functionName: e.target.value })} /></div>
              <div className="form-group"><label>Description (shown to the AI)</label><input className="input" required value={fnForm.description} onChange={(e) => setFnForm({ ...fnForm, description: e.target.value })} /></div>
              <div className="grid grid-cols-2">
                <div className="form-group">
                  <label>HTTP Method</label>
                  <select className="input" value={fnForm.httpMethod} onChange={(e) => setFnForm({ ...fnForm, httpMethod: e.target.value })}>
                    <option>GET</option><option>POST</option><option>PUT</option><option>PATCH</option><option>DELETE</option>
                  </select>
                </div>
                <div className="form-group"><label>Path Template</label><input className="input" required placeholder="/customers/{mobile}" value={fnForm.pathTemplate} onChange={(e) => setFnForm({ ...fnForm, pathTemplate: e.target.value })} /></div>
              </div>
              <button className="btn btn-primary btn-sm">Add Function</button>
            </form>
          )}

          {integration.functions?.length === 0 ? (
            <div style={{ fontSize: 12.5, color: "var(--text-secondary)" }}>No functions defined yet.</div>
          ) : (
            integration.functions.map((fn) => (
              <div key={fn.id} style={{ padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div>
                    <span style={{ fontFamily: "monospace", fontSize: 12.5, color: "var(--cyan)" }}>{fn.function_name}()</span>
                    <span style={{ fontSize: 11, color: "var(--text-muted)", marginLeft: 8 }}>{fn.http_method} {fn.path_template}</span>
                  </div>
                  <div style={{ display: "flex", gap: 6 }}>
                    <button className="btn btn-sm" onClick={() => handleTest(fn.id)} disabled={testingId === fn.id}>{testingId === fn.id ? "..." : "Test"}</button>
                    <button className="btn btn-sm btn-danger" onClick={() => handleDeleteFunction(fn.id)}>✕</button>
                  </div>
                </div>
                <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 3 }}>{fn.description}</div>
                {testResult?.fnId === fn.id && (
                  <div style={{ fontSize: 11.5, marginTop: 6, padding: 8, background: "var(--bg-hover)", borderRadius: 6, fontFamily: "monospace", whiteSpace: "pre-wrap" }}>
                    {testResult.error ? `Error: ${testResult.error}` : JSON.stringify(testResult.body, null, 2)}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
