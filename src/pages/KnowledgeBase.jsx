import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import * as api from "../services/api.js";
import { LoadingState, ErrorState, EmptyState } from "../components/DataState.jsx";

export default function KnowledgeBase() {
  const [kbs, setKbs] = useState([]);
  const [state, setState] = useState("loading");
  const navigate = useNavigate();

  const load = async () => {
    setState("loading");
    try {
      setKbs(await api.getKnowledgeBases());
      setState("ready");
    } catch {
      setState("error");
    }
  };

  useEffect(() => { load(); }, []);

  const handleCreate = async () => {
    const name = prompt("Knowledge base name:");
    if (!name) return;
    try {
      const kb = await api.createKnowledgeBase({ name });
      navigate(`/knowledge-base/${kb.id}`);
    } catch (err) {
      alert(err.message);
    }
  };

  if (state === "loading") return <LoadingState label="Loading knowledge bases..." />;
  if (state === "error") return <ErrorState onRetry={load} />;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12 }}>
        <div>
          <div className="section-title">Knowledge Base</div>
          <div className="section-sub">Documents, FAQs, and text that power RAG-grounded AI answers</div>
        </div>
        <button className="btn btn-primary" onClick={handleCreate}>+ Create Knowledge Base</button>
      </div>

      {kbs.length === 0 ? (
        <EmptyState message="No knowledge bases yet." />
      ) : (
        <div className="grid grid-cols-3">
          {kbs.map((kb) => (
            <Link to={`/knowledge-base/${kb.id}`} key={kb.id} className="card" style={{ display: "block" }}>
              <div style={{ fontWeight: 700, marginBottom: 6 }}>{kb.name}</div>
              <div style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 10 }}>{kb.description || "No description"}</div>
              <div style={{ fontSize: 12.5, color: "var(--text-muted)" }}>{kb.document_count} documents · {kb.chunk_count} chunks</div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
