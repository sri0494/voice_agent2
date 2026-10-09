-- Test-only approximation of the production schema (the real db/schema.sql was not available to the author).
-- Columns are those the application code reads and writes. Used ONLY by the test suite, inside a throw-away schema.
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text, email text UNIQUE, phone text, agent_id text,
  password_hash text, role text NOT NULL DEFAULT 'AGENT', status text DEFAULT 'ACTIVE', last_login_at timestamptz,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
CREATE TABLE agents (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text, description text, status text, language text, voice text,
  greeting text, system_prompt text, temperature numeric, fallback_message text, transfer_enabled boolean DEFAULT false, transfer_number text,
  max_call_duration_sec integer, recording_enabled boolean DEFAULT true, created_by uuid, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
  agent_type text, business_name text, gender text, personality text, primary_objective text, allowed_topics text[], restricted_topics text[],
  required_information text[], off_topic_strategy text, max_off_topic_turns integer, knowledge_only_mode boolean, confidence_threshold numeric,
  conversation_style text, extraction_fields jsonb);
CREATE TABLE agent_prompts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), agent_id uuid, system_prompt text, greeting text, created_by uuid, created_at timestamptz DEFAULT now());
CREATE TABLE knowledge_bases (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text, description text, created_by uuid, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
CREATE TABLE agent_knowledge_bases (agent_id uuid REFERENCES agents(id) ON DELETE CASCADE, knowledge_base_id uuid REFERENCES knowledge_bases(id) ON DELETE CASCADE, PRIMARY KEY (agent_id, knowledge_base_id));
CREATE TABLE knowledge_documents (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), knowledge_base_id uuid REFERENCES knowledge_bases(id) ON DELETE CASCADE, title text, source_type text, file_type text, file_path text, status text, chunk_count integer, error_message text, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
CREATE TABLE knowledge_chunks (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), document_id uuid REFERENCES knowledge_documents(id) ON DELETE CASCADE, knowledge_base_id uuid, chunk_index integer, content text, embedding vector(1536));
CREATE TABLE campaigns (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text, type text, description text, language text, agent_id uuid, knowledge_base_id uuid,
  status text DEFAULT 'Draft', start_date timestamptz, end_date timestamptz, retry_attempts integer DEFAULT 2, calling_hours jsonb, created_by uuid,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
CREATE TABLE contacts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), campaign_id uuid REFERENCES campaigns(id) ON DELETE CASCADE, name text, phone text, email text, language text,
  status text DEFAULT 'PENDING', last_call_at timestamptz, call_attempts integer DEFAULT 0, outcome text, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
  city text, state text, country text, contact_type text, source text, tags text[], notes text, converted_to_customer_id uuid);
CREATE TABLE customers (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), first_name text, last_name text, mobile text, alternate_mobile text, email text, customer_code text, address text,
  city text, state text, country text, pin_code text, customer_type text, company_name text, customer_category text, assigned_agent_id uuid, status text DEFAULT 'Active', date_of_birth date,
  preferred_language text, communication_preference text, notes text, tags text[], source_contact_id uuid, created_by uuid, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
CREATE TABLE calls (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), campaign_id uuid REFERENCES campaigns(id) ON DELETE SET NULL, contact_id uuid, agent_id uuid, direction text, customer_name text, phone text,
  language text, status text, provider_call_id text, sentiment text, intent text, outcome text, ai_resolved boolean, duration_sec integer, started_at timestamptz, ended_at timestamptz,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), customer_id uuid, phone_number_id uuid, ai_summary text, follow_up_required boolean);
CREATE TABLE call_messages (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), call_id uuid, speaker text, content text, sequence integer, created_at timestamptz DEFAULT now());
CREATE TABLE call_recordings (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), call_id uuid, url text, duration_sec integer, created_at timestamptz DEFAULT now());
CREATE TABLE surveys (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text, description text, agent_id uuid, created_by uuid, created_at timestamptz DEFAULT now());
CREATE TABLE survey_questions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), survey_id uuid REFERENCES surveys(id) ON DELETE CASCADE, sequence integer, question_text text, question_type text, options jsonb, condition_rule jsonb, required boolean);
CREATE TABLE survey_responses (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), survey_id uuid, question_id uuid, call_id uuid, contact_id uuid, customer_id uuid, answer_text text, answer_numeric numeric, sentiment text, created_at timestamptz DEFAULT now());
CREATE TABLE phone_numbers (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), number text UNIQUE, provider text, agent_id uuid, inbound_enabled boolean, outbound_enabled boolean, business_hours jsonb, recording_enabled boolean, voicemail_enabled boolean, created_at timestamptz DEFAULT now());
CREATE TABLE business_integrations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text, category text, base_url text, auth_type text, encrypted_credentials text, headers jsonb DEFAULT '{}', timeout_ms integer, environment text, status text, created_by uuid, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
CREATE TABLE integration_functions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), integration_id uuid REFERENCES business_integrations(id) ON DELETE CASCADE, function_name text, description text, http_method text, path_template text, input_schema jsonb, created_at timestamptz DEFAULT now(), UNIQUE (integration_id, function_name));
CREATE TABLE agent_integration_functions (agent_id uuid, integration_function_id uuid, PRIMARY KEY (agent_id, integration_function_id));
CREATE TABLE contact_requests (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text, email text, phone text, company text, subject text, message text, status text DEFAULT 'New', created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
-- existing audit_logs, in a shape that is NOT identical to what the migration needs (the migration adds the missing columns)
CREATE TABLE audit_logs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL DEFAULT gen_random_uuid(), entity text NOT NULL, entity_id uuid NOT NULL, details jsonb, created_at timestamptz DEFAULT now());

CREATE TABLE integrations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text, type text, config jsonb, created_at timestamptz DEFAULT now());
