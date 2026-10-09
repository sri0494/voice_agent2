import { useState } from "react";
import { http } from "../../services/http.js";
import StatusBadge from "../../components/StatusBadge.jsx";
import { Boundary, PageHeader, Table, confirmDelete, fmtDay, useLoad } from "../ui.jsx";

const EMPTY = { name: "", type: "", description: "", language: "", startDate: "", endDate: "" };
const day = (d) => (d ? String(d).slice(0, 10) : "");

export default function PortalCampaigns({ me }) {
  const can = (a) => me.actions.includes(a);
  const st = useLoad(() => http("/customer/campaigns", { params: { limit: 200 } }));
  const [form, setForm] = useState(null);   // null = hidden, {id?, ...fields}
  const [saving, setSaving] = useState(false);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const save = async (e) => {
    e.preventDefault(); setSaving(true);
    const { id, ...fields } = form;
    try {
      await http(id ? `/customer/campaigns/${id}` : "/customer/campaigns", { method: id ? "PUT" : "POST", body: fields });
      setForm(null); st.reload();
    } catch (err) { alert(err.message); } finally { setSaving(false); }
  };
  const remove = async (c) => {
    if (!confirmDelete(`the campaign "${c.name}"`)) return;
    try { await http(`/customer/campaigns/${c.id}`, { method: "DELETE" }); st.reload(); } catch (err) { alert(err.message); }
  };

  return (
    <div>
      <PageHeader title="Campaigns" sub="Your campaigns"
        actions={can("campaigns_create") && <button className="btn btn-primary" onClick={() => setForm(EMPTY)}>+ New Campaign</button>} />
      {form && (
        <form className="card" onSubmit={save} style={{ marginBottom: 16, maxWidth: 560 }}>
          <div style={{ fontWeight: 600, marginBottom: 12 }}>{form.id ? "Edit Campaign" : "New Campaign"}</div>
          <div className="form-group"><label>Campaign Name</label><input className="input" required value={form.name} onChange={set("name")} /></div>
          <div className="grid grid-cols-2">
            <div className="form-group"><label>Type</label><input className="input" placeholder="e.g. Voice Survey" value={form.type || ""} onChange={set("type")} /></div>
            <div className="form-group"><label>Language</label><input className="input" value={form.language || ""} onChange={set("language")} /></div>
          </div>
          <div className="grid grid-cols-2">
            <div className="form-group"><label>Start date</label><input className="input" type="date" value={day(form.startDate)} onChange={set("startDate")} /></div>
            <div className="form-group"><label>End date</label><input className="input" type="date" value={day(form.endDate)} onChange={set("endDate")} /></div>
          </div>
          <div className="form-group"><label>Description</label><textarea className="input" rows={2} value={form.description || ""} onChange={set("description")} /></div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn btn-primary" disabled={saving}>{saving ? "Saving..." : "Save"}</button>
            <button type="button" className="btn" onClick={() => setForm(null)}>Cancel</button>
          </div>
        </form>
      )}
      <Boundary state={st}>
        {st.data?.length ? (
          <Table head={["Name", "Type", "Status", "Contacts", "Calls", "Start", "End", "Actions"]}>
            {st.data.map((c) => (
              <tr key={c.id}>
                <td>{c.name}</td><td>{c.type || "—"}</td><td><StatusBadge status={c.status} /></td>
                <td>{c.contacts}</td><td>{c.calls}</td><td>{fmtDay(c.start_date)}</td><td>{fmtDay(c.end_date)}</td>
                <td><div style={{ display: "flex", gap: 6 }}>
                  {can("campaigns_edit") && <button className="btn btn-sm" onClick={() => setForm({ id: c.id, name: c.name, type: c.type, description: c.description, language: c.language, startDate: c.start_date, endDate: c.end_date })}>Edit</button>}
                  {can("campaigns_delete") && <button className="btn btn-sm btn-danger" onClick={() => remove(c)}>Delete</button>}
                </div></td>
              </tr>
            ))}
          </Table>
        ) : <div className="card">No campaigns yet.</div>}
      </Boundary>
    </div>
  );
}
