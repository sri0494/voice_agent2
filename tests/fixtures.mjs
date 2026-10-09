// Shared seed for the security suites: one user per role, two customer accounts (A and B) with campaigns, contacts,
// calls and recordings of their own, created through the real API wherever possible.
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

export const PASSWORD = "Passw0rd!Test";
export const ALL_PERMS = ["dashboard", "campaigns_view", "campaigns_create", "campaigns_edit", "campaigns_delete", "contacts_view", "contacts_create",
  "contacts_edit", "contacts_delete", "calls_view", "recordings_view", "recordings_download", "analytics_view", "reports_view", "agents_view", "settings_view"];
export const WAV = Buffer.concat([Buffer.from("RIFF\x24\x00\x00\x00WAVEfmt ", "latin1"), Buffer.alloc(2000, 7)]);

export async function seed(ctx, t) {
  const { query, base } = ctx;
  const hash = await bcrypt.hash(PASSWORD, 4);
  const staff = {};
  for (const role of ["SUPER_ADMIN", "ADMIN", "MANAGER", "AGENT", "VIEWER"]) {
    const email = `${role.toLowerCase()}@lmx.test`;
    const { rows } = await query(`INSERT INTO users (name,email,password_hash,role,status) VALUES ($1,$2,$3,$4,'ACTIVE') RETURNING id`, [role, email, hash, role]);
    const r = await t.call(null, "POST", "/api/auth/login", { email, password: PASSWORD });
    staff[role] = { id: rows[0].id, email, token: r.body?.data?.token, login: r };
  }
  const A = (k) => staff[k].token;
  const admin = A("SUPER_ADMIN");

  async function customer(label, perms) {
    const c = (await t.call(admin, "POST", "/api/clients", { name: `${label} Hospital`, companyName: `${label} Hospital Pvt` })).body.data;
    const email = `${label.toLowerCase()}@customer.test`;
    const login = (await t.call(admin, "POST", `/api/clients/${c.id}/login`, { email, password: PASSWORD })).body.data;
    await t.call(admin, "PUT", `/api/clients/${c.id}/permissions`, { permissions: perms });
    const lr = await t.call(null, "POST", "/api/auth/login", { email, password: PASSWORD });
    return { client: c, userId: login.user.id, email, token: lr.body?.data?.token, loginRes: lr };
  }
  const CA = await customer("Alpha", ALL_PERMS);
  const CB = await customer("Bravo", ALL_PERMS);

  const ag = async (name) => (await query(`INSERT INTO agents (name, agent_type, language, voice, system_prompt, status, fallback_message, transfer_number, recording_enabled)
    VALUES ($1,'Survey','Telugu','f1','TOP-SECRET-PROMPT-' || $1,'ACTIVE','I do not have that information.','+919876543210', true) RETURNING id`, [name])).rows[0].id;
  const agentA = await ag("AgentA"), agentB = await ag("AgentB");
  const camp = async (name, clientId, agentId, status = "Draft") =>
    (await query(`INSERT INTO campaigns (name, client_id, agent_id, status) VALUES ($1,$2,$3,$4) RETURNING id`, [name, clientId, agentId, status])).rows[0].id;
  const campA1 = await camp("Alpha Patient Survey", CA.client.id, agentA), campA2 = await camp("Alpha Feedback", CA.client.id, agentA);
  const campB1 = await camp("Bravo Sale Promo", CB.client.id, agentB), campU = await camp("Unassigned Campaign", null, agentA);
  const contact = async (campId, name, phone) => (await query(`INSERT INTO contacts (campaign_id,name,phone) VALUES ($1,$2,$3) RETURNING id`, [campId, name, phone])).rows[0].id;
  const ctA = await contact(campA1, "Alice A", "9876500001"), ctB = await contact(campB1, "Bob B", "9876500002");
  const call = async (campId, status, sentiment, dur, name, agentId, contactId = null) =>
    (await query(`INSERT INTO calls (campaign_id, contact_id, agent_id, customer_name, phone, status, sentiment, duration_sec, direction, provider_call_id)
      VALUES ($1,$2,$3,$4,'9876543210',$5,$6,$7,'OUTBOUND', $8) RETURNING id`, [campId, contactId, agentId, name, status, sentiment, dur, `CA${Math.random().toString(36).slice(2, 12)}`])).rows[0].id;
  const callA1 = await call(campA1, "Completed", "Positive", 60, "Ravi-A", agentA), callA2 = await call(campA1, "Completed", "Negative", 120, "Sita-A", agentA);
  const callA3 = await call(campA2, "Failed", null, 0, "Failed-A", agentA);
  const callB1 = await call(campB1, "Completed", "Positive", 999, "B-SECRET-PERSON", agentB);
  const callU = await call(campU, "Completed", "Positive", 5, "orphan", agentA);

  const { saveRecording } = await import("../server/services/recordings.js");
  const recA = await saveRecording({ callId: callA1, buffer: WAV, contentType: "audio/wav" });
  const recB = await saveRecording({ callId: callB1, buffer: WAV, contentType: "audio/wav" });

  const tok = (id, extra = {}, opts = {}) => jwt.sign({ id, ...extra }, process.env.JWT_SECRET, { algorithm: "HS256", ...opts });
  return { staff, tok: A, admin, CA, CB, agentA, agentB, campA1, campA2, campB1, campU, ctA, ctB, callA1, callA2, callA3, callB1, callU, recA, recB, jwtFor: tok, base };
}
