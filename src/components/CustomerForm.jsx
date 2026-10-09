import { useState } from "react";

export const EMPTY_CUSTOMER_FORM = {
  firstName: "", lastName: "", mobile: "", alternateMobile: "", email: "", city: "",
  customerCode: "", companyName: "", customerCategory: "", assignedAgentId: "",
  preferredLanguage: "English", tagsText: "", notes: "", status: "Active",
};

// Convert an API customer row (snake_case) into form values.
// Falls back to matching the agent by name if the API doesn't return assigned_agent_id,
// so saving an edit never silently unassigns the agent.
export function customerToForm(c, agents = []) {
  const agentId =
    c.assigned_agent_id ??
    agents.find((a) => a.name === c.assigned_agent_name)?.id ??
    "";
  return {
    firstName: c.first_name || "",
    lastName: c.last_name || "",
    mobile: c.mobile || "",
    alternateMobile: c.alternate_mobile || "",
    email: c.email || "",
    city: c.city || "",
    customerCode: c.customer_code || "",
    companyName: c.company_name || "",
    customerCategory: c.customer_category || "",
    assignedAgentId: agentId,
    preferredLanguage: c.preferred_language || "English",
    tagsText: Array.isArray(c.tags) ? c.tags.join(", ") : (c.tags || ""),
    notes: c.notes || "",
    status: c.status || "Active",
  };
}

// Shared create/edit form. onSubmit receives the API-ready payload.
export default function CustomerForm({ initial = EMPTY_CUSTOMER_FORM, agents = [], isEditing = false, saving = false, onSubmit, onCancel }) {
  const [form, setForm] = useState(initial);
  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value });

  const submit = (e) => {
    e.preventDefault();
    const { tagsText, status, ...rest } = form;
    onSubmit({
      ...rest,
      assignedAgentId: form.assignedAgentId || null,
      tags: tagsText.split(",").map((t) => t.trim()).filter(Boolean),
      ...(isEditing ? { status } : {}),
    });
  };

  return (
    <form className="card" onSubmit={submit} style={{ marginBottom: 16, maxWidth: 520 }}>
      <div style={{ fontWeight: 600, marginBottom: 12 }}>{isEditing ? "Edit Customer" : "New Customer"}</div>
      <div className="grid grid-cols-2">
        <div className="form-group"><label>First Name</label><input className="input" required value={form.firstName} onChange={set("firstName")} /></div>
        <div className="form-group"><label>Last Name</label><input className="input" value={form.lastName} onChange={set("lastName")} /></div>
      </div>
      <div className="grid grid-cols-2">
        <div className="form-group"><label>Mobile Number</label><input className="input" required placeholder="9876543210" value={form.mobile} onChange={set("mobile")} /></div>
        <div className="form-group"><label>Alternate Mobile</label><input className="input" value={form.alternateMobile} onChange={set("alternateMobile")} /></div>
      </div>
      <div className="grid grid-cols-2">
        <div className="form-group"><label>Email</label><input className="input" type="email" value={form.email} onChange={set("email")} /></div>
        <div className="form-group"><label>City</label><input className="input" value={form.city} onChange={set("city")} /></div>
      </div>
      <div className="grid grid-cols-2">
        <div className="form-group"><label>Customer ID</label><input className="input" placeholder="e.g. CUS10025" value={form.customerCode} onChange={set("customerCode")} /></div>
        <div className="form-group"><label>Company Name</label><input className="input" value={form.companyName} onChange={set("companyName")} /></div>
      </div>
      <div className="grid grid-cols-2">
        <div className="form-group"><label>Customer Category</label><input className="input" placeholder="e.g. Premium, Retail, Enterprise" value={form.customerCategory} onChange={set("customerCategory")} /></div>
        <div className="form-group">
          <label>Assigned Agent</label>
          <select className="input" value={form.assignedAgentId} onChange={set("assignedAgentId")}>
            <option value="">Unassigned</option>
            {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </div>
      </div>
      <div className="grid grid-cols-2">
        <div className="form-group">
          <label>Preferred Language</label>
          <select className="input" value={form.preferredLanguage} onChange={set("preferredLanguage")}>
            <option>English</option><option>Telugu</option><option>Hindi</option>
          </select>
        </div>
        <div className="form-group"><label>Tags (comma-separated)</label><input className="input" placeholder="vip, repeat-customer" value={form.tagsText} onChange={set("tagsText")} /></div>
      </div>
      {isEditing && (
        <div className="form-group">
          <label>Status</label>
          <select className="input" value={form.status} onChange={set("status")}>
            <option value="Active">Active</option>
            <option value="Inactive">Inactive</option>
          </select>
        </div>
      )}
      <div className="form-group"><label>Notes</label><textarea className="input" rows={2} value={form.notes} onChange={set("notes")} /></div>
      <div style={{ display: "flex", gap: 8 }}>
        <button className="btn btn-primary" disabled={saving}>
          {saving ? (isEditing ? "Saving..." : "Creating...") : (isEditing ? "Save Changes" : "Create Customer")}
        </button>
        {onCancel && <button type="button" className="btn" onClick={onCancel} disabled={saving}>Cancel</button>}
      </div>
    </form>
  );
}
