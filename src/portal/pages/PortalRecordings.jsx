import { useState } from "react";
import { useEffect } from "react";
import { http, resolvePlayback, saveRecording } from "../../services/http.js";
import { Boundary, PageHeader, Pager, Table, fmtDate, fmtDur, fmtSize, useLoad } from "../ui.jsx";

const LIMIT = 50;

export default function PortalRecordings() {
  const [campaignId, setCampaignId] = useState("");
  const [offset, setOffset] = useState(0);
  const options = useLoad(() => http("/customer/campaign-options"));
  const st = useLoad(() => http("/customer/recordings", { params: { campaignId, limit: LIMIT, offset } }), [campaignId, offset]);
  const [playing, setPlaying] = useState(null); // { id, src, download, release }
  const close = () => { playing?.release?.(); setPlaying(null); };
  useEffect(() => () => playing?.release?.(), [playing]);

  // The link is requested only when you press Play: the server checks ownership + permission, then signs a 5-minute link.
  const play = async (id) => {
    try {
      playing?.release?.();
      const meta = await http(`/customer/recordings/${id}/url`);
      const { src, release } = await resolvePlayback(meta);
      setPlaying({ id, src, release, download: meta.downloadUrl ? { mode: meta.mode, url: meta.downloadUrl } : null });
    } catch (err) { alert(err.message); }
  };

  return (
    <div>
      <PageHeader title="Recordings" sub="Call recordings for your campaigns" />
      <select className="input" style={{ maxWidth: 320, marginBottom: 16 }} value={campaignId} onChange={(e) => { setCampaignId(e.target.value); setOffset(0); }}>
        <option value="">All campaigns</option>
        {(options.data || []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
      <Boundary state={st}>
        {st.data?.length ? (
          <>
            <Table head={["Date", "Campaign", "Contact", "Phone", "Duration", "Size", "Recording"]}>
              {st.data.map((r) => (
                <tr key={r.id}>
                  <td>{fmtDate(r.created_at)}</td><td>{r.campaign_name}</td><td>{r.customer_name || "—"}</td><td>{r.phone || "—"}</td>
                  <td>{fmtDur(r.duration_sec)}</td><td>{fmtSize(r.size_bytes)}</td>
                  <td style={{ minWidth: 230 }}>
                    <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                      <button className="btn btn-sm" onClick={() => (playing?.id === r.id ? close() : play(r.id))}>{playing?.id === r.id ? "Close" : "▶ Play"}</button>
                      {playing?.id === r.id && playing.download && <button className="btn btn-sm" onClick={() => saveRecording(playing.download, `recording-${r.id}`).catch((e) => alert(e.message))}>Download</button>}
                    </div>
                    {playing?.id === r.id && <audio controls autoPlay src={playing.src} style={{ width: "100%", marginTop: 8 }} />}
                  </td>
                </tr>
              ))}
            </Table>
            <Pager offset={offset} limit={LIMIT} count={st.data.length} onChange={setOffset} />
          </>
        ) : <div className="card">No recordings yet.</div>}
      </Boundary>
    </div>
  );
}
