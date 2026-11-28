# Server recording copy (cloud copy) — design

Date: 2026-11-28 · Status: draft, waiting for Abdallah's approval

## Intent

Each person records locally in high quality (VP9 12–40 Mbps, Opus 256k) and
uploads it in the background. On Abdallah's ~1.7 Mbps home uplink that upload
takes hours after the call, so the laptop has to stay open. He wants the Zoom
cloud-recording experience: when the call ends, both people's recordings are
already on the server. He chose "both together": the server keeps a copy at
call quality from the moment the call starts, and the HQ copy keeps uploading
in the background and replaces it for editing once it arrives. If someone
closes their laptop early, the server copy is what we edit with.

## Goals

- While the host's room recording switch is on, the server records each person
  (host and guest) into their own file. It starts when the host presses Record
  and stops when the host presses Stop.
- A few seconds after Stop, both server copies are in the podcast's Supabase
  storage and recorded in the DB. Nobody's browser has to do anything for that.
- A guest who joins late, refreshes, or drops and rejoins while recording is on
  gets a server copy too (a second segment, the way takes already work).
- Editing (Mix page composite and `podcast_edit.py fetch` → `podcast_master.py`)
  uses a person's HQ take when it has fully arrived, and that person's server
  copy otherwise.
- Raise call audio from the default 48 kbps to hi-fi, since the call audio is
  now a possible episode source.

## Non-goals

- Changing the HQ recording, its live upload pacing, or the post-call upload.
- A mixed or side-by-side server recording. We want one file per person.
- Re-rendering the composite automatically when HQ arrives. Pressing Render
  again picks up the HQ takes.
- Captions, transcripts, more than 2 people.

## Anti-goals

- The server recording must never break or slow the live call or the HQ
  pipeline. If egress fails, the call and the HQ copy carry on as today.
- No guest action can start or stop recording for others (the host switch
  stays the only control).
- Nothing is restarted on the shared VPS without telling Abdallah first.

## Constraints found

- LiveKit 1.13.11 runs alone (`/opt/livekit`, compose project with one
  `livekit` service, no Redis). Egress needs a Redis that livekit-server also
  uses, so `livekit.yaml` gets a `redis:` block and the `livekit` container must
  restart. Any live call drops for a few seconds. **This needs Abdallah's
  explicit OK, and we restart only when no call is running.**
- VPS: 6 cores, 11 GB RAM (7 GB free), 138 GB disk free, load around 3. LiveKit
  recommends 4 CPUs / 4 GB for an egress instance. Two 720p participant egresses
  should fit, but the egress container gets a CPU cap so it can't starve the
  call.
- The podcast Supabase storage has the S3 endpoint routed but not enabled
  (`S3_PROTOCOL_ACCESS_KEY_*` are empty). Enabling it would mean new storage
  superuser keys and recreating `podcast-supabase-storage`.
- Call publish settings today (`SessionClient.tsx`, no `options`): VP8,
  simulcast, top layer at the capture size, BWE-limited. Audio is the
  livekit-client default: mono Opus at 48 kbps max with DTX and RED on.
- With a 1.7 Mbps uplink shared with the live HQ upload, the call video (and so
  the server copy) will be roughly 540p–720p at about 1 Mbps. A guest on a fast
  line sends more.

## Approaches

### What records each person

1. **Participant egress, one MP4 per person (chosen).** LiveKit's SDK egress
   (no Chrome) subscribes to one participant and writes their audio and video
   into one synced MP4 (H.264 + Opus). It keeps going through mute/unmute and
   camera changes, and ends when the participant leaves. Cost: it re-encodes
   (about one core per 720p stream). The source is already call quality, so
   re-encoding at 3 Mbps loses almost nothing.
2. **Track egress (passthrough), no re-encode.** Almost no CPU, but it gives a
   separate video file and audio file per person, with no guaranteed sync
   between them (video waits for a keyframe). One egress per track also stops
   when that track is republished, and the file switches resolution with
   simulcast. We'd need a mux step and a sync fix. Not worth it for a fallback
   copy.
3. **TrackComposite** re-encodes too (the docs say Composite and Participant are
   both transcoded) and needs the track ids up front. Participant egress is the
   same thing, but it follows the person.
4. Room composite (Chrome, one mixed file): ruled out. We need one file per
   person, and it's the heaviest on CPU.

Encoding: preset `H264_720P_30` (1280×720, 3 Mbps video, Opus 128k), about
1.4 GB per person per hour. My call: the call rarely carries more than 720p on
these lines, and 1080p doubles the encode cost on a shared box.

### Where the files land

1. **Egress writes to a local folder; the worker imports it into Supabase
   storage (chosen).** Egress writes `/out/...mp4` into a host folder
   (`/opt/podcast-egress`) that the `podcast-worker` container also mounts. When
   the egress is complete, the worker streams the file into the
   `podcast-recordings` bucket with its own long timeout (not the shared
   storage3 client, whose timeout fix is still pending), marks the row ready,
   and deletes the local file. This needs no Supabase restart and no new keys.
   If storage is down, the file waits on disk and the worker retries.
2. Egress uploads straight to Supabase's S3 endpoint. That's one less hop, but
   it means enabling S3 protocol keys (storage superuser keys) and recreating
   `podcast-supabase-storage`, and Supabase S3 working with the egress uploader
   is unproven.

### How starts, late joiners and finishes are detected

1. **Backend starts/stops right away; a worker loop reconciles (chosen).** The
   host switch endpoint starts an egress for everyone in the room on Record and
   stops all of them on Stop. A small loop in the worker (its own thread, so a
   long reconstruct or composite can't stall it) runs every ~5 s. For a session
   whose switch is on, it starts an egress for any participant who has none
   (late joiner, rejoin). For open copies whose egress is no longer active, it
   reads the final file info and queues the import. A DB unique index makes
   "start a copy for person X in run R" idempotent, so the backend and the loop
   can't start two copies of the same person.
2. LiveKit webhooks (`participant_joined`, `egress_ended`) to a new backend
   endpoint. This is event-driven, but it needs a webhook block in the shared
   `livekit.yaml`, sends every room's events to the podcast, and still needs a
   safety net for missed events. Per-request egress webhooks exist in the API
   and can come later if polling proves too slow.

## The design

### Infrastructure (on the VPS, after Abdallah's OK)

- `/opt/livekit/docker-compose.yml` gains `redis` (redis:7-alpine, no
  persistence, no public port) and `egress` (`livekit/egress`, pinned version,
  CPU-capped, `/opt/podcast-egress:/out`). `livekit.yaml` gains
  `redis: {address: redis:6379}`. Egress config: same API key/secret as
  livekit, `ws_url: ws://livekit:7880`, same Redis, CPU-cost settings tuned so
  two participant egresses are accepted. If the egress container can't reach
  LiveKit's media ports over the bridge, it falls back to host networking.
- The repo keeps copies without secrets under `deploy/livekit/`.
- `podcast-worker` mounts `/opt/podcast-egress:/egress` and gets `livekit-api`.

### Data

New table `podcast.server_copies`, kept apart from `podcast.recordings` so the
sweeper, finalize, reconstruct and composite paths can't mistake a server copy
for an HQ take:

| column | notes |
|---|---|
| `id` uuid pk | |
| `session_id`, `participant_id` | FKs, cascade on delete |
| `run` text | the room switch's run id |
| `egress_id` text unique | |
| `status` | `starting` → `recording` → `importing` → `ready`, or `error` |
| `local_path`, `storage_path` | `sessions/{sid}/participants/{pid}/server-{id}/call.mp4` |
| `started_at`, `ended_at` | from egress FileInfo; this is the timeline position |
| `duration_seconds`, `total_bytes`, `error_message`, `created_at`, `updated_at` | |

There is a unique partial index on `(session_id, participant_id, run)` where
status is `starting` or `recording`, and RLS owner select. `podcast.sessions`
gets `recording_run text` (set and cleared by the switch endpoint) so the loop
knows which rooms are recording. `podcast.recordings` gets a nullable `run`.
The browser sends it when it starts a take, which pairs each HQ take with its
server copy.

### Which copy editing uses

This is per person, per run. If every HQ take that person has in that run is
`ready`, use the HQ takes. Otherwise use that person's server copies for that
run. Takes without a run (older sessions, local-only mode) are HQ as today. A
run is all HQ or all server copy for one person, never a mix of segments. My
call: it's simpler, and it can't overlap.

- Worker `composite`: builds its take list with that rule.
- Mix page: one line per person, "HQ" or "Call copy — HQ still uploading", and
  the composite counts include server copies.
- `tools/podcast_edit.py fetch`: same rule. It writes each person's chosen file
  into `manifest.json` with `start` (HQ: `created_at`; server copy: FileInfo
  `started_at`) and a `source` field. `podcast_master.py` reads the manifest
  unchanged, so this design doesn't touch that file.

### Call publish quality

`<LiveKitRoom options={{ publishDefaults: { audioPreset:
AudioPresets.musicHighQuality, dtx: false, red: true } }}>`: 96 kbps mono Opus,
with no DTX so room tone stays continuous, and RED kept for packet loss. That's
about +100–150 kbps of uplink. Video stays as it is: BWE already fits it to the
line, and the HQ copy is where the quality lives.

### Deletion and failure

- Session delete already removes `sessions/{id}/…` from storage, and the rows
  cascade. The worker deletes local egress files after import. Files that fail
  to import stay on disk until a retry succeeds.
- If an egress fails or is rejected, the row is `error`, nothing in the call
  changes, and the HQ copy is the only source (as today).
- MP4 is written at the end. If egress or the server crashes mid-call, that
  segment is lost. The HQ copy is unaffected.
- If the host's browser vanishes with the switch on, the room closes once it
  is empty. The loop sees the room is gone, clears `recording_run`, and
  finishes any open copies.

## Done means

- The two-browser E2E against prod (fake media rig, upload throttled) shows
  both people's server copies `ready` in storage seconds after the host
  presses Stop, while the HQ uploads are still running. Later, the composite
  and `fetch` pick HQ for each person once their take is ready.
- Deployed per the usual flow, LiveKit restarted only with Abdallah's OK and
  with no call running.
- Memory files updated.

## Left to the builder

- Exact egress version pin, CPU cap and cpu-cost numbers. Verify that two
  egresses start on the box.
- Whether `ListEgress(egress_id)` returns finished egresses; if not, read the
  egress manifest JSON written next to the file.
- Measure in the E2E how far a server copy's `started_at` is from the HQ
  take's `created_at` for the same person. If it's more than ~0.3 s, note it for
  the editor (matching the two audio tracks gives an exact offset; that's a
  later improvement in the editor).
