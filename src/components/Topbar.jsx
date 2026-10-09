import { useAuth } from "../context/AuthContext.jsx";

export default function Topbar({ title, theme, onToggleTheme, onToggleSidebar }) {
  const { user, signOut } = useAuth();

  return (
    <header className="topbar">
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <button className="sidebar-toggle" onClick={onToggleSidebar} aria-label="Toggle menu">☰</button>
        <div className="topbar-title">{title}</div>
      </div>
      <div className="topbar-actions">
        <button className="icon-btn" onClick={onToggleTheme} title="Toggle theme">
          {theme === "dark" ? "☀️" : "🌙"}
        </button>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ textAlign: "right", display: "none" }} className="user-name">
            <div style={{ fontSize: 13, fontWeight: 600 }}>{user?.name}</div>
            <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>{user?.role}</div>
          </div>
          <button className="btn btn-sm" onClick={signOut}>Logout</button>
        </div>
      </div>
    </header>
  );
}
