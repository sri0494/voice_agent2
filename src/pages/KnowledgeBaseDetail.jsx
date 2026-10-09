import { useEffect, useRef, useState } from "react";
import { useParams, Link } from "react-router-dom";
import * as api from "../services/api.js";
import StatusBadge from "../components/StatusBadge.jsx";
import { LoadingState, ErrorState } from "../components/DataState.jsx";

export default function KnowledgeBaseDetail() {
  const { id } = useParams();
  const [kb, setKb] = useState(null);
  const [state, setState] = useState("loading");
  const fileInput = useRef(null);
  const [uploading, setUploading] = useState(false);
  const [showText, setShowText] = useState(false);
  const [showFaq, setShowFaq] = useState(false);
  const [textForm, setTextForm] = useState({ title: "", text: "" });
  const [faqForm, setFaqForm] = useState({ question: "", answer: "" });
  const [searchQ, setSearchQ] = useState("");
  const [searchResults, setSearchResults] = useState(null);
  const [searching, setSearching] = useState(false);

  const load = async () => {
    setState("loading");
    try {
      setKb(await api.getKnowledgeBase(id));
      setState("ready");
    } catch {
      setState("error");
    }
  };

  useEffect(() => { load(); }, [id]);

  // Auto-refresh while any document is still processing, so status/chunk counts update live.
  useEffect(() => {
    if (!kb) return;
    const hasPending = kb.documents?.some((d) => d.status === "PENDING" || d.status === "PROCESSING");
    if (!hasPending) return;
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [kb]);

  const handleUpload = async (e) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    setUploading(true);
    let succeeded = 0;
    const failed = [];
    try {
      // Uploaded sequentially (not in parallel) so each document's
      // async processing kicks off cleanly and errors are attributable
      // to a specific file rather than racing each other.
      for (const file of files) {
        try {
          await api.uploadDocument(file, id);
          succeeded++;
        } catch (err) {
          failed.push(`${file.name}: ${err.message}`);
        }
      }
      if (failed.length > 0) {
        alert(`Uploaded ${succeeded} of ${files.length} files.\n\nFailed:\n${failed.join("\n")}`);
      }
      load();
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  const handleAddText = async (e) => {
    e.preventDefault();
    try {
      await api.addKnowledgeText(id, textForm.title, textForm.text);
      setTextForm({ title: "", text: "" });
      setShowText(false);
      load();
    } catch (err) { alert(err.message); }
  };

  const handleAddFaq = async (e) => {
    e.preventDefault();
    try {
      await api.addKnowledgeFaq(id, faqForm.question, faqForm.answer);
      setFaqForm({ question: "", answer: "" });
      setShowFaq(false);
      load();
    } catch (err) { alert(err.message); }
  };

  const handleReindex = async (docId) => {
    await api.reindexDocument(docId);
    load();
  };

  const handleDeleteDoc = async (docId) => {
    if (!confirm("Delete this document?")) return;
    await api.deleteDocument(docId);
    load();
  };

  const handleSearch = async (e) => {
    e.preventDefault();
    if (!searchQ.trim()) return;
    setSearching(true);
    try {
      setSearchResults(await api.searchDocuments(id, searchQ));
    } catch (err) {
      alert(err.message);
    } finally {
      setSearching(false);
    }
  };

  if (state === "loading") return <LoadingState label="Loading knowledge base..." />;
  if (state === "error") return <ErrorState onRetry={load} />;

  return (
    <div>
      <Link to="/knowledge-base" style={{ color: "var(--text-secondary)", fontSize: 13 }}>← Back to Knowledge Base</Link>
      <div className="section-title" style={{ marginTop: 8 }}>{kb.name}</div>
      <div className="section-sub">{kb.description || "No description"}</div>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 6 }}>
        <input ref={fileInput} type="file" multiple accept=".pdf,.txt,.docx,.csv,.md" onChange={handleUpload} style={{ display: "none" }} />
        <button className="btn btn-primary" onClick={() => fileInput.current?.click()} disabled={uploading}>
          {uploading ? "Uploading..." : "⬆ Upload Documents"}
        </button>
        <button className="btn" onClick={() => setShowText((v) => !v)}>+ Add Text</button>
        <button className="btn" onClick={() => setShowFaq((v) => !v)}>+ Add FAQ</button>
      </div>
      <div style={{ fontSize: 11.5, color: "var(--text-muted)", marginBottom: 20 }}>
        Select multiple files at once. Supported: PDF, TXT, DOCX, CSV, Markdown.
        Video, audio, and image files aren't supported — the knowledge base
        needs actual text to search, and turning media into text needs
        speech-to-text/OCR that isn't built yet. Workaround: transcribe the
        content yourself and use "+ Add Text" instead.
      </div>

      {showText && (
        <form className="card" onSubmit={handleAddText} style={{ marginBottom: 16, maxWidth: 520 }}>
          <div className="form-group"><label>Title</label><input className="input" value={textForm.title} onChange={(e) => setTextForm({ ...textForm, title: e.target.value })} /></div>
          <div className="form-group"><label>Text Content</label><textarea className="input" rows={5} required value={textForm.text} onChange={(e) => setTextForm({ ...textForm, text: e.target.value })} /></div>
          <button className="btn btn-primary">Add Text</button>
        </form>
      )}

      {showFaq && (
        <form className="card" onSubmit={handleAddFaq} style={{ marginBottom: 16, maxWidth: 520 }}>
          <div className="form-group"><label>Question</label><input className="input" required value={faqForm.question} onChange={(e) => setFaqForm({ ...faqForm, question: e.target.value })} /></div>
          <div className="form-group"><label>Answer</label><textarea className="input" rows={3} required value={faqForm.answer} onChange={(e) => setFaqForm({ ...faqForm, answer: e.target.value })} /></div>
          <button className="btn btn-primary">Add FAQ</button>
        </form>
      )}

      <form className="card" onSubmit={handleSearch} style={{ marginBottom: 20, display: "flex", gap: 10, maxWidth: 520 }}>
        <input className="input" placeholder="Search this knowledge base..." value={searchQ} onChange={(e) => setSearchQ(e.target.value)} />
        <button className="btn" disabled={searching}>{searching ? "..." : "Search"}</button>
      </form>

      {searchResults && (
        <div className="card" style={{ marginBottom: 20 }}>
          <div style={{ fontWeight: 600, marginBottom: 10 }}>Search Results</div>
          {searchResults.length === 0 ? (
            <div style={{ color: "var(--text-secondary)", fontSize: 13 }}>No matching chunks found.</div>
          ) : (
            searchResults.map((r) => (
              <div key={r.id} style={{ padding: "8px 0", borderBottom: "1px solid var(--border)", fontSize: 13 }}>
                <div style={{ color: "var(--text-muted)", fontSize: 11, marginBottom: 3 }}>similarity: {r.similarity?.toFixed?.(3) ?? "—"}</div>
                {r.content}
              </div>
            ))
          )}
        </div>
      )}

      <div style={{ fontWeight: 600, marginBottom: 10 }}>Documents ({kb.documents?.length || 0})</div>
      {kb.documents?.length === 0 ? (
        <div className="card">No documents yet. Upload a PDF, DOCX, TXT, CSV, or Markdown file.</div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Title</th><th>Type</th><th>Status</th><th>Chunks</th><th>Actions</th></tr></thead>
            <tbody>
              {kb.documents.map((d) => (
                <tr key={d.id}>
                  <td>{d.title}</td>
                  <td>{d.file_type || d.source_type}</td>
                  <td>
                    <StatusBadge status={d.status} />
                    {d.status === "FAILED" && d.error_message && (
                      <div style={{ fontSize: 11, color: "var(--red)", marginTop: 3 }}>{d.error_message}</div>
                    )}
                  </td>
                  <td>{d.chunk_count}</td>
                  <td>
                    <div style={{ display: "flex", gap: 6 }}>
                      <button className="btn btn-sm" onClick={() => handleReindex(d.id)}>↻ Re-index</button>
                      <button className="btn btn-sm btn-danger" onClick={() => handleDeleteDoc(d.id)}>Delete</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
