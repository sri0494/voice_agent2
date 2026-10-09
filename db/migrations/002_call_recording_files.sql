-- New table (does not touch your existing call_recordings table).
-- Assumes calls.id is UUID. If it is not, change call_id's type to match.
CREATE TABLE IF NOT EXISTS call_recording_files (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id          UUID,
  source           TEXT NOT NULL DEFAULT 'upload',   -- upload | browser | telephony
  storage_provider TEXT NOT NULL,                    -- local | s3
  storage_key      TEXT NOT NULL,
  content_type     TEXT NOT NULL,
  size_bytes       BIGINT NOT NULL,
  duration_sec     INTEGER,
  original_url     TEXT,
  created_by       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_call_recording_files_call ON call_recording_files(call_id);
-- Optional once you've confirmed calls.id is UUID:
-- ALTER TABLE call_recording_files ADD CONSTRAINT fk_crf_call FOREIGN KEY (call_id) REFERENCES calls(id) ON DELETE SET NULL;
