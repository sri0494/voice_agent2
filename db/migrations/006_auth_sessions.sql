-- 006: server-side login sessions (inactivity timeout, absolute lifetime, tab liveness, revocation). Additive; no existing table is touched.
-- A session is created at login; the JWT carries its id (`sid`). Every protected request re-checks it, so logout, expiry and
-- revocation work immediately on every Render instance (all state lives here, none in process memory).
CREATE TABLE IF NOT EXISTS auth_sessions (
  id               UUID PRIMARY KEY,
  user_id          TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT now(),   -- last meaningful user action (drives the inactivity timeout)
  last_seen_at     TIMESTAMPTZ NOT NULL DEFAULT now(),   -- last heartbeat / request from an open tab (drives tab liveness)
  expires_at       TIMESTAMPTZ NOT NULL,                 -- absolute maximum lifetime; never extended
  revoked_at       TIMESTAMPTZ,
  revoked_reason   TEXT,
  ip               TEXT,
  user_agent       TEXT
);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_user    ON auth_sessions(user_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires ON auth_sessions(expires_at);
