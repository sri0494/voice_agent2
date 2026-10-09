import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import * as api from "../services/api.js";
import { updateCustomer } from "../services/http.js";
import StatusBadge from "../components/StatusBadge.jsx";
import { LoadingState, ErrorState, EmptyState } from "../components/DataState.jsx";

const EMPTY_FORM = {
  firstName: "", lastName: "", mobile: "", alternateMobile: "", email: "", city: "",
  customerCode: "", companyName: "", customerCategory: "", assignedAgentId: "",
  preferredLanguage: "English", tagsText: "", notes: "", status: "Active",
};

// Convert a customer row from the API (snake_case) into the form shape.
const customerToForm = (c, agents = []) => ({
  firstName: c.first_name || "",
  lastName: c.last_name || "",
  mobile: c.mobile || "",
  alternateMobile: c.alternate_mobile || "",
  email: c.email || "",
  city: c.city || "",
  customerCode: c.customer_code || "",
  companyName: c.company_name || "",
  customerCategory: c.customer_category || "",
  assignedAgentId: c.assigned_agent_id ?? agents.find((a) => a.name === c.assigned_agent_name)?.id ?? "",
  preferredLanguage: c.preferred_language || "English",
  tagsText: Array.isArray(c.tags) ? c.tags.join(", ") : (c.tags || ""),
  notes: c.notes || "",
  status: c.status || "Active",
});

export default function Customers() {
  const [customers, setCustomers] = useState([]);
  const [agents, setAgents] = useState([]);
  const [state, setState] = useState("loading");
  const [q, setQ] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState(null); // null = creating, id = editing
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setState("loading");
    try {
      const [c, a] = await Promise.all([api.getCustomers(q ? { q } : {}), api.getAgents()]);
      setCustomers(c);
      setAgents(a);
      setState("ready");
    } catch {
      setState("error");
    }
  };

  useEffect(() => { load(); }, [q]);

  const closeForm = () => {
    setForm(EMPTY_FORM);
    setEditingId(null);
    setShowForm(false);
  };

  const openCreate = () => {
    if (showForm && !editingId) return closeForm();
    setForm(EMPTY_FORM);
    setEditingId(null);
    setShowForm(true);
  };

  const openEdit = (c) => {
    setForm(customerToForm(c, agents));
    setEditingId(c.id);
    setShowForm(true);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    const { tagsText, status, ...rest } = form;
    const payload = {
      ...rest,
      assignedAgentId: form.assignedAgentId || null,
      tags: tagsText.split(",").map((t) => t.trim()).filter(Boolean),
      // status is only sent when editing, so create matches the original payload exactly
      ...(editingId ? { status } : {}),
    };
    try {
      if (editingId) {
        await updateCustomer(editingId, payload);
      } else {
        await api.createCustomer(payload);
      }
      closeForm();
      load();
    } catch (err) {
      alert(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (customerId, name) => {
    if (!confirm(`Delete customer "${name || "this customer"}"? This cannot be undone.`)) return;
    try {
      await api.deleteCustomer(customerId);
      if (editingId === customerId) closeForm();
      load();
    } catch (err) {
      alert(err.message);
    }
  };

  const isEditing = Boolean(editingId);

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12 }}>
        <div>
          <div className="section-title">Customers</div>
          <div className="section-sub">People with an established business relationship</div>
        </div>
        <button className="btn btn-primary" onClick={openCreate}>+ Add Customer</button>
      </div>

      {showForm && (
        <form className="card" onSubmit={handleSubmit} style={{ marginBottom: 16, maxWidth: 520 }}>
          <div style={{ fontWeight: 600, marginBottom: 12 }}>
            {isEditing ? "Edit Customer" : "New Customer"}
          </div>
          <div className="grid grid-cols-2">
            <div className="form-group"><label>First Name</label><input className="input" required value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} /></div>
            <div className="form-group"><label>Last Name</label><input className="input" value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} /></div>
          </div>
          <div className="grid grid-cols-2">
            <div className="form-group"><label>Mobile Number</label><input className="input" required placeholder="9876543210" value={form.mobile} onChange={(e) => setForm({ ...form, mobile: e.target.value })} /></div>
            <div className="form-group"><label>Alternate Mobile</label><input className="input" value={form.alternateMobile} onChange={(e) => setForm({ ...form, alternateMobile: e.target.value })} /></div>
          </div>
          <div className="grid grid-cols-2">
            <div className="form-group"><label>Email</label><input className="input" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></div>
            <div className="form-group"><label>City</label><input className="input" value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} /></div>
          </div>
          <div className="grid grid-cols-2">
            <div className="form-group"><label>Customer ID</label><input className="input" placeholder="e.g. CUS10025" value={form.customerCode} onChange={(e) => setForm({ ...form, customerCode: e.target.value })} /></div>
            <div className="form-group"><label>Company Name</label><input className="input" value={form.companyName} onChange={(e) => setForm({ ...form, companyName: e.target.value })} /></div>
          </div>
          <div className="grid grid-cols-2">
            <div className="form-group"><label>Customer Category</label><input className="input" placeholder="e.g. Premium, Retail, Enterprise" value={form.customerCategory} onChange={(e) => setForm({ ...form, customerCategory: e.target.value })} /></div>
            <div className="form-group">
              <label>Assigned Agent</label>
              <select className="input" value={form.assignedAgentId} onChange={(e) => setForm({ ...form, assignedAgentId: e.target.value })}>
                <option value="">Unassigned</option>
                {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2">
            <div className="form-group">
              <label>Preferred Language</label>
              <select className="input" value={form.preferredLanguage} onChange={(e) => setForm({ ...form, preferredLanguage: e.target.value })}>
                <option>English</option><option>Telugu</option><option>Hindi</option>
              </select>
            </div>
            <div className="form-group"><label>Tags (comma-separated)</label><input className="input" placeholder="vip, repeat-customer" value={form.tagsText} onChange={(e) => setForm({ ...form, tagsText: e.target.value })} /></div>
          </div>
          {isEditing && (
            <div className="form-group">
              <label>Status</label>
              <select className="input" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
                <option value="Active">Active</option>
                <option value="Inactive">Inactive</option>
              </select>
            </div>
          )}
          <div className="form-group"><label>Notes</label><textarea className="input" rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn btn-primary" disabled={saving}>
              {saving ? (isEditing ? "Saving..." : "Creating...") : (isEditing ? "Save Changes" : "Create Customer")}
            </button>
            <button type="button" className="btn" onClick={closeForm} disabled={saving}>Cancel</button>
          </div>
        </form>
      )}

      <input className="input" placeholder="Search by name, mobile, or email..." style={{ maxWidth: 340, marginBottom: 16 }} value={q} onChange={(e) => setQ(e.target.value)} />

      {state === "loading" && <LoadingState label="Loading customers..." />}
      {state === "error" && <ErrorState onRetry={load} />}
      {state === "ready" && customers.length === 0 && <EmptyState message="No customers yet." />}

      {state === "ready" && customers.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Name</th><th>Mobile</th><th>Email</th><th>City</th><th>Status</th><th>Assigned Agent</th><th>Actions</th></tr></thead>
            <tbody>
              {customers.map((c) => (
                <tr key={c.id}>
                  <td><Link to={`/customers/${c.id}`} style={{ color: "var(--cyan)", fontWeight: 600 }}>{c.first_name} {c.last_name || ""}</Link></td>
                  <td>{c.mobile}</td>
                  <td>{c.email || "—"}</td>
                  <td>{c.city || "—"}</td>
                  <td><StatusBadge status={c.status} /></td>
                  <td>{c.assigned_agent_name || "—"}</td>
                  <td>
                    <div style={{ display: "flex", gap: 6 }}>
                      <button className="btn btn-sm" onClick={() => openEdit(c)}>Edit</button>
                      <button className="btn btn-sm btn-danger" onClick={() => handleDelete(c.id, `${c.first_name} ${c.last_name || ""}`.trim())}>Delete</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
