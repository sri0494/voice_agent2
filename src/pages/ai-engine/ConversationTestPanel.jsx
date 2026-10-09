import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import * as api from "../../services/api.js";

const RELEVANCE_COLOR = {
  BUSINESS_RELEVANT: "green", PARTIALLY_RELEVANT: "amber", INFORMATION_REQUEST: "cyan",
  FEEDBACK: "purple", SURVEY_RESPONSE: "purple", CLARIFICATION: "amber",
  OFF_TOPIC: "red", UNSAFE: "red", UNKNOWN: "muted",
};

export default function ConversationTestPanel() {
  const { id } = useParams();
  const [messages, setMessages] = useState([]); // { role, content }
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [lastAnalysis, setLastAnalysis] = useState(null);
  const [sessionId, setSessionId] = useState(null);

  const handleSend = async (e) => {
    e.preventDefault();
    if (!input.trim()) return;
    const customerText = input;
    setInput("");
    setSending(true);
    const historyForApi = messages.map((m) => ({ role: m.role, content: m.content }));

    try {
      const result = await api.processConversation(id, customerText, historyForApi, sessionId);
      setSessionId(result.sessionId);
      setMessages((prev) => [
        ...prev,
        { role: "user", content: customerText },
        { role: "assistant", content: result.response },
      ]);
      setLastAnalysis(result);
    } catch (err) {
      alert(err.message);
    } finally {
      setSending(false);
    }
  };

  const handleReset = () => {
    setMessages([]);
    setLastAnalysis(null);
    setSessionId(null);
  };

  return (
    <div>
      <Link to={`/ai-engine/agents/${id}`} style={{ color: "var(--text-secondary)", fontSize: 13 }}>← Back to Agent</Link>
      <div className="section-title" style={{ marginTop: 8 }}>Conversation Testing Playground</div>
      <div className="section-sub">
        Runs the full conversation intelligence pipeline (relevance → steering → knowledge retrieval → response) —
        the same path a live call would take. No real telephony or paid AI provider required in mock mode.
      </div>

      <div className="grid grid-cols-2" style={{ alignItems: "flex-start" }}>
        <div className="card" style={{ minHeight: 320 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <div style={{ fontWeight: 700 }}>Conversation {sessionId && <span style={{ fontSize: 11, color: "var(--text-muted)", fontWeight: 400 }}>· session active</span>}</div>
            {messages.length > 0 && <button className="btn btn-sm" onClick={handleReset}>New Conversation</button>}
          </div>
          <div style={{ marginBottom: 14, maxHeight: 360, overflowY: "auto" }}>
            {messages.length === 0 && <div style={{ fontSize: 13, color: "var(--text-secondary)" }}>Send a test message to begin.</div>}
            {messages.map((m, i) => (
              <div key={i} className="transcript-line">
                <div className="transcript-speaker" style={{ color: m.role === "user" ? "var(--purple)" : "var(--cyan)" }}>
                  {m.role === "user" ? "Customer" : "AI"}
                </div>
                <div>{m.content}</div>
              </div>
            ))}
          </div>
          <form onSubmit={handleSend} style={{ display: "flex", gap: 8 }}>
            <input className="input" placeholder="Type a customer message..." value={input} onChange={(e) => setInput(e.target.value)} />
            <button className="btn btn-primary" disabled={sending}>{sending ? "..." : "Send"}</button>
          </form>
        </div>

        <div className="card">
          <div style={{ fontWeight: 700, marginBottom: 10 }}>AI Analysis (last turn)</div>
          {!lastAnalysis ? (
            <div style={{ fontSize: 13, color: "var(--text-secondary)" }}>Send a message to see the breakdown.</div>
          ) : (
            <>
              <AnalysisRow label="Relevance" value={lastAnalysis.relevance} color={RELEVANCE_COLOR[lastAnalysis.relevance] || "muted"} />
              <AnalysisRow label="Sentiment" value={lastAnalysis.sentiment} />
              <AnalysisRow label="Confidence" value={`${Math.round(lastAnalysis.confidence * 100)}%`} />
              <AnalysisRow label="Next Action" value={lastAnalysis.next_action} />
              <AnalysisRow label="Objective Progress" value={`${lastAnalysis.objective_progress}%`} />
              <AnalysisRow label="Knowledge Sources Used" value={lastAnalysis.knowledge_context?.length || 0} />
              {Object.keys(lastAnalysis.entities || {}).length > 0 && (
                <div style={{ marginTop: 10 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Extracted Information</div>
                  <pre style={{ fontSize: 11.5, background: "var(--bg-hover)", padding: 8, borderRadius: 6, overflowX: "auto" }}>
                    {JSON.stringify(lastAnalysis.entities, null, 2)}
                  </pre>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function AnalysisRow({ label, value, color }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "7px 0", borderBottom: "1px solid var(--border)", fontSize: 13 }}>
      <span style={{ color: "var(--text-secondary)" }}>{label}</span>
      <span style={{ fontWeight: 600, color: color ? `var(--${color})` : "var(--text-primary)" }}>{value}</span>
    </div>
  );
}
