# LeoMox: hardened release (Customer Portal + Recordings + Security)

This zip is an **overlay**: extract it over your project root. It replaces the files listed in section 0 and adds new ones.
It supersedes the earlier `leomox-portal-update.zip`. Review the diff in git before you commit.

## 0. What is inside
| Path | What |
|---|---|
| `server/index.js`, `server/app.js` | **Replaced.** `app.js` builds the Express app (mount order: rate limit, customer blocker, routers); `index.js` validates env, checks the schema, starts the HTTP + WebSocket server, dialer and retention job |
| `server/config/env.js` | Startup validation (fails fast in production on unsafe config) |
| `server/middleware/` | `auth` (DB-backed), `rbac`, `portal` (customer isolation), `rateLimit`, `errorHandler`, `requestLogger` |
| `server/routes/*.js` | All routers hardened (RBAC, tenant scope, audit, validation); new `customerPortal`, `clients`, `recordings` |
| `server/services/` | `permissions`, `clientData`, `recordings`, `liveCalls`, `audit`, `storage`, telephony `placeCall`/`TelephonyProvider`, `campaignDialer`, `functionExecutor`, `vectorSearch` |
| `server/utils/` | `jwt`, `logger`, `crypto`, **new** `ssrf`, `fileValidation` |
| `server/db/pool.js`, `server/db/migrate.js` | Pool with statement timeout; migration runner |
| `db/migrations/002..004` | Recording files, client portal, security hardening (all additive and re-runnable) |
| `src/portal/**`, `src/pages/*`, `src/components/*`, `src/services/http.js` | Customer Portal, admin pages, recorder, API helper |
| `scripts/wire-portal.mjs` | Patches the frontend files this zip cannot replace (preview by default) |
| `tests/**`, `ENDPOINT_AUDIT.md`, `API_SECURITY_MATRIX.md` | Security tests and generated audit reports |
| `package.json`, `.env.example`, `.gitignore`, `README.md`, `USER_MANUAL.md`, `DEVELOPMENT_PROMPT.md` | Updated / new |

## 1. Install
    git checkout -b hardening
    unzip -o leomox-hardened.zip
    npm install

## 2. Wire the frontend
    npm run wire:portal              # preview, changes nothing
    npm run wire:portal -- --apply   # patches src/main.jsx|App.jsx (CustomerGate, routes, sidebar), Live Calls socket; .bak copies saved
Anything marked MANUAL STEP NEEDED is printed with a snippet. `server/index.js` and the routers are already replaced, so the
server side needs no wiring. Do not run it twice by habit: it is idempotent, but read the preview.

If you hit a git merge conflict in `server/routes/recordings.js` or `server/services/recordings.js`, take the versions from this zip.

## 3. Database (Neon)
    npm run db:migrate
Applies `db/migrations/*.sql` in order, one transaction per file, recorded in `schema_migrations`. Do not run `db:init` on every deploy and never run `db:seed` in production.
Migration 004 is defensive: constraints are added `NOT VALID` and unique indexes are skipped with a NOTICE when your existing data already has duplicates.
Check the NOTICE lines, clean the duplicates, and re-run. Existing campaigns are invisible to customers until an admin assigns them.

## 4. Environment (Render dashboard)
Copy the names from `.env.example`. Minimum for production:
`NODE_ENV=production`, `DATABASE_URL`, `JWT_SECRET` (32+ chars), `ENCRYPTION_KEY` (32 bytes base64), `CORS_ORIGIN`, `PUBLIC_BASE_URL`,
`STORAGE_PROVIDER=s3` with `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_REGION=auto`, `S3_ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com`.
Keep the bucket private. Never put secrets in `VITE_*` variables (the server refuses to start if you do).
Telephony `mock` needs `TELEPHONY_WEBHOOK_SECRET` in production, otherwise its webhooks are rejected.

## 5. Render commands
- Build: `npm install && npm run build`
- Pre-deploy: `npm run db:migrate`
- Start: `npm start`

## 6. Smoke test after deploy
1. Log in as admin. **Customer Accounts** -> add "ABC Hospital" with a login and a few permissions; assign one campaign.
2. Log in as that customer: only permitted modules show, only the assigned campaign appears.
3. As the customer, open an admin URL or API such as `/api/customers` or `/api/users`: expect 403.
4. Record and play a recording; check it plays from a short-lived link and that Download is blocked without `recordings_download`.

## 7. Tests
    npm run build
    npm run test:security      # PGlite by default; set TEST_DATABASE_URL (Postgres with pgvector) to include the race tests
    npm run audit
Last run (PGlite): units 44, access 210, recordings 57, ws 27, ops 52, data 80, ui 21, audit-coverage 1, endpoint audit 141 endpoints / 0 HIGH / 0 MED.

## 8. Known limits
- `tests/fixtures/schema.sql` approximates your production schema; I never saw your real `db/schema.sql`.
- Sarvam STT/TTS adapters are **not** included (mock only); Twilio's recording start is untested against a live account.
- No UI yet for: agent consent/retention fields, the Phone Numbers and Knowledge Base delete buttons (the backend delete endpoints exist), the customer dropdown on the campaign form, and the Calls status filter page (backend filter is fixed). Those frontend pages were not provided.
- Not run against real Render, Neon, Twilio or R2.
