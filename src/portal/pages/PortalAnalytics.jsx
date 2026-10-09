import { useState } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { downloadFile, http } from "../../services/http.js";
import { Boundary, PageHeader, StatGrid, Table, fmtDur, useLoad } from "../ui.jsx";

export default function PortalAnalytics({ me }) {
  const [range, setRange] = useState({ from: "", to: "" });
  const st = useLoad(() => http("/customer/analytics", { params: range }), [range.from, range.to]);
  const a = st.data;
  const pct = (n) => (a?.total_calls ? `${Math.round((n / a.total_calls) * 100)}%` : "—");

  return (
    <div>
      <PageHeader title="Analytics" sub="Calculated only from your own calls"
        actions={me.actions.includes("reports_view") && (
          <button className="btn" onClick={() => downloadFile("/customer/reports/calls.csv", "calls-report.csv", range).catch((e) => alert(e.message))}>Download CSV report</button>
        )} />
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 16 }}>
        <input className="input" type="date" style={{ maxWidth: 170 }} value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} aria-label="From date" />
        <input className="input" type="date" style={{ maxWidth: 170 }} value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} aria-label="To date" />
      </div>
      <Boundary state={st}>
        {a && (
          <>
            <StatGrid items={[
              ["Total Calls", a.total_calls], ["Completed", a.completed_calls], ["Failed", a.failed_calls],
              ["Avg. Duration", fmtDur(a.avg_duration_sec)], ["Positive", `${a.positive} (${pct(a.positive)})`], ["Negative", `${a.negative} (${pct(a.negative)})`],
            ]} />
            <div className="card" style={{ marginBottom: 16 }}>
              <div style={{ fontWeight: 600, marginBottom: 8 }}>Calls per day</div>
              {a.daily.length ? (
                <div style={{ width: "100%", height: 220 }}>
                  <ResponsiveContainer>
                    <BarChart data={a.daily}><CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="day" fontSize={11} /><YAxis allowDecimals={false} fontSize={11} /><Tooltip /><Bar dataKey="calls" fill="#38bdf8" /></BarChart>
                  </ResponsiveContainer>
                </div>
              ) : <div style={{ color: "var(--text-secondary)" }}>No calls in this period.</div>}
            </div>
            <div style={{ fontWeight: 600, marginBottom: 8 }}>Campaign performance</div>
            {a.byCampaign.length ? (
              <Table head={["Campaign", "Calls", "Completed", "Avg. duration"]}>
                {a.byCampaign.map((c) => <tr key={c.id}><td>{c.name}</td><td>{c.calls}</td><td>{c.completed}</td><td>{fmtDur(c.avg_duration_sec)}</td></tr>)}
              </Table>
            ) : <div className="card">No campaigns yet.</div>}
          </>
        )}
      </Boundary>
    </div>
  );
}
