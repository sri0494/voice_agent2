-- =========================================================
-- LeoMox Voice AI Platform — PostgreSQL Schema (Neon-ready)
-- Run via: npm run db:init
-- Safe to re-run: uses IF NOT EXISTS everywhere, never drops data.
-- =========================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "vector";     -- pgvector for embeddings (Neon supports this)

-- ---------- ENUM-like check constraints kept as TEXT for portability ----------

-- =========================================================
-- USERS & ROLES
-- =========================================================
CREATE TABLE IF NOT EXISTS users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  email           TEXT NOT NULL UNIQUE,
  phone           TEXT,
  agent_id        TEXT,                       -- optional external/agent desk id
  password_hash   TEXT NOT NULL,
  role            TEXT NOT NULL DEFAULT 'AGENT'
                    CHECK (role IN ('SUPER_ADMIN','ADMIN','MANAGER','AGENT','VIEWER')),
  status          TEXT NOT NULL DEFAULT 'ACTIVE'
                    CHECK (status IN ('ACTIVE','DISABLED')),
  last_login_at   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

-- =========================================================
-- AI AGENTS
-- =========================================================
CREATE TABLE IF NOT EXISTS agents (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  TEXT NOT NULL,
  description           TEXT,
  status                TEXT NOT NULL DEFAULT 'DRAFT'
                          CHECK (status IN ('ACTIVE','PAUSED','DRAFT')),
  language              TEXT NOT NULL DEFAULT 'English'
                          CHECK (language IN ('Telugu','English','Hindi')),
  voice                 TEXT,
  greeting              TEXT,
  system_prompt         TEXT,
  temperature           NUMERIC(3,2) NOT NULL DEFAULT 0.30,
  fallback_message      TEXT NOT NULL DEFAULT
    'I don''t have enough information to answer that accurately. I can connect you with a human representative.',
  transfer_enabled      BOOLEAN NOT NULL DEFAULT false,
  transfer_number       TEXT,
  max_call_duration_sec INTEGER NOT NULL DEFAULT 600,
  recording_enabled     BOOLEAN NOT NULL DEFAULT true,
  created_by            UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);

-- Versioned prompt history per agent (audit trail for prompt changes)
CREATE TABLE IF NOT EXISTS agent_prompts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id      UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  system_prompt TEXT NOT NULL,
  greeting      TEXT,
  created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_agent_prompts_agent ON agent_prompts(agent_id);

-- =========================================================
-- KNOWLEDGE BASE
-- =========================================================
CREATE TABLE IF NOT EXISTS knowledge_bases (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  description   TEXT,
  created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Agent <-> Knowledge base (many-to-many)
CREATE TABLE IF NOT EXISTS agent_knowledge_bases (
  agent_id            UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  knowledge_base_id   UUID NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  PRIMARY KEY (agent_id, knowledge_base_id)
);

CREATE TABLE IF NOT EXISTS knowledge_documents (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  knowledge_base_id UUID NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  title             TEXT NOT NULL,
  source_type       TEXT NOT NULL DEFAULT 'FILE' CHECK (source_type IN ('FILE','TEXT','FAQ')),
  file_type         TEXT CHECK (file_type IN ('PDF','TXT','DOCX','CSV','MD', NULL)),
  file_path         TEXT,
  raw_text          TEXT,
  status            TEXT NOT NULL DEFAULT 'PENDING'
                      CHECK (status IN ('PENDING','PROCESSING','READY','FAILED')),
  chunk_count       INTEGER NOT NULL DEFAULT 0,
  error_message     TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_knowledge_documents_kb ON knowledge_documents(knowledge_base_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_documents_status ON knowledge_documents(status);

CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id   UUID NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
  knowledge_base_id UUID NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  chunk_index   INTEGER NOT NULL,
  content       TEXT NOT NULL,
  embedding     vector(1536),   -- adjust dimension to match EMBEDDING_PROVIDER
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_document ON knowledge_chunks(document_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_kb ON knowledge_chunks(knowledge_base_id);
-- IVFFlat index for fast approximate similarity search (build after data exists: run ANALYZE)
CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_embedding
  ON knowledge_chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- =========================================================
-- CAMPAIGNS
-- =========================================================
CREATE TABLE IF NOT EXISTS campaigns (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name              TEXT NOT NULL,
  type              TEXT NOT NULL CHECK (type IN
                      ('Survey','Outbound Sales','Payment Reminder','Appointment Reminder',
                       'Grievance','Customer Support','Custom')),
  description       TEXT,
  language          TEXT NOT NULL DEFAULT 'English',
  agent_id          UUID REFERENCES agents(id) ON DELETE SET NULL,
  knowledge_base_id UUID REFERENCES knowledge_bases(id) ON DELETE SET NULL,
  status            TEXT NOT NULL DEFAULT 'Draft'
                      CHECK (status IN ('Draft','Scheduled','Running','Paused','Completed','Cancelled')),
  start_date        TIMESTAMPTZ,
  end_date          TIMESTAMPTZ,
  retry_attempts    INTEGER NOT NULL DEFAULT 2,
  calling_hours     JSONB NOT NULL DEFAULT '{"start":"09:00","end":"19:00","days":["MON","TUE","WED","THU","FRI"]}',
  created_by        UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_campaigns_status ON campaigns(status);
CREATE INDEX IF NOT EXISTS idx_campaigns_agent ON campaigns(agent_id);

-- =========================================================
-- CONTACTS
-- =========================================================
CREATE TABLE IF NOT EXISTS contacts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id   UUID REFERENCES campaigns(id) ON DELETE CASCADE,
  name          TEXT,
  phone         TEXT NOT NULL,
  email         TEXT,
  language      TEXT DEFAULT 'English',
  status        TEXT NOT NULL DEFAULT 'PENDING'
                  CHECK (status IN ('PENDING','QUEUED','CALLED','DONE','FAILED','DNC')),
  last_call_at  TIMESTAMPTZ,
  call_attempts INTEGER NOT NULL DEFAULT 0,
  outcome       TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_contacts_phone ON contacts(phone);
CREATE INDEX IF NOT EXISTS idx_contacts_campaign ON contacts(campaign_id);

-- =========================================================
-- CALLS
-- =========================================================
CREATE TABLE IF NOT EXISTS calls (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id       UUID REFERENCES campaigns(id) ON DELETE SET NULL,
  contact_id        UUID REFERENCES contacts(id) ON DELETE SET NULL,
  agent_id          UUID REFERENCES agents(id) ON DELETE SET NULL,
  direction         TEXT NOT NULL DEFAULT 'OUTBOUND' CHECK (direction IN ('OUTBOUND','INBOUND')),
  customer_name     TEXT,
  phone             TEXT NOT NULL,
  language          TEXT,
  status            TEXT NOT NULL DEFAULT 'RINGING'
                      CHECK (status IN ('Ringing','Connected','Live','Transferred','Completed','Failed','Missed')),
  provider_call_id  TEXT,               -- id returned by telephony provider
  sentiment         TEXT CHECK (sentiment IN ('Positive','Neutral','Negative', NULL)),
  intent            TEXT CHECK (intent IN
                      ('Pricing','Complaint','Survey','Support','Payment','Appointment',
                       'Information','Transfer','Other', NULL)),
  outcome           TEXT,
  ai_resolved       BOOLEAN,
  duration_sec      INTEGER DEFAULT 0,
  started_at        TIMESTAMPTZ,
  ended_at          TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_calls_status ON calls(status);
CREATE INDEX IF NOT EXISTS idx_calls_campaign ON calls(campaign_id);
CREATE INDEX IF NOT EXISTS idx_calls_agent ON calls(agent_id);
CREATE INDEX IF NOT EXISTS idx_calls_created_at ON calls(created_at);

CREATE TABLE IF NOT EXISTS call_messages (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id       UUID NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  speaker       TEXT NOT NULL CHECK (speaker IN ('AI','CUSTOMER','HUMAN_AGENT','SYSTEM')),
  content       TEXT NOT NULL,
  sequence      INTEGER NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_call_messages_call ON call_messages(call_id);

CREATE TABLE IF NOT EXISTS call_recordings (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id       UUID NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  url           TEXT,
  duration_sec  INTEGER,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_call_recordings_call ON call_recordings(call_id);

-- =========================================================
-- CONTACT US / SALES REQUESTS
-- =========================================================
CREATE TABLE IF NOT EXISTS contact_requests (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  email         TEXT NOT NULL,
  phone         TEXT,
  company       TEXT,
  subject       TEXT,
  message        TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'New' CHECK (status IN ('New','In Progress','Resolved','Closed')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_contact_requests_status ON contact_requests(status);

-- =========================================================
-- INTEGRATIONS
-- =========================================================
CREATE TABLE IF NOT EXISTS integrations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  type          TEXT NOT NULL,     -- e.g. TELEPHONY, AI, STT, TTS, CRM
  status        TEXT NOT NULL DEFAULT 'DISCONNECTED' CHECK (status IN ('CONNECTED','DISCONNECTED','ERROR')),
  config        JSONB NOT NULL DEFAULT '{}',   -- non-secret config only; secrets stay in env vars
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =========================================================
-- AUDIT LOGS
-- =========================================================
CREATE TABLE IF NOT EXISTS audit_logs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID REFERENCES users(id) ON DELETE SET NULL,
  action        TEXT NOT NULL,
  entity_type   TEXT,
  entity_id     UUID,
  metadata      JSONB DEFAULT '{}',
  ip_address    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_user ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at);
