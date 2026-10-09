import { useState } from "react";
import { http } from "../../services/http.js";
import StatusBadge from "../../components/StatusBadge.jsx";
import { Boundary, PageHeader, Pager, Table, confirmDelete, useLoad } from "../ui.jsx";

const LIMIT = 50;
const EMPTY = { campaignId: "", name: "", phone: "", email: "", language: "", city: "", notes: "" };

export default function PortalContacts({ me }) {
  const can = (a) => me.actions.includes(a);
  const [campaignId, setCampaignId] = useState("");
  const [offset, setOffset] = useState(0);
  const options = useLoad(() => http("/customer/campaign-options"));
  const st = useLoad(() => http("/customer/contacts", { params: { campaignId, limit: LIMIT, offset } }), [campaignId, offset]);
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const save = async (e) => {
    e.preventDefault(); setSaving(true);
    const { id, campaignId: cid, ...rest } = form;
    try {
      if (id) await http(`/customer/contacts/${id}`, { method: "PUT", body: rest });
      else await http("/customer/contacts", { method: "POST", body: { ...rest, campaignId: cid } });
      setForm(null); st.reload();
    } catch (err) { alert(err.message); } finally { setSaving(false); }
  };
  const remove = async (c) => {
    if (!confirmDelete(`the contact "${c.name}"`)) return;
    try { await http(`/customer/contacts/${c.id}`, { method: "DELETE" }); st.reload(); } catch (err) { alert(err.message); }
  };

  return (
    <div>
      <PageHeader title="Contacts / Call Lists" sub="People on your campaign call lists"
        actions={can("contacts_create") && <button className="btn btn-primary" onClick={() => setForm({ ...EMPTY, campaignId })}>+ Add Contact</button>} />
      {form && (
        <form className="card" onSubmit={save} style={{ marginBottom: 16, maxWidth: 560 }}>
          <div style={{ fontWeight: 600, marginBottom: 12 }}>{form.id ? "Edit Contact" : "New Contact"}</div>
          {!form.id && (
            <div className="form-group"><label>Campaign</label>
              <select className="input" required value={form.campaignId} onChange={set("campaignId")}>
                <option value="">Select a campaign…</option>
                {(options.data || []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
          )}
          <div className="grid grid-cols-2">
            <div className="form-group"><label>Name</label><input className="input" required value={form.name || ""} onChange={set("name")} /></div>
            <div className="form-group"><label>Mobile</label><input className="input" required placeholder="9876543210" value={form.phone || ""} onChange={set("phone")} /></div>
          </div>
          <div className="grid grid-cols-2">
            <div className="form-group"><label>Email</label><input className="input" type="email" value={form.email || ""} onChange={set("email")} /></div>
            <div className="form-group"><label>City</label><input className="input" value={form.city || ""} onChange={set("city")} /></div>
          </div>
          <div className="form-group"><label>Notes</label><textarea className="input" rows={2} value={form.notes || ""} onChange={set("notes")} /></div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn btn-primary" disabled={saving}>{saving ? "Saving..." : "Save"}</button>
            <button type="button" className="btn" onClick={() => setForm(null)}>Cancel</button>
          </div>
        </form>
      )}
      <select className="input" style={{ maxWidth: 320, marginBottom: 16 }} value={campaignId} onChange={(e) => { setCampaignId(e.target.value); setOffset(0); }}>
        <option value="">All campaigns</option>
        {(options.data || []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
      <Boundary state={st}>
        {st.data?.length ? (
          <>
            <Table head={["Name", "Mobile", "Email", "City", "Campaign", "Status", "Attempts", "Actions"]}>
              {st.data.map((c) => (
                <tr key={c.id}>
                  <td>{c.name}</td><td>{c.phone}</td><td>{c.email || "—"}</td><td>{c.city || "—"}</td><td>{c.campaign_name}</td>
                  <td><StatusBadge status={c.status} /></td><td>{c.call_attempts ?? 0}</td>
                  <td><div style={{ display: "flex", gap: 6 }}>
                    {can("contacts_edit") && <button className="btn btn-sm" onClick={() => setForm({ id: c.id, name: c.name, phone: c.phone, email: c.email, language: c.language, city: c.city, notes: c.notes })}>Edit</button>}
                    {can("contacts_delete") && <button className="btn btn-sm btn-danger" onClick={() => remove(c)}>Delete</button>}
                  </div></td>
                </tr>
              ))}
            </Table>
            <Pager offset={offset} limit={LIMIT} count={st.data.length} onChange={setOffset} />
          </>
        ) : <div className="card">No contacts found.</div>}
      </Boundary>
    </div>
  );
}
