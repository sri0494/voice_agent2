// Two layers: MODULE toggles (what the portal shows) + ACTION permissions (create/edit/delete/download).
export const PERMISSION_GROUPS = {
  Dashboard: ["dashboard"],
  Campaigns: ["campaigns_view", "campaigns_create", "campaigns_edit", "campaigns_delete"],
  Contacts: ["contacts_view", "contacts_create", "contacts_edit", "contacts_delete"],
  "Call History": ["calls_view"],
  Recordings: ["recordings_view", "recordings_download"],
  Analytics: ["analytics_view"],
  Reports: ["reports_view"],
  Agents: ["agents_view"],
  Settings: ["settings_view"],
};
export const PERMISSIONS = Object.values(PERMISSION_GROUPS).flat();

// Module name used by the frontend -> permission that switches it on.
export const MODULE_MAP = {
  dashboard: "dashboard",
  campaigns: "campaigns_view",
  contacts: "contacts_view",
  recordings: "recordings_view",
  call_history: "calls_view",
  analytics: "analytics_view",
  agents: "agents_view",
  settings: "settings_view",
};
export const moduleFlags = (set) => Object.fromEntries(Object.entries(MODULE_MAP).map(([m, p]) => [m, set.has(p)]));

/** Validate a permission list; create/edit/delete/download automatically imply the matching view. */
export function normalizePermissions(list) {
  if (!Array.isArray(list)) return { error: "permissions must be an array" };
  const bad = list.filter((p) => !PERMISSIONS.includes(p));
  if (bad.length) return { error: `Unknown permission(s): ${bad.join(", ")}` };
  const set = new Set(list);
  for (const p of list) {
    const m = /^(\w+?)_(create|edit|delete|download)$/.exec(p);
    if (m) set.add(`${m[1]}_view`);
  }
  return { permissions: [...set] };
}
