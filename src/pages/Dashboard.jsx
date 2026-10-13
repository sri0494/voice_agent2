import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid, PieChart, Pie, Cell } from "recharts";
import * as api from "../services/api.js";
import * as media from "../services/http.js";
import { useAuth } from "../context/AuthContext.jsx";
import StatusBadge from "../components/StatusBadge.jsx";
import { LoadingState, ErrorState } from "../components/DataState.jsx";
import "./dashboard.css";

const COLORS = ["#00D4FF", "#8B5CF6", "#10B981", "#F59E0B", "#EF4444", "#6B7690"];
const RANGES = [{ v: "7d", l: "7 days" }, { v: "30d", l: "30 days" }];
const tip = { contentStyle: { background: "var(--bg-elevated)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 } };
const dur = (s) => { s = Math.round(Number(s) || 0); return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`; };
const ok = (r) => (r.status === "fulfilled" ? r.value : null);
const greeting = () => { const h = new Date().getHours(); return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening"; };

export default function Dashboard() {
  const { user } = useAuth();
  const [range, setRange] = useState("30d");
  const [d, setD] = useState(null);
  const [state, setState] = useState("loading");

  const load = async () => {
    setState((s) => (s === "ready" ? s : "loading"));
    try {
      // The summary is essential; everything else is optional and a failure only hides that panel
      // (e.g. integrations are manager-only, customer accounts are admin-only).
      const [summary, ...rest] = await Promise.allSettled([
        api.getAnalyticsSummary(range), api.getCallsByDay(range), api.getOutcomes(), api.getSentiment(),
        api.getCalls({ limit: 6 }), api.getCampaigns(), media.getRecordings(), api.getIntegrations(), api.getAgents(),
      ]);
      if (summary.status !== "fulfilled") throw summary.reason;
      const [byDay, outcomes, sentiment, calls, campaigns, recordings, infra, agents] = rest.map(ok);
      setD({ summary: summary.value, byDay, outcomes, sentiment, calls, campaigns, recordings, infra, agents });
      setState("ready");
    } catch { setState("error"); }
  };
  useEffect(() => { load(); }, [range]);
  useEffect(() => { const t = setInterval(load, 30000); return () => clearInterval(t); }, [range]);

  const series = useMemo(() => (d?.byDay || []).map((x) => ({ day: new Date(x.day).toLocaleDateString("en-IN", { month: "short", day: "numeric" }), count: Number(x.count) })), [d]);
  const outcomes = useMemo(() => (d?.outcomes || []).map((o) => ({ name: o.status, value: Number(o.count) })), [d]);
  const sentiment = useMemo(() => (d?.sentiment || []).map((o) => ({ name: o.sentiment || "Unknown", value: Number(o.count) })), [d]);

  if (state === "loading") return <LoadingState label="Loading dashboard..." />;
  if (state === "error") return <ErrorState onRetry={load} />;
  const s = d.summary; const total = Number(s.totalCalls) || 0;
  const connectRate = total ? Math.round((Number(s.connectedCalls) / total) * 100) : 0;
  const outcomeTotal = outcomes.reduce((a, b) => a + b.value, 0);
  const campaigns = d.campaigns || []; const agents = d.agents || [];
  const running = campaigns.filter((c) => c.status === "Running");
  const showSetup = d.campaigns && d.agents && (agents.length === 0 || campaigns.length === 0 || campaigns.every((c) => Number(c.contact_count) === 0) || total === 0);

  return (
    <div>
      <div className="dx-hero">
        <div>
          <div className="dx-hello">{greeting()}{user?.name ? `, ${user.name.split(" ")[0]}` : ""} 👋</div>
          <div className="dx-sub">{new Date().toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric" })} · {running.length} campaign{running.length === 1 ? "" : "s"} running · {s.liveCalls} live call{Number(s.liveCalls) === 1 ? "" : "s"}</div>
        </div>
        <div className="dx-actions">
          <div className="dx-seg">{RANGES.map((r) => <button key={r.v} className={range === r.v ? "on" : ""} onClick={() => setRange(r.v)}>{r.l}</button>)}</div>
          <Link to="/campaigns" className="btn btn-primary btn-sm">+ New Campaign</Link>
          <Link to="/live-calls" className="btn btn-sm">🔴 Live Calls</Link>
          <Link to="/recordings" className="btn btn-sm">🎙️ Recordings</Link>
        </div>
      </div>

      <div className="dx-kpis">
        <div className="dx-kpi" style={{ "--accent": "var(--cyan)" }}><div className="l">📞 Total Calls</div><div className="v">{total}</div><div className="n">{connectRate}% connected · last {range === "7d" ? "7" : "30"} days</div></div>
        <div className="dx-kpi" style={{ "--accent": "var(--green)" }}><div className="l">✅ Completed</div><div className="v">{s.completedCalls}</div><div className="n">{s.connectedCalls} connected · {s.missedCalls} missed</div></div>
        <div className="dx-kpi" style={{ "--accent": "var(--purple)" }}><div className="l">🤖 AI Resolution</div><div className="v">{s.aiResolutionRate}%</div><div className="n">{s.humanTransfers} handed to a human</div></div>
        <div className="dx-kpi" style={{ "--accent": "var(--amber)" }}><div className="l">⏱️ Avg. Duration</div><div className="v">{dur(s.avgDurationSec)}</div><div className="n">Conversion {s.conversionRate}%</div></div>
      </div>

      <div className="dx-mini">
        <Link to="/live-calls"><div className="l">🔴 Live now</div><div className="v">{s.liveCalls}</div></Link>
        <Link to="/calls"><div className="l">📵 Missed</div><div className="v">{s.missedCalls}</div></Link>
        <Link to="/calls"><div className="l">🙋 Transfers</div><div className="v">{s.humanTransfers}</div></Link>
        <Link to="/campaigns"><div className="l">📣 Active campaigns</div><div className="v">{s.activeCampaigns}</div></Link>
        <Link to="/ai-engine/agents"><div className="l">🧠 Active agents</div><div className="v">{s.activeAgents}</div></Link>
        <Link to="/knowledge-base"><div className="l">📚 KB chunks</div><div className="v">{s.totalChunks}</div></Link>
        <Link to="/recordings"><div className="l">🎙️ Recordings</div><div className="v">{d.recordings ? d.recordings.length : "—"}</div></Link>
        <Link to="/analytics"><div className="l">📈 Conversion</div><div className="v">{s.conversionRate}%</div></Link>
      </div>

      <div className="dx-grid">
        <div className="card">
          <div className="dx-h"><b>Calls over time</b><Link to="/analytics">Full analytics →</Link></div>
          {series.length === 0 ? <div className="state-block">No calls in this period yet.</div> : (
            <ResponsiveContainer width="100%" height={250}>
              <AreaChart data={series}>
                <defs><linearGradient id="dxg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#00D4FF" stopOpacity={0.35} /><stop offset="100%" stopColor="#00D4FF" stopOpacity={0} /></linearGradient></defs>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="day" stroke="var(--text-secondary)" fontSize={11} />
                <YAxis stroke="var(--text-secondary)" fontSize={11} allowDecimals={false} />
                <Tooltip {...tip} />
                <Area type="monotone" dataKey="count" name="Calls" stroke="#00D4FF" strokeWidth={2} fill="url(#dxg)" />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>
        <div className="card">
          <div className="dx-h"><b>Call outcomes</b></div>
          {outcomeTotal === 0 ? <div className="state-block">No call data yet.</div> : (
            <>
              <div style={{ position: "relative" }}>
                <ResponsiveContainer width="100%" height={170}>
                  <PieChart><Pie data={outcomes} dataKey="value" nameKey="name" innerRadius={52} outerRadius={78} paddingAngle={3} stroke="none">{outcomes.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}</Pie><Tooltip {...tip} /></PieChart>
                </ResponsiveContainer>
                <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", pointerEvents: "none" }}><div style={{ textAlign: "center" }}><div style={{ fontSize: 22, fontWeight: 700 }}>{outcomeTotal}</div><div style={{ fontSize: 11, color: "var(--text-secondary)" }}>calls</div></div></div>
              </div>
              <div className="dx-legend">{outcomes.map((o, i) => <span key={o.name}><i style={{ background: COLORS[i % COLORS.length] }} />{o.name}<em>{o.value} · {Math.round((o.value / outcomeTotal) * 100)}%</em></span>)}</div>
            </>
          )}
        </div>
      </div>

      <div className="dx-grid3">
        <div className="card">
          <div className="dx-h"><b>Recent calls</b><Link to="/calls">View all →</Link></div>
          {!d.calls?.length ? <div className="state-block">No calls yet.</div> : d.calls.map((c) => (
            <div className="dx-row" key={c.id}>
              <div style={{ minWidth: 0 }}><Link to={`/calls/${c.id}`} style={{ color: "var(--cyan)", fontWeight: 600 }}>{c.customer_name || c.phone}</Link>
                <small>{c.campaign_name || "Inbound"} · {c.duration_sec ? dur(c.duration_sec) : "—"}{c.recording_count > 0 ? " · 🎙️" : ""}</small></div>
              <StatusBadge status={c.status} />
            </div>
          ))}
        </div>

        <div className="card">
          <div className="dx-h"><b>Campaigns</b><Link to="/campaigns">Manage →</Link></div>
          {!campaigns.length ? <div className="state-block">No campaigns yet.</div> : campaigns.slice(0, 5).map((c) => (
            <div className="dx-row" key={c.id}>
              <div style={{ minWidth: 0 }}><Link to={`/campaigns/${c.id}`} style={{ color: "var(--cyan)", fontWeight: 600 }}>{c.name}</Link>
                <small>{c.contact_count} contacts · {c.call_count} calls{c.client_name ? ` · ${c.client_name}` : ""}</small></div>
              <StatusBadge status={c.status} />
            </div>
          ))}
        </div>

        <div className="card">
          <div className="dx-h"><b>System status</b><Link to="/integrations">Details →</Link></div>
          {!d.infra?.builtIn ? <div className="state-block">Available to managers and admins.</div> : d.infra.builtIn.map((p) => (
            <div className="dx-row" key={p.envVar}>
              <div><span className={`dx-dot ${p.status === "CONNECTED" ? "ok" : p.status === "ERROR" ? "err" : "off"}`} />{p.name}<small>{p.value}</small></div>
              <span style={{ fontSize: 11.5, color: p.status === "CONNECTED" ? "var(--green)" : p.status === "ERROR" ? "var(--red)" : "var(--amber)" }}>{p.status === "DISCONNECTED" ? "mock" : p.status.toLowerCase()}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="dx-grid" style={{ gridTemplateColumns: showSetup ? "1fr 1fr" : "1fr" }}>
        <div className="card">
          <div className="dx-h"><b>Latest recordings</b><Link to="/recordings">All recordings →</Link></div>
          {!d.recordings?.length ? <div className="state-block">No recordings yet. Calls with recording enabled and consent will appear here.</div> : d.recordings.slice(0, 4).map((r) => (
            <div className="dx-row" key={r.id}>
              <div>🎙️ {new Date(r.created_at).toLocaleString()}<small>{r.duration_sec ? dur(r.duration_sec) : "—"} · {r.source === "telephony" ? "Phone call" : r.source === "browser" ? "Browser recording" : "Upload"}</small></div>
              {r.call_id ? <Link to={`/calls/${r.call_id}`} className="btn btn-sm">Open call</Link> : <Link to="/recordings" className="btn btn-sm">Open</Link>}
            </div>
          ))}
        </div>
        {showSetup && (
          <div className="card">
            <div className="dx-h"><b>Getting started</b></div>
            <ul className="dx-steps">
              {[
                [agents.length > 0, "Create an AI agent", "/ai-engine/agents"],
                ...(d.infra?.builtIn ? [[d.infra.builtIn.some((p) => p.type === "TELEPHONY" && p.status === "CONNECTED"), "Connect telephony (Exotel) in Integrations", "/integrations"]] : []),
                [campaigns.length > 0, "Create a campaign", "/campaigns"],
                [campaigns.some((c) => Number(c.contact_count) > 0), "Upload contacts (CSV) to the campaign", campaigns[0] ? `/campaigns/${campaigns[0].id}` : "/campaigns"],
                [total > 0, "Place your first call", "/campaigns"],
              ].map(([done, label, to]) => <li key={label} className={done ? "done" : ""}><div className="c">{done ? "✓" : ""}</div><Link to={to}><span>{label}</span></Link></li>)}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
