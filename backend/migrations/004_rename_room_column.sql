-- Rename podcast_sessions.daily_room_name → room_name. Daily.co was replaced
-- by self-hosted LiveKit in Phase 2 (commit ae09fa1); the column name was
-- kept for compatibility until this migration.
--
-- Idempotent: safe to re-run — only rename if the old name still exists and
-- the new one doesn't.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'podcast_sessions'
      AND column_name = 'daily_room_name'
  ) AND NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'podcast_sessions'
      AND column_name = 'room_name'
  ) THEN
    ALTER TABLE public.podcast_sessions
      RENAME COLUMN daily_room_name TO room_name;
  END IF;
END $$;
