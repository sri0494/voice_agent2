import { useEffect, useState } from "react";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid,
  PieChart, Pie, Cell, LineChart, Line,
} from "recharts";
import * as api from "../services/api.js";
import StatCard from "../components/StatCard.jsx";
import { LoadingState, ErrorState } from "../components/DataState.jsx";

const COLORS = ["#00D4FF", "#8B5CF6", "#10B981", "#F59E0B", "#EF4444", "#6B7690"];
const RANGES = [
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "7d", label: "7 Days" },
  { value: "30d", label: "30 Days" },
];

export default function Analytics() {
  const [range, setRange] = useState("30d");
  const [summary, setSummary] = useState(null);
  const [byDay, setByDay] = useState([]);
  const [byCampaign, setByCampaign] = useState([]);
  const [byLanguage, setByLanguage] = useState([]);
  const [outcomes, setOutcomes] = useState([]);
  const [sentiment, setSentiment] = useState([]);
  const [state, setState] = useState("loading");

  const load = async () => {
    setState("loading");
    try {
      const [s, day, camp, lang, out, sent] = await Promise.all([
        api.getAnalyticsSummary(range),
        api.getCallsByDay(range),
        api.getCallsByCampaign(),
        api.getCallsByLanguage(),
        api.getOutcomes(),
        api.getSentiment(),
      ]);
      setSummary(s);
      setByDay(day.map((d) => ({ day: new Date(d.day).toLocaleDateString("en-IN", { month: "short", day: "numeric" }), count: Number(d.count) })));
      setByCampaign(camp.map((c) => ({ name: c.name, count: Number(c.count) })));
      setByLanguage(lang.map((l) => ({ name: l.language, value: Number(l.count) })));
      setOutcomes(out.map((o) => ({ name: o.status, value: Number(o.count) })));
      setSentiment(sent.map((s2) => ({ name: s2.sentiment, value: Number(s2.count) })));
      setState("ready");
    } catch {
      setState("error");
    }
  };

  useEffect(() => { load(); }, [range]);

  if (state === "loading") return <LoadingState label="Loading analytics..." />;
  if (state === "error") return <ErrorState onRetry={load} />;

  const chartTooltip = { contentStyle: { background: "var(--bg-elevated)", border: "1px solid var(--border)", borderRadius: 8 } };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", flexWrap: "wrap", gap: 12, marginBottom: 16 }}>
        <div>
          <div className="section-title">Call Analytics</div>
          <div className="section-sub">Performance across campaigns, agents, and languages</div>
        </div>
        <select className="input" style={{ width: 180 }} value={range} onChange={(e) => setRange(e.target.value)}>
          {RANGES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
        </select>
      </div>

      <div className="grid grid-cols-4" style={{ marginBottom: 20 }}>
        <StatCard label="Total Calls" value={summary.totalCalls} icon="📞" color="cyan" />
        <StatCard label="Connected" value={summary.connectedCalls} icon="🔗" color="green" />
        <StatCard label="AI Resolved" value={`${summary.aiResolutionRate}%`} icon="🤖" color="purple" />
        <StatCard label="Conversion" value={`${summary.conversionRate}%`} icon="🎯" color="amber" />
      </div>

      <div className="grid grid-cols-2" style={{ marginBottom: 16 }}>
        <div className="card">
          <div style={{ fontWeight: 600, marginBottom: 12 }}>Calls by Day</div>
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={byDay}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="day" stroke="var(--text-secondary)" fontSize={11} />
              <YAxis stroke="var(--text-secondary)" fontSize={11} allowDecimals={false} />
              <Tooltip {...chartTooltip} />
              <Line type="monotone" dataKey="count" stroke="var(--cyan)" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
        <div className="card">
          <div style={{ fontWeight: 600, marginBottom: 12 }}>Calls by Campaign</div>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={byCampaign}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="name" stroke="var(--text-secondary)" fontSize={10} interval={0} angle={-15} textAnchor="end" height={50} />
              <YAxis stroke="var(--text-secondary)" fontSize={11} allowDecimals={false} />
              <Tooltip {...chartTooltip} />
              <Bar dataKey="count" fill="var(--purple)" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="grid grid-cols-3">
        <div className="card">
          <div style={{ fontWeight: 600, marginBottom: 12 }}>Calls by Language</div>
          <ResponsiveContainer width="100%" height={220}>
            <PieChart>
              <Pie data={byLanguage} dataKey="value" nameKey="name" outerRadius={80}>
                {byLanguage.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
              </Pie>
              <Tooltip {...chartTooltip} />
            </PieChart>
          </ResponsiveContainer>
        </div>
        <div className="card">
          <div style={{ fontWeight: 600, marginBottom: 12 }}>Call Outcomes</div>
          <ResponsiveContainer width="100%" height={220}>
            <PieChart>
              <Pie data={outcomes} dataKey="value" nameKey="name" outerRadius={80}>
                {outcomes.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
              </Pie>
              <Tooltip {...chartTooltip} />
            </PieChart>
          </ResponsiveContainer>
        </div>
        <div className="card">
          <div style={{ fontWeight: 600, marginBottom: 12 }}>Sentiment</div>
          <ResponsiveContainer width="100%" height={220}>
            <PieChart>
              <Pie data={sentiment} dataKey="value" nameKey="name" outerRadius={80}>
                {sentiment.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
              </Pie>
              <Tooltip {...chartTooltip} />
            </PieChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}
