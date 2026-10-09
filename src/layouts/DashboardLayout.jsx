import { useState, useEffect } from "react";
import { Outlet, useLocation } from "react-router-dom";
import Sidebar from "../components/Sidebar.jsx";
import Topbar from "../components/Topbar.jsx";

const TITLES = {
  "/dashboard": "Dashboard",
  "/campaigns": "Campaigns",
  "/live-calls": "Live Calls",
  "/calls": "Calls",
  "/ai-engine/agents": "AI Engine",
  "/knowledge-base": "Knowledge Base",
  "/analytics": "Analytics",
  "/contact-requests": "Contact Requests",
  "/integrations": "Integrations",
  "/settings": "Settings",
};

export default function DashboardLayout() {
  const location = useLocation();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [theme, setTheme] = useState(() => localStorage.getItem("leomox_theme") || "dark");

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("leomox_theme", theme);
  }, [theme]);

  useEffect(() => { setSidebarOpen(false); }, [location.pathname]);

  const title = Object.entries(TITLES).find(([path]) => location.pathname.startsWith(path))?.[1] || "LeoMox";

  return (
    <div className="app-shell">
      <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
      <div className="main-area">
        <Topbar
          title={title}
          theme={theme}
          onToggleTheme={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
          onToggleSidebar={() => setSidebarOpen((o) => !o)}
        />
        <div className="page-content">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
