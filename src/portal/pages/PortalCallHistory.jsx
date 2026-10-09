import { useState } from "react";
import { downloadFile, http } from "../../services/http.js";
import StatusBadge from "../../components/StatusBadge.jsx";
import { Boundary, PageHeader, Pager, Table, fmtDate, fmtDur, useLoad } from "../ui.jsx";

const LIMIT = 50;
const STATUSES = ["completed", "failed", "busy", "no_answer"];

export default function PortalCallHistory({ me }) {
  const [f, setF] = useState({ status: "", campaignId: "", from: "", to: "" });
  const [offset, setOffset] = useState(0);
  const options = useLoad(() => http("/customer/campaign-options"));
  const st = useLoad(() => http("/customer/calls", { params: { ...f, limit: LIMIT, offset } }), [f.status, f.campaignId, f.from, f.to, offset]);
  const set = (k) => (e) => { setF({ ...f, [k]: e.target.value }); setOffset(0); };
  const showRec = me.permissions.recordings;

  return (
    <div>
      <PageHeader title="Call History" sub="Calls made for your campaigns"
        actions={me.actions.includes("reports_view") && (
          <button className="btn" onClick={() => downloadFile("/customer/reports/calls.csv", "calls-report.csv", f).catch((e) => alert(e.message))}>Download CSV</button>
        )} />
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 16 }}>
        <select className="input" style={{ maxWidth: 200 }} value={f.campaignId} onChange={set("campaignId")}>
          <option value="">All campaigns</option>
          {(options.data || []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select className="input" style={{ maxWidth: 160 }} value={f.status} onChange={set("status")}>
          <option value="">All statuses</option>
          {STATUSES.map((s) => <option key={s} value={s}>{s.replace("_", " ")}</option>)}
        </select>
        <input className="input" type="date" style={{ maxWidth: 160 }} value={f.from} onChange={set("from")} aria-label="From date" />
        <input className="input" type="date" style={{ maxWidth: 160 }} value={f.to} onChange={set("to")} aria-label="To date" />
      </div>
      <Boundary state={st}>
        {st.data?.length ? (
          <>
            <Table head={["Date/Time", "Campaign", "Contact", "Phone", "Duration", "Status", "Agent", ...(showRec ? ["Recording"] : [])]}>
              {st.data.map((c) => (
                <tr key={c.id}>
                  <td>{fmtDate(c.created_at)}</td><td>{c.campaign_name}</td><td>{c.customer_name || "—"}</td><td>{c.phone}</td>
                  <td>{fmtDur(c.duration_sec)}</td><td><StatusBadge status={c.status} /></td><td>{c.agent_name || "—"}</td>
                  {showRec && <td>{c.has_recording ? "🎙️ Available" : "—"}</td>}
                </tr>
              ))}
            </Table>
            <Pager offset={offset} limit={LIMIT} count={st.data.length} onChange={setOffset} />
          </>
        ) : <div className="card">No calls found.</div>}
      </Boundary>
    </div>
  );
}
