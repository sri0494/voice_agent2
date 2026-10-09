import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import * as api from "../services/api.js";
import StatusBadge from "../components/StatusBadge.jsx";
import { LoadingState, ErrorState } from "../components/DataState.jsx";

const SPEAKER_COLOR = { AI: "cyan", CUSTOMER: "purple", HUMAN_AGENT: "green", SYSTEM: "muted" };

export default function CallDetail() {
  const { id } = useParams();
  const [call, setCall] = useState(null);
  const [state, setState] = useState("loading");

  const load = async () => {
    setState("loading");
    try {
      setCall(await api.getCall(id));
      setState("ready");
    } catch {
      setState("error");
    }
  };

  useEffect(() => { load(); }, [id]);

  if (state === "loading") return <LoadingState label="Loading call..." />;
  if (state === "error") return <ErrorState onRetry={load} />;

  return (
    <div>
      <Link to="/calls" style={{ color: "var(--text-secondary)", fontSize: 13 }}>← Back to Calls</Link>

      <div className="grid grid-cols-2" style={{ marginTop: 12, alignItems: "flex-start" }}>
        <div className="card">
          <div style={{ fontWeight: 700, marginBottom: 12 }}>Call Information</div>
          <Row label="Call ID" value={call.id} />
          <Row label="Customer" value={call.customer_name || call.phone} />
          <Row label="Campaign" value={call.campaign_name || "—"} />
          <Row label="Agent" value={call.agent_name || "—"} />
          <Row label="Language" value={call.language || "—"} />
          <Row label="Duration" value={call.duration_sec ? `${Math.floor(call.duration_sec / 60)}m ${call.duration_sec % 60}s` : "—"} />
          <Row label="Status" value={<StatusBadge status={call.status} />} />
          <Row label="Sentiment" value={call.sentiment ? <StatusBadge status={call.sentiment} /> : "—"} />
          <Row label="Intent" value={call.intent || "—"} />
          <Row label="Started" value={call.started_at ? new Date(call.started_at).toLocaleString() : "—"} />
        </div>

        <div className="card">
          <div style={{ fontWeight: 700, marginBottom: 12 }}>Conversation Transcript</div>
          {call.messages?.length === 0 ? (
            <div style={{ color: "var(--text-secondary)", fontSize: 13.5 }}>No transcript available for this call.</div>
          ) : (
            <div>
              {call.messages.map((m) => (
                <div className="transcript-line" key={m.id}>
                  <div className={`transcript-speaker badge-${SPEAKER_COLOR[m.speaker] || "muted"}`} style={{ color: `var(--${SPEAKER_COLOR[m.speaker] === "muted" ? "text-muted" : SPEAKER_COLOR[m.speaker]})` }}>
                    {m.speaker.replace("_", " ")}
                  </div>
                  <div>{m.content}</div>
                </div>
              ))}
            </div>
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
