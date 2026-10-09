import { useState } from "react";
import { http } from "../services/http.js";
import StatusBadge from "../components/StatusBadge.jsx";
import { Boundary, PageHeader, StatGrid, Table, confirmDelete, fmtDate, fmtDur, useLoad } from "../portal/ui.jsx";

const DEFAULT_PERMS = ["dashboard", "settings_view"];
const label = (p, group) => (group.length === 1 ? "Access" : p.split("_").pop().replace(/^./, (c) => c.toUpperCase()));
const list = (d) => (Array.isArray(d) ? d : d?.campaigns || d?.items || d?.rows || []);

/** Permission checkboxes (groups come from the server so the UI never drifts from what the API accepts). */
function PermissionPicker({ groups, value, onChange }) {
  const has = (p) => value.includes(p);
  const toggle = (p, group) => {
    const view = group.find((x) => x.endsWith("_view"));
    let next = new Set(value);
    if (next.has(p)) {
      next.delete(p);
      if (p === view) group.forEach((x) => next.delete(x));          // removing "View" removes the group's actions
    } else {
      next.add(p);
      if (view) next.add(view);                                       // an action implies "View"
    }
    onChange([...next]);
  };
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 12 }}>
      {Object.entries(groups).map(([name, group]) => (
        <div key={name} style={{ border: "1px solid var(--border)", borderRadius: 10, padding: 10 }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>{name}</div>
          {group.map((p) => (
            <label key={p} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13.5, padding: "2px 0" }}>
              <input type="checkbox" checked={has(p)} onChange={() => toggle(p, group)} /> {label(p, group)}
            </label>
          ))}
        </div>
      ))}
    </div>
  );
}

export default function AdminCustomers() {
  const clients = useLoad(() => http("/clients"));
  const perms = useLoad(() => http("/clients/permissions"));
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState(null);
  const [notice, setNotice] = useState(null);

  const remove = async (c) => {
    if (!confirmDelete(`the customer account "${c.name}" and its logins (campaigns and call data are kept)`)) return;
    try { await http(`/clients/${c.id}`, { method: "DELETE" }); if (selected === c.id) setSelected(null); clients.reload(); } catch (err) { alert(err.message); }
  };

  return (
    <div>
      <PageHeader title="Customer Accounts" sub="Business customers who log in to see their own campaigns, calls and recordings"
        actions={<button className="btn btn-primary" onClick={() => setCreating((v) => !v)}>+ Add Customer</button>} />
      {notice && (
        <div className="card" style={{ marginBottom: 16, borderColor: "#16a34a" }}>
          <div style={{ fontWeight: 600 }}>{notice.title}</div>
          {notice.secret && <div style={{ margin: "6px 0" }}>Temporary password: <code style={{ fontSize: 15 }}>{notice.secret}</code> <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>(shown once — share it securely)</span></div>}
          <button className="btn btn-sm" onClick={() => setNotice(null)}>Dismiss</button>
        </div>
      )}
      {creating && perms.data && (
        <CreateForm groups={perms.data.groups} onCancel={() => setCreating(false)}
          onDone={(n) => { setCreating(false); setNotice(n); clients.reload(); }} />
      )}
      <Boundary state={clients}>
        {clients.data?.length ? (
          <Table head={["Customer", "Company", "Email", "Status", "Campaigns", "Logins", "Actions"]}>
            {clients.data.map((c) => (
              <tr key={c.id}>
                <td>{c.name}</td><td>{c.company_name || "—"}</td><td>{c.email || "—"}</td><td><StatusBadge status={c.status} /></td><td>{c.campaigns}</td><td>{c.logins}</td>
                <td><div style={{ display: "flex", gap: 6 }}>
                  <button className="btn btn-sm" onClick={() => setSelected(selected === c.id ? null : c.id)}>{selected === c.id ? "Close" : "Manage"}</button>
                  <button className="btn btn-sm btn-danger" onClick={() => remove(c)}>Delete</button>
                </div></td>
              </tr>
            ))}
          </Table>
        ) : <div className="card">No customer accounts yet.</div>}
      </Boundary>
      {selected && perms.data && (
        <CustomerPanel key={selected} id={selected} groups={perms.data.groups} onChanged={clients.reload} onNotice={setNotice} />
      )}
    </div>
  );
}

function CreateForm({ groups, onCancel, onDone }) {
  const [f, setF] = useState({ name: "", companyName: "", email: "", phone: "", loginEmail: "", password: "" });
  const [perms, setPerms] = useState(DEFAULT_PERMS);
  const [saving, setSaving] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  const submit = async (e) => {
    e.preventDefault(); setSaving(true);
    try {
      const c = await http("/clients", { method: "POST", body: { name: f.name, companyName: f.companyName, email: f.email, phone: f.phone } });
      await http(`/clients/${c.id}/permissions`, { method: "PUT", body: { permissions: perms } });
      let secret = null;
      if (f.loginEmail) {
        const l = await http(`/clients/${c.id}/login`, { method: "POST", body: { email: f.loginEmail, name: f.name, password: f.password || undefined } });
        secret = l.temporaryPassword || null;
      }
      onDone({ title: `Customer "${c.name}" created${f.loginEmail ? ` with login ${f.loginEmail.toLowerCase()}` : ""}.`, secret });
    } catch (err) { alert(err.message); } finally { setSaving(false); }
  };

  return (
    <form className="card" onSubmit={submit} style={{ marginBottom: 16 }}>
      <div style={{ fontWeight: 600, marginBottom: 12 }}>New customer account</div>
      <div className="grid grid-cols-2">
        <div className="form-group"><label>Customer Name</label><input className="input" required value={f.name} onChange={set("name")} /></div>
        <div className="form-group"><label>Company Name</label><input className="input" value={f.companyName} onChange={set("companyName")} /></div>
        <div className="form-group"><label>Email</label><input className="input" type="email" value={f.email} onChange={set("email")} /></div>
        <div className="form-group"><label>Phone</label><input className="input" value={f.phone} onChange={set("phone")} /></div>
        <div className="form-group"><label>Login email (username)</label><input className="input" type="email" value={f.loginEmail} onChange={set("loginEmail")} /></div>
        <div className="form-group"><label>Password (blank = generate one)</label><input className="input" type="text" minLength={8} autoComplete="off" value={f.password} onChange={set("password")} /></div>
      </div>
      <div style={{ fontWeight: 600, margin: "8px 0" }}>What can this customer see?</div>
      <PermissionPicker groups={groups} value={perms} onChange={setPerms} />
      <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
        <button className="btn btn-primary" disabled={saving}>{saving ? "Creating..." : "Create customer"}</button>
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

function CustomerPanel({ id, groups, onChanged, onNotice }) {
  const [tick, setTick] = useState(0);
  const st = useLoad(() => http(`/clients/${id}`), [id, tick]);
  const usage = useLoad(async () => ({
    usage: await http(`/clients/${id}/usage`), analytics: await http(`/clients/${id}/analytics`), calls: await http(`/clients/${id}/calls`, { params: { limit: 10 } }),
  }), [id, tick]);
  const allCampaigns = useLoad(() => http("/campaigns").catch(() => []));
  const refresh = () => { setTick((t) => t + 1); onChanged(); };
  const run = async (fn, okText) => { try { await fn(); if (okText) onNotice({ title: okText }); refresh(); } catch (err) { alert(err.message); } };

  const c = st.data;
  return (
    <div style={{ marginTop: 20 }}>
      <Boundary state={st}>
        {c && (
          <>
            <div className="section-title" style={{ marginBottom: 12 }}>{c.name}</div>
            <Details c={c} run={run} />
            <Section title="Permissions"><PermsEditor groups={groups} initial={c.permissions} onSave={(p) => run(() => http(`/clients/${id}/permissions`, { method: "PUT", body: { permissions: p } }), "Permissions saved.")} /></Section>
            <Section title="Logins"><Logins c={c} run={run} onNotice={onNotice} /></Section>
            <Section title="Campaigns"><Campaigns c={c} all={list(allCampaigns.data)} run={run} /></Section>
            <Section title="Usage">
              {usage.data && (
                <>
                  <StatGrid items={[["Campaigns", usage.data.usage.totalCampaigns], ["Contacts", usage.data.usage.totalContacts], ["Calls", usage.data.usage.totalCalls], ["Completed", usage.data.usage.completedCalls], ["Failed", usage.data.usage.failedCalls], ["Recordings", usage.data.usage.totalRecordings], ["Avg. duration", fmtDur(usage.data.analytics.avg_duration_sec)]]} />
                  {usage.data.calls.length ? (
                    <Table head={["Date", "Campaign", "Contact", "Status", "Duration"]}>
                      {usage.data.calls.map((x) => <tr key={x.id}><td>{fmtDate(x.created_at)}</td><td>{x.campaign_name}</td><td>{x.customer_name || "—"}</td><td><StatusBadge status={x.status} /></td><td>{fmtDur(x.duration_sec)}</td></tr>)}
                    </Table>
                  ) : <div style={{ color: "var(--text-secondary)" }}>No calls yet.</div>}
                </>
              )}
            </Section>
          </>
        )}
      </Boundary>
    </div>
  );
}

const Section = ({ title, children }) => (
  <div className="card" style={{ marginBottom: 16 }}><div style={{ fontWeight: 600, marginBottom: 10 }}>{title}</div>{children}</div>
);

function Details({ c, run }) {
  const [f, setF] = useState({ name: c.name || "", companyName: c.company_name || "", email: c.email || "", phone: c.phone || "", status: c.status });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  return (
    <Section title="Details">
      <div className="grid grid-cols-2">
        <div className="form-group"><label>Customer Name</label><input className="input" value={f.name} onChange={set("name")} /></div>
        <div className="form-group"><label>Company Name</label><input className="input" value={f.companyName} onChange={set("companyName")} /></div>
        <div className="form-group"><label>Email</label><input className="input" value={f.email} onChange={set("email")} /></div>
        <div className="form-group"><label>Phone</label><input className="input" value={f.phone} onChange={set("phone")} /></div>
        <div className="form-group"><label>Status</label>
          <select className="input" value={f.status} onChange={set("status")}><option>Active</option><option>Inactive</option></select>
        </div>
      </div>
      <button className="btn btn-primary" onClick={() => run(() => http(`/clients/${c.id}`, { method: "PUT", body: f }), "Details saved.")}>Save details</button>
      <span style={{ fontSize: 12, color: "var(--text-secondary)", marginLeft: 10 }}>Inactive customers cannot log in.</span>
    </Section>
  );
}

function PermsEditor({ groups, initial, onSave }) {
  const [value, setValue] = useState(initial);
  return (<><PermissionPicker groups={groups} value={value} onChange={setValue} /><button className="btn btn-primary" style={{ marginTop: 12 }} onClick={() => onSave(value)}>Save permissions</button></>);
}

function Logins({ c, run, onNotice }) {
  const [f, setF] = useState({ email: "", name: "", password: "" });
  const add = (e) => {
    e.preventDefault();
    run(async () => {
      const l = await http(`/clients/${c.id}/login`, { method: "POST", body: { email: f.email, name: f.name || c.name, password: f.password || undefined } });
      setF({ email: "", name: "", password: "" });
      onNotice({ title: `Login ${l.user.email} created.`, secret: l.temporaryPassword });
    });
  };
  return (
    <>
      {c.logins.length ? (
        <Table head={["Email", "Status", "Last login", "Actions"]}>
          {c.logins.map((u) => (
            <tr key={u.id}>
              <td>{u.email}</td><td><StatusBadge status={u.status} /></td><td>{fmtDate(u.last_login_at)}</td>
              <td><div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                <button className="btn btn-sm" onClick={() => run(async () => { const r = await http(`/clients/${c.id}/users/${u.id}/reset-password`, { method: "POST" }); onNotice({ title: `Password reset for ${u.email}.`, secret: r.temporaryPassword }); })}>Reset password</button>
                <button className="btn btn-sm" onClick={() => run(() => http(`/clients/${c.id}/users/${u.id}/status`, { method: "PUT", body: { active: String(u.status).toLowerCase() !== "active" } }))}>{String(u.status).toLowerCase() === "active" ? "Deactivate" : "Activate"}</button>
                <button className="btn btn-sm btn-danger" onClick={() => confirmDelete(`the login ${u.email}`) && run(() => http(`/clients/${c.id}/users/${u.id}`, { method: "DELETE" }))}>Delete</button>
              </div></td>
            </tr>
          ))}
        </Table>
      ) : <div style={{ color: "var(--text-secondary)", marginBottom: 10 }}>No logins yet.</div>}
      <form onSubmit={add} style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
        <input className="input" style={{ maxWidth: 240 }} type="email" required placeholder="Login email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
        <input className="input" style={{ maxWidth: 200 }} placeholder="Name (optional)" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        <input className="input" style={{ maxWidth: 220 }} minLength={8} placeholder="Password (blank = generate)" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
        <button className="btn btn-primary">Add login</button>
      </form>
    </>
  );
}

function Campaigns({ c, run, all }) {
  const [pick, setPick] = useState([]);
  const free = all.filter((x) => x.client_id !== c.id && !c.campaigns.some((m) => m.id === x.id));
  return (
    <>
      {c.campaigns.length ? (
        <Table head={["Campaign", "Status", "Actions"]}>
          {c.campaigns.map((m) => (
            <tr key={m.id}><td>{m.name}</td><td><StatusBadge status={m.status} /></td>
              <td><button className="btn btn-sm" onClick={() => confirmDelete(`the assignment of "${m.name}" (the campaign itself is kept)`) && run(() => http(`/clients/${c.id}/campaigns/${m.id}`, { method: "DELETE" }))}>Unassign</button></td></tr>
          ))}
        </Table>
      ) : <div style={{ color: "var(--text-secondary)", marginBottom: 10 }}>No campaigns assigned.</div>}
      <div style={{ marginTop: 12 }}>
        <select multiple className="input" style={{ minHeight: 110, maxWidth: 420 }} value={pick} onChange={(e) => setPick([...e.target.selectedOptions].map((o) => o.value))}>
          {free.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
        </select>
        <div><button className="btn btn-primary" style={{ marginTop: 8 }} disabled={!pick.length} onClick={() => run(async () => { await http(`/clients/${c.id}/campaigns`, { method: "POST", body: { campaignIds: pick } }); setPick([]); }, "Campaigns assigned.")}>Assign selected campaigns</button></div>
      </div>
    </>
  );
}
