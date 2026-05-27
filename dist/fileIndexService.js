"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FileIndexService = void 0;
const crypto_1 = require("crypto");
const constants_1 = require("./constants");
const pathSanitize_1 = require("./pathSanitize");
/**
 * 映射索引独立通道：根目录 `.openclaw-sync-map.json`（全量 local_path → remoteFileId）。
 * 不参与 SyncEngine 路径对账。
 */
class FileIndexService {
    db;
    remoteFs;
    localFs;
    mapping;
    constructor(db, remoteFs, localFs, mapping) {
        this.db = db;
        this.remoteFs = remoteFs;
        this.localFs = localFs;
        this.mapping = mapping;
    }
    log(msg) {
        console.log(`[FileIndex][${this.mapping.mappingId}] ${msg}`);
    }
    warn(msg) {
        console.warn(`[FileIndex][${this.mapping.mappingId}] ${msg}`);
    }
    delay(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
    /** Pull / bidirectional：同步开始前从 KB 拉取索引到本地 */
    async consumeIndex() {
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
        for (let attempt = 1; attempt <= constants_1.FILE_INDEX_CONSUME_MAX_RETRIES; attempt++) {
            const readResult = await this.remoteFs.readFile(remoteId);
            if (readResult.ok) {
                await this.localFs.writeFile(constants_1.FILE_INDEX_NAME, readResult.value);
                this.log(`consume ok → local ${constants_1.FILE_INDEX_NAME} (${readResult.value.length} bytes)`);
                this.syncIndexHashFromRemote(readResult.value);
                return;
            }
            lastError = readResult.error;
            if (attempt < constants_1.FILE_INDEX_CONSUME_MAX_RETRIES) {
                await this.delay(constants_1.RETRY_BASE_DELAY_MS);
            }
        }
        this.warn(`consume failed after ${constants_1.FILE_INDEX_CONSUME_MAX_RETRIES} attempts: ${lastError}`);
    }
    /** Push / bidirectional：主 sync 成功后 publish 索引到 KB */
    async publishIndex() {
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
        }
        else {
            this.log(`publish needed: index hash changed (${mappingState.indexContentHash.slice(0, 8)}… → ${contentHash.slice(0, 8)}…)`);
        }
        const jsonText = this.buildIndexJson(files);
        const folderName = this.remoteFs.getRootFolderPath();
        let lastError = '';
        for (let attempt = 1; attempt <= constants_1.FILE_INDEX_PUBLISH_MAX_RETRIES; attempt++) {
            const upload = await this.remoteFs.uploadTextContent({
                content: jsonText,
                fileName: constants_1.FILE_INDEX_NAME,
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
                const doc = JSON.parse(jsonText);
                this.log(`publish ok fileId=${fileId} fileCount=${doc.fileCount}`);
                return;
            }
            lastError = upload.error;
            if (attempt < constants_1.FILE_INDEX_PUBLISH_MAX_RETRIES) {
                await this.delay(constants_1.RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1));
            }
        }
        this.warn(`publish failed after ${constants_1.FILE_INDEX_PUBLISH_MAX_RETRIES} attempts: ${lastError}; will retry next sync`);
    }
    syncIndexHashFromRemote(rawJson) {
        try {
            const doc = JSON.parse(rawJson);
            if (!doc.files || typeof doc.files !== 'object')
                return;
            const localHash = hashFilesMapping(this.buildFilesMap());
            const remoteHash = hashFilesMapping(doc.files);
            if (localHash !== remoteHash)
                return;
            this.db.upsertMappingState({
                mappingId: this.mapping.mappingId,
                indexContentHash: localHash,
            });
            this.log(`consume synced index hash (${Object.keys(doc.files).length} files)`);
        }
        catch {
            // 远端索引格式异常时不阻断主 sync
        }
    }
    buildFilesMap() {
        const records = this.db
            .getAllFileStates(this.mapping.mappingId)
            .filter((r) => r.syncStatus === 'done' && r.remoteFileId);
        const files = {};
        for (const r of records) {
            const key = (0, pathSanitize_1.canonicalizeRelativeSyncPath)(r.localPath);
            if (!key)
                continue;
            files[key] = String(r.remoteFileId);
        }
        const sortedKeys = Object.keys(files).sort();
        const sortedFiles = {};
        for (const k of sortedKeys)
            sortedFiles[k] = files[k];
        return sortedFiles;
    }
    buildIndexJson(files) {
        const doc = {
            version: 1,
            mappingId: this.mapping.mappingId,
            updatedAt: new Date().toISOString(),
            fileCount: Object.keys(files).length,
            files,
        };
        return JSON.stringify(doc, null, 2) + '\n';
    }
    async locateRemoteIndexFileId() {
        const rootId = this.remoteFs.getRootFileId();
        return this.remoteFs.findDirectChildFileId(rootId, constants_1.FILE_INDEX_NAME);
    }
}
exports.FileIndexService = FileIndexService;
function hashFilesMapping(files) {
    const sorted = {};
    for (const k of Object.keys(files).sort())
        sorted[k] = String(files[k]);
    return (0, crypto_1.createHash)('sha256').update(JSON.stringify(sorted), 'utf8').digest('hex');
}
//# sourceMappingURL=fileIndexService.js.map