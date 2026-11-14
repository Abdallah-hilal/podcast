-- Fix public.can_access_podcast_object() after the schema split in 005.
--
-- This function is owned by supabase_admin (part of the shared Supabase
-- stack, not this repo) and is called from three RLS policies on
-- storage.objects — podcast_recordings_{select,insert,update}_session_member.
-- Its body still referenced `public.podcast_sessions` and
-- `public.podcast_participants`, so after migration 005 moved those tables
-- every storage upload — podcast AND community (Postgres doesn't guarantee
-- AND short-circuit, so even non-podcast buckets evaluate the predicate) —
-- failed with "relation public.podcast_sessions does not exist".
--
-- CREATE OR REPLACE is idempotent and, since the signature is unchanged,
-- carries the existing GRANTs forward. Must be run as supabase_admin
-- (the function owner), which the shared /pg/query endpoint can't do, so
-- this one lives alongside the others as documentation and is applied via:
--
--   docker exec -i supabase-db psql -U supabase_admin -d postgres \
--     < 006_fix_storage_access_function.sql

CREATE OR REPLACE FUNCTION public.can_access_podcast_object(object_name text)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT public.is_admin(auth.uid())
      OR (
        (storage.foldername(object_name))[1] = 'sessions'
        AND (
          EXISTS (SELECT 1 FROM podcast.sessions s
                   WHERE s.id::text = (storage.foldername(object_name))[2]
                     AND s.owner_id = auth.uid())
          OR
          EXISTS (SELECT 1 FROM podcast.participants p
                   WHERE p.session_id::text = (storage.foldername(object_name))[2]
                     AND p.user_id = auth.uid())
        )
      );
$$;
