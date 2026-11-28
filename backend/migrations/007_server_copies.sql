-- Server recording copy (design: docs/superpowers/specs/2026-11-28-server-recording-copy-design.md).
--
-- While the host's room switch is on, LiveKit participant egress records each
-- person into an MP4 on the server. Those files live in their own table so the
-- HQ pipeline (sweeper, finalize, reconstruct) never mistakes one for a take.
--
-- Idempotent; additive only.

BEGIN;

CREATE TABLE IF NOT EXISTS podcast.server_copies (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES podcast.sessions(id) ON DELETE CASCADE,
  participant_id uuid NOT NULL REFERENCES podcast.participants(id) ON DELETE CASCADE,
  run text NOT NULL,
  egress_id text UNIQUE,
  status text NOT NULL DEFAULT 'starting'
    CHECK (status IN ('starting', 'recording', 'stopping', 'importing', 'ready', 'error')),
  local_path text,
  storage_path text,
  started_at timestamptz,
  ended_at timestamptz,
  duration_seconds double precision,
  total_bytes bigint,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One open copy per person per run, so the reconcile loop can claim a start
-- by inserting and treat a unique violation as "someone already started it".
CREATE UNIQUE INDEX IF NOT EXISTS server_copies_one_open_per_run
  ON podcast.server_copies (session_id, participant_id, run)
  WHERE status IN ('starting', 'recording');

CREATE INDEX IF NOT EXISTS server_copies_session_idx
  ON podcast.server_copies (session_id);

ALTER TABLE podcast.server_copies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS owner_view_server_copies ON podcast.server_copies;
CREATE POLICY owner_view_server_copies ON podcast.server_copies FOR SELECT
  USING (
    session_id IN (SELECT id FROM podcast.sessions WHERE owner_id = auth.uid())
  );

-- The run the room switch is on right now (NULL = off). Written by
-- POST /sessions/{id}/recording next to the LiveKit room metadata.
ALTER TABLE podcast.sessions ADD COLUMN IF NOT EXISTS recording_run text;

-- Which run an HQ take belongs to, so it can be paired with its server copy.
ALTER TABLE podcast.recordings ADD COLUMN IF NOT EXISTS run text;

COMMIT;
