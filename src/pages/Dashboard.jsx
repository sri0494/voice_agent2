import { useEffect, useState } from "react";
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, PieChart, Pie, Cell } from "recharts";
import * as api from "../services/api.js";
import StatCard from "../components/StatCard.jsx";
import { LoadingState, ErrorState } from "../components/DataState.jsx";

const PIE_COLORS = ["#00D4FF", "#8B5CF6", "#10B981", "#F59E0B", "#EF4444", "#6B7690"];

export default function Dashboard() {
  const [summary, setSummary] = useState(null);
  const [byDay, setByDay] = useState([]);
  const [outcomes, setOutcomes] = useState([]);
  const [state, setState] = useState("loading");

  const load = async () => {
    setState("loading");
    try {
      const [s, day, out] = await Promise.all([
        api.getAnalyticsSummary("30d"),
        api.getCallsByDay("30d"),
        api.getOutcomes(),
      ]);
      setSummary(s);
      setByDay(day.map((d) => ({ day: new Date(d.day).toLocaleDateString("en-IN", { month: "short", day: "numeric" }), count: Number(d.count) })));
      setOutcomes(out.map((o) => ({ name: o.status, value: Number(o.count) })));
      setState("ready");
    } catch {
      setState("error");
    }
  };

  useEffect(() => { load(); }, []);

  if (state === "loading") return <LoadingState label="Loading dashboard..." />;
  if (state === "error") return <ErrorState onRetry={load} />;

  return (
    <div>
      <div className="section-title">Overview</div>
      <div className="section-sub">Last 30 days across all campaigns and agents</div>

      <div className="grid grid-cols-4" style={{ marginBottom: 16 }}>
        <StatCard label="Total Calls" value={summary.totalCalls} icon="📞" color="cyan" />
        <StatCard label="Connected Calls" value={summary.connectedCalls} icon="🔗" color="green" />
        <StatCard label="Live Calls" value={summary.liveCalls} icon="🔴" color="purple" />
        <StatCard label="Completed" value={summary.completedCalls} icon="✅" color="green" />
      </div>
      <div className="grid grid-cols-4" style={{ marginBottom: 16 }}>
        <StatCard label="Missed Calls" value={summary.missedCalls} icon="📵" color="red" />
        <StatCard label="Human Transfers" value={summary.humanTransfers} icon="🙋" color="amber" />
        <StatCard label="Conversion Rate" value={`${summary.conversionRate}%`} icon="🎯" color="cyan" />
        <StatCard label="AI Resolution Rate" value={`${summary.aiResolutionRate}%`} icon="🤖" color="purple" />
      </div>
      <div className="grid grid-cols-4" style={{ marginBottom: 24 }}>
        <StatCard label="Avg. Call Duration" value={`${Math.floor(summary.avgDurationSec / 60)}m ${summary.avgDurationSec % 60}s`} icon="⏱️" color="cyan" />
        <StatCard label="Active Campaigns" value={summary.activeCampaigns} icon="📣" color="green" />
        <StatCard label="Active AI Agents" value={summary.activeAgents} icon="🧠" color="purple" />
        <StatCard label="Knowledge Base Chunks" value={summary.totalChunks} icon="📚" color="amber" />
      </div>

      <div className="grid grid-cols-2">
        <div className="card">
          <div style={{ fontWeight: 600, marginBottom: 12 }}>Calls (last 30 days)</div>
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={byDay}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="day" stroke="var(--text-secondary)" fontSize={11} />
              <YAxis stroke="var(--text-secondary)" fontSize={11} allowDecimals={false} />
              <Tooltip contentStyle={{ background: "var(--bg-elevated)", border: "1px solid var(--border)", borderRadius: 8 }} />
              <Line type="monotone" dataKey="count" stroke="var(--cyan)" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>

        <div className="card">
          <div style={{ fontWeight: 600, marginBottom: 12 }}>Call Outcomes</div>
          {outcomes.length === 0 ? (
            <div className="state-block">No call data yet.</div>
          ) : (
            <ResponsiveContainer width="100%" height={260}>
              <PieChart>
                <Pie data={outcomes} dataKey="value" nameKey="name" innerRadius={55} outerRadius={90} paddingAngle={3}>
                  {outcomes.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                </Pie>
                <Tooltip contentStyle={{ background: "var(--bg-elevated)", border: "1px solid var(--border)", borderRadius: 8 }} />
              </PieChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>
    </div>
  );
}
