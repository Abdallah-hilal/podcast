# Host-Controlled Recording Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The host's Record/Stop starts and stops recording for every participant in a LiveKit session.

**Architecture:** An owner-only backend endpoint writes a recording switch into LiveKit room metadata. Every client watches the room metadata and drives its own existing `RecordingPipeline` from it; each client reports its recording/upload status as LiveKit participant attributes, shown on every tile.

**Tech Stack:** FastAPI + livekit-api 1.2.2 (backend), Next.js 16 / React 19 + @livekit/components-react 2.9 + livekit-client 2.23 (frontend), Node 26 built-in test runner for the pure switch logic.

**Spec:** `docs/superpowers/specs/2026-11-15-host-controlled-recording-design.md`

## Global Constraints

- Only the session owner may change the switch (403 for anyone else).
- Room metadata JSON shape: `{"recording": bool, "run": "<uuid hex>", "changed_at": "<iso8601>"}`; a fresh `run` on every start.
- Participant attributes: `rec` ∈ `idle|recording|uploading|done|error`, `up` = integer string 0–100.
- Local-only mode (no LiveKit) keeps the existing manual `LocalControlBar` unchanged.
- No new npm or pip dependencies. Never ship `SERVICE_ROLE_KEY`/`JWT_SECRET`/LiveKit secret to the browser.

## Review Focus

- Guest's camera/mic not ready yet when the switch turns on → recording starts as soon as the stream is ready, not never.
- Host stops then restarts quickly while a guest is still uploading the first take → guest finishes uploading, then starts the new run.
- Guest refreshes mid-recording → rejoins and starts a new take automatically (old take's tail is the known separate gap).
- Host's own tab refreshes mid-recording → guests keep recording; host comes back recording too.
- Host clicks Leave while recording → everyone stops and uploads.

---

### Task 1: Backend switch endpoint

**Files:**
- Modify: `backend/app/services/livekit.py` (token grant + new `set_room_recording`)
- Modify: `backend/app/routers/sessions.py` (`JoinSessionResponse.is_host`, new route)

**Interfaces:**
- Produces: `POST /api/v1/sessions/{session_id}/recording` body `{"recording": bool}` → 200 `{"recording": bool, "run": str | null}`; 403 non-owner; 404 unknown session; 409 room not live / LiveKit not configured.
- Produces: `JoinSessionResponse.is_host: bool`.
- Produces: `async def set_room_recording(room_name: str, recording: bool) -> dict` in `livekit.py`, returning the metadata dict it wrote.

- [ ] **Step 1:** Add `can_update_own_metadata=True` to `VideoGrants` in `create_access_token`.
- [ ] **Step 2:** Implement `set_room_recording` with `async with api.LiveKitAPI(settings.livekit_url, key, secret) as lk: await lk.room.update_room_metadata(api.UpdateRoomMetadataRequest(room=room_name, metadata=json.dumps(meta)))`; `run = uuid4().hex` when recording else `None`.
- [ ] **Step 3:** Add `is_host` to `JoinSessionResponse` (`is_owner` already computed in `join_session`).
- [ ] **Step 4:** Add the route using `_owner_only`; map LiveKit errors to 409.
- [ ] **Step 5: Verify on prod after deploying the backend:** with a minted host JWT, `POST …/recording {"recording":true}` while a browser is in the room → 200 with a `run`; same call with a guest JWT → 403; `lk.room.list_rooms` shows the metadata.

### Task 2: Pure switch logic (TDD)

**Files:**
- Create: `frontend/src/lib/recording/hostSwitch.ts`
- Test: `frontend/src/lib/recording/hostSwitch.test.ts`

**Interfaces:**
- Produces: `type RoomSwitch = { recording: boolean; run: string | null }`
- Produces: `parseRoomSwitch(metadata: string | undefined | null): RoomSwitch` — bad/empty JSON → `{recording:false, run:null}`.
- Produces: `decideSwitchAction(i: { sw: RoomSwitch; state: PipelineState; lastStartedRun: string | null; ready: boolean }): "start" | "stop" | "none"`.
- Produces: `recStatusAttr(state: PipelineState): "idle"|"recording"|"uploading"|"done"|"error"`.

- [ ] **Step 1: Write failing tests** (`node:test` + `node:assert/strict`):
  - parse: `undefined`, `""`, `"{bad"` → off; `'{"recording":true,"run":"r1"}'` → `{true,"r1"}`.
  - on + idle + not started + ready → `start`; on + idle + not ready → `none`; on + complete + lastStartedRun==run → `none`; on + complete + different run → `start`.
  - on + recording + same run → `none`; on + recording + different run → `stop`.
  - on + uploading (any run) → `none`; off + recording → `stop`; off + idle → `none`.
  - status: stopping/uploading → `uploading`, complete → `done`.
- [ ] **Step 2:** Run `node --test src/lib/recording/hostSwitch.test.ts` → FAIL (module missing).
- [ ] **Step 3:** Implement `hostSwitch.ts` (type-only import of `PipelineState`).
- [ ] **Step 4:** Run the same command → all PASS.

### Task 3: Wire the switch into the session page

**Files:**
- Modify: `frontend/src/types/index.ts` (`JoinSessionResponse.is_host: boolean`)
- Modify: `frontend/src/lib/api.ts` (`setRoomRecording(token, sessionId, recording): Promise<{recording: boolean; run: string | null}>`)
- Modify: `frontend/src/app/session/[id]/SessionClient.tsx` (`RoomRecordingControls`, `handleLeave`)
- Modify: `frontend/src/components/meeting/ControlBar.tsx` (host vs guest record control)

**Interfaces:**
- Consumes: Task 1 endpoint, Task 2 `parseRoomSwitch` / `decideSwitchAction`.
- `ControlBar` gains `isHost: boolean`, `switchOn: boolean`, `switchPending: boolean`. Host: Record → `onRecord`, Stop → `onStop` (both now call the API). Guest: no button; a non-interactive pill — "Recording · mm:ss — started by the host" while recording, "Uploading…" while busy, otherwise "Waiting for the host to start recording".

- [ ] **Step 1:** `RoomRecordingControls` reads `useRoomInfo().metadata`, keeps `lastStartedRun` in a ref (set synchronously before calling start), and runs `decideSwitchAction` in an effect over `[sw.recording, sw.run, recState, isReady]`: `start` → `onStartRecording(buildStream(), false)`; `stop` → `onStop()` (guarded so one stop runs at a time).
- [ ] **Step 2:** Host Record/Stop call `api.setRoomRecording`; show `switchPending` while in flight; surface errors through the existing `setError`-style path without killing the page (a toast-free inline `title` is enough).
- [ ] **Step 3:** `handleLeave`: if host and switch on → `setRoomRecording(false)` before the local stop.
- [ ] **Step 4:** `npx tsc --noEmit` and `npx eslint` on touched files → clean.

### Task 4: Status chips on tiles

**Files:**
- Modify: `frontend/src/app/session/[id]/SessionClient.tsx` (publish attributes from `RoomRecordingControls`)
- Modify: `frontend/src/components/meeting/ParticipantTile.tsx` (chip)

**Interfaces:**
- Consumes: Task 2 `recStatusAttr`; `localParticipant.setAttributes`; `useParticipantAttributes({ participant })`.

- [ ] **Step 1:** Publish `{rec, up}` whenever `rec` changes or `up` moves ≥5 points; `up = round(bytesUploaded / max(bytesRecorded,1) * 100)` clamped 0–100; swallow `setAttributes` errors with a console warning.
- [ ] **Step 2:** Tile chip top-right: recording → coral "● REC"; uploading → "↑ {up}%"; done → teal "✓ Saved"; error → "⚠ Upload failed"; idle → nothing.
- [ ] **Step 3:** `npx tsc --noEmit` clean.

### Task 5: End-to-end on prod, deploy, commit

- [ ] **Step 1:** Deploy backend, then frontend (existing re-deploy flow).
- [ ] **Step 2:** Two-browser rig: host presses Record, guest never touches anything → both have recordings with matching length; guest tile showed REC on host's page; after host Stop both reach `ready`, chips show Saved.
- [ ] **Step 3:** Late joiner: third browser joins mid-recording → records a take from its join time.
- [ ] **Step 4:** Guest reload mid-recording → new take starts after rejoin.
- [ ] **Step 5:** Guest JWT POST to the switch → 403.
- [ ] **Step 6:** Delete test sessions; commit with spec + plan.
