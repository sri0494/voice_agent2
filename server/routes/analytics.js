import { Router } from "express";
import { query } from "../db/pool.js";
import { requireAuth, requireStaff } from "../middleware/auth.js";
import { rbac, R } from "../middleware/rbac.js";
import { audit } from "../services/audit.js";

const router = Router();
router.use(requireAuth, requireStaff, rbac({ read: R.STAFF, write: R.MANAGERS }));

function rangeToInterval(range) {
  switch (range) {
    case "today": return "1 day";
    case "yesterday": return "2 days";
    case "7d": return "7 days";
    case "30d": return "30 days";
    default: return "30 days";
  }
}

// Dashboard summary cards.
router.get("/summary", async (req, res, next) => {
  try {
    const interval = rangeToInterval(req.query.range);
    const { rows } = await query(
      `SELECT
        COUNT(*) AS total_calls,
        COUNT(*) FILTER (WHERE status IN ('Connected','Live','Completed','Transferred')) AS connected_calls,
        COUNT(*) FILTER (WHERE status IN ('Ringing','Connected','Live')) AS live_calls,
        COUNT(*) FILTER (WHERE status = 'Completed') AS completed_calls,
        COUNT(*) FILTER (WHERE status = 'Missed') AS missed_calls,
        COUNT(*) FILTER (WHERE status = 'Transferred') AS human_transfers,
        COUNT(*) FILTER (WHERE ai_resolved = true) AS ai_resolved,
        COALESCE(AVG(duration_sec) FILTER (WHERE duration_sec > 0), 0) AS avg_duration_sec
       FROM calls WHERE created_at >= now() - $1::interval`,
      [interval]
    );

    const { rows: campaignStats } = await query(
      `SELECT COUNT(*) FILTER (WHERE status = 'Running') AS active_campaigns FROM campaigns`
    );
    const { rows: agentStats } = await query(
      `SELECT COUNT(*) FILTER (WHERE status = 'ACTIVE') AS active_agents FROM agents`
    );
    const { rows: kbStats } = await query(
      `SELECT COUNT(*) AS knowledge_bases, COALESCE(SUM(chunk_count),0) AS total_chunks
       FROM knowledge_bases kb LEFT JOIN knowledge_documents d ON d.knowledge_base_id = kb.id`
    );

    const s = rows[0];
    const totalCalls = Number(s.total_calls);
    const conversionRate = totalCalls ? (Number(s.completed_calls) / totalCalls) * 100 : 0;
    const aiResolutionRate = totalCalls ? (Number(s.ai_resolved) / totalCalls) * 100 : 0;

    res.json({
      success: true,
      data: {
        totalCalls,
        connectedCalls: Number(s.connected_calls),
        liveCalls: Number(s.live_calls),
        completedCalls: Number(s.completed_calls),
        missedCalls: Number(s.missed_calls),
        humanTransfers: Number(s.human_transfers),
        avgDurationSec: Math.round(Number(s.avg_duration_sec)),
        conversionRate: Number(conversionRate.toFixed(1)),
        aiResolutionRate: Number(aiResolutionRate.toFixed(1)),
        activeCampaigns: Number(campaignStats[0].active_campaigns),
        activeAgents: Number(agentStats[0].active_agents),
        knowledgeBases: Number(kbStats[0].knowledge_bases),
        totalChunks: Number(kbStats[0].total_chunks),
      },
      message: "Success",
    });
  } catch (err) { next(err); }
});

router.get("/calls-by-day", async (req, res, next) => {
  try {
    const interval = rangeToInterval(req.query.range);
    const { rows } = await query(
      `SELECT date_trunc('day', created_at) AS day, COUNT(*) AS count
       FROM calls WHERE created_at >= now() - $1::interval
       GROUP BY day ORDER BY day ASC`,
      [interval]
    );
    res.json({ success: true, data: rows, message: "Success" });
  } catch (err) { next(err); }
});

router.get("/calls-by-campaign", async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT camp.name, COUNT(c.id) AS count
       FROM calls c JOIN campaigns camp ON camp.id = c.campaign_id
       GROUP BY camp.name ORDER BY count DESC LIMIT 10`
    );
    res.json({ success: true, data: rows, message: "Success" });
  } catch (err) { next(err); }
});

router.get("/calls-by-language", async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT COALESCE(language,'Unknown') AS language, COUNT(*) AS count FROM calls GROUP BY language`
    );
    res.json({ success: true, data: rows, message: "Success" });
  } catch (err) { next(err); }
});

router.get("/outcomes", async (req, res, next) => {
  try {
    const { rows } = await query(`SELECT status, COUNT(*) AS count FROM calls GROUP BY status`);
    res.json({ success: true, data: rows, message: "Success" });
  } catch (err) { next(err); }
});

router.get("/sentiment", async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT COALESCE(sentiment,'Unrated') AS sentiment, COUNT(*) AS count FROM calls GROUP BY sentiment`
    );
    res.json({ success: true, data: rows, message: "Success" });
  } catch (err) { next(err); }
});

export default router;
