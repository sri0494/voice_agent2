import { useEffect, useState } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import * as api from "../../services/api.js";
import { LoadingState, ErrorState } from "../../components/DataState.jsx";

export default function AgentDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [agent, setAgent] = useState(null);
  const [knowledgeBases, setKnowledgeBases] = useState([]);
  const [state, setState] = useState("loading");
  const [saving, setSaving] = useState(false);
  const [testMsg, setTestMsg] = useState("");
  const [testResult, setTestResult] = useState(null);
  const [testing, setTesting] = useState(false);

  const load = async () => {
    setState("loading");
    try {
      const [a, kbs] = await Promise.all([api.getAgent(id), api.getKnowledgeBases()]);
      setAgent({ ...a, knowledgeBaseIds: a.knowledgeBases?.map((k) => k.id) || [] });
      setKnowledgeBases(kbs);
      setState("ready");
    } catch {
      setState("error");
    }
  };

  useEffect(() => { load(); }, [id]);

  const set = (key) => (e) => setAgent({ ...agent, [key]: e.target.value });

  const handleSave = async () => {
    setSaving(true);
    try {
      await api.updateAgent(id, {
        name: agent.name, description: agent.description, status: agent.status, language: agent.language,
        voice: agent.voice, greeting: agent.greeting, systemPrompt: agent.system_prompt,
        temperature: Number(agent.temperature), fallbackMessage: agent.fallback_message,
        transferEnabled: agent.transfer_enabled, transferNumber: agent.transfer_number,
        maxCallDurationSec: Number(agent.max_call_duration_sec), recordingEnabled: agent.recording_enabled,
        knowledgeBaseIds: agent.knowledgeBaseIds,
        agentType: agent.agent_type, businessName: agent.business_name, gender: agent.gender, personality: agent.personality,
      });
      alert("Agent saved");
      load();
    } catch (err) {
      alert(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm("Delete this agent?")) return;
    await api.deleteAgent(id);
    navigate("/ai-engine/agents");
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await api.testAgent(id, testMsg || "Hello");
      setTestResult(result);
    } catch (err) {
      setTestResult({ error: err.message });
    } finally {
      setTesting(false);
    }
  };

  const toggleKb = (kbId) => {
    setAgent((a) => ({
      ...a,
      knowledgeBaseIds: a.knowledgeBaseIds.includes(kbId)
        ? a.knowledgeBaseIds.filter((x) => x !== kbId)
        : [...a.knowledgeBaseIds, kbId],
    }));
  };

  if (state === "loading") return <LoadingState label="Loading agent..." />;
  if (state === "error") return <ErrorState onRetry={load} />;

  return (
    <div>
      <Link to="/ai-engine/agents" style={{ color: "var(--text-secondary)", fontSize: 13 }}>← Back to Agents</Link>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 8, flexWrap: "wrap", gap: 10 }}>
        <div>
          <div className="section-title" style={{ marginBottom: 0 }}>{agent.name}</div>
          <div className="section-sub">AI Voice Agent configuration</div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <Link to={`/ai-engine/agents/${id}/steering`} className="btn btn-sm">Conversation Settings</Link>
          <Link to={`/ai-engine/agents/${id}/test`} className="btn btn-sm">Test Playground</Link>
        </div>
      </div>

      <div className="grid grid-cols-2" style={{ alignItems: "flex-start" }}>
        <div className="card">
          <div className="form-group"><label>Agent Name</label><input className="input" value={agent.name || ""} onChange={set("name")} /></div>
          <div className="form-group"><label>Description</label><input className="input" value={agent.description || ""} onChange={set("description")} /></div>
          <div className="form-group"><label>Business Name</label><input className="input" value={agent.business_name || ""} onChange={set("business_name")} /></div>

          <div className="form-group">
            <label>Agent Type</label>
            <select className="input" value={agent.agent_type || "Custom Agent"} onChange={set("agent_type")}>
              <option>Customer Support Agent</option>
              <option>Sales Agent</option>
              <option>Appointment Agent</option>
              <option>Survey Agent</option>
              <option>Collection Agent</option>
              <option>Custom Agent</option>
            </select>
          </div>

          <div className="grid grid-cols-2">
            <div className="form-group">
              <label>Status</label>
              <select className="input" value={agent.status} onChange={set("status")}>
                <option value="DRAFT">Draft</option><option value="ACTIVE">Active</option><option value="PAUSED">Paused</option>
              </select>
            </div>
            <div className="form-group">
              <label>Language</label>
              <select className="input" value={agent.language} onChange={set("language")}>
                <option>English</option><option>Telugu</option><option>Hindi</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2">
            <div className="form-group"><label>Voice</label><input className="input" placeholder="e.g. Female Telugu" value={agent.voice || ""} onChange={set("voice")} /></div>
            <div className="form-group">
              <label>Gender</label>
              <select className="input" value={agent.gender || ""} onChange={set("gender")}>
                <option value="">Not set</option><option>Female</option><option>Male</option><option>Neutral</option>
              </select>
            </div>
          </div>
          <div className="form-group"><label>Personality</label><input className="input" placeholder="e.g. Friendly and professional" value={agent.personality || ""} onChange={set("personality")} /></div>
          <div className="form-group"><label>Greeting</label><textarea className="input" rows={2} value={agent.greeting || ""} onChange={set("greeting")} /></div>
          <div className="form-group"><label>System Prompt</label><textarea className="input" rows={5} value={agent.system_prompt || ""} onChange={set("system_prompt")} /></div>
          <div className="form-group"><label>Fallback Message</label><textarea className="input" rows={2} value={agent.fallback_message || ""} onChange={set("fallback_message")} /></div>

          <div className="grid grid-cols-2">
            <div className="form-group">
              <label>Temperature</label>
              <input className="input" type="number" step="0.05" min="0" max="1" value={agent.temperature} onChange={set("temperature")} />
            </div>
            <div className="form-group">
              <label>Max Call Duration (sec)</label>
              <input className="input" type="number" value={agent.max_call_duration_sec} onChange={set("max_call_duration_sec")} />
            </div>
          </div>

          <div className="form-group">
            <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input type="checkbox" checked={agent.transfer_enabled} onChange={(e) => setAgent({ ...agent, transfer_enabled: e.target.checked })} />
              Human Transfer Enabled
            </label>
          </div>
          {agent.transfer_enabled && (
            <div className="form-group"><label>Transfer Number</label><input className="input" value={agent.transfer_number || ""} onChange={set("transfer_number")} /></div>
          )}

          <div className="form-group">
            <label>Knowledge Bases</label>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {knowledgeBases.map((kb) => (
                <button
                  key={kb.id}
                  type="button"
                  className="btn btn-sm"
                  style={agent.knowledgeBaseIds.includes(kb.id) ? { borderColor: "var(--cyan)", color: "var(--cyan)" } : {}}
                  onClick={() => toggleKb(kb.id)}
                >
                  {kb.name}
                </button>
              ))}
            </div>
          </div>

          <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
            <button className="btn btn-primary" onClick={handleSave} disabled={saving}>{saving ? "Saving..." : "Save Agent"}</button>
            <button className="btn btn-danger" onClick={handleDelete}>Delete</button>
          </div>
        </div>

        <div className="card">
          <div style={{ fontWeight: 700, marginBottom: 10 }}>Test Agent</div>
          <div style={{ fontSize: 12.5, color: "var(--text-secondary)", marginBottom: 12 }}>
            Sends a sample message through this agent's prompt + knowledge base. No real call is placed.
          </div>
          <div className="form-group">
            <textarea className="input" rows={3} placeholder="Type a test customer message..." value={testMsg} onChange={(e) => setTestMsg(e.target.value)} />
          </div>
          <button className="btn btn-primary" onClick={handleTest} disabled={testing}>{testing ? "Testing..." : "Run Test"}</button>

          {testResult && (
            <div className="card" style={{ marginTop: 14, background: "var(--bg-elevated)" }}>
              {testResult.error ? (
                <div style={{ color: "var(--red)" }}>{testResult.error}</div>
              ) : (
                <>
                  <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 6 }}>
                    {testResult.usedFallback ? "Used fallback response (no relevant context found)" : "AI response"}
                  </div>
                  <div>{testResult.text}</div>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
