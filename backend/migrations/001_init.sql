-- Phase 0: Initial database schema
-- Run this in your Supabase SQL Editor

-- 1. podcast_sessions
CREATE TABLE IF NOT EXISTS podcast_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL,
  title TEXT NOT NULL,
  daily_room_name TEXT,
  status TEXT NOT NULL DEFAULT 'created'
    CHECK (status IN ('created', 'active', 'ended')),
  scheduled_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE podcast_sessions ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "owner_manage_sessions"
    ON podcast_sessions FOR ALL
    USING (auth.uid() = owner_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 2. podcast_participants
CREATE TABLE IF NOT EXISTS podcast_participants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES podcast_sessions(id) ON DELETE CASCADE,
  user_id UUID,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'guest'
    CHECK (role IN ('host', 'guest')),
  invite_token_hash TEXT,
  joined_at TIMESTAMPTZ,
  left_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_participants_session ON podcast_participants(session_id);
CREATE INDEX IF NOT EXISTS idx_participants_user ON podcast_participants(user_id);

ALTER TABLE podcast_participants ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "participant_view_own"
    ON podcast_participants FOR SELECT
    USING (user_id = auth.uid());
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY "owner_manage_participants"
    ON podcast_participants FOR ALL
    USING (
      session_id IN (
        SELECT id FROM podcast_sessions WHERE owner_id = auth.uid()
      )
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 3. podcast_recordings
CREATE TABLE IF NOT EXISTS podcast_recordings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES podcast_sessions(id) ON DELETE CASCADE,
  participant_id UUID NOT NULL REFERENCES podcast_participants(id),
  mime_type TEXT,
  actual_width INTEGER,
  actual_height INTEGER,
  fps REAL,
  duration_seconds REAL,
  total_bytes BIGINT,
  checksum TEXT,
  status TEXT NOT NULL DEFAULT 'recording'
    CHECK (status IN ('recording', 'uploading', 'uploaded', 'processing', 'ready', 'error')),
  final_storage_path TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_recordings_session ON podcast_recordings(session_id);
CREATE INDEX IF NOT EXISTS idx_recordings_participant ON podcast_recordings(participant_id);

ALTER TABLE podcast_recordings ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "participant_manage_recordings"
    ON podcast_recordings FOR ALL
    USING (
      participant_id IN (
        SELECT id FROM podcast_participants WHERE user_id = auth.uid()
      )
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY "owner_view_recordings"
    ON podcast_recordings FOR SELECT
    USING (
      session_id IN (
        SELECT id FROM podcast_sessions WHERE owner_id = auth.uid()
      )
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 4. recording_batches
CREATE TABLE IF NOT EXISTS recording_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recording_id UUID NOT NULL REFERENCES podcast_recordings(id) ON DELETE CASCADE,
  sequence_number INTEGER NOT NULL,
  storage_path TEXT NOT NULL,
  byte_size BIGINT NOT NULL DEFAULT 0,
  checksum TEXT,
  upload_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (upload_status IN ('pending', 'uploading', 'uploaded', 'error')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (recording_id, sequence_number)
);

ALTER TABLE recording_batches ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "participant_manage_batches"
    ON recording_batches FOR ALL
    USING (
      recording_id IN (
        SELECT r.id FROM podcast_recordings r
        JOIN podcast_participants p ON r.participant_id = p.id
        WHERE p.user_id = auth.uid()
      )
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 5. processing_jobs
CREATE TABLE IF NOT EXISTS processing_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recording_id UUID NOT NULL REFERENCES podcast_recordings(id) ON DELETE CASCADE,
  job_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

ALTER TABLE processing_jobs ENABLE ROW LEVEL SECURITY;

-- 6. Create storage bucket
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('podcast-recordings', 'podcast-recordings', false, 5368709120)
ON CONFLICT (id) DO NOTHING;

-- Storage policies: allow authenticated users to upload to their participant path
DO $$ BEGIN
  CREATE POLICY "authenticated_upload"
    ON storage.objects FOR INSERT
    TO authenticated
    WITH CHECK (bucket_id = 'podcast-recordings');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY "service_role_all"
    ON storage.objects FOR ALL
    TO service_role
    USING (bucket_id = 'podcast-recordings');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
