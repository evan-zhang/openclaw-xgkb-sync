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
const constants_1 = require("./constants");
const pathSanitize_1 = require("./pathSanitize");
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
    emptyStats() {
        return {
            uploaded: 0,
            downloaded: 0,
            deleted: 0,
            prunedRemoteDirs: 0,
            skipped: 0,
            failed: 0,
            errors: [],
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
        const prog = (msg) => {
            console.log(`[SyncEngine][${this.mapping.mappingId}] ${msg}`);
            this.progress(msg);
        };
        prog('扫描本地文件...');
        const localFiles = await this.localFs.listFiles();
        prog(`本地: ${localFiles.length} 个文件`);
        const { map: remoteMap, newSince, remoteDeltaCount, fullScan } = await this.buildRemoteMap(lastSyncSince, prog, opts);
        prog(`远端: ${remoteMap.size} 个文件（水位 ${newSince}）`);
        this.stats.newSince = newSince;
        this.stats.fullScan = fullScan;
        const localMap = new Map(localFiles.map((f) => [f.path, f]));
        // 一次性批量加载所有文件状态，供决策循环 O(1) 查找，避免 N 次独立 SQLite 查询
        const recordMap = new Map(this.db.getAllFileStates(this.mapping.mappingId).map((r) => [r.localPath, r]));
        // 增量快速通道：远端0变更时，仅检查本地是否有变化
        // 若本地也无新增/修改/删除，则所有路径必然是 skip，直接跳过决策循环
        if (remoteDeltaCount === 0) {
            const hasLocalNew = localFiles.some((f) => !recordMap.has(f.path));
            const hasLocalModified = localFiles.some((f) => (recordMap.get(f.path)?.localMtime ?? -1) + constants_1.MTIME_TOLERANCE_MS < f.mtime);
            const hasLocalDeleted = [...recordMap.keys()].some((p) => !localMap.has(p));
            if (!hasLocalNew && !hasLocalModified && !hasLocalDeleted) {
                const totalPaths = new Set([...localMap.keys(), ...remoteMap.keys()]).size;
                this.stats.skipped += totalPaths;
                await this.pruneRemoteEmptyDirectories(prog);
                prog(`增量无变化（远端0变更，本地无新增/修改/删除），跳过决策，共跳过 ${totalPaths} 个路径`);
                return this.stats;
            }
            prog(`远端0变更，但本地有变化（new=${hasLocalNew} mod=${hasLocalModified} del=${hasLocalDeleted}），继续决策`);
        }
        const allPaths = new Set([...localMap.keys(), ...remoteMap.keys()]);
        prog(`共 ${allPaths.size} 个路径需要决策`);
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
            await this.executePlan(plan);
        }
        const hasRemoteDelete = deletePlans.some((p) => p.op === 'delete-remote');
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
        await this.pruneRemoteEmptyDirectories(prog, {
            hadRemoteDelete: hasRemoteDelete,
            reason: hasRemoteDelete ? '远端文件删除后的目录整理' : undefined,
        });
        prog(`完成: ↑${this.stats.uploaded} ↓${this.stats.downloaded} ✗${this.stats.deleted}` +
            ` 空目录清理:${this.stats.prunedRemoteDirs ?? 0} fail:${this.stats.failed} skip:${this.stats.skipped}`);
        return this.stats;
    }
    async pruneRemoteEmptyDirectories(prog, opts) {
        const dir = this.mapping.syncDirection ?? 'bidirectional';
        if (dir === 'pull')
            return;
        if (!opts?.hadRemoteDelete)
            return;
        if (opts.reason) {
            prog(`开始清理远端空目录（${opts.reason}）...`);
        }
        const localDirs = new Set(await this.localFs.listDirectories());
        const result = await this.remoteFs.pruneEmptyDirectories(localDirs);
        if (!result.ok) {
            this.stats.failed++;
            this.stats.errors.push(`清理远端空目录失败: ${result.error}`);
            prog(`清理远端空目录失败: ${result.error}`);
            return;
        }
        this.stats.prunedRemoteDirs = (this.stats.prunedRemoteDirs ?? 0) + result.value.deleted;
        if (result.value.failed > 0) {
            this.stats.failed += result.value.failed;
            this.stats.errors.push(...result.value.errors);
        }
        if (result.value.deleted > 0 || result.value.failed > 0) {
            prog(`远端空目录清理: 删除=${result.value.deleted} 失败=${result.value.failed}`);
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
        const addRemoteEntry = (entry) => {
            const existing = map.get(entry.path);
            if (existing && existing.remoteFileId !== entry.remoteFileId) {
                prog(`发现远端路径冲突 "${entry.path}"（fileId=${existing.remoteFileId} / ${entry.remoteFileId}），降级全量对账...`);
                return false;
            }
            map.set(entry.path, entry);
            return true;
        };
        // 未变更的已知文件（过滤不匹配的）
        for (const record of allRecords) {
            const id = record.remoteFileId ?? '';
            if (deleteIds.has(id) || upsertById.has(id))
                continue;
            if (!this.matchesSync(record.localPath))
                continue;
            if (!addRemoteEntry({
                path: record.localPath,
                name: record.localPath.split('/').pop() ?? record.localPath,
                mtime: record.remoteMtime ?? 0,
                remoteFileId: id,
                remoteFolderId: record.remoteFolderId ?? '',
            }))
                return null;
        }
        // 已知 upsert：刷新元数据（过滤不匹配的）
        if (knownUpsertIds.length > 0) {
            prog(`批量获取 ${knownUpsertIds.length} 个变更文件元数据...`);
            const metaMap = await this.remoteFs.batchGetMetaAll(knownUpsertIds);
            const missingMetaIds = knownUpsertIds.filter((id) => !metaMap.has(id));
            if (missingMetaIds.length > 0) {
                prog(`有 ${missingMetaIds.length} 个已知变更文件未取到元数据，降级全量对账，避免误判删除...`);
                return null;
            }
            for (const id of knownUpsertIds) {
                const meta = metaMap.get(id);
                const record = fileIdToRecord.get(id);
                if (!meta || meta.deleted)
                    continue;
                if (!this.matchesSync(record.localPath))
                    continue;
                if (!addRemoteEntry({
                    path: record.localPath,
                    name: meta.name ?? record.localPath.split('/').pop() ?? record.localPath,
                    mtime: meta.updateTime ?? (record.remoteMtime ?? 0),
                    remoteFileId: id,
                    remoteFolderId: meta.parentId != null ? String(meta.parentId) : (record.remoteFolderId ?? ''),
                }))
                    return null;
            }
        }
        // 路径重建的新文件（已过滤）
        for (const { id, path, item } of filteredNewFiles) {
            if (!addRemoteEntry({
                path,
                name: item.name ?? path.split('/').pop() ?? path,
                mtime: item.updateTime ?? Date.now(),
                remoteFileId: id,
                remoteFolderId: item.parentId != null ? String(item.parentId) : '',
            }))
                return null;
        }
        this.removePathsUnderFileNodes(map, prog);
        return { map, newSince, fullScan: false, remoteDeltaCount: upsertById.size + deleteIds.size };
    }
    /** 全量扫描（listDescendantFiles 分页） */
    async fullRemoteMap() {
        // 先记录水位再扫描：确保扫描期间发生的变更在下一轮 listChanges 中不会被跳过
        const newSince = Date.now();
        const remoteResult = await this.remoteFs.listFiles();
        if (!remoteResult.ok)
            throw new Error(`扫描远端失败: ${remoteResult.error}`);
        const map = new Map();
        for (const f of remoteResult.value)
            map.set(f.path, f);
        this.removePathsUnderFileNodes(map, (msg) => console.log(`[SyncEngine][${this.mapping.mappingId}] ${msg}`));
        console.log(`[SyncEngine][${this.mapping.mappingId}] 全量扫描完成: ${map.size} 个文件，新水位=${newSince}`);
        return { map, newSince, fullScan: true };
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
                return local.mtime >= remote.mtime ? 'upload-update' : 'download-update';
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
            return remoteChanged ? 'download-update' : 'delete-remote';
        }
        // 本地存在，远端缺失
        if (local && !remote) {
            if (dir === 'pull')
                return 'skip';
            const localChanged = local.mtime > (record.localMtime ?? 0) + constants_1.MTIME_TOLERANCE_MS;
            return localChanged ? 'upload-new' : 'delete-local';
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
            // 双端均变更（LWW）
            if (dir === 'pull')
                return 'download-update';
            if (dir === 'push')
                return 'upload-update';
            return local.mtime >= remote.mtime ? 'upload-update' : 'download-update';
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
    async executePlan(plan) {
        const { path, local, remote, record, op } = plan;
        try {
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
            // 记录失败状态（保留原 record，仅标记 failed）
            if (record) {
                this.db.upsertFileState({
                    ...record,
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
        // remoteMtime 加 MTIME_TOLERANCE_MS 作为缓冲：
        // uploadContent 不返回服务端实际 mtime，用客户端时间 + 容差，
        // 确保下轮增量时 remote.mtime <= record.remoteMtime，不触发虚假 download。
        const now = Date.now();
        this.db.upsertFileState({
            mappingId: this.mapping.mappingId,
            localPath: path,
            remoteFileId: result.value.remoteFileId,
            remoteFolderId: result.value.remoteFolderId,
            localMtime: local.mtime,
            remoteMtime: now + constants_1.MTIME_TOLERANCE_MS,
            syncStatus: 'done',
            lastSyncAt: now,
            lastError: null,
        });
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
        const nextRemoteFileId = result.value || remoteFileId;
        const next = record
            ? {
                ...record,
                remoteFileId: nextRemoteFileId,
                remoteFolderId: remote?.remoteFolderId ?? record.remoteFolderId ?? '',
                localMtime: local.mtime,
                remoteMtime: now + constants_1.MTIME_TOLERANCE_MS,
                syncStatus: 'done',
                lastSyncAt: now,
                lastError: null,
            }
            : {
                mappingId: this.mapping.mappingId,
                localPath: path,
                remoteFileId: nextRemoteFileId,
                remoteFolderId: remote?.remoteFolderId ?? '',
                localMtime: local.mtime,
                remoteMtime: now + constants_1.MTIME_TOLERANCE_MS,
                contentHash: null,
                syncStatus: 'done',
                lastSyncAt: now,
                lastError: null,
            };
        this.db.upsertFileState(next);
        this.stats.uploaded++;
        this.progress(`↑ ${path}`);
    }
    async doDownloadNew(path, remote) {
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
        this.stats.downloaded++;
        this.progress(`↓ ${path}`);
    }
    async doDownloadUpdate(path, remote, record) {
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
    async doDeleteLocal(path, record) {
        await this.localFs.deleteFile(path);
        this.db.deleteFileState(this.mapping.mappingId, path);
        this.stats.deleted++;
        this.progress(`✗ 本地删除 ${path}`);
        void record; // record 已被 deleteFileState 移除
    }
    async doDeleteRemote(path, record) {
        const result = await this.remoteFs.deleteFile(record.remoteFileId);
        if (!result.ok)
            throw new Error(result.error);
        this.db.deleteFileState(this.mapping.mappingId, path);
        this.stats.deleted++;
        this.progress(`✗ 远端删除 ${path}`);
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