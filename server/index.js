import http from "http";
import dotenv from "dotenv";
dotenv.config();

import { logger } from "./utils/logger.js";
import { assertEnvOrExit } from "./config/env.js";
import { createApp } from "./app.js";
import { attachLiveCallsServer } from "./services/liveCalls.js";
import { startCampaignDialer } from "./services/campaigns/campaignDialer.js";
import { startRetentionJob } from "./services/recordings.js";
import { verifyAuditTable } from "./services/audit.js";
import { query } from "./db/pool.js";

assertEnvOrExit(logger);   // production refuses to start with an unsafe or incomplete environment

const app = createApp();
const server = http.createServer(app);
attachLiveCallsServer(server);   // authenticated + tenant-scoped /ws/live-calls

// Fail fast (with a readable message) if `npm run db:migrate` has not been run.
async function assertSchemaReady() {
  const { rows } = await query(
    `SELECT (SELECT count(*) FROM information_schema.columns WHERE table_name = 'users' AND column_name IN ('client_id','password_changed_at')) AS u,
            (SELECT count(*) FROM information_schema.tables WHERE table_name IN ('clients','client_permissions','call_recording_files')) AS t`);
  if (Number(rows[0].u) < 2 || Number(rows[0].t) < 3) {
    logger.error("schema_not_ready", { hint: "run `npm run db:migrate` (migrations 003 and 004 are required)" });
    if (process.env.NODE_ENV === "production") process.exit(1);
  }
}

const PORT = process.env.PORT || 10000;
server.listen(PORT, "0.0.0.0", async () => {
  logger.info("server_started", { port: PORT, env: process.env.NODE_ENV || "development" });
  try { await assertSchemaReady(); await verifyAuditTable(); } catch (err) { logger.error("startup_check_failed", { error: err.message }); }
  startCampaignDialer();
  startRetentionJob();
});

process.on("SIGTERM", () => {
  logger.info("shutdown", { signal: "SIGTERM" });
  server.close(() => process.exit(0));
});
