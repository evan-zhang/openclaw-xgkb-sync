"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SyncEngine = void 0;
const micromatch_1 = __importDefault(require("micromatch"));
const nodePath = __importStar(require("path"));
const reconcileEngine_1 = require("./reconcileEngine");
const constants_1 = require("./constants");
const pathSanitize_1 = require("./pathSanitize");
const trashBin_1 = require("./trashBin");
const fileIndexService_1 = require("./fileIndexService");
/**
 * 核心同步引擎（OpenClaw 版）
 * 与 Obsidian 版的主要差异：
 * - 使用 mappingId 隔离多条映射规则的状态
 * - 状态库操作基于 SQLite（SyncStateDb）
 * - 本地/远端文件操作基于 LocalFsAdapter / RemoteFsAdapter
 */
class SyncEngine {
    localFs;
    remoteFs;
    db;
    mapping;
    stats;
    progress;
    filePatterns;
    excludePatterns;
    downloadConcurrency;
    uploadConcurrency;
    /** pull/bidirectional 本轮 sync 写入本地的路径，供 FileWatcher resume 后 echo 过滤 */
    pullLocalTouchPaths = new Set();
    constructor(localFs, remoteFs, db, mapping, opts) {
        this.localFs = localFs;
        this.remoteFs = remoteFs;
        this.db = db;
        this.mapping = mapping;
        this.filePatterns = mapping.filePatterns ?? constants_1.DEFAULT_FILE_PATTERNS;
        this.excludePatterns = mapping.excludePatterns ?? constants_1.DEFAULT_EXCLUDE_PATTERNS;
        this.downloadConcurrency = opts?.downloadConcurrency ?? constants_1.DOWNLOAD_CONCURRENCY;
        this.uploadConcurrency = opts?.uploadConcurrency ?? constants_1.UPLOAD_CONCURRENCY;
        this.stats = this.emptyStats();
        this.progress = () => undefined;
    }
    delay(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
    /** 判断路径是否应纳入同步范围 */
    matchesSync(path) {
        if (micromatch_1.default.isMatch(path, this.excludePatterns))
            return false;
        return micromatch_1.default.isMatch(path, this.filePatterns);
    }
    /** 本轮 sync 中 pull 侧写入本地的路径（供 chokidar echo 过滤） */
    getPullLocalTouchPaths() {
        return [...this.pullLocalTouchPaths];
    }
    notePullLocalTouch(...paths) {
        const syncDir = this.mapping.syncDirection ?? 'bidirectional';
        if (syncDir === 'push')
            return;
        for (const p of paths) {
            if (!p)
                continue;
            const key = (0, pathSanitize_1.canonicalizeRelativeSyncPath)(p);
            if (key)
                this.pullLocalTouchPaths.add(key);
        }
    }
    emptyStats() {
        return {
            uploaded: 0,
            downloaded: 0,
            deleted: 0,
            prunedRemoteDirs: 0,
            skipped: 0,
            failed: 0,
            errors: [],
            renamed: 0,
            moved: 0,
        };
    }
    /**
     * 执行一轮同步（增量优先，降级全量）。
     * @param onProgress 进度回调
     * @param lastSyncSince 上次成功同步的水位时间戳（毫秒）；undefined = 首次全量
     */
    async runSync(onProgress, lastSyncSince, opts) {
        this.stats = this.emptyStats();
        this.progress = onProgress ?? (() => undefined);
        this.pullLocalTouchPaths.clear();
        const prog = (msg) => {
            console.log(`[SyncEngine][${this.mapping.mappingId}] ${msg}`);
            this.progress(msg);
        };
        await this.runFileIndexConsume(prog);
        prog('扫描本地文件...');
        const [localFiles, localDirs] = await Promise.all([
            this.localFs.listFiles(),
            this.localFs.listDirectories(),
        ]);
        prog(`本地: ${localFiles.length} 个文件, ${localDirs.length} 个目录`);
        const { map: remoteMap, newSince, remoteDeltaCount, fullScan, remoteMoveHints } = await this.buildRemoteMap(lastSyncSince, prog, opts);
        prog(`远端: ${remoteMap.size} 个文件（水位 ${newSince}）`);
        this.stats.newSince = newSince;
        this.stats.fullScan = fullScan;
        let localMap = new Map(localFiles.map((f) => [f.path, f]));
        // 一次性批量加载所有文件状态，供决策循环 O(1) 查找，避免 N 次独立 SQLite 查询
        let recordMap = new Map(this.db.getAllFileStates(this.mapping.mappingId).map((r) => [r.localPath, r]));
        // ── Phase 1：inode 对账（rename/move 检测）──────────────────────────────
        // 只在 push / bidirectional 方向下执行（pull 不修改远端）
        const syncDir = this.mapping.syncDirection ?? 'bidirectional';
        let consumedFromPaths = new Set();
        let consumedToPaths = new Set();
        if (syncDir !== 'pull') {
            // 补全迁移后被清空的 inode（旧 INTEGER→新 TEXT bigint 升级时置 NULL 的记录）
            this.backfillInodes(localFiles, recordMap);
            // 同步本地目录 inode 到 sync_folder_state（为文件夹 rename 检测准备数据）
            this.syncFolderInodes(localDirs);
            const folderPathToRemoteId = this.buildFolderPathToRemoteId([...recordMap.values()], this.remoteFs.getRootFileId());
            await this.enrichFolderPathToRemoteId(folderPathToRemoteId, localFiles, [...recordMap.values()], prog);
            const folderRecords = this.db.getAllFolderStates(this.mapping.mappingId);
            const { plans: renamePlans, consumedFromPaths: cfp, consumedToPaths: ctp } = (0, reconcileEngine_1.detectLocalRenames)(localFiles, localDirs, [...recordMap.values()], folderRecords, folderPathToRemoteId);
            this.logInodeDetectionGaps(localFiles, [...recordMap.values()], renamePlans);
            consumedFromPaths = cfp;
            consumedToPaths = ctp;
            const contentChangedAfterRename = (0, reconcileEngine_1.releaseContentChangedRenameTargets)(localMap, renamePlans, consumedToPaths);
            if (contentChangedAfterRename > 0) {
                prog(`inode 对账：${contentChangedAfterRename} 项 rename 同时有内容变更，仍参与 Phase2 上传`);
            }
            if (renamePlans.length > 0) {
                const dirPlans = renamePlans.filter((p) => p.isDirectory);
                const filePlans = renamePlans.filter((p) => !p.isDirectory);
                prog(`inode 对账：${renamePlans.length} 项（文件 rename=${filePlans.filter((p) => p.op === 'rename-remote').length}` +
                    ` move=${filePlans.filter((p) => p.op === 'move-remote').length}` +
                    ` 目录合并=${dirPlans.length}）`);
                this.logRenamePlans(renamePlans);
                // 先执行目录级（一次 API），再单文件
                for (const plan of [...dirPlans, ...filePlans]) {
                    await this.executePlan(plan, remoteMap);
                }
                // 重命名/移动执行后 DB 已变更，重新加载 recordMap
                recordMap = new Map(this.db.getAllFileStates(this.mapping.mappingId).map((r) => [r.localPath, r]));
            }
        }
        // ── Phase 1.5：远端 → 本地 rename/move（仅 bidirectional / pull 模式）────────
        if (syncDir !== 'push') {
            let moveHints = [];
            if (remoteMoveHints && remoteMoveHints.length > 0) {
                // 增量模式下已有检测结果
                moveHints = remoteMoveHints;
            }
            else if (fullScan) {
                // 全量扫描模式：通过 remoteFileId 比对 DB 中的 localPath 来检测
                moveHints = this.detectRemoteMovesFromFullScan(remoteMap, recordMap);
            }
            // 过滤掉与本地 inode 检测冲突的路径（同一文件本地也 rename 了）
            const validHints = moveHints.filter((h) => !consumedFromPaths.has(h.oldPath) && !consumedToPaths.has(h.newPath));
            if (validHints.length > 0) {
                // 目录级优先，避免逐文件 rename 时路径冲突
                const sortedHints = [...validHints].sort((a, b) => (b.isDirectory ? 1 : 0) - (a.isDirectory ? 1 : 0));
                prog(`远端 rename/move 检测到 ${sortedHints.length} 项，执行本地同步...`);
                for (const hint of sortedHints) {
                    await this.doRemoteMoveToLocal(hint, prog);
                    if (hint.isDirectory) {
                        // 目录级：所有旧前缀下的路径都需标记为已消费
                        for (const [p] of recordMap) {
                            if (p.startsWith(hint.oldPath + '/') || p === hint.oldPath) {
                                consumedFromPaths.add(p);
                                const newP = hint.newPath + p.slice(hint.oldPath.length);
                                consumedToPaths.add(newP);
                            }
                        }
                    }
                    else {
                        consumedFromPaths.add(hint.oldPath);
                        consumedToPaths.add(hint.newPath);
                    }
                }
                // 本地文件已被 rename，必须刷新 localMap，否则 Phase 2 会误判 delete-remote / upload-new
                const refreshedLocalFiles = await this.localFs.listFiles();
                localMap = new Map(refreshedLocalFiles.map((f) => [f.path, f]));
                recordMap = new Map(this.db.getAllFileStates(this.mapping.mappingId).map((r) => [r.localPath, r]));
            }
        }
        // ── Phase 2：路径对账（增量快速通道 & 完整决策循环）─────────────────────
        // 增量快速通道：远端0变更时，仅检查本地是否有变化
        // 若本地也无新增/修改/删除，则所有路径必然是 skip，直接跳过决策循环
        if (remoteDeltaCount === 0) {
            const hasLocalNew = localFiles.some((f) => !consumedToPaths.has(f.path) && !recordMap.has(f.path));
            const hasLocalModified = localFiles.some((f) => {
                if (consumedToPaths.has(f.path))
                    return false;
                return (recordMap.get(f.path)?.localMtime ?? -1) + constants_1.MTIME_TOLERANCE_MS < f.mtime;
            });
            const hasLocalDeleted = [...recordMap.keys()].some((p) => !consumedFromPaths.has(p) && !localMap.has(p));
            if (!hasLocalNew && !hasLocalModified && !hasLocalDeleted) {
                const totalPaths = new Set([...localMap.keys(), ...remoteMap.keys()]).size;
                this.stats.skipped += totalPaths;
                await this.pruneRemoteEmptyDirectories(prog, localDirs);
                prog(`增量无变化（远端0变更，本地无新增/修改/删除），跳过决策，共跳过 ${totalPaths} 个路径`);
                await this.runFileIndexPublish(prog);
                return this.stats;
            }
            prog(`远端0变更，但本地有变化（new=${hasLocalNew} mod=${hasLocalModified} del=${hasLocalDeleted}），继续决策`);
        }
        // 排除已被 rename/move 消费的路径，避免路径对账重复处理
        const effectiveLocalKeys = [...localMap.keys()].filter((p) => !consumedToPaths.has(p));
        const effectiveRemoteKeys = [...remoteMap.keys()].filter((p) => !consumedFromPaths.has(p));
        const allPaths = new Set([...effectiveLocalKeys, ...effectiveRemoteKeys]);
        prog(`共 ${allPaths.size} 个路径需要路径对账决策`);
        // 决策阶段
        const plans = [];
        let idx = 0;
        for (const path of allPaths) {
            idx++;
            if (idx % 500 === 0 || idx === allPaths.size) {
                prog(`决策中 ${idx}/${allPaths.size}...`);
            }
            const local = localMap.get(path);
            const remote = remoteMap.get(path);
            const record = recordMap.get(path);
            const op = this.decide(path, local, remote, record);
            plans.push({ path, local, remote, record, op });
        }
        // 分类计划：删除 / 下载 / 上传
        const deletePlans = plans.filter((p) => p.op === 'delete-local' || p.op === 'delete-remote');
        const downloadPlans = plans.filter((p) => p.op === 'download-new' || p.op === 'download-update');
        const uploadPlans = plans.filter((p) => p.op === 'upload-new' || p.op === 'upload-update');
        const skipCount = plans.filter((p) => p.op === 'skip').length;
        this.stats.skipped += skipCount;
        prog(`执行计划: 删除=${deletePlans.length} 下载=${downloadPlans.length}` +
            ` 上传=${uploadPlans.length} 跳过=${skipCount}`);
        // 1. 删除操作串行（避免竞态）
        for (const plan of deletePlans) {
            await this.executePlan(plan, remoteMap);
        }
        // 2. 下载：按 downloadConcurrency 分批，批间加 pause，由 KbApiClient 限速器节流
        if (downloadPlans.length > 0) {
            prog(`开始下载 ${downloadPlans.length} 个文件（并发=${this.downloadConcurrency}）...`);
            await this.executePlansInQueue(downloadPlans, this.downloadConcurrency, '下载', prog);
        }
        // 3. 上传：按 uploadConcurrency 分批，同理
        if (uploadPlans.length > 0) {
            prog(`开始上传 ${uploadPlans.length} 个文件（并发=${this.uploadConcurrency}）...`);
            await this.executePlansInQueue(uploadPlans, this.uploadConcurrency, '上传', prog);
        }
        await this.pruneRemoteEmptyDirectories(prog);
        // 清理过期回收站（静默，不阻塞主流程）
        (0, trashBin_1.cleanupTrash)(this.mapping.mappingId).catch(() => { });
        prog(`完成: ↑${this.stats.uploaded} ↓${this.stats.downloaded} ✗${this.stats.deleted}` +
            ` 重命名:${this.stats.renamed ?? 0} 移动:${this.stats.moved ?? 0}` +
            ` 空目录清理:${this.stats.prunedRemoteDirs ?? 0} fail:${this.stats.failed} skip:${this.stats.skipped}`);
        await this.runFileIndexPublish(prog);
        return this.stats;
    }
    /** enableFileIndex + pull/bidirectional：同步开始前 consume 索引 */
    async runFileIndexConsume(prog) {
        if (!this.mapping.enableFileIndex)
            return;
        const syncDir = this.mapping.syncDirection ?? 'bidirectional';
        if (syncDir !== 'pull' && syncDir !== 'bidirectional')
            return;
        try {
            prog('拉取映射索引文件...');
            await new fileIndexService_1.FileIndexService(this.db, this.remoteFs, this.localFs, this.mapping).consumeIndex();
        }
        catch (e) {
            this.warnFileIndex('consume', e);
        }
    }
    /** enableFileIndex + push/bidirectional + 主 sync 无失败：同步成功后 publish 索引 */
    async runFileIndexPublish(prog) {
        if (!this.mapping.enableFileIndex)
            return;
        if (this.stats.failed > 0)
            return;
        const syncDir = this.mapping.syncDirection ?? 'bidirectional';
        if (syncDir !== 'push' && syncDir !== 'bidirectional')
            return;
        try {
            prog('发布映射索引文件...');
            await new fileIndexService_1.FileIndexService(this.db, this.remoteFs, this.localFs, this.mapping).publishIndex();
        }
        catch (e) {
            this.warnFileIndex('publish', e);
        }
    }
    warnFileIndex(phase, e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`[FileIndex][${this.mapping.mappingId}] ${phase} unexpected error: ${msg}`);
    }
    /**
     * 清理远端空目录：基于 sync_folder_state 中已记录但本地已不存在的目录。
     * 从叶子到根（路径最长优先）逐个检查，避免递归 getChildFiles。
     * 若远端目录下仍有子项（非同步文件或非同步子目录），则保留。
     */
    async pruneRemoteEmptyDirectories(prog, cachedLocalDirs) {
        const syncDir = this.mapping.syncDirection ?? 'bidirectional';
        if (syncDir === 'pull')
            return;
        const localDirEntries = cachedLocalDirs ?? await this.localFs.listDirectories();
        const localDirPaths = new Set(localDirEntries.map((d) => d.path));
        // 补全/更新已有 folder 记录的 inode（确保下次 rename 检测有数据可用）
        this.syncFolderInodes(localDirEntries);
        const folderStates = this.db.getAllFolderStates(this.mapping.mappingId);
        // 找出本地已删除但 DB 中有记录的目录
        const orphanFolders = folderStates
            .filter((fs) => !localDirPaths.has(fs.localPath))
            .sort((a, b) => b.localPath.length - a.localPath.length); // 叶子优先
        if (orphanFolders.length === 0)
            return;
        let deleted = 0;
        let failed = 0;
        const errors = [];
        // 预加载文件状态（避免循环内重复查询）
        const allFileStates = this.db.getAllFileStates(this.mapping.mappingId);
        const folderIdToFiles = new Map();
        for (const f of allFileStates) {
            if (f.remoteFolderId)
                folderIdToFiles.set(f.remoteFolderId, true);
        }
        for (const folder of orphanFolders) {
            // 1. 本地 DB 中仍有文件引用此 folderId → 跳过
            if (folderIdToFiles.has(folder.remoteFolderId))
                continue;
            // 2. 仍有子目录记录 → 跳过（等子目录先处理）
            const hasSubFolders = folderStates.some((f) => f.localPath !== folder.localPath && f.localPath.startsWith(folder.localPath + '/'));
            if (hasSubFolders)
                continue;
            // 3. 安全检查：远端目录是否真的为空（可能有非同步文件）
            const childResult = await this.remoteFs.getChildFiles(folder.remoteFolderId);
            if (childResult.ok && childResult.value && childResult.value.length > 0) {
                console.log(`[SyncEngine] 跳过远端非空目录: "${folder.localPath}" (${folder.remoteFolderId}) 远端有 ${childResult.value.length} 个子项`);
                // 仅清理 DB 记录（本地已删，但远端有非同步内容，不删远端）
                this.db.deleteFolderState(this.mapping.mappingId, folder.localPath);
                continue;
            }
            const result = await this.remoteFs.deleteFile(folder.remoteFolderId);
            if (result.ok) {
                deleted++;
                this.db.deleteFolderState(this.mapping.mappingId, folder.localPath);
                console.log(`[SyncEngine] Pruned empty remote folder: "${folder.localPath}" (${folder.remoteFolderId})`);
            }
            else {
                failed++;
                errors.push(`${folder.localPath}: ${result.error}`);
                this.db.deleteFolderState(this.mapping.mappingId, folder.localPath);
                console.warn(`[SyncEngine] 远端目录删除失败: "${folder.localPath}" (${folder.remoteFolderId}): ${result.error}`);
            }
        }
        this.stats.prunedRemoteDirs = (this.stats.prunedRemoteDirs ?? 0) + deleted;
        if (failed > 0) {
            this.stats.failed += failed;
            this.stats.errors.push(...errors);
        }
        if (deleted > 0 || failed > 0) {
            prog(`远端空目录清理: 删除=${deleted} 失败=${failed}`);
        }
    }
    /**
     * 将本地目录的 dev/ino 同步到 sync_folder_state（仅更新已有记录的 inode）。
     */
    syncFolderInodes(localDirEntries) {
        const updates = [];
        for (const dir of localDirEntries) {
            if (dir.dev === '0' && dir.ino === '0')
                continue;
            const existing = this.db.getFolderState(this.mapping.mappingId, dir.path);
            if (!existing)
                continue;
            if (existing.localDev === dir.dev && existing.localIno === dir.ino)
                continue;
            updates.push({
                ...existing,
                localDev: dir.dev,
                localIno: dir.ino,
            });
        }
        if (updates.length > 0) {
            this.db.upsertFolderStateBatch(updates);
        }
    }
    // ==================== 辅助工具 ====================
    /**
     * 从 DB 记录中构建「本地相对目录路径 → 远端 folderId」映射。
     * 用于 reconcileEngine 在生成 move-remote 计划时解析目标 folderId。
     */
    /**
     * 收集本地相对目录路径（不含文件名），用于补齐 folderPathToRemoteId。
     */
    collectLocalDirPaths(localFiles, records) {
        const set = new Set();
        const addFilePath = (filePath) => {
            const idx = filePath.lastIndexOf('/');
            if (idx <= 0)
                return;
            const dir = filePath.slice(0, idx);
            const parts = dir.split('/');
            for (let i = 1; i <= parts.length; i++) {
                set.add(parts.slice(0, i).join('/'));
            }
        };
        for (const f of localFiles)
            addFilePath(f.path);
        for (const r of records)
            addFilePath(r.localPath);
        return [...set].sort((a, b) => a.split('/').length - b.split('/').length);
    }
    /**
     * 为 inode 对账补齐「本地目录 → 远端 folderId」。
     * sync_file_state 只存文件不存文件夹；新目标目录若从未同步过文件，须通过 KB API 解析/创建。
     */
    /**
     * 补齐 map 中缺失的目录 folderId。
     * 由于 sync_folder_state 已被 buildFolderPathToRemoteId 优先加载，
     * 此方法仅在极少数情况（文件被移到全新目录）才调用 KB API。
     */
    async enrichFolderPathToRemoteId(map, localFiles, records, prog) {
        const dirs = this.collectLocalDirPaths(localFiles, records);
        let resolved = 0;
        for (const dir of dirs) {
            if (map.has(dir))
                continue;
            // 仅查找已存在的远端目录，不创建新目录。
            // 重命名/移动检测只需目标的父目录可解析即可；
            // 目录创建留给实际上传流程（uploadContent 自动建目录）。
            const r = await this.remoteFs.resolveFolderIdForLocalDir(dir, false);
            if (!r.ok)
                continue; // 远端不存在，跳过（可能是 rename 目标或尚未同步的新目录）
            map.set(dir, r.value);
            resolved++;
            this.db.upsertFolderState({
                mappingId: this.mapping.mappingId,
                localPath: dir,
                remoteFolderId: r.value,
            });
            console.log(`[SyncEngine][${this.mapping.mappingId}] 目录 folderId 已解析并持久化: "${dir}" -> ${r.value}`);
        }
        if (resolved > 0) {
            prog(`已解析 ${resolved} 个本地目录的远端 folderId（供 move/rename 使用）`);
        }
    }
    /**
     * 补全因 INTEGER→TEXT 迁移被清空的 localDev/localIno。
     * 按路径匹配当前本地文件，将 bigint stat 的正确值写回 DB。
     */
    backfillInodes(localFiles, recordMap) {
        const updates = [];
        for (const f of localFiles) {
            if (!f.ino || f.ino === '0')
                continue;
            const rec = recordMap.get(f.path);
            if (!rec || rec.localIno)
                continue;
            const updated = { ...rec, localDev: f.dev, localIno: f.ino };
            updates.push(updated);
            recordMap.set(f.path, updated);
        }
        if (updates.length > 0) {
            this.db.upsertFileStateBatch(updates);
            console.log(`[SyncEngine][${this.mapping.mappingId}] backfill inode: ${updates.length} 条记录已补全`);
        }
    }
    /**
     * 当未生成 rename/move 计划时，打印可能被路径对账误判为 upload 的 inode 移动线索。
     */
    logInodeDetectionGaps(localFiles, records, plans) {
        if (plans.length > 0)
            return;
        const inodeToEntry = new Map();
        for (const f of localFiles) {
            if (f.ino && f.ino !== '0')
                inodeToEntry.set(`${f.dev}:${f.ino}`, f);
        }
        let gapCount = 0;
        for (const rec of records) {
            if (!rec.localDev || !rec.localIno || rec.localIno === '0' || !rec.remoteFileId)
                continue;
            const entry = inodeToEntry.get(`${rec.localDev}:${rec.localIno}`);
            if (!entry || entry.path === rec.localPath)
                continue;
            gapCount++;
            if (gapCount <= 10) {
                console.warn(`[SyncEngine][${this.mapping.mappingId}] inode 移动未生成计划（将走路径对账 upload/delete）: ` +
                    `"${rec.localPath}" -> "${entry.path}" remoteFileId=${rec.remoteFileId}`);
            }
        }
        if (gapCount > 10) {
            console.warn(`[SyncEngine][${this.mapping.mappingId}] 另有 ${gapCount - 10} 条 inode 移动未生成计划`);
        }
    }
    buildFolderPathToRemoteId(records, rootFileId) {
        const m = new Map();
        m.set('', rootFileId);
        // 优先从 sync_folder_state 加载（权威来源）
        const folderStates = this.db.getAllFolderStates(this.mapping.mappingId);
        for (const fs of folderStates) {
            m.set(fs.localPath, fs.remoteFolderId);
        }
        // 兜底：从文件记录中提取未覆盖的目录
        for (const r of records) {
            if (!r.remoteFolderId)
                continue;
            const dir = r.localPath.includes('/')
                ? r.localPath.slice(0, r.localPath.lastIndexOf('/'))
                : '';
            if (!m.has(dir)) {
                m.set(dir, r.remoteFolderId);
            }
        }
        return m;
    }
    /**
     * 上传/下载成功后，将文件的直接父目录写入 sync_folder_state（如尚不存在）。
     * 仅写直接父目录（该目录的 folderId 已从上传结果中获得），祖先由后续上传自然填充。
     */
    persistFileFolderState(filePath, remoteFolderId) {
        if (!remoteFolderId)
            return;
        const dir = filePath.includes('/')
            ? filePath.slice(0, filePath.lastIndexOf('/'))
            : '';
        if (!dir)
            return; // 根目录不记
        const existing = this.db.getFolderState(this.mapping.mappingId, dir);
        if (existing)
            return;
        this.db.upsertFolderState({
            mappingId: this.mapping.mappingId,
            localPath: dir,
            remoteFolderId,
        });
    }
    /**
     * 打印 inode 对账阶段生成的计划明细（用于排查目录被拆散、冲突自动改名等问题）。
     */
    logRenamePlans(plans) {
        if (plans.length === 0)
            return;
        const maxPlanLogs = 30;
        const shown = plans.slice(0, maxPlanLogs);
        for (const [i, p] of shown.entries()) {
            const base = `[SyncEngine][${this.mapping.mappingId}] inode-plan#${i + 1}/${plans.length}` +
                ` op=${p.op} dir=${p.isDirectory ? 'Y' : 'N'}` +
                ` from="${p.fromPath ?? ''}" to="${p.path}"`;
            if (p.isDirectory) {
                const samples = (p.affectedRecords ?? []).slice(0, 3).map((r) => r.localPath);
                console.log(`${base} oldDir="${p.directoryOldPath ?? ''}" newDir="${p.directoryNewPath ?? ''}"` +
                    ` remoteFolderFileId="${p.remoteFolderFileId ?? ''}" targetParentId="${p.targetParentId ?? ''}"` +
                    ` renameAfterMoveName="${p.renameAfterMoveName ?? ''}" newName="${p.newName ?? ''}"` +
                    ` affected=${p.affectedRecords?.length ?? 0} samples=${JSON.stringify(samples)}`);
            }
            else {
                console.log(`${base} remoteFileId="${p.record?.remoteFileId ?? ''}" targetParentId="${p.targetParentId ?? ''}"` +
                    ` renameAfterMoveName="${p.renameAfterMoveName ?? ''}" newName="${p.newName ?? ''}"`);
            }
        }
        if (plans.length > shown.length) {
            console.log(`[SyncEngine][${this.mapping.mappingId}] inode-plan 日志已截断: 仅展示 ${shown.length}/${plans.length}`);
        }
    }
    // ==================== 远端视图构建 ====================
    /**
     * 构建远端文件 Map，优先走增量路径，遇到无法解析的新目录降级全量。
     */
    async buildRemoteMap(lastSyncSince, prog, opts) {
        if (opts?.forceFullScan) {
            prog(`强制全量对账: ${opts.forceFullScanReason ?? '周期性校验'}`);
            return this.fullRemoteMap();
        }
        if (lastSyncSince !== undefined) {
            const sinceStr = new Date(lastSyncSince).toLocaleString('zh-CN');
            prog(`增量模式: since=${lastSyncSince} (${sinceStr})`);
            const result = await this.tryIncrementalRemoteMap(lastSyncSince, prog);
            if (result) {
                prog(`增量成功: 远端视图 ${result.map.size} 个文件`);
                return result;
            }
            prog('增量降级: 执行全量扫描...');
        }
        else {
            prog('无同步水位（首轮或上轮有失败），执行全量扫描...');
        }
        return this.fullRemoteMap();
    }
    /**
     * 增量路径：listChanges + batchGetMeta。
     * 若遇到无法解析路径的新增文件，返回 null 触发全量降级。
     */
    async tryIncrementalRemoteMap(since, prog) {
        const safeSince = since - constants_1.CHANGES_SAFETY_WINDOW_MS;
        const changesResult = await this.remoteFs.listAllChanges(safeSince);
        if (!changesResult.ok) {
            console.warn(`[SyncEngine][${this.mapping.mappingId}] listChanges 失败，降级全量:`, changesResult.error);
            return null;
        }
        const { items, serverTime } = changesResult.value;
        const newSince = serverTime ?? Date.now();
        prog(`增量变更: ${items.length} 条`);
        const upsertById = new Map();
        const deleteIds = new Set();
        for (const item of items) {
            const id = String(item.fileId);
            if (item.event === 'delete')
                deleteIds.add(id);
            else
                upsertById.set(id, item);
        }
        // 构建 fileId → record 索引（过滤 remoteFileId 为空的记录，避免空字符串键碰撞）
        const allRecords = this.db.getAllFileStates(this.mapping.mappingId);
        const fileIdToRecord = new Map(allRecords.filter((r) => r.remoteFileId).map((r) => [r.remoteFileId, r]));
        // 区分"已知"和"新增"
        const knownUpsertIds = [];
        const unknownUpsertIds = [];
        for (const id of upsertById.keys()) {
            if (fileIdToRecord.has(id))
                knownUpsertIds.push(id);
            else
                unknownUpsertIds.push(id);
        }
        prog(`变更分类: upsert已知=${knownUpsertIds.length} upsert新增=${unknownUpsertIds.length} delete=${deleteIds.size}`);
        // 尝试路径重建：通过已知 folderId → 路径 映射
        const folderIdToPath = new Map();
        folderIdToPath.set(this.remoteFs.getRootFileId(), '');
        for (const record of allRecords) {
            const parts = record.localPath.split('/');
            const folderPath = parts.length > 1 ? parts.slice(0, -1).join('/') : '';
            if (record.remoteFolderId) {
                folderIdToPath.set(record.remoteFolderId, folderPath);
            }
        }
        const resolvedNewFiles = [];
        const unresolvedIds = [];
        for (const id of unknownUpsertIds) {
            const item = upsertById.get(id);
            const parentId = item.parentId != null ? String(item.parentId) : '';
            const folderPath = folderIdToPath.get(parentId);
            if (folderPath !== undefined) {
                const safeName = (0, pathSanitize_1.sanitizePathSegment)(item.name ?? id);
                const filePath = folderPath ? `${folderPath}/${safeName}` : safeName;
                resolvedNewFiles.push({ id, path: filePath, item });
            }
            else {
                unresolvedIds.push(id);
            }
        }
        if (unresolvedIds.length > 0) {
            prog(`发现 ${unresolvedIds.length} 个文件位于全新目录，降级全量对账...`);
            return null;
        }
        // 过滤掉不匹配 filePatterns 的新增文件（如 .sql、.log 等）
        const filteredNewFiles = resolvedNewFiles.filter((f) => this.matchesSync(f.path));
        const skippedCount = resolvedNewFiles.length - filteredNewFiles.length;
        if (skippedCount > 0) {
            prog(`跳过 ${skippedCount} 个不匹配 filePatterns 的远端文件`);
        }
        if (filteredNewFiles.length > 0) {
            prog(`路径重建成功 ${filteredNewFiles.length} 个新文件: ${filteredNewFiles.map((f) => f.path).join(', ')}`);
        }
        // 构建最终 remoteMap
        const map = new Map();
        // 未变更的已知文件（过滤不匹配的）
        for (const record of allRecords) {
            const id = record.remoteFileId ?? '';
            if (deleteIds.has(id) || upsertById.has(id))
                continue;
            if (!this.matchesSync(record.localPath))
                continue;
            map.set(record.localPath, {
                path: record.localPath,
                name: record.localPath.split('/').pop() ?? record.localPath,
                mtime: record.remoteMtime ?? 0,
                remoteFileId: id,
                remoteFolderId: record.remoteFolderId ?? '',
            });
        }
        // 已知 upsert：刷新元数据 + 检测远端 rename/move
        const remoteMoveHints = [];
        if (knownUpsertIds.length > 0) {
            prog(`批量获取 ${knownUpsertIds.length} 个变更文件元数据...`);
            const metaMap = await this.remoteFs.batchGetMetaAll(knownUpsertIds);
            for (const id of knownUpsertIds) {
                const meta = metaMap.get(id);
                const record = fileIdToRecord.get(id);
                if (!meta || meta.deleted)
                    continue;
                if (!this.matchesSync(record.localPath))
                    continue;
                const newParentId = meta.parentId != null ? String(meta.parentId) : '';
                const newName = meta.name ?? '';
                const oldName = record.localPath.split('/').pop() ?? '';
                const oldParentId = record.remoteFolderId ?? '';
                // 检测远端 rename/move：parentId 或 name 发生变化
                let effectivePath = record.localPath;
                if (newParentId && oldParentId && (newParentId !== oldParentId || newName !== oldName)) {
                    // 推导新本地路径
                    const newFolderPath = folderIdToPath.get(newParentId);
                    if (newFolderPath !== undefined) {
                        const safeName = (0, pathSanitize_1.sanitizePathSegment)(newName);
                        effectivePath = newFolderPath ? `${newFolderPath}/${safeName}` : safeName;
                        const isMove = newParentId !== oldParentId;
                        remoteMoveHints.push({
                            fileId: id,
                            oldPath: record.localPath,
                            newPath: effectivePath,
                            isMove,
                            record,
                            newRemoteFolderId: newParentId,
                        });
                    }
                    else {
                        // 目标目录无法解析（新目录），降级全量
                        prog(`远端 move 目标目录无法解析 (parentId=${newParentId})，降级全量...`);
                        return null;
                    }
                }
                map.set(effectivePath, {
                    path: effectivePath,
                    name: newName || effectivePath.split('/').pop() || effectivePath,
                    mtime: meta.updateTime ?? (record.remoteMtime ?? 0),
                    remoteFileId: id,
                    remoteFolderId: newParentId || (record.remoteFolderId ?? ''),
                });
            }
        }
        // 路径重建的新文件（已过滤）
        for (const { id, path, item } of filteredNewFiles) {
            map.set(path, {
                path,
                name: item.name ?? path.split('/').pop() ?? path,
                mtime: item.updateTime ?? Date.now(),
                remoteFileId: id,
                remoteFolderId: item.parentId != null ? String(item.parentId) : '',
            });
        }
        this.removePathsUnderFileNodes(map, prog);
        return {
            map,
            newSince,
            fullScan: false,
            remoteDeltaCount: upsertById.size + deleteIds.size,
            remoteMoveHints: remoteMoveHints.length > 0 ? remoteMoveHints : undefined,
        };
    }
    /** 全量扫描（listDescendantFiles 分页） */
    async fullRemoteMap() {
        const newSince = Date.now();
        const remoteResult = await this.remoteFs.listFiles();
        if (!remoteResult.ok)
            throw new Error(`扫描远端失败: ${remoteResult.error}`);
        const map = new Map();
        for (const f of remoteResult.value)
            map.set(f.path, f);
        this.removePathsUnderFileNodes(map, (msg) => console.log(`[SyncEngine][${this.mapping.mappingId}] ${msg}`));
        // 全量扫描后批量持久化目录 → folderId 映射
        this.persistFolderStatesFromRemoteEntries(remoteResult.value);
        console.log(`[SyncEngine][${this.mapping.mappingId}] 全量扫描完成: ${map.size} 个文件，新水位=${newSince}`);
        return { map, newSince, fullScan: true };
    }
    /**
     * 全量扫描模式下，通过 remoteFileId 匹配 DB 中的已知记录来检测远端 rename/move。
     * 如果一个文件的 remoteFileId 在 DB 中存在，但其路径（map key）与 DB 中的 localPath 不同，
     * 说明该文件在远端被 rename 或 move 了。
     *
     * 还会尝试聚合多个同目录文件的路径变化为目录级 rename/move hint，
     * 以便 doRemoteMoveToLocal 可以一次 fs.rename 整个目录。
     */
    detectRemoteMovesFromFullScan(remoteMap, recordMap) {
        const fileIdToRecord = new Map();
        for (const record of recordMap.values()) {
            if (record.remoteFileId) {
                fileIdToRecord.set(record.remoteFileId, record);
            }
        }
        // 收集所有路径变更的文件
        const rawChanges = [];
        for (const [newPath, entry] of remoteMap) {
            if (!entry.remoteFileId)
                continue;
            const record = fileIdToRecord.get(entry.remoteFileId);
            if (!record)
                continue;
            if (record.localPath === newPath)
                continue;
            rawChanges.push({ oldPath: record.localPath, newPath, fileId: entry.remoteFileId, record });
        }
        if (rawChanges.length === 0)
            return [];
        // 尝试聚合为目录级 rename/move：
        // 如果多个文件共享 "oldDir → newDir" 的前缀变化，且数量覆盖 oldDir 下所有已知文件，
        // 则合并为一个目录级 hint（isDirectory=true）。
        const dirMoveGroups = new Map();
        for (const c of rawChanges) {
            const oldDir = c.oldPath.includes('/') ? c.oldPath.slice(0, c.oldPath.lastIndexOf('/')) : '';
            const newDir = c.newPath.includes('/') ? c.newPath.slice(0, c.newPath.lastIndexOf('/')) : '';
            if (!oldDir && !newDir) {
                // 根目录下的文件无法聚合为目录操作
                continue;
            }
            const key = `${oldDir}\0${newDir}`;
            if (!dirMoveGroups.has(key))
                dirMoveGroups.set(key, []);
            dirMoveGroups.get(key).push(c);
        }
        // 判定目录级移动：同一旧目录下的所有已知文件都匹配该变化模式
        const dirHints = [];
        const consumedFileIds = new Set();
        for (const [key, group] of dirMoveGroups) {
            const [oldDir, newDir] = key.split('\0');
            if (!oldDir)
                continue;
            // 统计 DB 中旧目录下的所有文件数
            let totalInOldDir = 0;
            for (const record of recordMap.values()) {
                if (record.localPath.startsWith(oldDir + '/'))
                    totalInOldDir++;
            }
            // 若覆盖率 >= 80%（允许少量文件独立移动或删除），视为目录级操作
            if (totalInOldDir > 0 && group.length >= totalInOldDir * 0.8 && group.length >= 2) {
                const isMove = oldDir.includes('/')
                    ? oldDir.slice(0, oldDir.lastIndexOf('/')) !== (newDir.includes('/') ? newDir.slice(0, newDir.lastIndexOf('/')) : '')
                    : newDir.includes('/');
                dirHints.push({
                    fileId: '', // 目录级无单一 fileId
                    oldPath: oldDir,
                    newPath: newDir,
                    isMove,
                    record: group[0].record, // 仅用于类型兼容
                    isDirectory: true,
                });
                for (const c of group)
                    consumedFileIds.add(c.fileId);
            }
        }
        // 剩余的单文件级 hints
        const fileHints = [];
        for (const c of rawChanges) {
            if (consumedFileIds.has(c.fileId))
                continue;
            const oldDir = c.oldPath.includes('/') ? c.oldPath.slice(0, c.oldPath.lastIndexOf('/')) : '';
            const newDir = c.newPath.includes('/') ? c.newPath.slice(0, c.newPath.lastIndexOf('/')) : '';
            fileHints.push({
                fileId: c.fileId,
                oldPath: c.oldPath,
                newPath: c.newPath,
                isMove: oldDir !== newDir,
                record: c.record,
                newRemoteFolderId: remoteMap.get(c.newPath)?.remoteFolderId,
            });
        }
        const allHints = [...dirHints, ...fileHints];
        if (allHints.length > 0) {
            console.log(`[SyncEngine][${this.mapping.mappingId}] 全量对账检测到远端 rename/move: ` +
                `${dirHints.length} 个目录级, ${fileHints.length} 个文件级`);
        }
        return allHints;
    }
    /**
     * 从远端文件列表中提取目录 → remoteFolderId 映射并批量写入 sync_folder_state。
     */
    persistFolderStatesFromRemoteEntries(entries) {
        const dirMap = new Map();
        for (const f of entries) {
            if (!f.remoteFolderId)
                continue;
            const dir = f.path.includes('/')
                ? f.path.slice(0, f.path.lastIndexOf('/'))
                : '';
            if (!dir)
                continue;
            if (!dirMap.has(dir)) {
                dirMap.set(dir, f.remoteFolderId);
            }
        }
        if (dirMap.size === 0)
            return;
        const states = [];
        for (const [localPath, remoteFolderId] of dirMap) {
            states.push({
                mappingId: this.mapping.mappingId,
                localPath,
                remoteFolderId,
            });
        }
        this.db.upsertFolderStateBatch(states);
        console.log(`[SyncEngine][${this.mapping.mappingId}] 全量扫描持久化 ${states.length} 条目录映射到 sync_folder_state`);
    }
    /**
     * 知识库允许「文件节点」下再挂文件；本地不能把同名路径既当文件又当目录。
     * 简单策略：保留祖先路径对应的文件，移除其下所有更深的路径条目。
     */
    removePathsUnderFileNodes(map, prog) {
        const shadowed = (0, pathSanitize_1.pathsShadowedByAncestorFiles)(map.keys());
        if (shadowed.size === 0)
            return;
        for (const p of shadowed) {
            map.delete(p);
        }
        prog(`跳过 ${shadowed.size} 条「父路径亦为文件」的子路径（无法在本地镜像，仅同步父文档）`);
        const sample = [...shadowed].slice(0, 15);
        for (const p of sample) {
            console.warn(`[SyncEngine][${this.mapping.mappingId}]   ↳ ${p}`);
        }
        if (shadowed.size > sample.length) {
            console.warn(`[SyncEngine][${this.mapping.mappingId}]   … 另有 ${shadowed.size - sample.length} 条未列出`);
        }
    }
    // ==================== 决策逻辑 ====================
    decide(_path, local, remote, record) {
        const dir = this.mapping.syncDirection ?? 'bidirectional';
        // 无历史记录：首次碰到
        if (!record) {
            if (local && !remote)
                return dir === 'pull' ? 'skip' : 'upload-new';
            if (!local && remote)
                return dir === 'push' ? 'skip' : 'download-new';
            if (local && remote) {
                if (dir === 'pull')
                    return 'download-update';
                if (dir === 'push')
                    return 'upload-update';
                // bidirectional 且无历史：用冲突策略决定
                const conflictWinner = this.mapping.conflictStrategy ?? 'local-wins';
                return conflictWinner === 'local-wins' ? 'upload-update' : 'download-update';
            }
            return 'skip';
        }
        // 双端均消失
        if (!local && !remote)
            return 'skip';
        // 本地缺失，远端存在
        if (!local && remote) {
            if (dir === 'push')
                return 'skip';
            const remoteChanged = remote.mtime > (record.remoteMtime ?? 0) + constants_1.MTIME_TOLERANCE_MS;
            if (remoteChanged)
                return 'download-update';
            const RECENTLY_SYNCED_THRESHOLD_MS = 10 * 60 * 1000;
            if (record.syncStatus === 'done' &&
                record.remoteFileId &&
                record.lastSyncAt &&
                Date.now() - record.lastSyncAt < RECENTLY_SYNCED_THRESHOLD_MS) {
                return 'skip';
            }
            return 'delete-remote';
        }
        // 本地存在，远端缺失
        if (local && !remote) {
            if (dir === 'pull')
                return 'skip';
            const localChanged = local.mtime > (record.localMtime ?? 0) + constants_1.MTIME_TOLERANCE_MS;
            if (localChanged)
                return 'upload-new';
            // 安全阈值：如果文件是最近刚同步成功的（10 分钟内），不因一次全量列表为空就删本地。
            // 防止 KB 接口延迟、uploadContent 目录冲突等导致 listDescendantFiles 暂时看不到文件。
            const RECENTLY_SYNCED_THRESHOLD_MS = 10 * 60 * 1000;
            if (record.syncStatus === 'done' &&
                record.remoteFileId &&
                record.lastSyncAt &&
                Date.now() - record.lastSyncAt < RECENTLY_SYNCED_THRESHOLD_MS) {
                return 'skip';
            }
            return 'delete-local';
        }
        // 双端均存在
        if (local && remote) {
            const localChanged = local.mtime > (record.localMtime ?? 0) + constants_1.MTIME_TOLERANCE_MS;
            const remoteChanged = remote.mtime > (record.remoteMtime ?? 0) + constants_1.MTIME_TOLERANCE_MS;
            if (!localChanged && !remoteChanged)
                return 'skip';
            if (localChanged && !remoteChanged)
                return dir === 'pull' ? 'skip' : 'upload-update';
            if (!localChanged && remoteChanged)
                return dir === 'push' ? 'skip' : 'download-update';
            // 双端均变更 — 冲突
            if (dir === 'pull')
                return 'download-update';
            if (dir === 'push')
                return 'upload-update';
            // bidirectional: 使用配置的冲突策略（不再跨时钟比 mtime）
            const conflictWinner = this.mapping.conflictStrategy ?? 'local-wins';
            return conflictWinner === 'local-wins' ? 'upload-update' : 'download-update';
        }
        return 'skip';
    }
    // ==================== 计划执行 ====================
    /**
     * 按 concurrency 分批并发执行计划列表，批间插入 EXECUTE_BATCH_PAUSE_MS 的间隔。
     * 真正的请求限速由 KbApiClient 内置的 RateLimiter 负责，这里的 pause 只是平滑突发。
     */
    async executePlansInQueue(plans, concurrency, label, prog) {
        const total = plans.length;
        for (let i = 0; i < total; i += concurrency) {
            const chunk = plans.slice(i, i + concurrency);
            await Promise.all(chunk.map((p) => this.executePlan(p)));
            const done = Math.min(i + concurrency, total);
            prog(`${label} ${done}/${total}...`);
            // 批间 pause：给限速器补充令牌，同时平滑磁盘/网络压力
            if (done < total) {
                await this.delay(constants_1.EXECUTE_BATCH_PAUSE_MS);
            }
        }
    }
    /**
     * @param remoteMap 可选：rename/move 执行后需同步更新远端视图，保持路径对账视图一致性
     */
    async executePlan(plan, remoteMap) {
        const { path, local, remote, record, op } = plan;
        try {
            // 执行前 re-check：验证本地文件状态未在计划生成后发生变化
            if (op === 'upload-new' || op === 'upload-update' || op === 'delete-local') {
                const currentMtime = await this.localFs.getMtime(path);
                if (op === 'delete-local') {
                    if (currentMtime === null) {
                        // 文件已被用户删除 → skip
                        this.stats.skipped++;
                        return;
                    }
                    if (local && Math.abs(currentMtime - local.mtime) > constants_1.MTIME_TOLERANCE_MS) {
                        // 文件在计划生成后又被修改 → 不应删除
                        this.stats.skipped++;
                        return;
                    }
                }
                else {
                    if (currentMtime === null) {
                        // 文件在计划生成后被删除 → skip
                        this.stats.skipped++;
                        return;
                    }
                    if (local && Math.abs(currentMtime - local.mtime) > constants_1.MTIME_TOLERANCE_MS) {
                        // 文件在计划生成后又被修改 → skip 等下一轮
                        this.stats.skipped++;
                        return;
                    }
                }
            }
            switch (op) {
                case 'upload-new':
                    await this.doUploadNew(path, local);
                    break;
                case 'upload-update':
                    await this.doUploadUpdate(path, local, record, remote);
                    break;
                case 'download-new':
                    await this.doDownloadNew(path, remote);
                    break;
                case 'download-update':
                    await this.doDownloadUpdate(path, remote, record);
                    break;
                case 'delete-local':
                    await this.doDeleteLocal(path, record);
                    break;
                case 'delete-remote':
                    await this.doDeleteRemote(path, record);
                    break;
                case 'rename-remote':
                    if (plan.isDirectory) {
                        await this.doRenameRemoteDirectory(plan, remoteMap);
                    }
                    else {
                        await this.doRenameRemote(plan, remoteMap);
                    }
                    break;
                case 'move-remote':
                    if (plan.isDirectory) {
                        await this.doMoveRemoteDirectory(plan, remoteMap);
                    }
                    else {
                        await this.doMoveRemote(plan, remoteMap);
                    }
                    break;
                case 'skip':
                    // skip 计数已在 runSync 中批量累加，此处不重复计数
                    break;
            }
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            const errno = e instanceof Error && 'code' in e ? String(e.code) : '';
            const localAbsPath = nodePath.join(this.localFs.getRoot(), nodePath.normalize(path.replace(/\//g, nodePath.sep)));
            this.stats.failed++;
            this.stats.errors.push(`${path}: ${msg}`);
            console.error(`[SyncEngine][${this.mapping.mappingId}] 同步失败 rel=${path} op=${op}${errno ? ` syscallCode=${errno}` : ''}\n` +
                `  localAbsPath: ${localAbsPath}\n` +
                `  error: ${msg}`);
            const failRecords = plan.isDirectory && plan.affectedRecords?.length
                ? plan.affectedRecords
                : record
                    ? [record]
                    : [];
            for (const r of failRecords) {
                this.db.upsertFileState({
                    ...r,
                    syncStatus: 'failed',
                    lastError: msg,
                    lastSyncAt: Date.now(),
                });
            }
        }
    }
    // ==================== 具体操作 ====================
    async doUploadNew(path, local) {
        const content = await this.localFs.readFile(path);
        const result = await this.remoteFs.createFile(path, content);
        if (!result.ok)
            throw new Error(result.error);
        const now = Date.now();
        this.db.upsertFileState({
            mappingId: this.mapping.mappingId,
            localPath: path,
            remoteFileId: result.value.remoteFileId,
            remoteFolderId: result.value.remoteFolderId,
            localMtime: local.mtime,
            remoteMtime: now + constants_1.MTIME_TOLERANCE_MS,
            localDev: local.dev,
            localIno: local.ino,
            remoteRelativePath: path,
            syncStatus: 'done',
            lastSyncAt: now,
            lastError: null,
        });
        this.persistFileFolderState(path, result.value.remoteFolderId);
        this.stats.uploaded++;
        this.progress(`↑ ${path}`);
    }
    async doUploadUpdate(path, local, record, remote) {
        // 优先用本轮远端列表的 fileId（远端为权威）；SQLite 里可能是旧 id，会导致 upload 报「文件信息查询失败」
        const remoteFileId = remote?.remoteFileId ?? record?.remoteFileId;
        if (!remoteFileId) {
            throw new Error('upload-update 缺少远端 fileId（状态库无该路径且远端映射无 fileId，请先全量对账）');
        }
        const content = await this.localFs.readFile(path);
        const fileName = path.split('/').pop() ?? path;
        const result = await this.remoteFs.updateFile(remoteFileId, fileName, content);
        if (!result.ok)
            throw new Error(result.error);
        const now = Date.now();
        const folderId = remote?.remoteFolderId ?? record?.remoteFolderId ?? '';
        const next = record
            ? {
                ...record,
                remoteFileId,
                remoteFolderId: folderId,
                localMtime: local.mtime,
                remoteMtime: now + constants_1.MTIME_TOLERANCE_MS,
                localDev: local.dev,
                localIno: local.ino,
                remoteRelativePath: path,
                syncStatus: 'done',
                lastSyncAt: now,
                lastError: null,
            }
            : {
                mappingId: this.mapping.mappingId,
                localPath: path,
                remoteFileId,
                remoteFolderId: folderId,
                localMtime: local.mtime,
                remoteMtime: now + constants_1.MTIME_TOLERANCE_MS,
                contentHash: null,
                localDev: local.dev,
                localIno: local.ino,
                remoteRelativePath: path,
                syncStatus: 'done',
                lastSyncAt: now,
                lastError: null,
            };
        this.db.upsertFileState(next);
        this.persistFileFolderState(path, folderId);
        this.stats.uploaded++;
        this.progress(`↑ ${path}`);
    }
    async doDownloadNew(path, remote) {
        this.notePullLocalTouch(path);
        const body = await this.fetchContent(remote.remoteFileId);
        const actualMtime = await this.localFs.writeFile(path, body);
        this.db.upsertFileState({
            mappingId: this.mapping.mappingId,
            localPath: path,
            remoteFileId: remote.remoteFileId,
            remoteFolderId: remote.remoteFolderId,
            localMtime: actualMtime,
            remoteMtime: remote.mtime,
            syncStatus: 'done',
            lastSyncAt: Date.now(),
            lastError: null,
        });
        this.persistFileFolderState(path, remote.remoteFolderId);
        this.stats.downloaded++;
        this.progress(`↓ ${path}`);
    }
    async doDownloadUpdate(path, remote, record) {
        this.notePullLocalTouch(path);
        const body = await this.fetchContent(remote.remoteFileId);
        const actualMtime = await this.localFs.writeFile(path, body);
        const now = Date.now();
        if (record) {
            this.db.upsertFileState({
                ...record,
                localMtime: actualMtime,
                remoteMtime: remote.mtime,
                syncStatus: 'done',
                lastSyncAt: now,
                lastError: null,
            });
        }
        else {
            this.db.upsertFileState({
                mappingId: this.mapping.mappingId,
                localPath: path,
                remoteFileId: remote.remoteFileId,
                remoteFolderId: remote.remoteFolderId,
                localMtime: actualMtime,
                remoteMtime: remote.mtime,
                contentHash: null,
                syncStatus: 'done',
                lastSyncAt: now,
                lastError: null,
            });
        }
        this.stats.downloaded++;
        this.progress(`↓ ${path}`);
    }
    /**
     * 远端 rename/move → 本地 fs.rename + 更新 DB。
     * - 文件级：rename 单个文件，更新该文件的 DB 记录。
     * - 目录级：rename 整个目录，批量更新 DB 中所有相关文件/文件夹记录的路径前缀。
     */
    async doRemoteMoveToLocal(hint, prog) {
        const { oldPath, newPath, isMove } = hint;
        if (hint.isDirectory) {
            return this.doRemoteDirMoveToLocal(hint, prog);
        }
        const { record } = hint;
        try {
            const oldExists = await this.localFs.exists(oldPath);
            if (!oldExists) {
                console.warn(`[SyncEngine][${this.mapping.mappingId}] 远端 ${isMove ? 'move' : 'rename'}-local 跳过: 本地旧文件不存在 "${oldPath}"`);
                return;
            }
            const newExists = await this.localFs.exists(newPath);
            if (newExists) {
                console.warn(`[SyncEngine][${this.mapping.mappingId}] 远端 ${isMove ? 'move' : 'rename'}-local 跳过: 目标路径已存在 "${newPath}"`);
                return;
            }
            await this.localFs.rename(oldPath, newPath);
            this.notePullLocalTouch(oldPath, newPath);
            this.db.deleteFileState(this.mapping.mappingId, oldPath);
            this.db.upsertFileState({
                ...record,
                localPath: newPath,
                remoteFolderId: hint.newRemoteFolderId ?? record.remoteFolderId,
                remoteRelativePath: newPath,
                syncStatus: 'done',
                lastSyncAt: Date.now(),
                lastError: null,
            });
            const opLabel = isMove ? '→' : '↻';
            prog(`${opLabel} 远端${isMove ? '移动' : '重命名'}→本地 ${oldPath} → ${newPath}`);
            if (isMove) {
                this.stats.moved = (this.stats.moved ?? 0) + 1;
            }
            else {
                this.stats.renamed = (this.stats.renamed ?? 0) + 1;
            }
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            console.error(`[SyncEngine][${this.mapping.mappingId}] 远端 ${isMove ? 'move' : 'rename'}-local 失败: ${oldPath} → ${newPath}: ${msg}`);
            this.stats.failed++;
            this.stats.errors.push(`${oldPath}→${newPath}: ${msg}`);
        }
    }
    /**
     * 目录级远端 rename/move → 本地。
     * 整棵子树用一次 fs.rename，然后批量更新 sync_file_state 和 sync_folder_state 中的路径前缀。
     */
    async doRemoteDirMoveToLocal(hint, prog) {
        const { oldPath, newPath, isMove } = hint;
        try {
            const oldExists = await this.localFs.exists(oldPath);
            if (!oldExists) {
                console.warn(`[SyncEngine][${this.mapping.mappingId}] 远端目录 ${isMove ? 'move' : 'rename'}-local 跳过: 本地旧目录不存在 "${oldPath}"`);
                return;
            }
            const newExists = await this.localFs.exists(newPath);
            if (newExists) {
                console.warn(`[SyncEngine][${this.mapping.mappingId}] 远端目录 ${isMove ? 'move' : 'rename'}-local 跳过: 目标路径已存在 "${newPath}"`);
                return;
            }
            await this.localFs.rename(oldPath, newPath);
            for (const r of this.db.getAllFileStates(this.mapping.mappingId)) {
                const p = r.localPath;
                if (p === oldPath || p.startsWith(`${oldPath}/`)) {
                    this.notePullLocalTouch(p, `${newPath}${p.slice(oldPath.length)}`);
                }
            }
            this.notePullLocalTouch(oldPath, newPath);
            // 批量更新 sync_file_state 中该目录前缀下的所有文件路径
            this.db.renameFilePaths(this.mapping.mappingId, oldPath, newPath);
            // 批量更新 sync_folder_state 中该目录前缀下的所有文件夹路径
            this.db.renameFolderPaths(this.mapping.mappingId, oldPath, newPath);
            const opLabel = isMove ? '→' : '↻';
            const affectedCount = this.db.getAllFileStates(this.mapping.mappingId)
                .filter((r) => r.localPath.startsWith(newPath + '/') || r.localPath === newPath).length;
            prog(`${opLabel} 远端目录${isMove ? '移动' : '重命名'}→本地 ${oldPath} → ${newPath}（影响 ${affectedCount} 个文件）`);
            if (isMove) {
                this.stats.moved = (this.stats.moved ?? 0) + 1;
            }
            else {
                this.stats.renamed = (this.stats.renamed ?? 0) + 1;
            }
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            console.error(`[SyncEngine][${this.mapping.mappingId}] 远端目录 ${isMove ? 'move' : 'rename'}-local 失败: ${oldPath} → ${newPath}: ${msg}`);
            this.stats.failed++;
            this.stats.errors.push(`dir ${oldPath}→${newPath}: ${msg}`);
        }
    }
    async doDeleteLocal(path, record) {
        this.notePullLocalTouch(path);
        const absPath = this.localFs.resolve(path);
        await (0, trashBin_1.moveToTrash)(absPath, this.mapping.mappingId, path);
        this.db.deleteFileState(this.mapping.mappingId, path);
        this.stats.deleted++;
        this.progress(`✗ 本地删除(→回收站) ${path}`);
        void record;
    }
    async doDeleteRemote(path, record) {
        const result = await this.remoteFs.deleteFile(record.remoteFileId);
        if (!result.ok)
            throw new Error(result.error);
        this.db.deleteFileState(this.mapping.mappingId, path);
        this.stats.deleted++;
        this.progress(`✗ 远端删除 ${path}`);
    }
    /**
     * 目录级 rename-remote：对文件夹 fileId 调用一次 updateFileName，并批量更新子文件 state。
     * 同父目录下改名（如 dirA → dirB）时使用，不涉及 moveFile。
     */
    async doRenameRemoteDirectory(plan, remoteMap) {
        const { directoryOldPath = '', directoryNewPath = '', remoteFolderFileId, newName, affectedRecords = [], } = plan;
        if (!remoteFolderFileId || !newName) {
            throw new Error('rename-remote(目录) 缺少 remoteFolderFileId 或 newName');
        }
        console.log(`[SyncEngine][${this.mapping.mappingId}] dir-rename request:` +
            ` fileId=${remoteFolderFileId} oldDir="${directoryOldPath}" newDir="${directoryNewPath}"` +
            ` newName="${newName}" strategy=${this.resolveRenameConflictStrategy()}` +
            ` affected=${affectedRecords.length}`);
        const result = await this.remoteFs.renameFile({
            fileId: remoteFolderFileId,
            newName,
            nameConflictStrategy: this.resolveRenameConflictStrategy(),
        });
        if (!result.ok)
            throw new Error(result.error);
        console.log(`[SyncEngine][${this.mapping.mappingId}] dir-rename response:` +
            ` fileId=${result.value.fileId} name="${result.value.name}"` +
            ` relativePath="${result.value.relativePath ?? ''}" updateTime=${result.value.updateTime}` +
            ` renamedDueToConflict=${result.value.renamedDueToConflict === true ? 'Y' : 'N'}`);
        if (result.value.renamedDueToConflict) {
            console.warn(`[SyncEngine][${this.mapping.mappingId}] 目录 rename-remote 因冲突自动改名: ` +
                `请求=${newName} 实际=${result.value.name}`);
        }
        const now = Date.now();
        for (const rec of affectedRecords) {
            const oldPath = rec.localPath;
            const suffix = directoryOldPath ? oldPath.slice(directoryOldPath.length + 1) : oldPath;
            const newPath = directoryNewPath ? `${directoryNewPath}/${suffix}` : suffix;
            this.db.deleteFileState(this.mapping.mappingId, oldPath);
            this.db.upsertFileState({
                ...rec,
                localPath: newPath,
                // updateFileName 不会改变文件的 remoteFileId / remoteFolderId / 内容 mtime 基线
                remoteMtime: rec.remoteMtime,
                remoteRelativePath: newPath,
                syncStatus: 'done',
                lastSyncAt: now,
                lastError: null,
            });
            if (remoteMap) {
                const oldEntry = remoteMap.get(oldPath);
                remoteMap.delete(oldPath);
                if (oldEntry) {
                    remoteMap.set(newPath, { ...oldEntry, path: newPath });
                }
            }
        }
        // 更新 sync_folder_state：重命名旧路径前缀为新路径
        this.db.renameFolderPaths(this.mapping.mappingId, directoryOldPath, directoryNewPath);
        this.stats.renamed = (this.stats.renamed ?? 0) + 1;
        this.progress(`↻ 远端重命名目录 ${directoryOldPath} → ${directoryNewPath}（${affectedRecords.length} 个文件，1 次 updateFileName）`);
    }
    /**
     * 执行远端重命名（同目录内改名）。
     * 成功后：删除旧 DB 记录，以新路径写入新 DB 记录，并同步更新 remoteMap。
     */
    resolveRenameConflictStrategy() {
        return this.mapping.renameNameConflictStrategy ?? constants_1.DEFAULT_RENAME_NAME_CONFLICT_STRATEGY;
    }
    resolveMoveConflictStrategy() {
        return this.mapping.moveNameConflictStrategy ?? constants_1.DEFAULT_MOVE_NAME_CONFLICT_STRATEGY;
    }
    /** 从 moveFile 最小契约收集 id 映射（normalizeMoveFileResult 已保证 idChanged 时有 mappings） */
    collectMoveIdMappings(result) {
        if (!result.idChanged)
            return [];
        return (result.idMappings ?? []).map((m) => ({
            sourceFileId: String(m.sourceFileId),
            targetFileId: String(m.targetFileId),
        }));
    }
    async doRenameRemote(plan, remoteMap) {
        const { path: toPath, fromPath, newName, record, local } = plan;
        if (!record?.remoteFileId || !fromPath || !newName) {
            throw new Error(`rename-remote 缺少必要字段 fromPath=${fromPath} newName=${newName}`);
        }
        const result = await this.remoteFs.renameFile({
            fileId: record.remoteFileId,
            newName,
            nameConflictStrategy: this.resolveRenameConflictStrategy(),
        });
        if (!result.ok)
            throw new Error(result.error);
        const finalPath = result.value.relativePath ?? toPath;
        const now = Date.now();
        this.db.deleteFileState(this.mapping.mappingId, fromPath);
        this.db.upsertFileState({
            ...record,
            localPath: toPath,
            remoteFileId: String(result.value.fileId),
            // 保留 rename 前的 mtime 基线，供 Phase2 检测同轮内容变更
            localMtime: record.localMtime,
            remoteMtime: record.remoteMtime,
            localDev: local?.dev ?? record.localDev,
            localIno: local?.ino ?? record.localIno,
            remoteRelativePath: finalPath,
            syncStatus: 'done',
            lastSyncAt: now,
            lastError: null,
        });
        if (remoteMap) {
            const oldEntry = remoteMap.get(fromPath);
            remoteMap.delete(fromPath);
            if (oldEntry) {
                remoteMap.set(toPath, { ...oldEntry, path: toPath, name: result.value.name });
            }
        }
        if (result.value.renamedDueToConflict) {
            console.warn(`[SyncEngine][${this.mapping.mappingId}] rename-remote 因冲突自动改名: 请求=${newName} 实际=${result.value.name}`);
        }
        this.stats.renamed = (this.stats.renamed ?? 0) + 1;
        this.progress(`↻ 远端重命名 ${fromPath} → ${toPath}`);
    }
    /**
     * 执行远端移动（跨目录移动，可同时改名）。
     * targetParentId 为空时降级为 delete-remote + upload-new（退化路径）。
     * 成功后：处理 idMappings，删除旧 DB 记录，以新路径写入新 DB 记录，更新 remoteMap。
     */
    async doMoveRemote(plan, remoteMap) {
        let { path: toPath, fromPath, targetParentId, renameAfterMoveName, record, local } = plan;
        if (!record?.remoteFileId || !fromPath) {
            throw new Error(`move-remote 缺少必要字段 fromPath=${fromPath}`);
        }
        // 目标目录尚未创建时，先创建再 move
        if (!targetParentId) {
            const targetDir = toPath.includes('/') ? toPath.slice(0, toPath.lastIndexOf('/')) : '';
            if (targetDir) {
                console.log(`[SyncEngine][${this.mapping.mappingId}] move-remote: 目标目录不存在，尝试创建 "${targetDir}"`);
                const resolveResult = await this.remoteFs.resolveFolderIdForLocalDir(targetDir, true);
                if (resolveResult.ok) {
                    targetParentId = resolveResult.value;
                    this.db.upsertFolderState({
                        mappingId: this.mapping.mappingId,
                        localPath: targetDir,
                        remoteFolderId: targetParentId,
                    });
                }
            }
            if (!targetParentId) {
                console.warn(`[SyncEngine][${this.mapping.mappingId}] move-remote 降级为 delete+upload: ` +
                    `无法解析/创建目标目录 dir="${targetDir}"`);
                await this.doDeleteRemote(fromPath, record);
                await this.doUploadNew(toPath, local);
                return;
            }
        }
        const moveStrategy = this.resolveMoveConflictStrategy();
        const moveResult = await this.remoteFs.moveFile({
            fileId: record.remoteFileId,
            targetParentId,
            nameConflictStrategy: moveStrategy,
        });
        if (!moveResult.ok)
            throw new Error(moveResult.error);
        const mv = moveResult.value;
        if (mv.mainSkipped === true) {
            const msg = `move-remote 主节点因冲突被跳过: ${fromPath} → ${toPath}`;
            console.warn(`[SyncEngine][${this.mapping.mappingId}] ${msg}`);
            this.stats.errors.push(msg);
            return;
        }
        const idMappings = this.collectMoveIdMappings(mv);
        if (idMappings.length > 0) {
            this.db.applyRemoteIdMappings(this.mapping.mappingId, idMappings);
            console.log(`[SyncEngine][${this.mapping.mappingId}] move-remote 已应用 ${idMappings.length} 条 idMappings`);
        }
        let finalFileId = String(mv.fileId);
        let finalName = mv.name;
        let finalRelativePath = mv.relativePath ?? toPath;
        let finalParentId = mv.parentId != null ? String(mv.parentId) : targetParentId;
        // 换目录且改名：先 move（保留原名），再 updateFileName（不传 moveFile.newName）
        if (renameAfterMoveName) {
            const renameResult = await this.remoteFs.renameFile({
                fileId: finalFileId,
                newName: renameAfterMoveName,
                nameConflictStrategy: this.resolveRenameConflictStrategy(),
            });
            if (!renameResult.ok)
                throw new Error(renameResult.error);
            finalFileId = String(renameResult.value.fileId);
            finalName = renameResult.value.name;
            if (renameResult.value.relativePath) {
                finalRelativePath = renameResult.value.relativePath;
            }
        }
        const now = Date.now();
        this.db.deleteFileState(this.mapping.mappingId, fromPath);
        this.db.upsertFileState({
            ...record,
            localPath: toPath,
            remoteFileId: finalFileId,
            remoteFolderId: finalParentId,
            localMtime: record.localMtime,
            remoteMtime: record.remoteMtime,
            localDev: local?.dev ?? record.localDev,
            localIno: local?.ino ?? record.localIno,
            remoteRelativePath: finalRelativePath,
            syncStatus: 'done',
            lastSyncAt: now,
            lastError: null,
        });
        if (remoteMap) {
            const oldEntry = remoteMap.get(fromPath);
            remoteMap.delete(fromPath);
            if (oldEntry) {
                remoteMap.set(toPath, {
                    ...oldEntry,
                    path: toPath,
                    name: finalName,
                    remoteFileId: finalFileId,
                    remoteFolderId: finalParentId,
                });
            }
        }
        this.stats.moved = (this.stats.moved ?? 0) + 1;
        this.progress(`→ 远端移动 ${fromPath} → ${toPath}`);
    }
    /**
     * 目录级 move-remote：对文件夹 fileId 调用一次 moveFile，并批量更新子文件 state。
     */
    async doMoveRemoteDirectory(plan, remoteMap) {
        const { directoryOldPath = '', directoryNewPath = '', remoteFolderFileId, targetParentId, renameAfterMoveName, affectedRecords = [], } = plan;
        if (!remoteFolderFileId || !targetParentId) {
            throw new Error('move-remote(目录) 缺少 remoteFolderFileId 或 targetParentId');
        }
        console.log(`[SyncEngine][${this.mapping.mappingId}] dir-move request:` +
            ` fileId=${remoteFolderFileId} oldDir="${directoryOldPath}" newDir="${directoryNewPath}"` +
            ` targetParentId=${targetParentId} strategy=${this.resolveMoveConflictStrategy()}` +
            ` renameAfterMoveName="${renameAfterMoveName ?? ''}" affected=${affectedRecords.length}`);
        const moveResult = await this.remoteFs.moveFile({
            fileId: remoteFolderFileId,
            targetParentId,
            nameConflictStrategy: this.resolveMoveConflictStrategy(),
        });
        if (!moveResult.ok)
            throw new Error(moveResult.error);
        const mv = moveResult.value;
        console.log(`[SyncEngine][${this.mapping.mappingId}] dir-move response:` +
            ` sourceFileId=${mv.sourceFileId} fileId=${mv.fileId} idChanged=${mv.idChanged ? 'Y' : 'N'}` +
            ` name="${mv.name}" parentId="${mv.parentId}" relativePath="${mv.relativePath ?? ''}"` +
            ` mainSkipped=${mv.mainSkipped === true ? 'Y' : 'N'} idMappings=${mv.idMappings?.length ?? 0}`);
        if (mv.mainSkipped === true) {
            const msg = `目录 move-remote 因冲突被跳过: ${directoryOldPath} → ${directoryNewPath}`;
            console.warn(`[SyncEngine][${this.mapping.mappingId}] ${msg}`);
            this.stats.errors.push(msg);
            return;
        }
        const idMappings = this.collectMoveIdMappings(mv);
        if (idMappings.length > 0) {
            this.db.applyRemoteIdMappings(this.mapping.mappingId, idMappings);
        }
        let folderFileId = String(mv.fileId);
        if (renameAfterMoveName) {
            console.log(`[SyncEngine][${this.mapping.mappingId}] dir-move follow-up rename request:` +
                ` fileId=${folderFileId} newName="${renameAfterMoveName}" strategy=${this.resolveRenameConflictStrategy()}`);
            const renameResult = await this.remoteFs.renameFile({
                fileId: folderFileId,
                newName: renameAfterMoveName,
                nameConflictStrategy: this.resolveRenameConflictStrategy(),
            });
            if (!renameResult.ok)
                throw new Error(renameResult.error);
            folderFileId = String(renameResult.value.fileId);
            console.log(`[SyncEngine][${this.mapping.mappingId}] dir-move follow-up rename response:` +
                ` fileId=${renameResult.value.fileId} name="${renameResult.value.name}"` +
                ` relativePath="${renameResult.value.relativePath ?? ''}" updateTime=${renameResult.value.updateTime}` +
                ` renamedDueToConflict=${renameResult.value.renamedDueToConflict === true ? 'Y' : 'N'}`);
        }
        const idLookup = new Map(idMappings.map((m) => [m.sourceFileId, m.targetFileId]));
        const now = Date.now();
        let mappingLogCount = 0;
        const maxMappingLogs = 20;
        for (const rec of affectedRecords) {
            const oldPath = rec.localPath;
            const suffix = directoryOldPath
                ? oldPath.slice(directoryOldPath.length + 1)
                : oldPath;
            const newPath = directoryNewPath ? `${directoryNewPath}/${suffix}` : suffix;
            // 通过 idMappings 映射 remoteFileId（COVER 策略时文件 id 可能改变）
            const mappedRemoteId = rec.remoteFileId
                ? idLookup.get(rec.remoteFileId) ?? rec.remoteFileId
                : rec.remoteFileId;
            // remoteFolderId：保留原值，仅在 COVER 策略导致父目录 id 改变时通过 idMappings 更新。
            // 不能统一设为 folderFileId：嵌套子目录中的文件的直接父目录并非顶层移动目录。
            const mappedFolderId = rec.remoteFolderId
                ? idLookup.get(rec.remoteFolderId) ?? rec.remoteFolderId
                : rec.remoteFolderId;
            if (mappingLogCount < maxMappingLogs) {
                console.log(`[SyncEngine][${this.mapping.mappingId}] dir-move map#${mappingLogCount + 1}/${affectedRecords.length}:` +
                    ` old="${oldPath}" new="${newPath}"` +
                    ` fileId=${rec.remoteFileId ?? ''}->${mappedRemoteId ?? ''}` +
                    ` folderId=${rec.remoteFolderId ?? ''}->${mappedFolderId ?? ''}`);
                mappingLogCount++;
            }
            this.db.deleteFileState(this.mapping.mappingId, oldPath);
            this.db.upsertFileState({
                ...rec,
                localPath: newPath,
                remoteFileId: mappedRemoteId,
                remoteFolderId: mappedFolderId,
                remoteMtime: rec.remoteMtime,
                remoteRelativePath: newPath,
                syncStatus: 'done',
                lastSyncAt: now,
                lastError: null,
            });
            if (remoteMap) {
                const oldEntry = remoteMap.get(oldPath);
                remoteMap.delete(oldPath);
                if (oldEntry) {
                    remoteMap.set(newPath, {
                        ...oldEntry,
                        path: newPath,
                        remoteFileId: mappedRemoteId ?? oldEntry.remoteFileId,
                        remoteFolderId: mappedFolderId ?? oldEntry.remoteFolderId,
                    });
                }
            }
        }
        if (affectedRecords.length > maxMappingLogs) {
            console.log(`[SyncEngine][${this.mapping.mappingId}] dir-move 文件映射日志已截断: 仅展示 ${maxMappingLogs}/${affectedRecords.length}`);
        }
        // 更新 sync_folder_state：旧路径前缀 → 新路径前缀
        this.db.renameFolderPaths(this.mapping.mappingId, directoryOldPath, directoryNewPath);
        this.stats.moved = (this.stats.moved ?? 0) + 1;
        this.progress(`→ 远端移动目录 ${directoryOldPath} → ${directoryNewPath}（${affectedRecords.length} 个文件，1 次 moveFile）`);
    }
    /** 拉取单个文件内容，由 KbApiClient 内置限速器控制请求速率 */
    async fetchContent(remoteFileId) {
        const r = await this.remoteFs.readFile(remoteFileId);
        if (!r.ok)
            throw new Error(`下载失败: ${r.error}`);
        if (!r.value) {
            console.warn(`[SyncEngine] fileId=${remoteFileId} 返回空内容，写入空文件`);
            return '';
        }
        return r.value;
    }
}
exports.SyncEngine = SyncEngine;
//# sourceMappingURL=syncEngine.js.map