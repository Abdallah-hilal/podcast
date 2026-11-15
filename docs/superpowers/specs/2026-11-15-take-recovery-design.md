# Take recovery — design

Date: 2026-11-15 · Status: approved by Abdallah in chat ("Both")

## Intent

A refresh, crash or closed tab mid-recording loses that person's take:
chunks sit in the browser (OPFS) but only reach the server at Stop or every
64 MB, and nothing ever picks them up again. With host-controlled recording
a refreshed tab auto-starts a new take, so the lost one shows up as a black
gap in the Mix.

## Goals

- A person who comes back (refresh, or reopening the link in the same
  browser) gets their earlier take uploaded and finished automatically,
  losing at most the last ~5 s chunk.
- A person who never comes back still has everything up to roughly the last
  minute on the server: uploads happen every ~60 s while recording, and the
  server closes a take that has gone silent for 5 minutes.
- Takes with no uploaded data at all are marked failed after 1 hour instead
  of showing "recording" forever.

## Non-goals

- Recovering takes recorded before this change (their OPFS folders have no
  manifest).
- Cross-device recovery.

## Anti-goals

- Recovery must never touch a take that is still live in another tab of the
  same browser.
- Recovery must not starve the live call's bandwidth.
- The server must never close a take twice or accept data for a closed take.

## Approaches

Chosen by Abdallah: **both** (A + B).

- A. Recover on return from OPFS — covers refresh/reopen, loses ≤5 s; does
  nothing if the person never returns.
- B. Upload every ~60 s + server sweeper — covers people who vanish, loses
  ≤~60 s; on its own a refresh still loses up to a minute.

## Design

- **Backend** (`backend/app/routers/recordings.py`): `register_batch` and
  `finalize_recording` return 409 "Recording already closed" when the take's
  status is not `recording`.
- **Worker sweeper** (`worker/sweep.py`, pure; wired into `worker/main.py`
  once a minute): for each take with status `recording`, last activity =
  latest of the take's `created_at` and its batches' `created_at`/`updated_at`.
  - ≥ 5 min silent and an uploaded batch prefix starting at sequence 0 →
    delete the batch rows after that prefix, set `final_storage_path`
    (`sessions/{sid}/participants/{pid}/recording-{rid}/original.webm`) and
    status `uploaded`, enqueue the normal `reconstruct` job.
  - ≥ 60 min silent and no such prefix → status `error`.
- **Browser, during recording**
  - `BatchManager` seals at 64 MB **or** 12 chunks (60 s at the 5 s
    timeslice).
  - Each take's OPFS folder gets `manifest.json`:
    `{v:1, recordingId, sessionId, batches:[{seq,start,end,size,uploaded}], finalized}`,
    rewritten (serialised) on seal, upload and finalize.
  - The pipeline holds a Web Lock `podcast-take-<recordingId>` for the
    take's lifetime.
- **Browser, on return** (`recovery.ts`, run once when the session page
  loads): for each OPFS take folder whose lock is free (`ifAvailable`):
  no manifest → skip; `finalized` → delete folder; else re-upload sealed
  batches not marked uploaded (same sequence; register is idempotent and TUS
  upserts), upload chunks after the last sealed batch as the next sequence,
  finalize, delete folder. 409/404 from the server → delete folder (server
  closed or deleted the take); other errors → keep for next time. Throttled
  to the same 8 Mbps as live uploads. A badge shows
  "Recovering an earlier recording · N%".

## Left to the builder

- Badge styling (match `UploadBadge`).
- Order of recovering multiple leftover takes (oldest first is fine).
