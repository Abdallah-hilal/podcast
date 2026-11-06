export class OPFSStore {
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

  async readChunkRange(startIndex: number, endIndex: number): Promise<Blob> {
    const parts: Blob[] = [];
    for (let i = startIndex; i <= endIndex; i++) {
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
