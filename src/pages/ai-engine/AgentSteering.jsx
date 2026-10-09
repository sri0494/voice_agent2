import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import * as api from "../../services/api.js";
import { LoadingState, ErrorState } from "../../components/DataState.jsx";

export default function AgentSteering() {
  const { id } = useParams();
  const [config, setConfig] = useState(null);
  const [state, setState] = useState("loading");
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setState("loading");
    try {
      const c = await api.getAgentSteering(id);
      setConfig({
        ...c,
        allowedTopicsText: (c.allowed_topics || []).join(", "),
        restrictedTopicsText: (c.restricted_topics || []).join(", "),
        requiredInfoText: (c.required_information || []).join(", "),
        extraction_fields: c.extraction_fields && c.extraction_fields.length > 0
          ? c.extraction_fields
          : [],
      });
      setState("ready");
    } catch {
      setState("error");
    }
  };

  useEffect(() => { load(); }, [id]);

  const set = (key) => (e) => setConfig({ ...config, [key]: e.target.value });
  const setChecked = (key) => (e) => setConfig({ ...config, [key]: e.target.checked });

  const addExtractionField = () => {
    setConfig({ ...config, extraction_fields: [...config.extraction_fields, { key: "", label: "", type: "text" }] });
  };
  const updateExtractionField = (index, field, value) => {
    const updated = [...config.extraction_fields];
    updated[index] = { ...updated[index], [field]: value };
    if (field === "label") updated[index].key = value.toLowerCase().trim().replace(/\s+/g, "_");
    setConfig({ ...config, extraction_fields: updated });
  };
  const removeExtractionField = (index) => {
    setConfig({ ...config, extraction_fields: config.extraction_fields.filter((_, i) => i !== index) });
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await api.updateAgentSteering(id, {
        primaryObjective: config.primary_objective,
        allowedTopics: config.allowedTopicsText.split(",").map((t) => t.trim()).filter(Boolean),
        restrictedTopics: config.restrictedTopicsText.split(",").map((t) => t.trim()).filter(Boolean),
        requiredInformation: config.requiredInfoText.split(",").map((t) => t.trim()).filter(Boolean),
        offTopicStrategy: config.off_topic_strategy,
        maxOffTopicTurns: Number(config.max_off_topic_turns),
        knowledgeOnlyMode: config.knowledge_only_mode,
        confidenceThreshold: Number(config.confidence_threshold),
        conversationStyle: config.conversation_style,
        extractionFields: config.extraction_fields.filter((f) => f.key && f.label),
      });
      alert("Conversation intelligence settings saved");
    } catch (err) {
      alert(err.message);
    } finally {
      setSaving(false);
    }
  };

  if (state === "loading") return <LoadingState label="Loading..." />;
  if (state === "error") return <ErrorState onRetry={load} />;

  return (
    <div>
      <Link to={`/ai-engine/agents/${id}`} style={{ color: "var(--text-secondary)", fontSize: 13 }}>← Back to Agent</Link>
      <div className="section-title" style={{ marginTop: 8 }}>Conversation Intelligence & Objective</div>
      <div className="section-sub">Controls how this agent steers conversations toward its business objective</div>

      <div className="card" style={{ maxWidth: 620 }}>
        <div className="form-group">
          <label>Primary Objective</label>
          <textarea className="input" rows={2} placeholder="e.g. Conduct a customer satisfaction survey" value={config.primary_objective || ""} onChange={set("primary_objective")} />
        </div>
        <div className="form-group">
          <label>Allowed Topics (comma-separated)</label>
          <input className="input" placeholder="products, pricing, delivery" value={config.allowedTopicsText} onChange={set("allowedTopicsText")} />
        </div>
        <div className="form-group">
          <label>Restricted Topics (comma-separated)</label>
          <input className="input" placeholder="competitor comparisons, legal advice" value={config.restrictedTopicsText} onChange={set("restrictedTopicsText")} />
        </div>
        <div className="form-group">
          <label>Required Information (comma-separated keys the agent must collect)</label>
          <input className="input" placeholder="budget, product, satisfaction_score" value={config.requiredInfoText} onChange={set("requiredInfoText")} />
        </div>

        <div className="grid grid-cols-2">
          <div className="form-group">
            <label>Off-topic Strategy</label>
            <select className="input" value={config.off_topic_strategy} onChange={set("off_topic_strategy")}>
              <option value="REDIRECT">Redirect</option>
              <option value="BRIEF_ANSWER_THEN_REDIRECT">Brief Answer + Redirect</option>
              <option value="STRICT_KNOWLEDGE_ONLY">Strict Knowledge Mode</option>
            </select>
          </div>
          <div className="form-group">
            <label>Max Off-topic Turns</label>
            <input className="input" type="number" min="0" value={config.max_off_topic_turns} onChange={set("max_off_topic_turns")} />
          </div>
        </div>

        <div className="form-group">
          <label>Confidence Threshold (0–1, minimum knowledge-match similarity to answer confidently)</label>
          <input className="input" type="number" step="0.05" min="0" max="1" value={config.confidence_threshold} onChange={set("confidence_threshold")} />
        </div>

        <div className="form-group">
          <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input type="checkbox" checked={config.knowledge_only_mode} onChange={setChecked("knowledge_only_mode")} />
            Knowledge-Only Mode (never answer without a matching knowledge base chunk)
          </label>
        </div>

        <div className="form-group">
          <label>Conversation Style</label>
          <input className="input" value={config.conversation_style || ""} onChange={set("conversation_style")} />
        </div>

        <div className="form-group">
          <label>Information to Extract from Speech</label>
          <div style={{ fontSize: 11.5, color: "var(--text-muted)", marginBottom: 8 }}>
            Only numeric fields (e.g. "Budget") are reliably extracted in mock mode — text fields
            (e.g. "Product") need a real AI provider to extract accurately.
          </div>
          {config.extraction_fields.map((f, i) => (
            <div key={i} style={{ display: "flex", gap: 8, marginBottom: 6 }}>
              <input className="input" placeholder="Label, e.g. Budget" value={f.label} onChange={(e) => updateExtractionField(i, "label", e.target.value)} />
              <select className="input" style={{ maxWidth: 110 }} value={f.type} onChange={(e) => updateExtractionField(i, "type", e.target.value)}>
                <option value="text">Text</option>
                <option value="number">Number</option>
              </select>
              <button type="button" className="btn btn-sm btn-danger" onClick={() => removeExtractionField(i)}>✕</button>
            </div>
          ))}
          <button type="button" className="btn btn-sm" onClick={addExtractionField}>+ Add Field</button>
        </div>

        <button className="btn btn-primary" onClick={handleSave} disabled={saving} style={{ marginTop: 10 }}>{saving ? "Saving..." : "Save Settings"}</button>
      </div>

      <div className="card" style={{ maxWidth: 620, marginTop: 16, background: "var(--bg-elevated)" }}>
        <div style={{ fontSize: 12.5, color: "var(--text-secondary)" }}>
          Want to see this in action? Use the <Link to={`/ai-engine/agents/${id}/test`} style={{ color: "var(--cyan)" }}>Conversation Testing Playground</Link> to
          send test messages and see relevance, sentiment, and objective progress live.
        </div>
      </div>
    </div>
  );
}
