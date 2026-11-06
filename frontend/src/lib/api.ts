import type {
  CompositeStatusResponse,
  CreateSessionResponse,
  JoinSessionResponse,
  RegisterBatchResponse,
  Session,
  StartRecordingResponse,
  TranscriptResponse,
} from "@/types";

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:8000";

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
    throw new Error(body.detail || `API error ${res.status}`);
  }

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

export function startRecording(
  token: string,
  sessionId: string,
  data: {
    mime_type: string;
    actual_width: number;
    actual_height: number;
    fps: number;
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

export function getTranscript(token: string, recordingId: string) {
  return request<TranscriptResponse>(
    `/api/v1/recordings/${recordingId}/transcript`,
    { method: "GET", token }
  );
}

export function retryTranscribe(token: string, recordingId: string) {
  return request<{ status: string; recording_id: string }>(
    `/api/v1/recordings/${recordingId}/transcribe`,
    { method: "POST", token }
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
