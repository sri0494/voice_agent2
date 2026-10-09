import { useEffect, useState } from "react";
import { getToken, http } from "../services/http.js";
import PortalApp from "./PortalApp.jsx";

/**
 * Wrap your existing app (inside <BrowserRouter>):  <CustomerGate><YourExistingApp /></CustomerGate>
 *  - not logged in            -> your app (login page)
 *  - logged in as CUSTOMER    -> customer portal ONLY (never the admin layout), also after a refresh
 *  - anyone else              -> your app, unchanged
 * This only chooses which UI to show. The server enforces access regardless (customer tokens get 403 on admin APIs).
 */
export default function CustomerGate({ children }) {
  const [token, setToken] = useState(getToken());
  const [role, setRole] = useState(null); // null = still checking

  // Detect login / logout without needing to touch AuthContext.
  useEffect(() => {
    const t = setInterval(() => setToken((prev) => { const now = getToken(); return prev === now ? prev : now; }), 500);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    let live = true;
    setRole(null);
    if (!token) return undefined;
    http("/customer/role")
      .then((r) => live && setRole(r.role))
      // A DB-checked 403 here only ever happens to a CUSTOMER whose account/customer is inactive: show the portal's message, never the admin shell.
      .catch((e) => live && setRole(e.status === 403 ? "CUSTOMER" : "UNKNOWN"));
    return () => { live = false; };
  }, [token]);

  if (!token) return children;
  if (role === null) return <div style={{ padding: 40, textAlign: "center", color: "var(--text-secondary)" }}>Loading…</div>;
  if (role === "CUSTOMER") return <PortalApp />;
  return children;
}
