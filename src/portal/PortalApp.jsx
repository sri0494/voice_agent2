import { useEffect, useState } from "react";
import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import { clearAuth, http } from "../services/http.js";
import PortalDashboard from "./pages/PortalDashboard.jsx";
import PortalCampaigns from "./pages/PortalCampaigns.jsx";
import PortalContacts from "./pages/PortalContacts.jsx";
import PortalRecordings from "./pages/PortalRecordings.jsx";
import PortalCallHistory from "./pages/PortalCallHistory.jsx";
import PortalAnalytics from "./pages/PortalAnalytics.jsx";
import PortalAgents from "./pages/PortalAgents.jsx";
import PortalSettings from "./pages/PortalSettings.jsx";

// `key` is the module name returned by GET /api/customer/me -> permissions. Nothing is hard-coded per customer.
const MODULES = [
  { key: "dashboard", path: "/customer", label: "Dashboard", icon: "📊", end: true, Page: PortalDashboard },
  { key: "campaigns", path: "/customer/campaigns", label: "Campaigns", icon: "📣", Page: PortalCampaigns },
  { key: "contacts", path: "/customer/contacts", label: "Contacts / Call Lists", icon: "👥", Page: PortalContacts },
  { key: "recordings", path: "/customer/recordings", label: "Recordings", icon: "🎙️", Page: PortalRecordings },
  { key: "call_history", path: "/customer/call-history", label: "Call History", icon: "📞", Page: PortalCallHistory },
  { key: "analytics", path: "/customer/analytics", label: "Analytics", icon: "📈", Page: PortalAnalytics },
  { key: "agents", path: "/customer/agents", label: "Agents", icon: "🤖", Page: PortalAgents },
  { key: "settings", path: "/customer/settings", label: "Settings", icon: "⚙️", Page: PortalSettings },
];

const CSS = `
.cp-shell{display:flex;min-height:100vh}
.cp-side{width:240px;flex:0 0 240px;background:var(--card,var(--bg-card,#fff));border-right:1px solid var(--border,#e5e7eb);padding:16px 12px;display:flex;flex-direction:column;gap:4px}
.cp-main{flex:1;min-width:0;display:flex;flex-direction:column}
.cp-top{display:flex;align-items:center;gap:12px;padding:12px 20px;border-bottom:1px solid var(--border,#e5e7eb);background:var(--card,var(--bg-card,#fff))}
.cp-body{padding:20px;max-width:1200px;width:100%;box-sizing:border-box}
.cp-link{display:flex;gap:10px;align-items:center;padding:10px 12px;border-radius:10px;text-decoration:none;color:var(--text-secondary,#555);font-size:14.5px}
.cp-link.active{background:rgba(56,189,248,.15);color:var(--cyan,#0891b2);font-weight:600}
.cp-burger{display:none}
@media (max-width: 860px){
  .cp-side{position:fixed;inset:0 auto 0 0;z-index:50;transform:translateX(-100%);transition:transform .2s;box-shadow:2px 0 12px rgba(0,0,0,.25)}
  .cp-side.open{transform:none}
  .cp-burger{display:inline-flex}
  .cp-body{padding:14px}
}
.cp-scrim{display:none}
@media (max-width: 860px){.cp-scrim.open{display:block;position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:40}}
`;

export default function PortalApp() {
  const [me, setMe] = useState(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let live = true;
    http("/customer/me").then((d) => live && setMe(d)).catch((e) => live && setError(e.message || "Could not load your account"));
    return () => { live = false; };
  }, []);

  const logout = () => { clearAuth(); window.location.assign("/"); };

  if (error) {
    return (
      <div style={{ padding: 40, textAlign: "center" }}>
        <div className="section-title">Customer Portal</div>
        <p style={{ color: "var(--text-secondary)" }}>{error}</p>
        <button className="btn" onClick={logout}>Logout</button>
      </div>
    );
  }
  if (!me) return <div style={{ padding: 40, textAlign: "center", color: "var(--text-secondary)" }}>Loading your portal…</div>;

  const allowed = MODULES.filter((m) => me.permissions[m.key]);   // menu = exactly what the server says you may use
  const home = allowed[0]?.path;

  return (
    <div className="cp-shell">
      <style>{CSS}</style>
      <div className={`cp-scrim ${open ? "open" : ""}`} onClick={() => setOpen(false)} />
      <aside className={`cp-side ${open ? "open" : ""}`}>
        <div style={{ fontWeight: 700, fontSize: 18, padding: "4px 12px 14px" }}>LeoMox <span style={{ fontWeight: 400, fontSize: 12, color: "var(--text-secondary)" }}>Customer Portal</span></div>
        {allowed.map((m) => (
          <NavLink key={m.key} to={m.path} end={m.end} className={({ isActive }) => `cp-link ${isActive ? "active" : ""}`} onClick={() => setOpen(false)}>
            <span>{m.icon}</span><span>{m.label}</span>
          </NavLink>
        ))}
      </aside>
      <div className="cp-main">
        <header className="cp-top">
          <button className="btn btn-sm cp-burger" aria-label="Menu" onClick={() => setOpen(true)}>☰</button>
          <div style={{ fontWeight: 600, flex: 1 }}>{me.customer.companyName || me.customer.name}</div>
          <span style={{ fontSize: 13, color: "var(--text-secondary)" }}>{me.user.email}</span>
          <button className="btn btn-sm" onClick={logout}>Logout</button>
        </header>
        <main className="cp-body">
          {!allowed.length ? (
            <div className="card">No modules are enabled for your account yet. Please contact your administrator.</div>
          ) : (
            <Routes>
              {allowed.map(({ key, path, Page, end }) => (
                <Route key={key} path={end ? "/customer" : path} element={<Page me={me} />} />
              ))}
              {/* Any other URL (including admin URLs and modules you don't have) -> back to the portal home */}
              <Route path="*" element={<Navigate to={home} replace />} />
            </Routes>
          )}
        </main>
      </div>
    </div>
  );
}
