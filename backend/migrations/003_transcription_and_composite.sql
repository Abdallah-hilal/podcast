-- Phase 3: transcription + composite rendering
-- Adds transcript columns on podcast_recordings, a per-session composite table,
-- and widens processing_jobs so it can hold session-scoped jobs too.

-- 1. Transcript columns on podcast_recordings
ALTER TABLE podcast_recordings
  ADD COLUMN IF NOT EXISTS transcript_status TEXT NOT NULL DEFAULT 'none'
    CHECK (transcript_status IN ('none','pending','processing','ready','error')),
  ADD COLUMN IF NOT EXISTS transcript_language TEXT,
  ADD COLUMN IF NOT EXISTS transcript_text TEXT,
  ADD COLUMN IF NOT EXISTS transcript_segments JSONB,
  ADD COLUMN IF NOT EXISTS transcript_error TEXT;

-- 2. Composite rendering per session (one row per session, upserted on render)
CREATE TABLE IF NOT EXISTS podcast_session_composites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES podcast_sessions(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','processing','ready','error')),
  final_storage_path TEXT,
  total_bytes BIGINT,
  duration_seconds REAL,
  layout TEXT NOT NULL DEFAULT 'hstack',
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (session_id)
);

CREATE INDEX IF NOT EXISTS idx_composites_session ON podcast_session_composites(session_id);

ALTER TABLE podcast_session_composites ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "owner_manage_composites"
    ON podcast_session_composites FOR ALL
    USING (
      session_id IN (
        SELECT id FROM podcast_sessions WHERE owner_id = auth.uid()
      )
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 3. processing_jobs: allow session-scoped jobs (composite) in addition to
-- recording-scoped jobs (reconstruct, transcribe).
ALTER TABLE processing_jobs
  ALTER COLUMN recording_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS session_id UUID REFERENCES podcast_sessions(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_jobs_type_status ON processing_jobs(job_type, status);
