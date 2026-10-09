# LeoMox — AI Voice Platform

LeoMox is a full-stack platform for AI voice agents: outbound campaigns, inbound
support, government/citizen surveys, payment & appointment reminders, grievance
collection, human-agent transfer, RAG-powered knowledge bases, and call analytics.

This repository contains a **complete, runnable scaffold**: React/Vite frontend,
Express/Node backend, PostgreSQL (Neon-ready) schema with pgvector, JWT auth,
a full RAG pipeline, and provider-abstraction interfaces for AI/STT/TTS/Telephony
so you can plug in real vendors without touching application code.

> **Status note:** this was generated in an environment with no internet access,
> so `npm install` / `npm run build` / a live Neon connection could not be executed
> or verified here. Every file was hand-checked for syntax (`node --check` on all
> backend files; consistent imports/routes across the frontend), but you should
> run the steps below yourself before treating this as production-ready.

---

## 1. Architecture

```
React/Vite Frontend (SPA)
        |
        | HTTPS REST API + WebSocket (live calls)
        v
Node.js / Express Backend
        |
        +----------------------+
        |                      |
        v                      v
  Neon PostgreSQL         AI/Voice Provider Interfaces
        |                      |
        |              +-------+-------+-------+
        |              |       |       |       |
        |             STT     LLM     TTS  Telephony
        |
        +-- users, agents, campaigns, contacts
        +-- calls, call_messages, call_recordings
        +-- clients, client_permissions (customer portal), call_recording_files (object storage)
        +-- knowledge_bases, knowledge_documents, knowledge_chunks (pgvector)
        +-- contact_requests, integrations, audit_logs
```

Provider-specific code lives only in `server/services/{ai,speech,telephony,knowledge}/`.
Every provider is selected at runtime via an environment variable
(`AI_PROVIDER`, `STT_PROVIDER`, `TTS_PROVIDER`, `TELEPHONY_PROVIDER`,
`EMBEDDING_PROVIDER`) and defaults to a **mock implementation** so the whole
app — RAG, campaigns, live-call UI — works out of the box with zero external
API keys. Real vendors are added by implementing the abstract class in each
file and adding a `case` in that file's `create*Provider()` factory function.

**LeoMox does not claim to place real phone calls or generate real AI/voice
output unless real providers are configured.** Mock responses are tagged
`mock: true` in API responses so the UI can label them honestly.

---

## 2. Prerequisites

- Node.js 18+
- A [Neon](https://neon.tech) PostgreSQL database (or any Postgres with the
  `pgvector` extension available)
- (Optional for real voice) accounts with an AI/LLM provider, an STT/TTS
  provider, and an India-compliant telephony provider (e.g. Exotel,
  Knowlarity, Ozonetel)

---

## 3. Local Setup

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# edit .env — at minimum set DATABASE_URL and JWT_SECRET

# 3. Create database schema (safe to re-run; never drops data)
npm run db:init
npm run db:migrate   # applies db/migrations/*.sql once each (recordings, customer portal)

# 4. (Optional, dev only) seed demo data — campaigns, calls, agents, KBs
npm run db:seed
# creates admin@leomox.ai / Leomox@123 — change this password immediately

# 5. Run frontend + backend together in dev mode
npm run dev
# Frontend: http://localhost:5173 (proxies /api and /ws to :10000)
# Backend:  http://localhost:10000
```

## 4. Production Build & Run

```bash
npm install
npm run build      # builds the React app into /dist
npm run db:init    # apply schema to your production DATABASE_URL
npm run db:migrate # apply db/migrations (safe to run on every deploy)
npm start          # Express serves both the API and the built frontend on $PORT
```

Health check: `GET /api/health` → `{ "ok": true, "database": "connected" }`

---

## 5. Deploying to Render + Neon

1. Create a Neon Postgres project, copy the **pooled** connection string
   (`...-pooler....neon.tech/...?sslmode=require`).
2. In Render, create a **Web Service** from this repo.
   - Build command: `npm install && npm run build`
   - Start command: `npm start`
   - Environment: set every variable from `.env.example` (`DATABASE_URL`,
     `JWT_SECRET`, provider keys, etc.) in Render's dashboard. **Never** commit
     `.env` or put secret keys in `VITE_*` variables.
3. After the first deploy, run `npm run db:init` against the production
   `DATABASE_URL` (via a Render Shell, or locally with the same connection
   string) to create tables. Also run `npm run db:migrate`, or set it as
   Render's **Pre-Deploy Command** so every deploy applies new migrations.
   For call recordings set `STORAGE_PROVIDER=s3` and the `S3_*` variables
   (Render's disk is wiped on every deploy, so `local` storage loses files).
4. Do **not** run `npm run db:seed` in production — it refuses to run when
   `NODE_ENV=production` by design.

---

## 6. Connecting Real Providers

Every provider is a drop-in swap. Example for telephony:

```env
TELEPHONY_PROVIDER=exotel
TELEPHONY_API_KEY=...
TELEPHONY_API_SECRET=...
TELEPHONY_PHONE_NUMBER=+91XXXXXXXXXX
TELEPHONY_WEBHOOK_SECRET=...
```

Then implement a class extending `TelephonyProvider` in
`server/services/telephony/TelephonyProvider.js` (there's a commented example
`case` already in `createTelephonyProvider()`) implementing `makeCall`,
`hangup`, `transfer`, `getCallStatus`, `getRecording`. Do the same pattern for
`AIProvider`, `SpeechToTextProvider`, `TextToSpeechProvider`, and
`EmbeddingProvider`. No other file needs to change.

Webhook endpoints are already wired for provider callbacks:
```
POST /api/telephony/webhook
POST /api/telephony/status
POST /api/telephony/recording
```
Signature validation is stubbed in `validateWebhookSignature()` — implement
your provider's specific signature scheme there (most providers use HMAC-SHA256
over the raw payload with a shared secret).

---

## 7. Knowledge Base / RAG Pipeline

```
Upload → Text Extraction → Cleaning → Chunking → Embedding → pgvector storage
                                                                    |
Customer question → Embed question → Cosine similarity search -----+
                                              |
                                    Relevant chunks → LLM context → Answer
```

- Supported formats: PDF, TXT, DOCX, CSV, Markdown (`server/services/knowledge/documentParser.js`)
- Chunking: 1000 chars with 150-char overlap (`chunker.js`)
- Embeddings: pluggable via `EMBEDDING_PROVIDER`; mock provider uses a
  deterministic hash-based vector so the full pipeline is testable without a
  real embedding API key (not semantically meaningful — swap in a real
  provider before relying on retrieval quality)
- Similarity search: pgvector cosine distance (`vectorSearch.js`)
- If no chunk clears the similarity threshold, the agent returns its
  configured **fallback message** rather than guessing — this is enforced in
  `rag.js` and is the core anti-hallucination safeguard for government/pricing
  content.

---

## 8. Default Roles

`SUPER_ADMIN`, `ADMIN`, `MANAGER`, `AGENT`, `VIEWER`, and `CUSTOMER` (a client
business's own login, limited to the Customer Portal — see section 12) — see
`server/middleware/auth.js` (`requireRole`) and `db/schema.sql` for where
role checks are enforced (user management and contact-request triage are
admin/manager-only; everything else requires a valid session).

---

## 9. Project Structure

```
leomox/
├── src/                    # React frontend
│   ├── components/         # Sidebar, Topbar, StatCard, StatusBadge, DataState, VoiceRecorder, RecordingList, CustomerForm
│   ├── pages/               # One file per route (see App.jsx for the map)
│   ├── portal/              # Customer Portal: CustomerGate (role routing), PortalApp (layout), pages/
│   ├── layouts/             # DashboardLayout (sidebar + topbar shell)
│   ├── context/              # AuthContext (session persistence)
│   └── services/api.js      # fetch helper for the original pages; services/http.js for recordings/portal/customer accounts
│
├── server/
│   ├── routes/              # one file per /api/* resource
│   ├── services/
│   │   ├── ai/               # AIProvider + mock
│   │   ├── speech/            # STT / TTS providers + mocks
│   │   ├── telephony/         # TelephonyProvider + mock
│   │   ├── knowledge/         # parser, chunker, embeddings, vectorSearch, rag, ingest
│   │   ├── storage/           # object storage (local | S3-compatible) for recordings
│   │   └── recordings.js, clientData.js, permissions.js
│   ├── middleware/           # auth, portal (customer isolation), error handling, rate limiting, logging
│   ├── db/                    # pool, init script, seed script
│   └── index.js               # Express app + WebSocket server
│
├── db/schema.sql            # full Postgres schema (pgvector, indexes, constraints)
├── db/migrations/           # additive migrations applied by `npm run db:migrate`
├── scripts/wire-portal.mjs  # one-time wiring of the customer portal into existing files
├── tests/                   # security + portal UI tests (`npm run test:security`)
├── uploads/                 # local file storage for uploaded KB documents
└── .env.example
```

---

## 10. What's Deliberately Left as a Provider Adapter

Per the safety requirements this project was built to: LeoMox will **not**
claim a voice agent is live/real unless real Telephony + STT + TTS + AI
providers are configured. The mock providers exist so you can develop,
demo, and test the entire product loop — agent config, campaigns, contact
upload, knowledge base, RAG answers, analytics — before connecting a single
paid vendor.

---

## 11. Call Recordings & Object Storage

- **Where files live:** `server/services/storage/` is a provider abstraction. `STORAGE_PROVIDER=s3` works with
  Cloudflare R2, AWS S3, Backblaze B2 or MinIO; `local` writes to `uploads/recordings` and is **development only**:
  in production the server refuses to start with local storage (no silent fallback).
- **Always private. There is no public file URL.** Playback goes: JWT -> role -> permission -> tenant -> ownership ->
  a 5-minute presigned R2/S3 URL. In development with local storage the same route returns an authenticated
  `/stream` path that the browser fetches with its token. Credentials and permanent URLs are never returned.
- **Two permissions:** `recordings_view` (play) and `recordings_download` (download). A view-only customer cannot download.
- **Retention:** per agent (`recordingRetentionDays`, 1-3650, or null = forever) with `RECORDING_RETENTION_DAYS` as the default.
  A purge job deletes expired objects, marks the rows and writes an audit entry.
- **Consent:** per agent `recordingConsent` = `NOT_REQUIRED | REQUIRED` plus a configurable `recordingConsentMessage`.
  When REQUIRED, the call plays the message and recording starts only after the callee agrees at `/api/telephony/voice/:callId/consent`;
  status, timestamp and method are stored. LeoMox does not claim recording is lawful anywhere: wording is yours.
  (These settings are API fields today; there is no UI form for them yet.)
- **Sources:** browser recorder, manual upload (magic-byte validated), and telephony webhooks via `ingestRecordingFromUrl()`
  (SSRF-guarded fetch, idempotent per provider recording id).
- **API (staff only):** `POST/GET /api/recordings`, `GET /api/recordings/:id/url`, `GET /api/recordings/:id/stream`
  (local storage only), `DELETE /api/recordings/:id`. Customers use `/api/customer/recordings/*`.

## 12. Customer Portal (client accounts)

A **Customer Account** is a client business (e.g. "ABC Hospital") that owns
campaigns, contacts, calls and recordings. It is separate from the existing
*Customers* page, which lists individual people.

```
Admin -> Customer Accounts -> create customer -> create login (role CUSTOMER)
      -> set permissions -> assign campaigns
Customer logs in -> Customer Portal (own data only, only permitted modules)
```

- **Modules:** Dashboard, Campaigns, Contacts, Recordings, Call History,
  Analytics, Agents, Settings, plus actions (create/edit/delete, download, reports).
- **Isolation is enforced on the server.** The customer comes only from the
  logged-in user's `users.client_id`; `?customer_id=` or body values are ignored.
  Another customer's record returns **403**; a customer calling an admin API
  gets **403** (`blockCustomerOutsidePortal`, mounted before all other `/api`
  routers, plus `requireStaff` on each admin router).
- **Frontend:** `CustomerGate` shows the portal to CUSTOMER logins (also after a
  refresh) and your existing app to everyone else. Hiding menus is only cosmetic.
- **Existing campaigns** are invisible to customers until an admin assigns them.
- Wiring and deployment steps: see `SETUP.md`.

## 13. Tests & Security Audit

```bash
npm install
npm run build                 # frontend build
npm run test:security         # 7 suites + audit-coverage + endpoint audit (see below)
node tests/audit.mjs          # regenerates ENDPOINT_AUDIT.md and API_SECURITY_MATRIX.md from the real app.use() mounts
```
The suites run real HTTP against the real Express app. Set `TEST_DATABASE_URL` to a throw-away Postgres with the
`vector` extension (each run uses its own schema and drops it) to also run the concurrency/race tests; with it unset
they run on in-process PGlite (single connection, so the race tests are skipped). Last run in PGlite mode:
units 44, access 210, recordings 57, ws 27, ops 52, data 80, ui 21, audit-coverage 1, endpoint audit 141 endpoints / 0 HIGH / 0 MED.
`tests/fixtures/schema.sql` is a **test-only approximation** of the production schema; it is not your `db/schema.sql`.

## 14. Security model (read before going live)

| Area | What the server enforces |
|---|---|
| Auth | HS256 pinned; user re-loaded from the DB on every request; disabled user / inactive customer / token older than `password_changed_at` is rejected at once |
| Roles | SUPER_ADMIN, ADMIN, MANAGER, AGENT, VIEWER, CUSTOMER via `rbac()`; VIEWER is read-only; CUSTOMER reaches only `/api/customer/*` |
| Customer isolation | `client_id` comes only from the session; request `customer_id`/`client_id` is ignored; other tenants' records answer 404/403 |
| Admin boundary | `blockCustomerOutsidePortal` is mounted before every router (fails closed with 401 on a token without a user id) plus `requireStaff` on each admin router |
| Recordings | private bucket, short-lived signed URLs, separate download permission, retention, consent, audit of play/download/delete |
| Integrations | SSRF guard (DNS resolved at connect time, private/loopback/link-local/metadata blocked, https + port 443 in production, no redirects); secrets encrypted (AES-256-GCM) and never returned (`hasCredentials` only) |
| Uploads | size caps, magic bytes + extension + MIME, sanitised names, path traversal rejected, CSV row cap |
| Dialer / webhooks | atomic `FOR UPDATE SKIP LOCKED` claim, advisory lock, stale-DIALING release, unique in-flight call per contact, forward-only status, signed + replay-windowed webhooks |
| Live Calls | WebSocket authenticated at upgrade (token in `Sec-WebSocket-Protocol`), tenant-scoped per message, phone masked, re-validated every 30 s |
| RAG | retrieval limited to knowledge bases attached to the agent; Knowledge-Only fallback preserved |
| Ops | per-route rate limits (`RL_*`), audit trail in `audit_logs` (secrets redacted), startup `validateEnv`, no stack traces to clients |

Generated references: `ENDPOINT_AUDIT.md` and `API_SECURITY_MATRIX.md`.

## 15. Providers and honest limits

Intended production chain: Frontend -> LeoMox Node.js -> Gemini -> telephony provider -> Cloudflare R2 -> Neon PostgreSQL.
Telephony is pluggable (`TelephonyProvider`); `mock` always works and is clearly labelled. Today `twilio` is the only real adapter, and it is optional.

- **Sarvam STT/TTS adapters are not shipped.** `STT_PROVIDER` / `TTS_PROVIDER` other than `mock` only produce a startup warning.
- **Twilio recording start** (`Calls/{sid}/Recordings.json`) was written from the API documentation and has not been run against a live Twilio account.
- Nothing here has been run against real Render, Neon, Twilio or R2 services.
