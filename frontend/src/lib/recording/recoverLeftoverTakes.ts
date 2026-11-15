import * as api from "@/lib/api";
import { OPFSStore } from "./opfsStore";
import { TusUploader } from "./tusUploader";
import { takeLockName, withSealed, withUploaded } from "./manifest";
import { planRecovery } from "./recovery";

export type RecoveryProgress = { active: boolean; percent: number };

type Opts = {
  getToken: () => Promise<string>;
  /** Belt and braces for browsers without Web Locks: never touch this tab's live take. */
  isLive: (recordingId: string) => boolean;
  /** Upload limit while this tab is in a live recording (null = full speed). */
  rateLimit: () => number | null;
  onProgress: (p: RecoveryProgress) => void;
};

/**
 * Finish every take a previous page left behind in OPFS (refresh, crash,
 * closed tab): upload what's missing, finalize, delete the local copy.
 * Takes still live in another tab hold their Web Lock and are skipped.
 * Safe to call on every page load.
 */
export async function recoverLeftoverTakes(opts: Opts): Promise<void> {
  if (typeof navigator === "undefined" || !navigator.storage?.getDirectory) return;
  const ids = await OPFSStore.listTakeIds();
  for (const id of ids) {
    if (opts.isLive(id)) continue;
    if (navigator.locks) {
      await navigator.locks.request(takeLockName(id), { ifAvailable: true }, async (lock) => {
        if (lock && !opts.isLive(id)) await recoverOne(id, opts);
      });
    } else {
      await recoverOne(id, opts);
    }
  }
}

async function recoverOne(id: string, { getToken, onProgress, rateLimit }: Opts): Promise<void> {
  const store = new OPFSStore();
  if (!(await store.open(id))) return;
  let manifest = await store.readManifest();
  if (!manifest) return; // recorded before manifests existed — leave it alone
  const plan = planRecovery(manifest, await store.getChunkCount());
  if (plan.discard) {
    await store.cleanup();
    return;
  }

  const blobs = await Promise.all(
    plan.uploads.map((u) => store.readChunkRange(u.start, u.end + 1)),
  );
  const total = blobs.reduce((n, b) => n + b.size, 0) || 1;
  let done = 0;
  const uploader = new TusUploader();
  uploader.setRateLimit(rateLimit);
  onProgress({ active: true, percent: 0 });
  // Keep the take open on the server while a long recovery upload runs.
  const ping = () =>
    void getToken()
      .then((t) => api.heartbeatRecording(t, id))
      .catch(() => {});
  ping();
  const heartbeat = setInterval(ping, 60_000);

  try {
    for (let i = 0; i < plan.uploads.length; i++) {
      const u = plan.uploads[i];
      const blob = blobs[i];
      let token = await getToken();
      const reg = await api.registerBatch(token, id, {
        sequence_number: u.seq,
        byte_size: blob.size,
      });
      token = await getToken();
      await uploader.upload({
        batchId: reg.batch_id,
        blob,
        storagePath: reg.storage_path,
        authToken: token,
        onProgress: (sent) =>
          onProgress({ active: true, percent: Math.min(99, Math.round(((done + sent) / total) * 100)) }),
      });
      token = await getToken();
      await api.completeBatch(token, id, reg.batch_id);
      done += blob.size;
      // Save progress so a second interruption doesn't redo this batch.
      manifest = withUploaded(withSealed(manifest, { ...u, size: blob.size }), u.seq);
      await store.writeManifest(manifest);
    }
    await api.finalizeRecording(await getToken(), id);
    await store.cleanup();
    console.info(`Recovered earlier take ${id} (${plan.uploads.length} batch(es))`);
  } catch (e) {
    if (e instanceof api.ApiError && (e.status === 409 || e.status === 404)) {
      // The server already closed this take (its sweeper, or a finalize
      // that landed before the tab died) or it was deleted — nothing left
      // to do with the local copy.
      await store.cleanup();
      return;
    }
    console.warn(`Couldn't recover take ${id} yet; will retry next visit:`, e);
  } finally {
    clearInterval(heartbeat);
    onProgress({ active: false, percent: 100 });
  }
}
