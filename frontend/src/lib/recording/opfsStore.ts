import { parseManifest, type TakeManifest } from "./manifest";

const MANIFEST_FILE = "manifest.json";

export class OPFSStore {
  /** Folder names (= recording ids) of every take still kept in OPFS. */
  static async listTakeIds(): Promise<string[]> {
    try {
      const root = await navigator.storage.getDirectory();
      const recordings = await root.getDirectoryHandle("recordings");
      const ids: string[] = [];
      for await (const [name, handle] of recordings as unknown as AsyncIterable<
        [string, FileSystemHandle]
      >) {
        if (handle.kind === "directory") ids.push(name);
      }
      return ids;
    } catch {
      return []; // no recordings folder yet
    }
  }

  private rootDir: FileSystemDirectoryHandle | null = null;
  private recordingDir: FileSystemDirectoryHandle | null = null;
  private chunksDir: FileSystemDirectoryHandle | null = null;
  private recordingId: string = "";

  async init(recordingId: string): Promise<void> {
    this.recordingId = recordingId;
    this.rootDir = await navigator.storage.getDirectory();

    const recordingsDir = await this.rootDir.getDirectoryHandle("recordings", {
      create: true,
    });
    this.recordingDir = await recordingsDir.getDirectoryHandle(recordingId, {
      create: true,
    });
    this.chunksDir = await this.recordingDir.getDirectoryHandle("chunks", {
      create: true,
    });

    // Request persistent storage (best-effort)
    try {
      await navigator.storage.persist();
    } catch {
      // Not all browsers support this
    }
  }

  /** Attach to an existing take's folder (recovery). False if it's gone. */
  async open(recordingId: string): Promise<boolean> {
    try {
      this.recordingId = recordingId;
      this.rootDir = await navigator.storage.getDirectory();
      const recordingsDir = await this.rootDir.getDirectoryHandle("recordings");
      this.recordingDir = await recordingsDir.getDirectoryHandle(recordingId);
      this.chunksDir = await this.recordingDir.getDirectoryHandle("chunks", { create: true });
      return true;
    } catch {
      return false;
    }
  }

  async writeManifest(m: TakeManifest): Promise<void> {
    if (!this.recordingDir) throw new Error("OPFS not initialized");
    const handle = await this.recordingDir.getFileHandle(MANIFEST_FILE, { create: true });
    const writable = await handle.createWritable();
    await writable.write(JSON.stringify(m));
    await writable.close();
  }

  async readManifest(): Promise<TakeManifest | null> {
    if (!this.recordingDir) return null;
    try {
      const handle = await this.recordingDir.getFileHandle(MANIFEST_FILE);
      return parseManifest(await (await handle.getFile()).text());
    } catch {
      return null; // takes recorded before manifests existed
    }
  }

  async writeChunk(index: number, data: Blob): Promise<void> {
    if (!this.chunksDir) throw new Error("OPFS not initialized");

    const fileName = `chunk-${String(index).padStart(6, "0")}.bin`;
    const fileHandle = await this.chunksDir.getFileHandle(fileName, {
      create: true,
    });
    const writable = await fileHandle.createWritable();
    await writable.write(data);
    await writable.close();
  }

  async readChunk(index: number): Promise<Blob> {
    if (!this.chunksDir) throw new Error("OPFS not initialized");

    const fileName = `chunk-${String(index).padStart(6, "0")}.bin`;
    const fileHandle = await this.chunksDir.getFileHandle(fileName);
    const file = await fileHandle.getFile();
    return file;
  }

  /**
   * Read chunks in the half-open range [startIndex, endIndex). Writing the
   * bound as exclusive matches the `getChunkCount()` return value directly —
   * callers pass `readChunkRange(0, count)` and get every chunk back. For a
   * batch spanning inclusive indices, pass `readChunkRange(start, end + 1)`.
   */
  async readChunkRange(startIndex: number, endIndex: number): Promise<Blob> {
    const parts: Blob[] = [];
    for (let i = startIndex; i < endIndex; i++) {
      parts.push(await this.readChunk(i));
    }
    return new Blob(parts);
  }

  async getChunkCount(): Promise<number> {
    if (!this.chunksDir) return 0;

    let count = 0;
    // FileSystemDirectoryHandle is async iterable but TS types lag behind
    for await (const _ of this.chunksDir as unknown as AsyncIterable<string>) {
      count++;
    }
    return count;
  }

  async cleanup(): Promise<void> {
    if (!this.rootDir || !this.recordingId) return;

    try {
      const recordingsDir = await this.rootDir.getDirectoryHandle("recordings");
      await recordingsDir.removeEntry(this.recordingId, { recursive: true });
    } catch {
      // Directory may not exist
    }
  }
}
