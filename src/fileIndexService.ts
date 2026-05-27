import { createHash } from 'crypto';
import { LocalFsAdapter } from './localFs';
import { RemoteFsAdapter } from './remoteFs';
import { SyncStateDb } from './syncStateDb';
import {
  FILE_INDEX_CONSUME_MAX_RETRIES,
  FILE_INDEX_NAME,
  FILE_INDEX_PUBLISH_MAX_RETRIES,
  RETRY_BASE_DELAY_MS,
} from './constants';
import { canonicalizeRelativeSyncPath } from './pathSanitize';
import { FileIndexDocument, SyncMapping } from './types';

/**
 * 映射索引独立通道：根目录 `.openclaw-sync-map.json`（全量 local_path → remoteFileId）。
 * 不参与 SyncEngine 路径对账。
 */
export class FileIndexService {
  constructor(
    private readonly db: SyncStateDb,
    private readonly remoteFs: RemoteFsAdapter,
    private readonly localFs: LocalFsAdapter,
    private readonly mapping: SyncMapping,
  ) {}

  private log(msg: string): void {
    console.log(`[FileIndex][${this.mapping.mappingId}] ${msg}`);
  }

  private warn(msg: string): void {
    console.warn(`[FileIndex][${this.mapping.mappingId}] ${msg}`);
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** Pull / bidirectional：同步开始前从 KB 拉取索引到本地 */
  async consumeIndex(): Promise<void> {
    const mappingState = this.db.getMappingState(this.mapping.mappingId);
    let remoteId = mappingState?.indexFileRemoteId ?? null;

    if (!remoteId) {
      const locate = await this.locateRemoteIndexFileId();
      if (!locate.ok) {
        this.warn(`consume locate failed: ${locate.error}`);
        return;
      }
      if (!locate.value) {
        this.warn('consume skipped: remote index not found (push may not have published yet)');
        return;
      }
      remoteId = locate.value;
      this.db.upsertMappingState({
        mappingId: this.mapping.mappingId,
        indexFileRemoteId: remoteId,
      });
      this.log(`located remote index id=${remoteId}`);
    }

    let lastError = '';
    for (let attempt = 1; attempt <= FILE_INDEX_CONSUME_MAX_RETRIES; attempt++) {
      const readResult = await this.remoteFs.readFile(remoteId);
      if (readResult.ok) {
        await this.localFs.writeFile(FILE_INDEX_NAME, readResult.value);
        this.log(`consume ok → local ${FILE_INDEX_NAME} (${readResult.value.length} bytes)`);
        this.syncIndexHashFromRemote(readResult.value);
        return;
      }
      lastError = readResult.error;
      if (attempt < FILE_INDEX_CONSUME_MAX_RETRIES) {
        await this.delay(RETRY_BASE_DELAY_MS);
      }
    }
    this.warn(`consume failed after ${FILE_INDEX_CONSUME_MAX_RETRIES} attempts: ${lastError}`);
  }

  /** Push / bidirectional：主 sync 成功后 publish 索引到 KB */
  async publishIndex(): Promise<void> {
    const files = this.buildFilesMap();
    // hash 仅基于 files 映射；updatedAt 每轮都会变，不能参与 diff
    const contentHash = hashFilesMapping(files);
    const mappingState = this.db.getMappingState(this.mapping.mappingId);

    if (mappingState?.indexContentHash === contentHash) {
      this.log('publish skipped: index content unchanged');
      return;
    }

    if (!mappingState?.indexContentHash) {
      this.log('publish needed: no stored index hash');
    } else {
      this.log(
        `publish needed: index hash changed (${mappingState.indexContentHash.slice(0, 8)}… → ${contentHash.slice(0, 8)}…)`,
      );
    }

    const jsonText = this.buildIndexJson(files);
    const folderName = this.remoteFs.getRootFolderPath();
    let lastError = '';
    for (let attempt = 1; attempt <= FILE_INDEX_PUBLISH_MAX_RETRIES; attempt++) {
      const upload = await this.remoteFs.uploadTextContent({
        content: jsonText,
        fileName: FILE_INDEX_NAME,
        fileSuffix: 'json',
        folderName: folderName || undefined,
        updateFileId: mappingState?.indexFileRemoteId ?? undefined,
      });
      if (upload.ok) {
        const fileId = String(upload.value.fileId);
        this.db.upsertMappingState({
          mappingId: this.mapping.mappingId,
          indexFileRemoteId: fileId,
          indexContentHash: contentHash,
        });
        const doc = JSON.parse(jsonText) as FileIndexDocument;
        this.log(`publish ok fileId=${fileId} fileCount=${doc.fileCount}`);
        return;
      }
      lastError = upload.error;
      if (attempt < FILE_INDEX_PUBLISH_MAX_RETRIES) {
        await this.delay(RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1));
      }
    }
    this.warn(
      `publish failed after ${FILE_INDEX_PUBLISH_MAX_RETRIES} attempts: ${lastError}; will retry next sync`,
    );
  }

  private syncIndexHashFromRemote(rawJson: string): void {
    try {
      const doc = JSON.parse(rawJson) as FileIndexDocument;
      if (!doc.files || typeof doc.files !== 'object') return;

      const localHash = hashFilesMapping(this.buildFilesMap());
      const remoteHash = hashFilesMapping(doc.files);
      if (localHash !== remoteHash) return;

      this.db.upsertMappingState({
        mappingId: this.mapping.mappingId,
        indexContentHash: localHash,
      });
      this.log(`consume synced index hash (${Object.keys(doc.files).length} files)`);
    } catch {
      // 远端索引格式异常时不阻断主 sync
    }
  }

  private buildFilesMap(): Record<string, string> {
    const records = this.db
      .getAllFileStates(this.mapping.mappingId)
      .filter((r) => r.syncStatus === 'done' && r.remoteFileId);

    const files: Record<string, string> = {};
    for (const r of records) {
      const key = canonicalizeRelativeSyncPath(r.localPath);
      if (!key) continue;
      files[key] = String(r.remoteFileId);
    }

    const sortedKeys = Object.keys(files).sort();
    const sortedFiles: Record<string, string> = {};
    for (const k of sortedKeys) sortedFiles[k] = files[k];
    return sortedFiles;
  }

  private buildIndexJson(files: Record<string, string>): string {
    const doc: FileIndexDocument = {
      version: 1,
      mappingId: this.mapping.mappingId,
      updatedAt: new Date().toISOString(),
      fileCount: Object.keys(files).length,
      files,
    };
    return JSON.stringify(doc, null, 2) + '\n';
  }

  private async locateRemoteIndexFileId(): Promise<
    { ok: true; value: string | null } | { ok: false; error: string }
  > {
    const rootId = this.remoteFs.getRootFileId();
    return this.remoteFs.findDirectChildFileId(rootId, FILE_INDEX_NAME);
  }
}

function hashFilesMapping(files: Record<string, string>): string {
  const sorted: Record<string, string> = {};
  for (const k of Object.keys(files).sort()) sorted[k] = String(files[k]);
  return createHash('sha256').update(JSON.stringify(sorted), 'utf8').digest('hex');
}
