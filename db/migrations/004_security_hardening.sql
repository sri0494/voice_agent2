-- 004: security hardening. Additive and idempotent; never deletes data.
-- Constraints that could clash with historical rows are added NOT VALID (enforced for new/changed rows) or skipped with a NOTICE.

-- ---------- sessions: invalidate tokens issued before a password change ----------
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ;

-- ---------- audit trail: use the existing audit_logs table, make sure the columns we write exist ----------
CREATE TABLE IF NOT EXISTS audit_logs (id BIGSERIAL PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS actor_id UUID;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS actor_role TEXT;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS action TEXT;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS resource TEXT;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS resource_id TEXT;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS result TEXT NOT NULL DEFAULT 'success';
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS ip TEXT;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS user_agent TEXT;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS meta JSONB;
-- An older audit_logs table may have NOT NULL columns we do not fill (e.g. user_id, entity). Relax them so audit writes never fail.
DO $$ DECLARE c record; BEGIN
  FOR c IN SELECT column_name FROM information_schema.columns
           WHERE table_schema = current_schema() AND table_name = 'audit_logs' AND is_nullable = 'NO' AND column_default IS NULL
             AND column_name NOT IN ('id') AND is_identity = 'NO'
  LOOP EXECUTE format('ALTER TABLE audit_logs ALTER COLUMN %I DROP NOT NULL', c.column_name); END LOOP;
END $$;
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor  ON audit_logs (actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs (action, created_at DESC);

-- ---------- recordings: retention, consent, idempotent provider callbacks ----------
ALTER TABLE call_recording_files ADD COLUMN IF NOT EXISTS retention_days INTEGER;
ALTER TABLE call_recording_files ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE call_recording_files ADD COLUMN IF NOT EXISTS consent_status TEXT;
ALTER TABLE call_recording_files ADD COLUMN IF NOT EXISTS consent_at TIMESTAMPTZ;
ALTER TABLE call_recording_files ADD COLUMN IF NOT EXISTS consent_method TEXT;
CREATE INDEX IF NOT EXISTS idx_crf_expires ON call_recording_files (expires_at) WHERE expires_at IS NOT NULL;
DO $$ BEGIN
  CREATE UNIQUE INDEX IF NOT EXISTS uq_crf_call_original_url ON call_recording_files (call_id, original_url) WHERE original_url IS NOT NULL;
EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'uq_crf_call_original_url skipped: duplicate rows exist, clean them up and re-run'; END $$;
DO $$ BEGIN
  CREATE UNIQUE INDEX IF NOT EXISTS uq_call_recordings_call_url ON call_recordings (call_id, url);
EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'uq_call_recordings_call_url skipped: duplicate rows exist';
          WHEN undefined_table THEN NULL; END $$;

-- ---------- recording consent per agent + per call ----------
ALTER TABLE agents ADD COLUMN IF NOT EXISTS recording_consent TEXT NOT NULL DEFAULT 'NOT_REQUIRED';
ALTER TABLE agents ADD COLUMN IF NOT EXISTS recording_consent_message TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS recording_retention_days INTEGER;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agents_recording_consent_check') THEN
    ALTER TABLE agents ADD CONSTRAINT agents_recording_consent_check CHECK (recording_consent IN ('NOT_REQUIRED','REQUIRED'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agents_recording_retention_check') THEN
    ALTER TABLE agents ADD CONSTRAINT agents_recording_retention_check CHECK (recording_retention_days IS NULL OR recording_retention_days > 0);
  END IF;
END $$;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS consent_status TEXT;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS consent_at TIMESTAMPTZ;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS consent_method TEXT;

-- ---------- dialer: DIALING state + database-level duplicate-call backstop ----------
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS dial_started_at TIMESTAMPTZ;
DO $$ DECLARE c record; BEGIN
  FOR c IN SELECT conname FROM pg_constraint
           WHERE conrelid = 'contacts'::regclass AND contype = 'c'
             AND pg_get_constraintdef(oid) ILIKE '%status%' AND pg_get_constraintdef(oid) ILIKE '%PENDING%'
  LOOP EXECUTE format('ALTER TABLE contacts DROP CONSTRAINT %I', c.conname); END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contacts_status_check') THEN
    ALTER TABLE contacts ADD CONSTRAINT contacts_status_check
      CHECK (status IN ('PENDING','DIALING','QUEUED','DONE','FAILED','SKIPPED','OPTED_OUT')) NOT VALID;
  END IF;
END $$;
DO $$ BEGIN
  CREATE UNIQUE INDEX IF NOT EXISTS uq_calls_contact_in_flight ON calls (contact_id)
    WHERE contact_id IS NOT NULL AND status IN ('Ringing','Connected','Live');
EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'uq_calls_contact_in_flight skipped: contacts with several in-flight calls exist'; END $$;
CREATE INDEX IF NOT EXISTS idx_calls_provider_call_id ON calls (provider_call_id) WHERE provider_call_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_contacts_campaign_status ON contacts (campaign_id, status);

-- ---------- surveys: a retry cannot create a second answer ----------
DO $$ BEGIN
  CREATE UNIQUE INDEX IF NOT EXISTS uq_survey_response_once ON survey_responses (survey_id, question_id, call_id) WHERE call_id IS NOT NULL;
EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'uq_survey_response_once skipped: duplicate survey responses exist'; END $$;

-- ---------- identity / tenant invariants enforced by PostgreSQL ----------
DO $$ BEGIN
  CREATE UNIQUE INDEX IF NOT EXISTS uq_users_email_lower ON users (lower(email));
EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'uq_users_email_lower skipped: users differing only by e-mail case exist'; END $$;
DO $$ DECLARE c record; BEGIN
  FOR c IN SELECT conname FROM pg_constraint
           WHERE conrelid = 'users'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%role%' AND conname <> 'users_role_check'
  LOOP EXECUTE format('ALTER TABLE users DROP CONSTRAINT %I', c.conname); END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_role_check') THEN
    ALTER TABLE users ADD CONSTRAINT users_role_check
      CHECK (upper(role) IN ('SUPER_ADMIN','ADMIN','MANAGER','AGENT','VIEWER','CUSTOMER')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'clients_status_check') THEN
    ALTER TABLE clients ADD CONSTRAINT clients_status_check CHECK (status IN ('Active','Inactive'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'client_permissions_permission_check') THEN
    ALTER TABLE client_permissions ADD CONSTRAINT client_permissions_permission_check CHECK (permission IN (
      'dashboard','campaigns_view','campaigns_create','campaigns_edit','campaigns_delete',
      'contacts_view','contacts_create','contacts_edit','contacts_delete','calls_view',
      'recordings_view','recordings_download','analytics_view','reports_view','agents_view','settings_view'));
  END IF;
END $$;
