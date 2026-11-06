"use client";

import { useState, useRef } from "react";
import * as tus from "tus-js-client";
import { createClient } from "@/lib/supabase/client";

export default function TusTestPage() {
  const [status, setStatus] = useState("Select a file to test TUS upload");
  const [progress, setProgress] = useState(0);
  const [uploadUrl, setUploadUrl] = useState("");
  const [error, setError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const uploadRef = useRef<tus.Upload | null>(null);
  const supabase = createClient();

  async function handleUpload() {
    const file = fileRef.current?.files?.[0];
    if (!file) return;

    setError("");
    setStatus("Getting auth token...");

    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
      setError("Not logged in");
      return;
    }

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const tusEndpoint = `${supabaseUrl}/storage/v1/upload/resumable`;
    const bucketName = "podcast-recordings";
    const objectName = `tus-test/${Date.now()}-${file.name}`;

    setStatus(`Uploading ${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB)...`);

    const upload = new tus.Upload(file, {
      endpoint: tusEndpoint,
      retryDelays: [3000, 5000, 10000],
      chunkSize: 6 * 1024 * 1024,
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        "x-upsert": "true",
      },
      metadata: {
        bucketName: bucketName,
        objectName: objectName,
        contentType: file.type || "application/octet-stream",
        cacheControl: "3600",
      },
      onProgress: (bytesUploaded, bytesTotal) => {
        const pct = Math.round((bytesUploaded / bytesTotal) * 100);
        setProgress(pct);
        setStatus(`Uploading... ${pct}% (${(bytesUploaded / 1024 / 1024).toFixed(1)} / ${(bytesTotal / 1024 / 1024).toFixed(1)} MB)`);
      },
      onSuccess: () => {
        setStatus(`Upload complete! File: ${objectName}`);
        setUploadUrl(upload.url || "");
      },
      onError: (err) => {
        setError(`Upload failed: ${err.message}`);
        setStatus("Failed");
      },
    });

    uploadRef.current = upload;

    const previousUploads = await upload.findPreviousUploads();
    if (previousUploads.length > 0) {
      setStatus("Resuming previous upload...");
      upload.resumeFromPreviousUpload(previousUploads[0]);
    }

    upload.start();
  }

  function handlePause() {
    if (uploadRef.current) {
      uploadRef.current.abort();
      setStatus(`Paused at ${progress}% — click Upload to resume`);
    }
  }

  return (
    <div className="min-h-screen bg-gray-950 text-white p-8">
      <div className="max-w-xl mx-auto space-y-6">
        <h1 className="text-2xl font-bold">TUS Upload Spike</h1>
        <p className="text-gray-400 text-sm">
          Tests resumable upload to Supabase Storage via TUS protocol.
          Pick a large file (100MB+), upload it, pause/resume, and verify it appears in the bucket.
        </p>

        <div className="space-y-4">
          <input
            ref={fileRef}
            type="file"
            className="block w-full text-sm text-gray-400 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:bg-gray-800 file:text-white hover:file:bg-gray-700"
          />

          <div className="flex gap-3">
            <button
              onClick={handleUpload}
              className="px-6 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg font-medium transition-colors"
            >
              Upload
            </button>
            <button
              onClick={handlePause}
              className="px-6 py-2 bg-yellow-600 hover:bg-yellow-700 rounded-lg font-medium transition-colors"
            >
              Pause
            </button>
          </div>

          {/* Progress bar */}
          <div className="w-full bg-gray-800 rounded-full h-3">
            <div
              className="bg-blue-500 h-3 rounded-full transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>

          <p className="text-sm text-gray-300">{status}</p>

          {error && <p className="text-sm text-red-400">{error}</p>}

          {uploadUrl && (
            <p className="text-sm text-green-400 break-all">
              TUS URL: {uploadUrl}
            </p>
          )}
        </div>

        <div className="mt-8 p-4 bg-gray-900 rounded-lg text-sm text-gray-400 space-y-2">
          <p className="font-semibold text-gray-300">Test checklist:</p>
          <ul className="list-disc list-inside space-y-1">
            <li>Upload a 100MB+ file — does it complete?</li>
            <li>Click Pause mid-upload, then Upload again — does it resume?</li>
            <li>Disconnect Wi-Fi mid-upload, reconnect, click Upload — does it resume?</li>
            <li>Check Supabase dashboard — does the file appear in the bucket?</li>
            <li>Download the file from Supabase — is it identical to the original?</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
