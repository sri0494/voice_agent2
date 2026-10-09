// Express application factory (no listening, no timers). index.js starts it; tests import it directly.
import express from "express";
import helmet from "helmet";
import cors from "cors";
import compression from "compression";
import path from "path";
import { fileURLToPath } from "url";

import { healthCheck } from "./db/pool.js";
import { requestLogger } from "./middleware/requestLogger.js";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler.js";
import { apiLimiter } from "./middleware/rateLimit.js";
import { blockCustomerOutsidePortal } from "./middleware/portal.js";

import authRoutes from "./routes/auth.js";
import userRoutes from "./routes/users.js";
import agentRoutes from "./routes/agents.js";
import campaignRoutes from "./routes/campaigns.js";
import contactRoutes from "./routes/contacts.js";
import customerRoutes from "./routes/customers.js";
import callRoutes from "./routes/calls.js";
import knowledgeBaseRoutes from "./routes/knowledgeBases.js";
import documentRoutes from "./routes/documents.js";
import ragRoutes from "./routes/rag.js";
import telephonyRoutes from "./routes/telephony.js";
import telephonyVoiceRoutes from "./routes/telephonyVoice.js";
import contactRequestRoutes from "./routes/contactRequests.js";
import analyticsRoutes from "./routes/analytics.js";
import integrationRoutes from "./routes/integrations.js";
import businessIntegrationRoutes from "./routes/businessIntegrations.js";
import phoneNumberRoutes from "./routes/phoneNumbers.js";
import conversationRoutes from "./routes/conversation.js";
import surveyRoutes from "./routes/surveys.js";
import agentSteeringRoutes from "./routes/agentSteering.js";
import clientsRoutes from "./routes/clients.js";
import customerPortalRoutes from "./routes/customerPortal.js";
import recordingsRoutes from "./routes/recordings.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp() {
  const app = express();
  // Render (and most PaaS platforms) sit behind a reverse proxy that sets X-Forwarded-For.
  app.set("trust proxy", 1);
  app.disable("x-powered-by");

  app.use(helmet({ contentSecurityPolicy: false })); // CSP relaxed for the bundled SPA; tighten per deployment
  app.use(cors({ origin: process.env.CORS_ORIGIN || true, credentials: true }));
  app.use(compression());
  app.use(express.json({ limit: "2mb" }));
  app.use(express.urlencoded({ extended: true, limit: "1mb" }));
  app.use(requestLogger);
  app.use("/api", apiLimiter);

  app.get("/api/health", async (req, res) => {
    const dbOk = await healthCheck();
    res.status(dbOk ? 200 : 503).json({ ok: dbOk, database: dbOk ? "connected" : "disconnected" });
  });

  // A CUSTOMER login can never reach an admin API. MUST stay before every other /api router.
  app.use("/api", blockCustomerOutsidePortal);

  app.use("/api/auth", authRoutes);
  app.use("/api/customer", customerPortalRoutes);        // customer portal (permission + ownership checked per route)
  app.use("/api/clients", clientsRoutes);                // admin: customer accounts, logins, permissions
  app.use("/api/recordings", recordingsRoutes);          // staff recordings (no public file endpoint)
  app.use("/api/users", userRoutes);
  app.use("/api/agents", agentRoutes);
  app.use("/api/campaigns", campaignRoutes);
  app.use("/api/contacts", contactRoutes);
  app.use("/api/customers", customerRoutes);
  app.use("/api/calls", callRoutes);
  app.use("/api/knowledge-bases", knowledgeBaseRoutes);
  app.use("/api/documents", documentRoutes);
  app.use("/api/rag", ragRoutes);
  app.use("/api/telephony", telephonyRoutes);
  app.use("/api/telephony", telephonyVoiceRoutes);
  app.use("/api/contact-requests", contactRequestRoutes);
  app.use("/api/analytics", analyticsRoutes);
  app.use("/api/integrations", integrationRoutes);
  app.use("/api/business-integrations", businessIntegrationRoutes);
  app.use("/api/phone-numbers", phoneNumberRoutes);
  app.use("/api/conversation", conversationRoutes);
  app.use("/api/surveys", surveyRoutes);
  app.use("/api/agent-steering", agentSteeringRoutes);

  // Built frontend (single Render web service)
  const distPath = path.resolve(__dirname, "../dist");
  app.use(express.static(distPath));
  app.get(/^(?!\/api|\/ws).*/, (req, res, next) => {
    res.sendFile(path.join(distPath, "index.html"), (err) => { if (err) next(); });
  });

  app.use("/api", notFoundHandler);
  app.use(errorHandler);
  return app;
}
