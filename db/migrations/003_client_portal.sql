-- Customer Portal (client = business owner, e.g. "ABC Hospital").
-- Additive and idempotent: safe to re-run, deletes nothing, existing `customers` table is untouched.
-- Ownership chain: clients -> campaigns -> contacts / calls -> recordings (traced via campaigns.client_id).

CREATE TABLE IF NOT EXISTS clients (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL,
  company_name TEXT,
  email        TEXT,
  phone        TEXT,
  status       TEXT NOT NULL DEFAULT 'Active',
  created_by   UUID,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS client_permissions (
  client_id  UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  permission TEXT NOT NULL,
  PRIMARY KEY (client_id, permission)
);

ALTER TABLE users     ADD COLUMN IF NOT EXISTS client_id UUID REFERENCES clients(id) ON DELETE SET NULL;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS client_id UUID REFERENCES clients(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_users_client      ON users(client_id);
CREATE INDEX IF NOT EXISTS idx_campaigns_client  ON campaigns(client_id);
CREATE INDEX IF NOT EXISTS idx_calls_campaign    ON calls(campaign_id);
CREATE INDEX IF NOT EXISTS idx_contacts_campaign ON contacts(campaign_id);

-- A CUSTOMER login must always be linked to a client.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_customer_requires_client') THEN
    ALTER TABLE users ADD CONSTRAINT users_customer_requires_client
      CHECK (upper(role) <> 'CUSTOMER' OR client_id IS NOT NULL);
  END IF;
END $$;

-- Recording files table (same as 002; included so this migration is self-contained).
CREATE TABLE IF NOT EXISTS call_recording_files (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id          UUID,
  source           TEXT NOT NULL DEFAULT 'upload',
  storage_provider TEXT NOT NULL,
  storage_key      TEXT NOT NULL,
  content_type     TEXT NOT NULL,
  size_bytes       BIGINT NOT NULL,
  duration_sec     INTEGER,
  original_url     TEXT,
  created_by       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_call_recording_files_call ON call_recording_files(call_id);

-- NOTE: if `users.role` has a CHECK constraint listing allowed roles, add 'CUSTOMER' to it.
-- Find it with:  SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'users'::regclass;
