import type {
  CompositeStatusResponse,
  CreateSessionResponse,
  JoinSessionResponse,
  RegisterBatchResponse,
  Session,
  StartRecordingResponse,
} from "@/types";

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:8000";

/** Non-2xx response; `status` lets callers tell "gone/closed" from flaky. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(
  path: string,
  options: RequestInit & { token: string }
): Promise<T> {
  const { token, ...init } = options;
  const res = await fetch(`${BACKEND_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...init.headers,
    },
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(body.detail || `API error ${res.status}`, res.status);
  }

  // 204 No Content (used by DELETE) has no body to parse.
  if (res.status === 204) return undefined as T;
  return res.json();
}

export function createSession(token: string, title: string) {
  return request<CreateSessionResponse>("/api/v1/sessions", {
    method: "POST",
    body: JSON.stringify({ title }),
    token,
  });
}

export function getSession(token: string, sessionId: string) {
  return request<Session>(`/api/v1/sessions/${sessionId}`, {
    method: "GET",
    token,
  });
}

export function joinSession(token: string, sessionId: string) {
  return request<JoinSessionResponse>(`/api/v1/sessions/${sessionId}/join`, {
    method: "POST",
    token,
  });
}

/** Host-only: flips the room-wide recording switch every participant follows. */
export function setRoomRecording(token: string, sessionId: string, recording: boolean) {
  return request<{ recording: boolean; run: string | null }>(
    `/api/v1/sessions/${sessionId}/recording`,
    { method: "POST", body: JSON.stringify({ recording }), token },
  );
}

export function startRecording(
  token: string,
  sessionId: string,
  data: {
    mime_type: string;
    actual_width: number;
    actual_height: number;
    fps: number;
    run?: string | null;
  }
) {
  return request<StartRecordingResponse>(
    `/api/v1/sessions/${sessionId}/recordings`,
    {
      method: "POST",
      body: JSON.stringify(data),
      token,
    }
  );
}

export function registerBatch(
  token: string,
  recordingId: string,
  data: { sequence_number: number; byte_size: number; checksum?: string }
) {
  return request<RegisterBatchResponse>(
    `/api/v1/recordings/${recordingId}/batches`,
    {
      method: "POST",
      body: JSON.stringify(data),
      token,
    }
  );
}

export function completeBatch(
  token: string,
  recordingId: string,
  batchId: string
) {
  return request<{ status: string }>(
    `/api/v1/recordings/${recordingId}/batches/${batchId}/complete`,
    { method: "POST", token }
  );
}

/** "Still here" ping while a take records or uploads (see worker/sweep.py). */
export function heartbeatRecording(token: string, recordingId: string) {
  return request<{ ok: boolean }>(`/api/v1/recordings/${recordingId}/heartbeat`, {
    method: "POST",
    token,
  });
}

export function finalizeRecording(token: string, recordingId: string) {
  return request<{ status: string; recording_id: string }>(
    `/api/v1/recordings/${recordingId}/finalize`,
    { method: "POST", token }
  );
}

export function getDownloadUrl(token: string, recordingId: string) {
  return request<{ download_url: string }>(
    `/api/v1/recordings/${recordingId}/download`,
    { method: "GET", token }
  );
}

export function getComposite(token: string, sessionId: string) {
  return request<CompositeStatusResponse>(
    `/api/v1/sessions/${sessionId}/composite`,
    { method: "GET", token }
  );
}

export function renderComposite(token: string, sessionId: string) {
  return request<{ status: string; session_id: string }>(
    `/api/v1/sessions/${sessionId}/composite`,
    { method: "POST", token }
  );
}

export function deleteSession(token: string, sessionId: string) {
  return request<void>(`/api/v1/sessions/${sessionId}`, {
    method: "DELETE",
    token,
  });
}

export function deleteRecording(token: string, recordingId: string) {
  return request<void>(`/api/v1/recordings/${recordingId}`, {
    method: "DELETE",
    token,
  });
}
