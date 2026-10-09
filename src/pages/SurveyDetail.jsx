import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import * as api from "../services/api.js";
import StatusBadge from "../components/StatusBadge.jsx";
import { LoadingState, ErrorState } from "../components/DataState.jsx";

const QUESTION_TYPES = ["Yes/No", "Rating 1-5", "Rating 1-10", "Multiple Choice", "Single Choice", "Free Text", "Voice Response", "Numeric", "Date", "Location", "Custom"];

export default function SurveyDetail() {
  const { id } = useParams();
  const [survey, setSurvey] = useState(null);
  const [results, setResults] = useState(null);
  const [state, setState] = useState("loading");
  const [showQForm, setShowQForm] = useState(false);
  const [qForm, setQForm] = useState({ questionText: "", questionType: "Rating 1-5", options: "" });
  const [tab, setTab] = useState("builder");

  const load = async () => {
    setState("loading");
    try {
      const [s, r] = await Promise.all([api.getSurvey(id), api.getSurveyResults(id)]);
      setSurvey(s);
      setResults(r);
      setState("ready");
    } catch {
      setState("error");
    }
  };

  useEffect(() => { load(); }, [id]);

  const handleAddQuestion = async (e) => {
    e.preventDefault();
    try {
      const options = qForm.questionType.includes("Choice") ? qForm.options.split(",").map((o) => o.trim()).filter(Boolean) : [];
      await api.addSurveyQuestion(id, { questionText: qForm.questionText, questionType: qForm.questionType, options });
      setQForm({ questionText: "", questionType: "Rating 1-5", options: "" });
      setShowQForm(false);
      load();
    } catch (err) {
      alert(err.message);
    }
  };

  const handleDeleteQuestion = async (qId) => {
    if (!confirm("Remove this question?")) return;
    await api.deleteSurveyQuestion(qId);
    load();
  };

  if (state === "loading") return <LoadingState label="Loading survey..." />;
  if (state === "error") return <ErrorState onRetry={load} />;

  return (
    <div>
      <Link to="/surveys" style={{ color: "var(--text-secondary)", fontSize: 13 }}>← Back to Surveys</Link>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 8 }}>
        <div className="section-title">{survey.name}</div>
        <StatusBadge status={survey.status} />
      </div>
      <div className="section-sub">{survey.description || "No description"}</div>

      <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
        <button className={`btn btn-sm ${tab === "builder" ? "btn-primary" : ""}`} onClick={() => setTab("builder")}>Question Builder</button>
        <button className={`btn btn-sm ${tab === "results" ? "btn-primary" : ""}`} onClick={() => setTab("results")}>Results</button>
      </div>

      {tab === "builder" && (
        <div>
          <button className="btn btn-primary btn-sm" style={{ marginBottom: 14 }} onClick={() => setShowQForm((v) => !v)}>+ Add Question</button>

          {showQForm && (
            <form className="card" onSubmit={handleAddQuestion} style={{ marginBottom: 16, maxWidth: 460 }}>
              <div className="form-group"><label>Question Text</label><input className="input" required value={qForm.questionText} onChange={(e) => setQForm({ ...qForm, questionText: e.target.value })} /></div>
              <div className="form-group">
                <label>Question Type</label>
                <select className="input" value={qForm.questionType} onChange={(e) => setQForm({ ...qForm, questionType: e.target.value })}>
                  {QUESTION_TYPES.map((t) => <option key={t}>{t}</option>)}
                </select>
              </div>
              {qForm.questionType.includes("Choice") && (
                <div className="form-group"><label>Options (comma-separated)</label><input className="input" placeholder="Yes, No, Maybe" value={qForm.options} onChange={(e) => setQForm({ ...qForm, options: e.target.value })} /></div>
              )}
              <button className="btn btn-primary">Add Question</button>
            </form>
          )}

          {survey.questions.length === 0 ? (
            <div className="card">No questions yet. Add your first question above.</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {survey.questions.map((q, i) => (
                <div key={q.id} className="card" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 13.5 }}>Q{i + 1}. {q.question_text}</div>
                    <div style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>{q.question_type}{q.options?.length ? ` — ${q.options.join(", ")}` : ""}</div>
                  </div>
                  <button className="btn btn-sm btn-danger" onClick={() => handleDeleteQuestion(q.id)}>✕</button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === "results" && (
        <div>
          <div className="grid grid-cols-4" style={{ marginBottom: 20 }}>
            <StatBox label="Total Responses" value={results.overall.total_responses} />
            <StatBox label="Positive" value={results.overall.positive} color="green" />
            <StatBox label="Negative" value={results.overall.negative} color="red" />
            <StatBox label="Neutral" value={results.overall.neutral} color="amber" />
          </div>

          {results.questions.length === 0 ? (
            <div className="card">No responses recorded yet.</div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Question</th><th>Responses</th><th>Avg Score</th><th>Positive %</th><th>Negative %</th></tr></thead>
                <tbody>
                  {results.questions.map((q) => (
                    <tr key={q.questionId}>
                      <td>{q.questionText}</td>
                      <td>{q.responseCount}</td>
                      <td>{q.avgScore ?? "—"}</td>
                      <td>{q.positivePct}%</td>
                      <td>{q.negativePct}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StatBox({ label, value, color = "cyan" }) {
  return (
    <div className="stat-card">
      <div className="label">{label}</div>
      <div className="value" style={{ color: `var(--${color})` }}>{value}</div>
    </div>
  );
}
