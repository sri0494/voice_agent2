import { useCallback, useEffect, useState } from "react";
import { LoadingState, ErrorState } from "../components/DataState.jsx";

/** Load data on mount / when deps change.  const { data, error, loading, reload } = useLoad(() => http("/customer/x"), [dep]) */
export function useLoad(fn, deps = []) {
  const [s, setS] = useState({ data: null, error: "", loading: true });
  const run = useCallback(async () => {
    setS((p) => ({ ...p, loading: true, error: "" }));
    try { setS({ data: await fn(), error: "", loading: false }); }
    catch (e) { setS({ data: null, error: e.message || "Something went wrong", loading: false, status: e.status }); }
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { run(); }, [run]);
  return { ...s, reload: run };
}

export function Boundary({ state, label, children }) {
  if (state.loading && !state.data) return <LoadingState label={label || "Loading..."} />;
  if (state.error) return <ErrorState onRetry={state.reload} />;
  return children;
}

export const PageHeader = ({ title, sub, actions }) => (
  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12, marginBottom: 16 }}>
    <div><div className="section-title">{title}</div>{sub && <div className="section-sub">{sub}</div>}</div>
    {actions && <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>{actions}</div>}
  </div>
);

export const StatGrid = ({ items }) => (
  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12, marginBottom: 16 }}>
    {items.map(([label, value]) => (
      <div className="card" key={label}>
        <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>{label}</div>
        <div style={{ fontSize: 24, fontWeight: 700, marginTop: 4 }}>{value ?? "—"}</div>
      </div>
    ))}
  </div>
);

export const fmtDate = (d) => (d ? new Date(d).toLocaleString() : "—");
export const fmtDay = (d) => (d ? new Date(d).toLocaleDateString() : "—");
export const fmtDur = (s) => (s ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : "—");
export const fmtSize = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

export function Pager({ offset, limit, count, onChange }) {
  if (offset === 0 && count < limit) return null;
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 12 }}>
      <button className="btn btn-sm" disabled={offset === 0} onClick={() => onChange(Math.max(0, offset - limit))}>← Previous</button>
      <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>Showing {offset + 1}–{offset + count}</span>
      <button className="btn btn-sm" disabled={count < limit} onClick={() => onChange(offset + limit)}>Next →</button>
    </div>
  );
}

export const Table = ({ head, children }) => (
  <div className="table-wrap"><table><thead><tr>{head.map((h) => <th key={h}>{h}</th>)}</tr></thead><tbody>{children}</tbody></table></div>
);

export const Empty = ({ text }) => <div className="card" style={{ color: "var(--text-secondary)", fontSize: 14 }}>{text}</div>;

/** Confirmation before any delete (matches the browser confirm already used elsewhere in the app). */
export const confirmDelete = (what) => window.confirm(`Are you sure you want to delete ${what || "this item"}? This cannot be undone.`);
