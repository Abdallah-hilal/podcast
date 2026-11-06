-- Phase 1: Supabase Storage TUS policies
--
-- The Phase 0 baseline (001_init.sql) only grants authenticated INSERT on
-- storage.objects. The TUS resumable protocol also needs SELECT (HEAD to
-- resolve offset) and UPDATE (PATCH chunks). This migration drops the old
-- policies and re-creates them with clearer names plus the two missing ones.

DROP POLICY IF EXISTS "authenticated_upload" ON storage.objects;
DROP POLICY IF EXISTS "service_role_all" ON storage.objects;

DO $$ BEGIN
  CREATE POLICY "allow_authenticated_upload"
    ON storage.objects FOR INSERT
    TO authenticated
    WITH CHECK (bucket_id = 'podcast-recordings');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY "allow_authenticated_select"
    ON storage.objects FOR SELECT
    TO authenticated
    USING (bucket_id = 'podcast-recordings');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY "allow_authenticated_update"
    ON storage.objects FOR UPDATE
    TO authenticated
    USING (bucket_id = 'podcast-recordings');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY "service_role_full_access"
    ON storage.objects FOR ALL
    TO service_role
    USING (bucket_id = 'podcast-recordings');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
