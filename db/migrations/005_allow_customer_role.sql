-- 005: let users.role hold 'CUSTOMER'. Fixes "Invalid value (check the users.role constraint allows 'CUSTOMER')" when creating a customer login.
-- Idempotent and non-destructive: replaces only CHECK constraints that restrict users.role; existing rows are never changed.
DO $$
DECLARE c record; t text;
BEGIN
  -- role stored as a Postgres ENUM type: add the value.
  SELECT udt_name INTO t FROM information_schema.columns
   WHERE table_schema = current_schema() AND table_name = 'users' AND column_name = 'role' AND data_type = 'USER-DEFINED';
  IF t IS NOT NULL THEN
    EXECUTE format('ALTER TYPE %I ADD VALUE IF NOT EXISTS %L', t, 'CUSTOMER');
    RETURN;
  END IF;

  -- role stored as text with a CHECK list: drop the restrictive check(s) (ours, which mentions client_id, is kept) and add one that includes CUSTOMER.
  FOR c IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'users'::regclass AND contype = 'c'
       AND pg_get_constraintdef(oid) ILIKE '%role%' AND pg_get_constraintdef(oid) NOT ILIKE '%client_id%'
  LOOP
    EXECUTE format('ALTER TABLE users DROP CONSTRAINT %I', c.conname);
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'users'::regclass AND conname = 'users_role_check') THEN
    ALTER TABLE users ADD CONSTRAINT users_role_check
      CHECK (upper(role) IN ('SUPER_ADMIN','ADMIN','MANAGER','AGENT','VIEWER','CUSTOMER')) NOT VALID;
  END IF;
END $$;
