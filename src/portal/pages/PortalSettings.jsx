import { useState } from "react";
import { getToken, http, replaceToken } from "../../services/http.js";
import { PageHeader } from "../ui.jsx";

export default function PortalSettings({ me }) {
  const [f, setF] = useState({ currentPassword: "", newPassword: "", confirm: "" });
  const [msg, setMsg] = useState({ ok: false, text: "" });
  const [saving, setSaving] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (f.newPassword.length < 8) return setMsg({ ok: false, text: "New password must be at least 8 characters." });
    if (f.newPassword !== f.confirm) return setMsg({ ok: false, text: "Passwords do not match." });
    setSaving(true);
    try {
      const old = getToken();
      const res = await http("/customer/me/password", { method: "PUT", body: { currentPassword: f.currentPassword, newPassword: f.newPassword } });
      replaceToken(old, res?.token);   // the server invalidates older tokens; keep THIS session signed in
      setF({ currentPassword: "", newPassword: "", confirm: "" });
      setMsg({ ok: true, text: "Password updated." });
    } catch (err) { setMsg({ ok: false, text: err.message }); } finally { setSaving(false); }
  };

  return (
    <div>
      <PageHeader title="Settings" sub="Your account" />
      <div className="card" style={{ maxWidth: 520, marginBottom: 16 }}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>Profile</div>
        <div style={{ fontSize: 14, lineHeight: 1.9 }}>
          <div><span style={{ color: "var(--text-secondary)" }}>Company: </span>{me.customer.companyName || me.customer.name}</div>
          <div><span style={{ color: "var(--text-secondary)" }}>Name: </span>{me.user.name || "—"}</div>
          <div><span style={{ color: "var(--text-secondary)" }}>Login email: </span>{me.user.email}</div>
        </div>
      </div>
      <form className="card" onSubmit={submit} style={{ maxWidth: 520 }}>
        <div style={{ fontWeight: 600, marginBottom: 12 }}>Change password</div>
        <div className="form-group"><label>Current password</label><input className="input" type="password" autoComplete="current-password" required value={f.currentPassword} onChange={(e) => setF({ ...f, currentPassword: e.target.value })} /></div>
        <div className="form-group"><label>New password</label><input className="input" type="password" autoComplete="new-password" required value={f.newPassword} onChange={(e) => setF({ ...f, newPassword: e.target.value })} /></div>
        <div className="form-group"><label>Confirm new password</label><input className="input" type="password" autoComplete="new-password" required value={f.confirm} onChange={(e) => setF({ ...f, confirm: e.target.value })} /></div>
        {msg.text && <div role="status" style={{ fontSize: 13, marginBottom: 10, color: msg.ok ? "#16a34a" : "#e5484d" }}>{msg.text}</div>}
        <button className="btn btn-primary" disabled={saving}>{saving ? "Saving..." : "Update password"}</button>
      </form>
    </div>
  );
}
