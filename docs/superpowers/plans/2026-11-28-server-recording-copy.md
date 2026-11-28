# Server Recording Copy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** While the host's room switch is on, LiveKit participant egress records each person into an MP4 that lands in the podcast's Supabase storage seconds after Stop. Editing prefers the HQ take once it is complete.

**Architecture:** The backend only flips `sessions.recording_run`, next to the room metadata it already writes. A reconcile thread in the worker (every 2 s) makes LiveKit match it: start an egress for each participant without one, stop egresses of old runs, and mark finished egresses `importing`. An importer thread streams finished files from `/egress` into storage. A pure `choose_sources()` picks HQ or server copy per person per run for the composite, the Mix page and `fetch`.

**Tech Stack:** livekit-api 1.2.2 (Python, async), livekit/egress + redis:7-alpine (docker), Supabase storage HTTP API, FastAPI, Next.js + livekit-client 2.23, stdlib unittest / node --test.

**Spec:** `docs/superpowers/specs/2026-11-28-server-recording-copy-design.md`

## Global Constraints

- Never restart `livekit` while a room has participants. Tell Abdallah right before the restart (he approved it on 2026-11-28).
- Don't restart supabase-* containers. Don't touch abdallah-* or /opt/abdallah-community. No UFW/SSH changes.
- Don't edit `tools/podcast_master.py`. Don't change the shared storage3 client timeout in `worker/main.py`.
- Egress preset `H264_720P_30`, MP4 output, one per participant, no Chrome.
- Storage path `sessions/{sid}/participants/{pid}/server-{copy_id}/call.mp4`. Local path in egress `/out/{sid}/{pid}/{copy_id}.mp4`, which the worker sees as `/egress/...`.
- Call audio publish: `AudioPresets.musicHighQuality`, `dtx: false`, `red: true`.
- Commits on main end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

- Guest drops and rejoins mid-run: the old egress ends and a new copy starts for the same person and run (reconcile test `test_rejoin_after_copy_finished_starts_another`).
- Stop then Record within 2 s: old-run copies get stopped and new ones start (test `test_new_run_stops_old_copies`).
- Egress refuses to start (no CPU, not connected): no tight retry loop (test `test_recent_error_blocks_retry_for_a_minute`).
- HQ partly ready and no server copy: use the ready HQ takes, don't drop the person (sources test `test_partial_hq_without_server_copy_uses_ready_hq`).
- Room gone while the switch is on (host vanished): clear `recording_run` (test `test_missing_room_clears_run`).

---

### Task 1: Redis + egress next to LiveKit (VPS)

**Files:**
- Create: `deploy/livekit/docker-compose.yml`, `deploy/livekit/livekit.yaml.example`, `deploy/livekit/egress.yaml.example` (no secrets)
- Modify on VPS: `/opt/livekit/docker-compose.yml`, `/opt/livekit/livekit.yaml`; create `/opt/livekit/egress.yaml` (chmod 600) and `/opt/podcast-egress/`

- [ ] Back up `/opt/livekit/*` to `*.bak-20261128`. Pull `livekit/egress` and pin its version tag.
- [ ] Compose: `redis` (`redis:7-alpine`, `--save "" --appendonly no`, no ports), and `egress` (pinned, `EGRESS_CONFIG_FILE=/etc/egress.yaml`, `/opt/podcast-egress:/out`, `cpus: 3`, restart unless-stopped). `livekit.yaml` gets `redis: {address: redis:6379}`.
- [ ] egress.yaml: `api_key`/`api_secret` copied from livekit.yaml, `ws_url: ws://livekit:7880`, `redis.address: redis:6379`, and cpu costs lowered so two participant egresses fit on 6 cores.
- [ ] Check that no room has participants (`list_rooms` from podcast-backend), tell Abdallah, then `docker compose up -d`.
- [ ] Verify: livekit logs show redis connected, egress logs show it registered, and `list_egress` from podcast-backend returns without "egress not connected". Commit `deploy/livekit/`.

### Task 2: Schema

**Files:** Create `backend/migrations/007_server_copies.sql`

- [ ] `podcast.server_copies` as in the spec (status check `starting|recording|stopping|importing|ready|error`). Unique partial index `(session_id, participant_id, run) where status in ('starting','recording')`, RLS on, owner select policy. Add `podcast.sessions.recording_run text` and `podcast.recordings.run text`. Idempotent (`if not exists`).
- [ ] Apply with `docker exec -i podcast-supabase-db psql -U postgres -d postgres`. Verify with `\d podcast.server_copies`. Commit.

### Task 3: Source choice (pure)

**Files:** Create `worker/sources.py`, `worker/test_sources.py`, `backend/app/services/sources.py` (byte-identical copy)

**Interfaces:**
- Produces: `choose_sources(takes: list[dict], copies: list[dict]) -> list[dict]`. Takes have keys `id, participant_id, run, status, created_at, final_storage_path`. Copies have `id, participant_id, run, status, started_at, storage_path`. Each returned item is `{kind: "hq"|"server", id, participant_id, start (iso str), path}`, sorted by start, ready items only.
- Produces: `summarize_people(takes, copies) -> dict[participant_id, {"source": "hq"|"server"|"none", "hq_ready": int, "hq_total": int, "server_ready": int}]`

- [ ] Tests: `test_complete_hq_wins`, `test_incomplete_hq_falls_back_to_server`, `test_partial_hq_without_server_copy_uses_ready_hq`, `test_legacy_take_without_run_is_hq`, `test_runs_decided_independently`, `test_summary_reports_source_per_person`, `test_backend_copy_is_identical` (compares the two files' bytes).
- [ ] Rule per (participant, run): all HQ takes ready → HQ. Else any ready server copy → those copies. Else → the ready HQ takes. `run is None` → HQ as today.
- [ ] `python3 -m unittest worker/test_sources.py` passes. Commit.

### Task 4: Reconcile plan (pure)

**Files:** Create `worker/server_copy.py`, `worker/test_server_copy.py`

**Interfaces:**
- Produces: `plan_reconcile(session: dict, room_identities: set[str] | None, copies: list[dict], now: datetime) -> Plan`. Here `session` is `{id, recording_run}`. `room_identities` is None when the room doesn't exist, otherwise non-egress identities that are session participants. `copies` are this session's rows. `Plan(start: list[str], stop: list[dict], clear_run: bool)`.
- Produces: `egress_done(status: int) -> bool` (COMPLETE/FAILED/ABORTED/LIMIT_REACHED), `local_to_worker(path) -> str` (`/out/` → `/egress/`), `storage_path(sid, pid, copy_id) -> str`.

- [ ] Tests: `test_start_for_everyone_in_room`, `test_open_copy_is_not_started_twice`, `test_rejoin_after_copy_finished_starts_another`, `test_new_run_stops_old_copies`, `test_switch_off_stops_open_copies`, `test_recent_error_blocks_retry_for_a_minute`, `test_missing_room_clears_run`.
- [ ] Pass, commit.

### Task 5: Worker threads, import, composite choice

**Files:** Modify `worker/main.py`, `worker/requirements.txt` (+`livekit-api==1.2.2`), `worker/Dockerfile` (COPY new modules), `docker-compose.yml` (worker volume `/opt/podcast-egress:/egress`)

**Interfaces:** Consumes Tasks 3–4.

- [ ] `reconcile_loop()` runs in a daemon thread with its own client, every 2 s, using `asyncio.run(tick())` with one `api.LiveKitAPI`. Sessions with `recording_run` or with open copies → plan. Start: insert row `starting` (a unique-violation means skip) → `start_participant_egress(ParticipantEgressRequest(room_name, identity, preset=H264_720P_30, file_outputs=[EncodedFileOutput(file_type=MP4, filepath=/out/...)]))` → `recording` with `egress_id`/`local_path`. If it fails → `error` + message. Stop → `stop_egress`, status `stopping`. For each open row, `list_egress(egress_id=…)`. If it's done with a file → `importing` with FileInfo `started_at/ended_at/duration/size`. If done without a file → `error`.
- [ ] `import_loop()` runs in a daemon thread every 5 s. It streams `importing` rows into storage with httpx (POST `/storage/v1/object/podcast-recordings/{path}`, service key, `x-upsert: true`, timeouts read/write 600 s), marks the row `ready` with `total_bytes`, and deletes the local file and its `.json` manifest. If it fails → keep `importing` with `error_message`, retry after 60 s. If the file is missing → `error`.
- [ ] `process_composite` builds its take list from `choose_sources` (server copies are MP4; `_remux_with_index` already passes non-VP files through).
- [ ] `python3 -m unittest discover worker` passes. Commit.

### Task 6: Backend

**Files:** Modify `backend/app/routers/sessions.py`, `backend/app/routers/recordings.py`

- [ ] `set_room_recording` writes `sessions.recording_run = meta["run"]` (None on stop) after the metadata update.
- [ ] `StartRecordingRequest.run: str | None = None`, stored in the `recordings.run` column.
- [ ] `get_composite` / `render_composite` count with `choose_sources` over the session's takes and copies. The response adds `people: list[{participant_id, role, source, hq_ready, hq_total, server_ready}]`.
- [ ] Byte-compile check `python3 -m py_compile`. Commit.

### Task 7: Frontend

**Files:** Modify `frontend/src/app/session/[id]/SessionClient.tsx`, `frontend/src/lib/recording/pipeline.ts`, `frontend/src/lib/api.ts`, `frontend/src/types/index.ts`, `frontend/src/app/session/[id]/mix/MixClient.tsx`

- [ ] `<LiveKitRoom options={{ publishDefaults: { audioPreset: AudioPresets.musicHighQuality, dtx: false, red: true } }}>` (stable module-level object).
- [ ] The switch-driven start passes `sw.run` through `onStartRecording(stream, ownsStream, run?)` → `pipeline.start(…, { run })` → `api.startRecording({..., run})`.
- [ ] Mix: one line per person, "HQ" or "Call copy (HQ x/y ready)". The ready counter uses the chosen items.
- [ ] `npm test` and `npx tsc --noEmit` pass. Commit.

### Task 8: fetch

**Files:** Modify `tools/podcast_edit.py` (`cmd_fetch` only)

- [ ] The query returns takes (+run, status) and server copies. `choose_sources` is imported from `worker/sources.py`. The manifest takes get `source`; server copies are saved as `.mp4`.
- [ ] Verify on the E2E session. Commit.

### Task 9: E2E, deploy, memory

- [ ] Deploy: `git pull && docker compose up -d --build` on the VPS.
- [ ] Two-browser rig, one page upload-throttled. Record ~60 s → Stop. Within ~30 s both `server_copies` rows are `ready`, the files exist in storage, and the HQ take of the throttled side is still uploading. Measure `started_at` vs `created_at`. Delete the test session.
- [ ] Update memory (new `server_recording_copy.md`, plus edits to `prod_deployment.md`, `e2e_rig_and_edit_tool.md`, `MEMORY.md`).
