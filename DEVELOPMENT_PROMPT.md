# LeoMox: development prompt

Paste this into a coding assistant (Claude Code, etc.) together with the repository. It captures the product rules and the
security requirements this codebase was hardened against, so new work stays consistent.

## Context
LeoMox is an AI voice platform. React 18 + Vite frontend; Node/Express backend; Neon Postgres with pgvector; deployed on Render.
Roles: SUPER_ADMIN, ADMIN, MANAGER, AGENT, VIEWER, CUSTOMER. Providers are abstractions (AI mock|gemini, embeddings mock|google,
speech mock, telephony mock|twilio, storage local|s3/R2). Mock mode must always keep working and be labelled as mock.
"Customers" are individual people; "Customer Accounts" (`clients` table) are client businesses; their logins have role CUSTOMER and `users.client_id`.

## Rules for every change
1. Do not remove working features, replace the architecture, add a second auth system, or bypass `rbac()` / `requireStaff`.
2. Authorize on the **server**. Frontend hiding is cosmetic.
3. Tenant comes only from the session (`req.user.client_id` / `req.portal.clientId`), never from `?customer_id=`, `client_id` or body fields.
   Cross-tenant access answers 404 (or 403); do not reveal existence.
4. Every endpoint needs: authentication, role, permission (customers), tenant scope, ownership check, rate limit where sensitive, audit entry for sensitive actions.
5. SQL: parameterised only; qualify columns in JOINs; transactions for multi-step security-sensitive work; enforce invariants in Postgres (CHECK, UNIQUE, FK).
6. Secrets: never in `VITE_*`, logs, audit rows, errors or API responses (return `hasCredentials`). Integration credentials are encrypted at rest.
7. Errors: 401 unauthenticated, 403 forbidden, 404 hidden/missing, 409 conflict, 422 validation, 429 rate limit, 500 generic. No stack traces, SQL, paths or tokens to clients.
8. Migrations are additive files in `db/migrations/` run by `npm run db:migrate`; never edit an applied one.

## Customer Portal requirements
- Permissions: module toggles plus actions (`dashboard`, `campaigns_*`, `contacts_*`, `calls_view`, `recordings_view`, `recordings_download`, `analytics_view`, `reports_view`, `agents_view`, `settings_view`); an action implies its `_view`.
- Endpoints under `/api/customer/*`: dashboard, campaigns(/:id), contacts(/:id), calls(/:id), recordings(+`/:id/url`), analytics, reports (summary, calls.csv), agents.
  A permission turned off must deny the API even when the URL is typed by hand. Unassigned campaigns are invisible; removing an assignment removes access at once.
- Analytics and CSV exports use exactly the same tenant filter as raw calls.
- `blockCustomerOutsidePortal` is mounted before every router and fails closed; `requireStaff` stays on each admin router.

## Recordings
Private bucket, no public or permanent URL. Playback = auth -> role -> permission -> tenant -> ownership -> presigned URL (5 minutes). Download is a separate permission.
Per-agent consent (`NOT_REQUIRED|REQUIRED`, configurable message; store status, timestamp, method) and retention (purge job deletes the object, marks the row, audits).
Production must refuse `STORAGE_PROVIDER=local`.

## Platform safety
- SSRF: integration URLs resolved at connect time; block loopback, private, link-local, metadata, private IPv6; https and port 443 only in production; no redirects; size/time caps.
- Uploads: size caps, magic bytes + extension + MIME, sanitised names, traversal rejected, temp files cleaned.
- Dialer: atomic QUEUED->DIALING (`FOR UPDATE SKIP LOCKED`), safe with several workers; valid campaign/call state transitions only; webhooks signed, replay-windowed and idempotent (no duplicate calls, recordings, survey responses or analytics).
- Live Calls WebSocket: authenticated at upgrade, tenant-scoped per message, re-validated periodically; customers receive only their own calls.
- RAG: retrieval restricted to the agent's authorised knowledge bases; keep the Knowledge-Only fallback.
- Conversation intelligence: keep FEEDBACK / INFORMATION_REQUEST / OFF_TOPIC / UNSAFE, session continuity, and word-boundary matching for OTP / PIN / CVV / PASSWORD.
- Rate limits for login, password reset/change, call initiation, campaign launch, integration test, upload, recording upload, contact import, contact form.
- Audit (`audit_logs`): login success/failure, password changes, user/client/permission changes, campaign actions, calls, recording play/download/delete, integrations and credential updates, KB and document actions.
- `validateEnv` fails startup in production on unsafe config; report honest warnings for providers without an adapter (e.g. Sarvam).

## Definition of done
`npm install`, `npm run build`, `npm run test:security` and `node tests/audit.mjs` all pass, including: two-tenant IDOR matrix (read/update/delete),
CUSTOMER against every admin route, role matrix, recordings (authorised / unauthorised / cross-tenant / download / delete), WebSocket isolation and expired auth,
SSRF cases, dialer race and duplicate webhook, RAG isolation, upload attacks. Add a test for every new endpoint (the audit-coverage test fails on untested audited actions).
When finished report: files changed/added, migrations, vulnerabilities fixed (problem, root cause, fix, test, result), endpoint changes, env changes, deploy steps, remaining limitations.
Do not claim production readiness unless the tests actually pass.
