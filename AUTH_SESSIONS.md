# Authentication & session management

## Root cause
1. Login issued a stateless 8-hour JWT; the server stored no session, `POST /auth/logout` did nothing, and nothing checked inactivity.
2. The browser kept that token in `localStorage`, which survives closing the tab/browser, so reopening the site logged you straight back in.

## Design
- **Server sessions** (`auth_sessions`, migration `006`): the JWT carries `sid`; every protected request (`requireAuth`) and WebSocket validates the session row. Logout, password change, user disable and timeouts revoke it. All timing uses the database clock, so it is correct with several Render instances.
- **Inactivity timeout** (default 15 min): reset only by real activity (non-GET requests, or the browser heartbeat reporting a click/key/scroll). Background GET polling does not keep a session alive.
- **Absolute lifetime** (default 8 h): never extended.
- **Tab scoping**: the token lives in `sessionStorage` (per tab, survives refresh, gone when the tab closes). The browser pings every 45 s; if no ping arrives for `AUTH_TAB_LIVENESS_SEC` (180 s) the server ends the session, which also covers browsers that restore sessionStorage when reopening a closed tab. Other tabs have their own session and are unaffected.
- Expired sessions return `401 {code:"SESSION_EXPIRED", reason}`; the SPA clears state, redirects to `/login` once and shows "Your session has expired. Please log in again."
- `Cache-Control: no-store` on all `/api` responses. No password or hash is ever sent or stored client-side. Tokens are sent in the `Authorization` header (no cookies, so no CSRF surface).

## Environment variables
| Name | Default | Meaning |
|---|---|---|
| AUTH_IDLE_TIMEOUT_MIN | 15 | inactivity timeout (minutes, >0) |
| AUTH_ABSOLUTE_TIMEOUT_HOURS | 8 | hard maximum session age |
| AUTH_TAB_LIVENESS_SEC | 180 | end session if the tab stops pinging (0 = off) |
| AUTH_REQUIRE_SESSION | true | `false` only for tests; refused in production |

## Deploy
1. Extract the zip over the project, commit, push. Render's pre-deploy `npm run db:migrate` applies `006_auth_sessions.sql` (additive; no user table touched).
2. Optionally set the variables above.
3. Everyone logs in once after deploy (old tokens have no session id).
4. Frontend: `src/main.jsx` imports `authStorage.js` and `sessionGuard.js` first. Recommended: also change your `services/api.js` `setAuthToken/getToken` to use `sessionStorage` directly; the shim redirects `localStorage` JWT writes meanwhile.

## Tests
`node tests/run-all.mjs` (suites `session`, `session-ui` are new).

## Trade-offs
- Opening a link in a brand-new tab requires login again (that is what tab-scoped means).
- A closed tab restored within ~3 minutes may still be logged in.

## Troubleshooting: login shows "Something went wrong"
Login writes a row to `auth_sessions`. If migration 006 was not applied (Render's pre-deploy command did not run), that insert fails with a 500.
Since this version the table is created automatically at server start (and again on demand), so no manual step is needed.
To confirm in Render > Logs, look for `auth_sessions_ready` after start, or for `relation "auth_sessions" does not exist` before the fix.
Manual alternative: in the Neon SQL editor run the contents of `db/migrations/006_auth_sessions.sql`.
