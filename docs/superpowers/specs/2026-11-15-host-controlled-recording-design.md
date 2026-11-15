# Host-controlled recording — design

Date: 2026-11-15 · Status: approved by Abdallah in chat

## Intent

Today every browser in a session has its own Record button and nothing ties
them together. If a guest forgets to press it, their side of the episode is
never recorded. The host should be able to press Record once and have every
participant start recording, and press Stop once to have everyone stop and
upload.

## Goals

- Host's Record/Stop drives every participant's local recording pipeline.
- Guests who join late or refresh while recording is on start recording on
  their own (a new take; the worker already places multiple takes per
  participant on the timeline by `recordings.created_at`).
- Everyone can see, on each person's tile, whether that person is recording,
  uploading (with %), done, or failed — so the host knows the guest is
  actually recording and when it is safe to hang up.
- Host clicking Leave while recording stops the recording for everyone.

## Non-goals

- Guests recording on their own (their Record button is removed; Abdallah
  chose host-only control).
- Resuming an interrupted take's unsent OPFS chunks after a refresh (separate
  gap).
- Local-only mode (no LiveKit configured) keeps its existing manual button.

## Anti-goals

- A guest must never be able to start or stop recording for others.
- A host network blip must not stop the guests' recordings.

## Approaches considered

1. **Recording switch in LiveKit room metadata, set by the backend
   (chosen).** `POST /sessions/{id}/recording` (owner only) calls LiveKit's
   `UpdateRoomMetadata`. Every client gets the change instantly via
   `RoomMetadataChanged`, and late joiners/refreshers receive it on connect.
   The room itself is the source of truth, so when the room empties the switch
   resets with it.
2. Host browser broadcasts a LiveKit data message. No backend change, but
   messages are lost for late joiners and refreshes, and the switch dies
   with the host's tab.
3. Store the switch in the DB and have clients poll. Slower to react, extra
   load, and still needs a push path for snappy start/stop.

## Design

- **Backend**
  - `JoinSessionResponse` gains `is_host: bool`.
  - LiveKit tokens gain `can_update_own_metadata=True` so each client can
    publish its own status as participant attributes.
  - New `POST /api/v1/sessions/{id}/recording` body `{ "recording": bool }`,
    owner only. Writes room metadata JSON
    `{"recording": true|false, "run": "<uuid>", "changed_at": "<iso>"}` —
    a fresh `run` id on every start so a client can tell a new run from the
    one it is already recording.
- **Frontend (LiveKit mode)**
  - A `useHostRecordingSwitch` hook reads `useRoomInfo().metadata` and drives
    the pipeline: start when the switch is on and this client hasn't
    recorded that `run` yet (waiting until the media stream is ready and any
    previous upload has finished); stop when the switch turns off or the
    run changes.
  - Host's Record/Stop buttons call the endpoint; the host's own pipeline
    starts through the same metadata path as everyone else's.
  - Guests: no Record button; a status pill shows "Recording — started by
    the host" / "Waiting for the host to start recording".
  - Each client publishes `rec` (`idle|recording|uploading|done|error`) and
    `up` (0–100) participant attributes; `ParticipantTile` shows a small chip
    from them.
  - Host Leave while the switch is on → call the endpoint with `false`
    before leaving.

## Left to the builder

- Exact chip styling (match existing Overlays / tile pills).
- Throttling of the `up` attribute (only on ≥5% change).
