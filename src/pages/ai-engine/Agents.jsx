import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import * as api from "../../services/api.js";
import StatusBadge from "../../components/StatusBadge.jsx";
import { LoadingState, ErrorState, EmptyState } from "../../components/DataState.jsx";

export default function Agents() {
  const [agents, setAgents] = useState([]);
  const [state, setState] = useState("loading");
  const navigate = useNavigate();

  const load = async () => {
    setState("loading");
    try {
      setAgents(await api.getAgents());
      setState("ready");
    } catch {
      setState("error");
    }
  };

  useEffect(() => { load(); }, []);

  const handleCreate = async () => {
    const name = prompt("New agent name:");
    if (!name) return;
    try {
      const agent = await api.createAgent({ name, language: "English" });
      navigate(`/ai-engine/agents/${agent.id}`);
    } catch (err) {
      alert(err.message);
    }
  };

  if (state === "loading") return <LoadingState label="Loading agents..." />;
  if (state === "error") return <ErrorState onRetry={load} />;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12 }}>
        <div>
          <div className="section-title">AI Engine — Agents</div>
          <div className="section-sub">Configure AI voice agents: prompts, voice, language, and knowledge base</div>
        </div>
        <button className="btn btn-primary" onClick={handleCreate}>+ New Agent</button>
      </div>

      {agents.length === 0 ? (
        <EmptyState message="No AI agents yet. Create one to get started." />
      ) : (
        <div className="grid grid-cols-3">
          {agents.map((a) => (
            <Link to={`/ai-engine/agents/${a.id}`} key={a.id} className="card" style={{ display: "block" }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                <div style={{ fontWeight: 700 }}>{a.name}</div>
                <StatusBadge status={a.status} />
              </div>
              <div style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 10 }}>{a.description || "No description"}</div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                <span className="badge badge-cyan">{a.language}</span>
                {a.voice && <span className="badge badge-purple">{a.voice}</span>}
                {a.transfer_enabled && <span className="badge badge-green">Human Transfer</span>}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
