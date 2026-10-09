import { NavLink } from "react-router-dom";

const NAV = [
  { to: "/dashboard", label: "Dashboard", icon: "📊" },
  { to: "/customers", label: "Customers", icon: "👤" },
  { to: "/campaigns", label: "Campaigns", icon: "📣" },
  { to: "/live-calls", label: "Live Calls", icon: "🔴" },
  { to: "/calls", label: "Calls", icon: "📞" },
  { to: "/ai-engine/agents", label: "AI Engine", icon: "🤖" },
  { to: "/knowledge-base", label: "Knowledge Base", icon: "📚" },
  { to: "/surveys", label: "Surveys", icon: "📋" },
  { to: "/phone-numbers", label: "Phone Numbers", icon: "☎️" },
  { to: "/analytics", label: "Analytics", icon: "📈" },
  { to: "/contact-requests", label: "Contact Requests", icon: "✉️" },
  { to: "/integrations", label: "Integrations", icon: "🔌" },
  { to: "/settings", label: "Settings", icon: "⚙️" },
];

export default function Sidebar({ open, onClose }) {
  return (
    <>
      <div className={`sidebar-backdrop ${open ? "open" : ""}`} onClick={onClose} />
      <aside className={`sidebar ${open ? "open" : ""}`}>
        <div className="sidebar-logo">
          <div className="sidebar-logo-mark">LX</div>
          <span>LeoMox</span>
        </div>
        <nav>
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              onClick={onClose}
              className={({ isActive }) => `sidebar-link ${isActive ? "active" : ""}`}
            >
              <span>{item.icon}</span>
              <span>{item.label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-footer">
          <div style={{ fontSize: 11.5, color: "var(--text-muted)", padding: "0 10px" }}>
            LeoMox Voice AI Platform
          </div>
        </div>
      </aside>
    </>
  );
}
