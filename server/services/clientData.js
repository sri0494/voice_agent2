// Every query here is scoped by campaigns.client_id. Used by BOTH the customer portal and the admin views,
// so the numbers a customer sees always match what the admin sees for that customer.
import { query } from "../db/pool.js";

const FAILED = `('failed','busy','no_answer','no-answer','error')`;
// $n = from, $n+1 = to (both nullable)
const range = (n) => `($${n}::timestamptz IS NULL OR c.created_at >= $${n}::timestamptz) AND ($${n + 1}::timestamptz IS NULL OR c.created_at < $${n + 1}::timestamptz)`;

export async function dashboard(clientId, perms) {
  const has = (p) => perms.has(p);
  const out = {};
  if (has("campaigns_view")) {
    out.totalCampaigns = (await query(`SELECT count(*)::int AS n FROM campaigns WHERE client_id = $1`, [clientId])).rows[0].n;
    out.recentCampaigns = (await query(
      `SELECT ca.id, ca.name, ca.status, ca.type,
              (SELECT count(*)::int FROM calls c WHERE c.campaign_id = ca.id) AS calls
       FROM campaigns ca WHERE ca.client_id = $1 ORDER BY ca.created_at DESC LIMIT 5`, [clientId])).rows;
  }
  if (has("contacts_view")) {
    out.totalContacts = (await query(
      `SELECT count(*)::int AS n FROM contacts ct JOIN campaigns ca ON ca.id = ct.campaign_id WHERE ca.client_id = $1`, [clientId])).rows[0].n;
  }
  if (has("calls_view")) {
    const r = (await query(
      `SELECT count(*)::int AS total, (count(*) FILTER (WHERE lower(c.status) = 'completed'))::int AS completed
       FROM calls c JOIN campaigns ca ON ca.id = c.campaign_id WHERE ca.client_id = $1`, [clientId])).rows[0];
    out.totalCalls = r.total; out.completedCalls = r.completed;
    out.failedCalls = (await query(
      `SELECT count(*)::int AS n FROM calls c JOIN campaigns ca ON ca.id = c.campaign_id
       WHERE ca.client_id = $1 AND lower(c.status) IN ${FAILED}`, [clientId])).rows[0].n;
    out.recentCalls = (await query(
      `SELECT c.id, ca.name AS campaign_name, c.customer_name, c.phone, c.status, c.duration_sec, c.created_at
       FROM calls c JOIN campaigns ca ON ca.id = c.campaign_id WHERE ca.client_id = $1
       ORDER BY c.created_at DESC LIMIT 5`, [clientId])).rows;
  }
  if (has("recordings_view")) {
    out.totalRecordings = (await query(
      `SELECT count(*)::int AS n FROM call_recording_files r
       JOIN calls c ON c.id = r.call_id JOIN campaigns ca ON ca.id = c.campaign_id WHERE ca.client_id = $1`, [clientId])).rows[0].n;
  }
  return out;
}

export async function analytics(clientId, { from = null, to = null } = {}) {
  const totals = (await query(
    `SELECT count(*)::int AS total_calls,
            (count(*) FILTER (WHERE lower(c.status) = 'completed'))::int AS completed_calls,
            (count(*) FILTER (WHERE lower(c.status) IN ${FAILED}))::int AS failed_calls,
            COALESCE(round(avg(c.duration_sec) FILTER (WHERE c.duration_sec > 0))::int, 0) AS avg_duration_sec,
            (count(*) FILTER (WHERE lower(c.sentiment) = 'positive'))::int AS positive,
            (count(*) FILTER (WHERE lower(c.sentiment) = 'negative'))::int AS negative,
            (count(*) FILTER (WHERE lower(c.sentiment) = 'neutral'))::int AS neutral
     FROM calls c JOIN campaigns ca ON ca.id = c.campaign_id
     WHERE ca.client_id = $1 AND ${range(2)}`, [clientId, from, to])).rows[0];

  const byCampaign = (await query(
    `SELECT ca.id, ca.name, ca.status,
            count(c.id)::int AS calls,
            (count(c.id) FILTER (WHERE lower(c.status) = 'completed'))::int AS completed,
            COALESCE(round(avg(c.duration_sec) FILTER (WHERE c.duration_sec > 0))::int, 0) AS avg_duration_sec
     FROM campaigns ca LEFT JOIN calls c ON c.campaign_id = ca.id AND ${range(2)}
     WHERE ca.client_id = $1 GROUP BY ca.id ORDER BY calls DESC, ca.name`, [clientId, from, to])).rows;

  const daily = (await query(
    `SELECT to_char(date_trunc('day', c.created_at), 'YYYY-MM-DD') AS day, count(*)::int AS calls
     FROM calls c JOIN campaigns ca ON ca.id = c.campaign_id
     WHERE ca.client_id = $1
       AND c.created_at >= COALESCE($2::timestamptz, now() - interval '30 days')
       AND ($3::timestamptz IS NULL OR c.created_at < $3::timestamptz)
     GROUP BY 1 ORDER BY 1`, [clientId, from, to])).rows;

  return { ...totals, byCampaign, daily };
}

export async function listCalls(clientId, { status = null, campaignId = null, from = null, to = null, limit = 50, offset = 0 } = {}) {
  const { rows } = await query(
    `SELECT c.id, c.campaign_id, ca.name AS campaign_name, c.customer_name, c.phone, c.direction, c.language,
            c.status, c.sentiment, c.intent, c.outcome, c.duration_sec, c.started_at, c.ended_at, c.created_at, c.ai_summary,
            ag.name AS agent_name,
            EXISTS (SELECT 1 FROM call_recording_files r WHERE r.call_id = c.id) AS has_recording
     FROM calls c JOIN campaigns ca ON ca.id = c.campaign_id LEFT JOIN agents ag ON ag.id = c.agent_id
     WHERE ca.client_id = $1
       AND ($2::text IS NULL OR lower(c.status) = lower($2::text))
       AND ($3::uuid IS NULL OR c.campaign_id = $3::uuid)
       AND ${range(4)}
     ORDER BY c.created_at DESC LIMIT $6 OFFSET $7`,
    [clientId, status, campaignId, from, to, limit, offset]);
  return rows;
}

export async function listRecordings(clientId, { campaignId = null, limit = 50, offset = 0 } = {}) {
  const { rows } = await query(
    `SELECT r.id, r.call_id, r.source, r.content_type, r.size_bytes, r.duration_sec, r.created_at,
            c.customer_name, c.phone, ca.id AS campaign_id, ca.name AS campaign_name
     FROM call_recording_files r
     JOIN calls c ON c.id = r.call_id JOIN campaigns ca ON ca.id = c.campaign_id
     WHERE ca.client_id = $1 AND ($2::uuid IS NULL OR ca.id = $2::uuid)
     ORDER BY r.created_at DESC LIMIT $3 OFFSET $4`, [clientId, campaignId, limit, offset]);
  return rows;
}

// Agents used by this customer's campaigns. Explicit column list: prompts/instructions are never exposed.
export async function listAgents(clientId) {
  const { rows } = await query(
    `SELECT a.id, a.name, a.agent_type, a.language, a.voice, a.description, count(ca.id)::int AS campaigns
     FROM agents a JOIN campaigns ca ON ca.agent_id = a.id
     WHERE ca.client_id = $1 GROUP BY a.id ORDER BY a.name`, [clientId]);
  return rows;
}

export async function listCampaignOptions(clientId) {
  const { rows } = await query(`SELECT id, name FROM campaigns WHERE client_id = $1 ORDER BY name`, [clientId]);
  return rows;
}
