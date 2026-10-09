import { useEffect, useState } from "react";
import { resolvePlayback, saveRecording } from "../services/http.js";
import * as api from "../services/http.js";

const fmtSize = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const fmtDur = (s) => (s ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : "—");
const SOURCE = { browser: "Browser", telephony: "Call", upload: "Upload" };

/**
 * Lists recordings (for one call, or all) with an on-demand player.
 * The playback link is fetched only when you press Play (short-lived, signed).
 *   <RecordingList callId={call.id} refreshKey={n} />
 */
export default function RecordingList({ callId, refreshKey = 0 }) {
  const [items, setItems] = useState(null);
  const [error, setError] = useState("");
  const [playing, setPlaying] = useState(null); // { id, src, release }
  useEffect(() => () => playing?.release?.(), [playing]);

  const load = async () => {
    try {
      setItems(await api.getRecordings(callId ? { callId } : {}));
      setError("");
    } catch (err) {
      setError(err.message || "Could not load recordings.");
    }
  };
  useEffect(() => { load(); }, [callId, refreshKey]);

  const play = async (id) => {
    try {
      playing?.release?.();
      const { src, release } = await resolvePlayback(await api.getRecordingUrl(id));
      setPlaying({ id, src, release });
    } catch (err) { alert(err.message); }
  };

  const download = async (id) => {
    try { await saveRecording(await api.getRecordingUrl(id, { download: true }), `recording-${id}`); } catch (err) { alert(err.message); }
  };

  const remove = async (id) => {
    if (!confirm("Delete this recording? This cannot be undone.")) return;
    try {
      await api.deleteRecording(id);
      if (playing?.id === id) { playing.release?.(); setPlaying(null); }
      load();
    } catch (err) { alert(err.message); }
  };

  if (error) return <div style={{ fontSize: 12.5, color: "#e5484d" }}>{error}</div>;
  if (!items) return <div style={{ fontSize: 12.5, color: "var(--text-secondary)" }}>Loading recordings...</div>;
  if (!items.length) return <div style={{ fontSize: 12.5, color: "var(--text-secondary)" }}>No recordings yet.</div>;

  return (
    <div>
      {items.map((r) => (
        <div key={r.id} style={{ padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <div style={{ fontSize: 12.5 }}>
              {new Date(r.created_at).toLocaleString()} · {fmtDur(r.duration_sec)} · {fmtSize(r.size_bytes)} · {SOURCE[r.source] || r.source}
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <button type="button" className="btn btn-sm" onClick={() => (playing?.id === r.id ? (playing.release?.(), setPlaying(null)) : play(r.id))}>
                {playing?.id === r.id ? "Close" : "Play"}
              </button>
              <button type="button" className="btn btn-sm" onClick={() => download(r.id)}>Download</button>
              <button type="button" className="btn btn-sm btn-danger" onClick={() => remove(r.id)}>Delete</button>
            </div>
          </div>
          {playing?.id === r.id && <audio controls autoPlay src={playing.src} style={{ width: "100%", marginTop: 8 }} />}
        </div>
      ))}
    </div>
  );
}
