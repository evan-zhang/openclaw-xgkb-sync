"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RemoteFsAdapter = void 0;
const micromatch_1 = __importDefault(require("micromatch"));
const fileUploader_1 = require("./fileUploader");
const kbMoveFileContract_1 = require("./kbMoveFileContract");
const kbRenameFileContract_1 = require("./kbRenameFileContract");
const constants_1 = require("./constants");
const pathSanitize_1 = require("./pathSanitize");
/**
 * Remote knowledge-base filesystem adapter for OpenClaw.
 * Handles root resolution, listing, downloads, uploads, and deletes.
 */
class RemoteFsAdapter {
    api;
    uploader;
    opts;
    filePatterns;
    excludePatterns;
    // Resolved by init().
    resolvedProjectId = null;
    resolvedRootFileId = null;
    resolvedRootFolderPath = null;
    constructor(api, opts) {
        this.api = api;
        this.uploader = new fileUploader_1.FileUploader(api);
        this.opts = opts;
        this.filePatterns = opts.filePatterns ?? constants_1.DEFAULT_FILE_PATTERNS;
        this.excludePatterns = (0, constants_1.mergeDefaultExcludePatterns)(opts.excludePatterns);
    }
    getRootFileId() {
        if (!this.resolvedRootFileId)
            throw new Error('RemoteFsAdapter is not initialized; call init() first');
        return this.resolvedRootFileId;
    }
    getProjectId() {
        if (!this.resolvedProjectId)
            throw new Error('RemoteFsAdapter is not initialized; call init() first');
        return this.resolvedProjectId;
    }
    getRootFolderPath() {
        return this.resolvedRootFolderPath ?? '';
    }
    /**
     * Resolve projectId and rootFileId with priority:
     * explicit config > SQLite cache > API lookup.
     */
    async init() {
        // 1. projectId: explicit config, then cache, then personal project API.
        let projectId = this.opts.projectId ?? this.opts.cachedProjectId ?? null;
        if (!projectId) {
            console.log('[RemoteFs] projectId missing; calling getPersonalProjectId()...');
            const r = await this.api.getPersonalProjectId();
            if (!r.ok)
                return { ok: false, error: `Failed to get personal project ID: ${r.error}` };
            projectId = r.value;
            console.log(`[RemoteFs] Resolved personal project ID: ${projectId}`);
        }
        this.resolvedProjectId = projectId;
        // 2. rootFileId: explicit config, then cache, then path resolution or project root.
        let rootFileId = this.opts.remoteRootFileId ?? this.opts.cachedRootFileId ?? null;
        if (!rootFileId) {
            if (this.opts.remoteRootFolderPath) {
                console.log(`[RemoteFs] remoteRootFileId missing; resolving path: "${this.opts.remoteRootFolderPath}"`);
                const r = await this.resolveFileIdFromPath(this.opts.remoteRootFolderPath, projectId);
                if (!r.ok)
                    return r;
                rootFileId = r.value;
                console.log(`[RemoteFs] Path resolved: rootFileId=${rootFileId}`);
            }
            else {
                // Both root fields omitted: target the project root.
                rootFileId = '0';
                console.log('[RemoteFs] remote root not configured; using project root (rootFileId=0)');
            }
        }
        this.resolvedRootFileId = rootFileId;
        // 3. rootFolderPath is used as uploadContent folderName prefix.
        if (this.opts.remoteRootFolderPath) {
            this.resolvedRootFolderPath = this.opts.remoteRootFolderPath;
        }
        else if (rootFileId === '0') {
            this.resolvedRootFolderPath = '';
        }
        else if (!this.resolvedRootFolderPath) {
            console.log('[RemoteFs] remoteRootFolderPath missing; resolving path with batchGetMeta...');
            const r = await this.resolvePathFromFileId(rootFileId);
            if (!r.ok)
                return r;
            this.resolvedRootFolderPath = r.value;
            console.log(`[RemoteFs] Reverse path resolved: "${this.resolvedRootFolderPath}"`);
        }
        return {
            ok: true,
            value: {
                projectId,
                rootFileId,
                rootFolderPath: this.resolvedRootFolderPath ?? '',
            },
        };
    }
    /**
     * Resolve a remote folder path to fileId.
     * Example resolveFileIdFromPath("OpenClaw/OutputA", projectId):
     * - getLevel1Folders finds "OpenClaw"(id=100)
     * - getChildFiles(100, type=1) finds "OutputA"(id=200)
     * - returns "200"
     */
    async resolveFileIdFromPath(folderPath, projectId) {
        const segments = folderPath.split('/').filter(Boolean);
        if (segments.length === 0) {
            return { ok: false, error: `remoteRootFolderPath is empty: "${folderPath}"` };
        }
        const level1Result = await this.api.getLevel1Folders(projectId);
        if (!level1Result.ok) {
            return { ok: false, error: `Failed to get level-1 folders: ${level1Result.error}` };
        }
        const folders = level1Result.value ?? [];
        const firstSeg = segments[0];
        let firstFolder = folders.find((f) => f.name === firstSeg && f.type === 1);
        if (!firstFolder) {
            console.log(`[RemoteFs] Level-1 folder "${firstSeg}" not found; creating it...`);
            const createResult = await this.api.createFolder({ projectId, parentId: '0', name: firstSeg });
            if (!createResult.ok) {
                return { ok: false, error: `Failed to create level-1 folder "${firstSeg}": ${createResult.error}` };
            }
            firstFolder = { id: Number(createResult.value), name: firstSeg, type: 1 };
            console.log(`[RemoteFs] Created level-1 folder "${firstSeg}" (id=${createResult.value})`);
        }
        let currentId = String(firstFolder.id);
        for (let i = 1; i < segments.length; i++) {
            const seg = segments[i];
            const childResult = await this.api.getChildFiles(currentId, 1);
            if (!childResult.ok) {
                return { ok: false, error: `Failed to get child folders(parentId=${currentId}): ${childResult.error}` };
            }
            const children = childResult.value ?? [];
            const found = children.find((f) => f.name === seg);
            if (!found) {
                const parentPath = segments.slice(0, i).join('/');
                console.log(`[RemoteFs] Folder "${seg}" not found under "${parentPath}"; creating it...`);
                const createResult = await this.api.createFolder({ projectId, parentId: currentId, name: seg });
                if (!createResult.ok) {
                    return { ok: false, error: `Failed to create folder "${seg}" under "${parentPath}": ${createResult.error}` };
                }
                console.log(`[RemoteFs] Created folder "${seg}" under "${parentPath}" (id=${createResult.value})`);
                currentId = String(createResult.value);
            }
            else {
                currentId = String(found.id);
            }
        }
        return { ok: true, value: currentId };
    }
    /**
     * 将「相对 mapping 根」的本地目录路径解析为远端 folderId。
     * 空字符串表示 mapping 根（resolvedRootFileId）。
     * @param createIfMissing true=路径不存在时逐级 createFolder（上传流程）；
     *                        false=只查找不创建，找不到返回 error（enrichment 阶段使用）。
     */
    async resolveFolderIdForLocalDir(localDirPath, createIfMissing = true) {
        if (!this.resolvedRootFileId || !this.resolvedProjectId) {
            return { ok: false, error: 'RemoteFsAdapter is not initialized; call init() first' };
        }
        const segments = localDirPath.split('/').filter(Boolean);
        if (segments.length === 0) {
            return { ok: true, value: this.resolvedRootFileId };
        }
        let currentId = this.resolvedRootFileId;
        for (const seg of segments) {
            const childResult = await this.api.getChildFiles(currentId, 1);
            if (!childResult.ok) {
                return {
                    ok: false,
                    error: `getChildFiles(parentId=${currentId}) failed: ${childResult.error}`,
                };
            }
            const children = childResult.value ?? [];
            const found = children.find((f) => f.name === seg && f.type === 1);
            if (!found) {
                if (!createIfMissing) {
                    return { ok: false, error: `folder "${seg}" not found (lookup-only mode)` };
                }
                console.log(`[RemoteFs] resolveFolderIdForLocalDir: create "${seg}" under parentId=${currentId}`);
                const createResult = await this.api.createFolder({
                    projectId: this.resolvedProjectId,
                    parentId: currentId,
                    name: seg,
                });
                if (!createResult.ok) {
                    return {
                        ok: false,
                        error: `createFolder "${seg}" failed: ${createResult.error}`,
                    };
                }
                currentId = String(createResult.value);
            }
            else {
                currentId = String(found.id);
            }
        }
        return { ok: true, value: currentId };
    }
    /**
     * Resolve a folder path from fileId for configs that only provide remoteRootFileId.
     */
    async resolvePathFromFileId(fileId) {
        const segments = [];
        let currentId = fileId;
        const MAX_DEPTH = 15;
        let reachedMaxDepth = true;
        for (let depth = 0; depth < MAX_DEPTH; depth++) {
            const metaMap = await this.batchGetMetaAll([currentId]);
            const meta = metaMap.get(currentId);
            if (!meta) {
                return { ok: false, error: `Failed to get file metadata: fileId=${currentId}` };
            }
            segments.unshift(meta.name);
            const parentId = meta.parentId != null ? String(meta.parentId) : '0';
            if (parentId === '0' || !parentId) {
                reachedMaxDepth = false;
                break;
            }
            currentId = parentId;
        }
        if (reachedMaxDepth) {
            console.warn(`[RemoteFs] resolvePathFromFileId reached max depth (${MAX_DEPTH}); path may be incomplete: "${segments.join('/')}"`);
        }
        return { ok: true, value: segments.join('/') };
    }
    /**
     * Full remote listing via paginated listDescendantFiles.
     * suffix is inferred from filePatterns for API-side filtering; complex patterns are filtered locally.
     */
    async listFiles() {
        const entries = [];
        let cursor;
        let page = 0;
        // Infer API suffix from filePatterns.
        const apiSuffix = (0, constants_1.extractUniqueSuffix)(this.filePatterns);
        console.log(`[RemoteFs] listDescendantFiles API suffix=${apiSuffix ?? 'none'}`);
        do {
            page++;
            const r = await this.api.listDescendantFiles({
                rootFileId: this.resolvedRootFileId, // '0' means project root.
                projectId: this.resolvedProjectId,
                suffix: apiSuffix,
                limit: 500,
                cursor,
                includePath: true,
            });
            if (!r.ok)
                return { ok: false, error: r.error };
            const pageItems = r.value.files ?? [];
            console.log(`[RemoteFs] listDescendantFiles page ${page}: ${pageItems.length} items, nextCursor=${r.value.nextCursor ?? 'null'}`);
            for (const item of pageItems) {
                const rawPath = item.relativePath ?? item.name;
                const safePath = (0, pathSanitize_1.canonicalizeRelativeSyncPath)(rawPath);
                // Even with API suffix filtering, still apply full include/exclude patterns locally.
                if (micromatch_1.default.isMatch(safePath, this.excludePatterns))
                    continue;
                if (!micromatch_1.default.isMatch(safePath, this.filePatterns))
                    continue;
                entries.push({
                    path: safePath,
                    name: item.name,
                    mtime: item.updateTime ?? 0,
                    size: item.size,
                    remoteFileId: String(item.fileId),
                    remoteFolderId: item.parentId != null ? String(item.parentId) : '',
                });
            }
            cursor = r.value.nextCursor ?? undefined;
        } while (cursor);
        const collision = findPathCollision(entries);
        if (collision) {
            return {
                ok: false,
                error: `远端路径规范化后发生冲突，已停止同步以避免覆盖文件: ${collision.path}` +
                    ` (fileId=${collision.first.remoteFileId} / ${collision.second.remoteFileId})`,
            };
        }
        console.log(`[RemoteFs] listDescendantFiles done: ${entries.length} files in ${page} pages`);
        return { ok: true, value: entries };
    }
    /**
     * Read remote file content.
     * Prefer getDownloadInfo(forceDownload=true) OSS URL; fall back to getFullFileContent.
     */
    async readFile(fileId) {
        const infoResult = await this.api.getDownloadInfo(fileId, true);
        if (infoResult.ok && infoResult.value.downloadUrl) {
            try {
                const resp = await fetch(infoResult.value.downloadUrl);
                if (!resp.ok) {
                    if (resp.status === 429) {
                        return {
                            ok: false,
                            error: `OSS download rate limited HTTP 429: ${resp.statusText}`,
                        };
                    }
                    return { ok: false, error: `OSS download failed HTTP ${resp.status}: ${resp.statusText}` };
                }
                const text = await resp.text();
                return { ok: true, value: text };
            }
            catch (e) {
                return { ok: false, error: `OSS download error: ${e instanceof Error ? e.message : String(e)}` };
            }
        }
        // Fallback: getDownloadInfo is unavailable or returns no downloadUrl.
        console.warn(`[RemoteFs] getDownloadInfo falling back to getFullFileContent (fileId=${fileId}): ${infoResult.ok ? 'no downloadUrl' : infoResult.error}`);
        const r = await this.api.getFullFileContent(fileId);
        if (!r.ok)
            return r;
        // AI fallback may include page footer text.
        const cleaned = r.value == null
            ? ''
            : r.value.replace(/\n*Page \d+ of \d+\s*$/, '').trimEnd() + '\n';
        return { ok: true, value: cleaned };
    }
    /**
     * Batch-read file content through getDownloadInfo + OSS fetch.
     * Single-file failures are warned here; callers can retry on cache miss.
     */
    async readFilesBatch(fileIds) {
        const out = new Map();
        const unique = [...new Set(fileIds.filter(Boolean))];
        const downloadOne = async (fileId) => {
            const r = await this.readFile(fileId);
            if (r.ok) {
                out.set(fileId, r.value ?? '');
            }
            else {
                console.warn(`[RemoteFs] Download failed fileId=${fileId}: ${r.error}`);
            }
        };
        for (let i = 0; i < unique.length; i += constants_1.DOWNLOAD_CONCURRENCY) {
            const chunk = unique.slice(i, i + constants_1.DOWNLOAD_CONCURRENCY);
            await Promise.all(chunk.map(downloadOne));
            console.log(`[RemoteFs] Download progress: ${Math.min(i + constants_1.DOWNLOAD_CONCURRENCY, unique.length)}/${unique.length}`);
        }
        return out;
    }
    /**
     * Create a remote file (new upload, no existing fileId).
     * @param relativePath Relative path, for example "folder/2024.md".
     */
    async createFile(relativePath, content) {
        if (this.resolvedRootFolderPath === null) {
            return { ok: false, error: 'RemoteFsAdapter is not initialized; call init() first' };
        }
        const lastSlash = relativePath.lastIndexOf('/');
        const subPath = lastSlash > 0 ? relativePath.substring(0, lastSlash) : '';
        const fileName = lastSlash > 0 ? relativePath.substring(lastSlash + 1) : relativePath;
        const fileSuffix = getFileSuffix(fileName);
        let folderName;
        if (this.resolvedRootFolderPath) {
            folderName = subPath
                ? `${this.resolvedRootFolderPath}/${subPath}`
                : this.resolvedRootFolderPath;
        }
        else {
            folderName = subPath;
        }
        return this.uploader.create({ content, fileName, fileSuffix, folderName, projectId: this.resolvedProjectId });
    }
    /**
     * Update a remote file version (append new version to existing fileId).
     */
    async updateFile(remoteFileId, fileName, content) {
        const fileSuffix = getFileSuffix(fileName);
        const r = await this.uploader.update({
            content,
            fileName,
            fileSuffix,
            updateFileId: remoteFileId,
            projectId: this.resolvedProjectId ?? undefined,
        });
        if (!r.ok)
            return { ok: false, error: r.error };
        return { ok: true, value: r.value.remoteFileId };
    }
    /**
     * 重命名远端文件或文件夹（同目录内改名，不移动）。
     * 对应 KB v2 updateFileName 接口。
     */
    async renameFile(params) {
        const rootFileId = params.rootFileId ?? this.resolvedRootFileId ?? undefined;
        const r = await this.api.updateFileName({
            fileId: params.fileId,
            newName: params.newName,
            nameConflictStrategy: params.nameConflictStrategy,
            projectId: params.projectId ?? this.resolvedProjectId ?? undefined,
            rootFileId,
        });
        if (!r.ok)
            return { ok: false, error: `renameFile 失败: ${r.error}` };
        return {
            ok: true,
            value: (0, kbRenameFileContract_1.normalizeUpdateFileNameResult)(r.value, params.fileId),
        };
    }
    /**
     * 移动远端节点。同步侧不传 newName（换目录+改名时由调用方先 move 再 updateFileName）。
     */
    async moveFile(params) {
        const rootFileId = params.rootFileId ?? this.resolvedRootFileId ?? undefined;
        const r = await this.api.moveFile({
            fileId: params.fileId,
            targetParentId: params.targetParentId,
            nameConflictStrategy: params.nameConflictStrategy,
            projectId: params.projectId ?? this.resolvedProjectId ?? undefined,
            rootFileId,
        });
        if (!r.ok)
            return { ok: false, error: `moveFile 失败: ${r.error}` };
        const value = (0, kbMoveFileContract_1.normalizeMoveFileResult)(r.value, params.fileId);
        (0, kbMoveFileContract_1.warnMoveFileResponseGaps)(value, params.fileId, rootFileId != null, 'RemoteFs');
        return { ok: true, value };
    }
    /** Delete remote file. */
    async deleteFile(remoteFileId) {
        const r = await this.api.deleteFile(remoteFileId);
        if (!r.ok)
            return r;
        return { ok: true, value: undefined };
    }
    /** 查询远端目录的直接子项（文件+子目录），用于安全检查目录是否为空 */
    async getChildFiles(folderId) {
        return this.api.getChildFiles(folderId);
    }
    /**
     * 后序清理远端空目录。
     * - 不删除 mapping 根目录自身；
     * - 若本地仍存在同名目录，即使为空也保留；
     * - 只删除知识库中真正没有任何子项的目录，避免误删含非同步文件的目录。
     */
    async pruneEmptyDirectories(localDirectoryPaths) {
        if (!this.resolvedRootFileId) {
            return { ok: false, error: 'RemoteFsAdapter is not initialized; call init() first' };
        }
        const result = await this.pruneFolderNode(this.resolvedRootFileId, '', localDirectoryPaths, true);
        return {
            ok: true,
            value: {
                deleted: result.deleted,
                failed: result.failed,
                errors: result.errors,
            },
        };
    }
    async pruneFolderNode(folderId, relPath, localDirectoryPaths, isRoot) {
        const childrenResult = await this.api.getChildFiles(folderId);
        if (!childrenResult.ok) {
            return {
                existsAfter: true,
                deleted: 0,
                failed: 1,
                errors: [`${relPath || '<root>'}: list children failed: ${childrenResult.error}`],
            };
        }
        let deleted = 0;
        let failed = 0;
        const errors = [];
        let hasChildAfterPrune = false;
        for (const child of childrenResult.value ?? []) {
            const childId = String(child.id);
            if (child.type !== 1) {
                hasChildAfterPrune = true;
                continue;
            }
            const childRelPath = relPath
                ? `${relPath}/${(0, pathSanitize_1.sanitizePathSegment)(child.name)}`
                : (0, pathSanitize_1.sanitizePathSegment)(child.name);
            const childResult = await this.pruneFolderNode(childId, childRelPath, localDirectoryPaths, false);
            deleted += childResult.deleted;
            failed += childResult.failed;
            errors.push(...childResult.errors);
            if (childResult.existsAfter) {
                hasChildAfterPrune = true;
            }
        }
        if (isRoot || hasChildAfterPrune || localDirectoryPaths.has(relPath)) {
            return { existsAfter: true, deleted, failed, errors };
        }
        const deleteResult = await this.api.deleteFile(folderId);
        if (!deleteResult.ok) {
            return {
                existsAfter: true,
                deleted,
                failed: failed + 1,
                errors: [...errors, `${relPath}: delete empty folder failed: ${deleteResult.error}`],
            };
        }
        console.log(`[RemoteFs] Pruned empty remote folder: ${relPath} (${folderId})`);
        return { existsAfter: false, deleted: deleted + 1, failed, errors };
    }
    /**
     * Incremental change listing through listChanges.
     * @param since Last successful sync watermark.
     */
    async listAllChanges(since) {
        const sinceStr = new Date(since).toLocaleString('zh-CN');
        console.log(`[RemoteFs] listChanges: since=${since} (${sinceStr}), rootId=${this.resolvedRootFileId}`);
        const allItems = [];
        let cursor;
        let serverTime;
        let page = 0;
        do {
            page++;
            const r = await this.api.listChanges({
                projectId: this.resolvedProjectId,
                // rootFileId='0' means project root; omit rootFileId to scan the whole project.
                ...(this.resolvedRootFileId !== '0' && { rootFileId: this.resolvedRootFileId }),
                since: cursor ? undefined : since,
                cursor,
                limit: 200,
            });
            if (!r.ok)
                return { ok: false, error: r.error };
            const pageItems = r.value.items ?? [];
            console.log(`[RemoteFs] listChanges page ${page}: ${pageItems.length} items, nextCursor=${r.value.nextCursor ?? 'null'}, serverTime=${r.value.serverTime ?? '-'}`);
            allItems.push(...pageItems);
            serverTime = r.value.serverTime ?? serverTime;
            cursor = r.value.nextCursor ?? undefined;
        } while (cursor);
        const upsertCount = allItems.filter((i) => i.event !== 'delete').length;
        const deleteCount = allItems.filter((i) => i.event === 'delete').length;
        console.log(`[RemoteFs] listChanges done: ${allItems.length} items (upsert:${upsertCount} delete:${deleteCount}), serverTime=${serverTime}`);
        return { ok: true, value: { items: allItems, serverTime } };
    }
    /**
     * Batch metadata lookup through batchGetMeta, returning fileId -> FileMeta.
     * Failed batches are warned and skipped; callers handle missing metadata.
     */
    async batchGetMetaAll(fileIds) {
        const out = new Map();
        const unique = [...new Set(fileIds.filter(Boolean))];
        console.log(`[RemoteFs] batchGetMeta: ${unique.length} fileIds, ${Math.ceil(unique.length / constants_1.BATCH_GET_META_MAX)} batches`);
        for (let i = 0; i < unique.length; i += constants_1.BATCH_GET_META_MAX) {
            const chunk = unique.slice(i, i + constants_1.BATCH_GET_META_MAX);
            const r = await this.api.batchGetMeta(chunk, this.resolvedProjectId);
            if (!r.ok) {
                console.warn('[RemoteFs] batchGetMeta batch failed:', r.error);
                continue;
            }
            let deletedCount = 0;
            for (const item of r.value ?? []) {
                out.set(String(item.fileId), item);
                if (item.deleted)
                    deletedCount++;
            }
            console.log(`[RemoteFs] batchGetMeta batch[${Math.floor(i / constants_1.BATCH_GET_META_MAX) + 1}]: requested ${chunk.length}, hit ${r.value?.length ?? 0} (deleted:${deletedCount})`);
        }
        const missingCount = unique.length - out.size;
        if (missingCount > 0) {
            console.log(`[RemoteFs] batchGetMeta done: hit ${out.size}, missing ${missingCount}`);
        }
        return out;
    }
}
exports.RemoteFsAdapter = RemoteFsAdapter;
function getFileSuffix(fileName) {
    const dot = fileName.lastIndexOf('.');
    if (dot <= 0 || dot === fileName.length - 1)
        return undefined;
    return fileName.slice(dot + 1).toLowerCase();
}
function findPathCollision(entries) {
    const seen = new Map();
    for (const entry of entries) {
        const existing = seen.get(entry.path);
        if (existing && existing.remoteFileId !== entry.remoteFileId) {
            return { path: entry.path, first: existing, second: entry };
        }
        seen.set(entry.path, entry);
    }
    return null;
}
//# sourceMappingURL=remoteFs.js.map