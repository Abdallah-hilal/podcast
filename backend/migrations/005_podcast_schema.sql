-- Move every podcast-owned table out of `public` (shared with the community
-- app) into its own `podcast` schema. Rename them to drop the now-redundant
-- `podcast_` prefix. RLS policies carry over with the tables but their bodies
-- reference other tables by unqualified name — those references would break
-- after rename, so we drop and re-create every policy with fully qualified
-- names.
--
-- Idempotent. Row data, FKs and indexes survive the moves.

BEGIN;

-- 1. Create the schema and grant access.
CREATE SCHEMA IF NOT EXISTS podcast;

GRANT USAGE ON SCHEMA podcast TO anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA podcast
  TO authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA podcast TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA podcast TO service_role, authenticated;

-- New tables created later in this schema get the same grants automatically.
ALTER DEFAULT PRIVILEGES IN SCHEMA podcast
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA podcast
  GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA podcast
  GRANT ALL ON SEQUENCES TO service_role, authenticated;

-- 2. Move + rename each table. SET SCHEMA is a no-op when the table is
-- already in the destination schema; RENAME is a no-op when the target name
-- already exists. Wrapping each pair in a guard keeps this re-runnable.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='podcast_sessions') THEN
    ALTER TABLE public.podcast_sessions SET SCHEMA podcast;
    ALTER TABLE podcast.podcast_sessions RENAME TO sessions;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='podcast_participants') THEN
    ALTER TABLE public.podcast_participants SET SCHEMA podcast;
    ALTER TABLE podcast.podcast_participants RENAME TO participants;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='podcast_recordings') THEN
    ALTER TABLE public.podcast_recordings SET SCHEMA podcast;
    ALTER TABLE podcast.podcast_recordings RENAME TO recordings;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='podcast_session_composites') THEN
    ALTER TABLE public.podcast_session_composites SET SCHEMA podcast;
    ALTER TABLE podcast.podcast_session_composites RENAME TO session_composites;
  END IF;

  -- These two never had the podcast_ prefix (predate the convention). Keep
  -- their names; they just move schemas.
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='processing_jobs') THEN
    ALTER TABLE public.processing_jobs SET SCHEMA podcast;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='recording_batches') THEN
    ALTER TABLE public.recording_batches SET SCHEMA podcast;
  END IF;
END $$;

-- 3. RLS policies moved with the tables but reference peers by unqualified
-- name. After the rename those lookups fail (no `podcast_sessions` in the
-- search path). Drop and re-create with `podcast.*` references.

DROP POLICY IF EXISTS owner_manage_sessions ON podcast.sessions;
CREATE POLICY owner_manage_sessions ON podcast.sessions FOR ALL
  USING (auth.uid() = owner_id);

DROP POLICY IF EXISTS participant_view_own ON podcast.participants;
CREATE POLICY participant_view_own ON podcast.participants FOR SELECT
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS owner_manage_participants ON podcast.participants;
CREATE POLICY owner_manage_participants ON podcast.participants FOR ALL
  USING (
    session_id IN (SELECT id FROM podcast.sessions WHERE owner_id = auth.uid())
  );

DROP POLICY IF EXISTS participant_manage_recordings ON podcast.recordings;
CREATE POLICY participant_manage_recordings ON podcast.recordings FOR ALL
  USING (
    participant_id IN (SELECT id FROM podcast.participants WHERE user_id = auth.uid())
  );

DROP POLICY IF EXISTS owner_view_recordings ON podcast.recordings;
CREATE POLICY owner_view_recordings ON podcast.recordings FOR SELECT
  USING (
    session_id IN (SELECT id FROM podcast.sessions WHERE owner_id = auth.uid())
  );

DROP POLICY IF EXISTS owner_manage_composites ON podcast.session_composites;
CREATE POLICY owner_manage_composites ON podcast.session_composites FOR ALL
  USING (
    session_id IN (SELECT id FROM podcast.sessions WHERE owner_id = auth.uid())
  );

DROP POLICY IF EXISTS participant_manage_batches ON podcast.recording_batches;
CREATE POLICY participant_manage_batches ON podcast.recording_batches FOR ALL
  USING (
    recording_id IN (
      SELECT r.id FROM podcast.recordings r
      JOIN podcast.participants p ON r.participant_id = p.id
      WHERE p.user_id = auth.uid()
    )
  );

-- processing_jobs had RLS enabled but no policy (service_role bypasses RLS
-- anyway; the worker runs with service_role). No change needed.

COMMIT;
