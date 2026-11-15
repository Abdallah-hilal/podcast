# Take Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A refreshed, crashed or vanished participant's take still ends up on the server and in the Mix.

**Architecture:** The browser uploads a batch every ~60 s and keeps a per-take manifest in OPFS; on return it finishes any leftover take. The worker closes takes that went silent for 5 minutes. The backend refuses to close or extend an already-closed take.

**Tech Stack:** FastAPI, Python worker (stdlib `unittest` for the pure sweeper), Next.js/TypeScript (`node --test`), OPFS, Web Locks, TUS.

**Spec:** `docs/superpowers/specs/2026-11-15-take-recovery-design.md`

## Global Constraints

- Silence threshold 5 minutes; zero-data failure threshold 60 minutes; batch seal at 64 MB or 12 chunks.
- Lock name `podcast-take-<recordingId>`; manifest file `manifest.json`, `v: 1`.
- Recovery throttle 8 Mbps (`THROTTLE_BPS`). No new dependencies.

## Review Focus

- A take live in another tab of the same browser → recovery skips it (lock held).
- Tab killed between sealing a batch and writing the manifest → recovery's tail reuses that sequence with a superset range (idempotent register + upsert) — consistent.
- Person returns after the sweeper closed their take → 409 → local folder deleted, no duplicate job.
- Old OPFS folders without a manifest → left alone.
- Normal Stop then refresh before `releaseLocalChunks` → manifest `finalized` → folder deleted, no second finalize.

---

### Task 1: Backend refuses closed takes

**Files:** Modify `backend/app/routers/recordings.py` (`register_batch`, `finalize_recording`).

- [ ] Prod RED: finalize an already-`ready` recording twice → today it returns 200 and enqueues a second job.
- [ ] Add the status check (`!= "recording"` → 409 "Recording already closed") before the idempotent-register lookup and before the pending-batch count.
- [ ] Deploy backend; same call → 409.

### Task 2: Worker sweeper

**Files:** Create `worker/sweep.py`, `worker/test_sweep.py`; modify `worker/main.py`, `worker/Dockerfile` (COPY sweep.py).

**Interfaces:** `plan_sweep(rec: dict, batches: list[dict], now: datetime) -> SweepDecision | None` where `SweepDecision = (action: "finalize"|"fail", keep_seqs: list[int], drop_ids: list[str])`; `final_path(session_id, participant_id, recording_id) -> str`.

- [ ] Tests (`python3 -m unittest worker/test_sweep.py`): recent activity → None; 5 min silent with uploaded 0,1,2 and pending 3 → finalize keep [0,1,2] drop [id3]; uploaded 0,2 (1 pending) → keep [0] drop [1,2]; no uploaded batches at 30 min → None, at 61 min → fail; status ≠ recording → None; a batch updated 1 min ago keeps the take alive.
- [ ] Implement; wire `sweep_abandoned(db)` into the main loop at most once per 60 s, each take in its own try/except.

### Task 3: Upload every minute + manifest + lock

**Files:** Modify `frontend/src/lib/recording/batchManager.ts`, `opfsStore.ts`, `pipeline.ts`; Test `batchManager.test.ts`.

**Interfaces:** `TakeManifest = { v: 1; recordingId: string; sessionId: string; batches: ManifestBatch[]; finalized: boolean }`, `ManifestBatch = { seq; start; end; size; uploaded }`; `OPFSStore.writeManifest(m)`, `OPFSStore.readManifest(): Promise<TakeManifest|null>`, `OPFSStore.open(recordingId)` (existing folder, no create), `OPFSStore.listTakeIds(): Promise<string[]>`.

- [ ] Test: 12 small chunks → sealed at the 12th; 64 MB chunk → sealed immediately; 11 chunks → not sealed.
- [ ] `MAX_CHUNKS_PER_BATCH = 12` in BatchManager.
- [ ] Pipeline writes the manifest (serialised chain) on start/seal/upload/finalize and holds the Web Lock from start until stop settles or the page dies.

### Task 4: Recovery on return

**Files:** Create `frontend/src/lib/recording/recovery.ts` + `recovery.test.ts`; modify `SessionClient.tsx`, `Overlays.tsx` (badge).

**Interfaces:** `planRecovery(m: TakeManifest, chunkCount: number): { uploads: { seq; start; end }[]; finalize: boolean; discard: boolean }`; `recoverLeftoverTakes(opts: { getToken; onProgress(p: { active: boolean; percent: number }) }): Promise<void>`.

- [ ] Tests: finalized → discard; batches 0(uploaded),1(not) + chunks to 30 → uploads [seq1 same range, seq2 tail], finalize; all uploaded and no tail → uploads [] finalize; no batches + 7 chunks → uploads [seq0 0–6]; zero chunks and no batches → discard.
- [ ] Implement executor with Web Lock `ifAvailable`, 409/404 → discard, else keep; throttled TusUploader.
- [ ] SessionClient runs it once after auth; badge shows progress.

### Task 5: Prod E2E, deploy, commit

- [ ] Guest reload mid-recording → its pre-reload take becomes `ready` with duration ≥ elapsed − 6 s.
- [ ] Kill a guest browser mid-recording (no Stop) → within ~6 min the take is `ready` with duration ≥ elapsed − 65 s.
- [ ] Two-tab safety covered by the lock (reviewed; not automated).
- [ ] Delete test sessions; commit.
