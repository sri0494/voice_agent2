import { useEffect, useState } from "react";
import { useAuth } from "../context/AuthContext.jsx";
import * as api from "../services/api.js";
import StatusBadge from "../components/StatusBadge.jsx";
import { LoadingState, ErrorState } from "../components/DataState.jsx";

const ROLES = ["SUPER_ADMIN", "ADMIN", "MANAGER", "AGENT", "VIEWER"];
const ADMIN_ROLES = ["SUPER_ADMIN", "ADMIN"];

export default function Settings() {
  const { user } = useAuth();
  const [tab, setTab] = useState("profile");

  return (
    <div>
      <div className="section-title">Settings</div>
      <div className="section-sub">Account, security, and team management</div>

      <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
        <button className={`btn btn-sm ${tab === "profile" ? "btn-primary" : ""}`} onClick={() => setTab("profile")}>Profile & Security</button>
        {ADMIN_ROLES.includes(user?.role) && (
          <button className={`btn btn-sm ${tab === "users" ? "btn-primary" : ""}`} onClick={() => setTab("users")}>User Management</button>
        )}
      </div>

      {tab === "profile" && <ProfileTab />}
      {tab === "users" && ADMIN_ROLES.includes(user?.role) && <UsersTab />}
    </div>
  );
}

function ProfileTab() {
  const { user } = useAuth();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");

  const handleChangePassword = async (e) => {
    e.preventDefault();
    setSaving(true);
    setMsg("");
    try {
      await api.changePassword(currentPassword, newPassword);
      setMsg("Password updated successfully.");
      setCurrentPassword("");
      setNewPassword("");
    } catch (err) {
      setMsg(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="grid grid-cols-2">
      <div className="card">
        <div style={{ fontWeight: 700, marginBottom: 12 }}>Profile</div>
        <Row label="Name" value={user?.name} />
        <Row label="Email" value={user?.email} />
        <Row label="Role" value={<StatusBadge status={user?.role} />} />
      </div>

      <div className="card">
        <div style={{ fontWeight: 700, marginBottom: 12 }}>Change Password</div>
        <form onSubmit={handleChangePassword}>
          <div className="form-group"><label>Current Password</label><input className="input" type="password" required value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} /></div>
          <div className="form-group"><label>New Password</label><input className="input" type="password" required minLength={8} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} /></div>
          {msg && <div style={{ fontSize: 13, marginBottom: 12, color: msg.includes("success") ? "var(--green)" : "var(--red)" }}>{msg}</div>}
          <button className="btn btn-primary" disabled={saving}>{saving ? "Updating..." : "Update Password"}</button>
        </form>
      </div>
    </div>
  );
}

function UsersTab() {
  const [users, setUsers] = useState([]);
  const [state, setState] = useState("loading");
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: "", email: "", phone: "", agentId: "", role: "AGENT", password: "" });
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setState("loading");
    try {
      setUsers(await api.getUsers());
      setState("ready");
    } catch {
      setState("error");
    }
  };

  useEffect(() => { load(); }, []);

  const handleCreate = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      await api.createUser(form);
      setForm({ name: "", email: "", phone: "", role: "AGENT", password: "" });
      setShowForm(false);
      load();
    } catch (err) {
      alert(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDisable = async (id) => {
    if (!confirm("Disable this user?")) return;
    await api.disableUser(id);
    load();
  };

  const handleReset = async (id) => {
    const pw = prompt("New password (min 8 characters):");
    if (!pw) return;
    try {
      await api.resetUserPassword(id, pw);
      alert("Password reset");
    } catch (err) {
      alert(err.message);
    }
  };

  if (state === "loading") return <LoadingState label="Loading users..." />;
  if (state === "error") return <ErrorState onRetry={load} />;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 14 }}>
        <button className="btn btn-primary" onClick={() => setShowForm((v) => !v)}>+ New User</button>
      </div>

      {showForm && (
        <form className="card" onSubmit={handleCreate} style={{ marginBottom: 16, maxWidth: 480 }}>
          <div className="form-group"><label>Name</label><input className="input" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
          <div className="form-group"><label>Email</label><input className="input" type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></div>
          <div className="form-group"><label>Phone</label><input className="input" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></div>
          <div className="form-group"><label>Agent ID <span style={{ fontWeight: 400, color: "var(--text-muted)" }}>(internal desk/agent code, optional)</span></label><input className="input" placeholder="e.g. AGT-014" value={form.agentId} onChange={(e) => setForm({ ...form, agentId: e.target.value })} /></div>
          <div className="form-group">
            <label>Role</label>
            <select className="input" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              {ROLES.map((r) => <option key={r}>{r}</option>)}
            </select>
          </div>
          <div className="form-group"><label>Temporary Password</label><input className="input" type="password" required minLength={8} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></div>
          <button className="btn btn-primary" disabled={saving}>{saving ? "Creating..." : "Create User"}</button>
        </form>
      )}

      <div className="table-wrap">
        <table>
          <thead><tr><th>Name</th><th>Email</th><th>Agent ID</th><th>Role</th><th>Status</th><th>Last Login</th><th>Actions</th></tr></thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>{u.name}</td>
                <td>{u.email}</td>
                <td>{u.agent_id || "—"}</td>
                <td><StatusBadge status={u.role} /></td>
                <td><StatusBadge status={u.status} /></td>
                <td>{u.last_login_at ? new Date(u.last_login_at).toLocaleDateString() : "Never"}</td>
                <td>
                  <div style={{ display: "flex", gap: 6 }}>
                    <button className="btn btn-sm" onClick={() => handleReset(u.id)}>Reset PW</button>
                    <button className="btn btn-sm btn-danger" onClick={() => handleDisable(u.id)}>Disable</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Row({ label, value }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "7px 0", borderBottom: "1px solid var(--border)", fontSize: 13.5 }}>
      <span style={{ color: "var(--text-secondary)" }}>{label}</span>
      <span style={{ fontWeight: 600 }}>{value}</span>
    </div>
  );
}
