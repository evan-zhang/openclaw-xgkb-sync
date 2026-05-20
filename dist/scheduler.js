"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SyncScheduler = void 0;
exports.resolveMaxConcurrentMappings = resolveMaxConcurrentMappings;
const kbApi_1 = require("./kbApi");
const localFs_1 = require("./localFs");
const rateLimiter_1 = require("./rateLimiter");
const remoteFs_1 = require("./remoteFs");
const syncEngine_1 = require("./syncEngine");
const syncStateDb_1 = require("./syncStateDb");
const constants_1 = require("./constants");
function resolveMaxConcurrentMappings(config) {
    const enabledMappings = config.mappings.filter((m) => m.enabled);
    if (enabledMappings.length === 0)
        return 0;
    if (config.maxConcurrentMappingsMode === 'manual') {
        return Math.max(1, config.maxConcurrentMappings ?? constants_1.DEFAULT_MAX_CONCURRENT_MAPPINGS);
    }
    const appKeySet = new Set(enabledMappings.map((m) => (m.appKey ?? config.appKey ?? '').trim()).filter(Boolean));
    const allUseIndependentKeys = appKeySet.size >= enabledMappings.length;
    if (enabledMappings.length <= 2)
        return enabledMappings.length;
    if (allUseIndependentKeys)
        return Math.min(5, enabledMappings.length);
    return Math.min(3, enabledMappings.length);
}
/**
 * 多 Mapping 同步调度器
 * - 同一 mappingId 严格串行（防重入）
 * - 不同 mappingId 可受控并发（maxConcurrentMappings）
 * - 定时触发 + 手动触发双路径
 */
class SyncScheduler {
    config;
    db;
    /** 按 appKey 分组的限速器，每个 appKey 独享自己的令牌桶 */
    limiters = new Map();
    runStates = new Map();
    mappingQueue = [];
    queuedMappingIds = new Set();
    timers = [];
    activeMappingRuns = 0;
    running = false;
    constructor(config) {
        this.config = config;
        const dbPath = config.stateDbPath ?? constants_1.DEFAULT_DB_PATH;
        this.db = new syncStateDb_1.SyncStateDb(dbPath);
        console.log(`[Scheduler] 状态库: ${dbPath}`);
    }
    /**
     * 按 appKey 获取或创建对应的限速器。
     * 同一 appKey 的所有请求共享一个令牌桶，不同 appKey 互不干扰。
     */
    getLimiter(appKey) {
        if (!this.limiters.has(appKey)) {
            const rpm = this.config.maxRequestsPerMinute ?? constants_1.DEFAULT_MAX_REQUESTS_PER_MINUTE;
            const burst = this.config.rateLimitBurst ?? constants_1.DEFAULT_RATE_LIMIT_BURST;
            const cooldownMs = (this.config.rateLimitCooldownSec ?? constants_1.RATE_LIMIT_COOLDOWN_MS / 1000) * 1000;
            const limiter = new rateLimiter_1.RateLimiter({
                requestsPerMinute: rpm,
                burst,
                cooldownMs,
                label: `KbApi(${appKey.slice(0, 8)}…)`,
            });
            this.limiters.set(appKey, limiter);
            console.log(`[Scheduler] 新建限速器 appKey=${appKey.slice(0, 8)}… ${rpm} req/min 突发=${burst} 冷却=${cooldownMs / 1000}s`);
        }
        return this.limiters.get(appKey);
    }
    /** 启动调度器：注册定时器，并立即触发一轮全量对账 */
    start() {
        if (this.running)
            return;
        this.running = true;
        const enabledMappings = this.config.mappings.filter((m) => m.enabled);
        console.log(`[Scheduler] 启动，映射规则: ${enabledMappings.length} 条，自动同步间隔: ${this.config.autoSyncIntervalSec}s`);
        for (const mapping of enabledMappings) {
            this.runStates.set(mapping.mappingId, { isSyncing: false, pendingSync: false });
        }
        // 启动后加随机抖动再触发首次同步，分散多实例同时启动的请求突刺
        const jitterMaxMs = (this.config.startupJitterMaxSec ?? constants_1.STARTUP_JITTER_MAX_MS / 1000) * 1000;
        const jitterMs = jitterMaxMs > 0 ? Math.floor(Math.random() * jitterMaxMs) : 0;
        if (jitterMs > 500) {
            console.log(`[Scheduler] 启动抖动 ${Math.round(jitterMs / 1000)}s，首次同步约在 ${new Date(Date.now() + jitterMs).toLocaleTimeString('zh-CN')} 开始`);
            const timer = setTimeout(() => this.triggerAll('启动后初始同步'), jitterMs);
            this.timers.push(timer);
        }
        else {
            this.triggerAll('启动后初始同步');
        }
        const intervalSec = this.config.autoSyncIntervalSec;
        if (intervalSec > 0) {
            const timer = setInterval(() => {
                this.triggerAll('定时同步');
            }, intervalSec * 1000);
            this.timers.push(timer);
            console.log(`[Scheduler] 定时器已注册，间隔 ${intervalSec}s`);
        }
    }
    /** 停止调度器，清理定时器和数据库连接 */
    stop() {
        this.running = false;
        for (const t of this.timers)
            clearInterval(t);
        this.timers = [];
        this.limiters.clear();
        this.mappingQueue.length = 0;
        this.queuedMappingIds.clear();
        this.activeMappingRuns = 0;
        this.db.close();
        console.log('[Scheduler] 已停止');
    }
    /** 手动触发指定 mapping 同步 */
    triggerMapping(mappingId) {
        const mapping = this.config.mappings.find((m) => m.mappingId === mappingId && m.enabled);
        if (!mapping) {
            console.warn(`[Scheduler] 未找到或未启用的 mapping: ${mappingId}`);
            return;
        }
        this.scheduleMapping(mapping);
    }
    /** 触发所有已启用 mapping */
    triggerAll(reason) {
        const enabledMappings = this.config.mappings.filter((m) => m.enabled);
        console.log(`[Scheduler] 触发全部同步（${reason}），共 ${enabledMappings.length} 条`);
        for (const mapping of enabledMappings) {
            this.scheduleMapping(mapping);
        }
    }
    scheduleMapping(mapping) {
        let state = this.runStates.get(mapping.mappingId);
        if (!state) {
            state = { isSyncing: false, pendingSync: false };
            this.runStates.set(mapping.mappingId, state);
        }
        if (state.isSyncing) {
            state.pendingSync = true;
            console.log(`[Scheduler][${mapping.mappingId}] 已在同步中，标记为待执行`);
            return;
        }
        const maxConcurrent = resolveMaxConcurrentMappings(this.config);
        if (this.activeMappingRuns >= maxConcurrent) {
            state.pendingSync = true;
            if (!this.queuedMappingIds.has(mapping.mappingId)) {
                this.mappingQueue.push(mapping);
                this.queuedMappingIds.add(mapping.mappingId);
                console.log(`[Scheduler][${mapping.mappingId}] 已加入同步队列（运行中 ${this.activeMappingRuns}/${maxConcurrent}）`);
            }
            return;
        }
        this.startMappingSync(mapping, state);
    }
    startMappingSync(mapping, state) {
        this.activeMappingRuns++;
        this.runMappingSync(mapping, state).catch((e) => {
            console.error(`[Scheduler][${mapping.mappingId}] 意外异常:`, e);
        });
    }
    async runMappingSync(mapping, state) {
        state.isSyncing = true;
        state.pendingSync = false;
        try {
            await this.doSync(mapping);
        }
        finally {
            state.isSyncing = false;
            this.activeMappingRuns = Math.max(0, this.activeMappingRuns - 1);
            // 若同步期间有新触发，再执行一轮
            if (state.pendingSync) {
                state.pendingSync = false;
                console.log(`[Scheduler][${mapping.mappingId}] 执行待挂起的同步`);
                this.scheduleMapping(mapping);
            }
            this.drainMappingQueue();
        }
    }
    drainMappingQueue() {
        if (!this.running)
            return;
        const maxConcurrent = resolveMaxConcurrentMappings(this.config);
        while (this.activeMappingRuns < maxConcurrent && this.mappingQueue.length > 0) {
            const mapping = this.mappingQueue.shift();
            this.queuedMappingIds.delete(mapping.mappingId);
            const state = this.runStates.get(mapping.mappingId);
            if (!state || state.isSyncing)
                continue;
            state.pendingSync = false;
            this.startMappingSync(mapping, state);
        }
    }
    async doSync(mapping) {
        console.log(`[Scheduler][${mapping.mappingId}] ===== 开始同步 =====`);
        console.log(`  localRoot: ${mapping.localRoot}`);
        console.log(`  projectId: ${mapping.projectId}  remoteRootFileId: ${mapping.remoteRootFileId}`);
        // 读取上次同步状态（含水位 + 已缓存的远端 ID，一次查询复用）
        const mappingState = this.db.getMappingState(mapping.mappingId);
        const lastSyncSince = mappingState?.lastSyncSince != null ? mappingState.lastSyncSince : undefined;
        const fullReconcileIntervalSec = this.config.fullReconcileIntervalSec ?? constants_1.DEFAULT_FULL_RECONCILE_INTERVAL_SEC;
        const forceFullScan = this.shouldForceFullScan(mappingState, fullReconcileIntervalSec);
        const isIncremental = lastSyncSince !== undefined && !forceFullScan.force;
        const sinceStr = lastSyncSince
            ? new Date(lastSyncSince).toLocaleString('zh-CN')
            : '无（首次全量）';
        console.log(`[Scheduler][${mapping.mappingId}] 模式=${isIncremental ? '增量' : '全量'} lastSyncSince=${sinceStr}`);
        if (forceFullScan.force) {
            console.log(`[Scheduler][${mapping.mappingId}] 强制全量对账原因: ${forceFullScan.reason}`);
        }
        const effectiveAppKey = (mapping.appKey ?? this.config.appKey ?? '').trim();
        const limiter = this.getLimiter(effectiveAppKey);
        const api = new kbApi_1.KbApiClient(this.config.serverUrl, effectiveAppKey, limiter);
        if (mapping.appKey?.trim()) {
            console.log(`[Scheduler][${mapping.mappingId}] 使用 mapping 独立 appKey（身份隔离），独立限速器`);
        }
        const localFs = new localFs_1.LocalFsAdapter(mapping.localRoot, mapping.filePatterns, mapping.excludePatterns);
        const remoteFs = new remoteFs_1.RemoteFsAdapter(api, {
            projectId: mapping.projectId,
            remoteRootFileId: mapping.remoteRootFileId,
            remoteRootFolderPath: mapping.remoteRootFolderPath,
            // 仅当显式配置了 remoteRootFileId 时才传缓存（此时 init() 内显式配置优先级更高，传不传无影响）。
            // 若用户靠 remoteRootFolderPath 解析，则每次启动重新解析，确保路径修改后立即生效。
            cachedRootFileId: mapping.remoteRootFileId
                ? (mappingState?.resolvedRootFileId ?? undefined)
                : undefined,
            // 同理：projectId 显式配置时才传缓存；未配置时每次重新 getPersonalProjectId()。
            cachedProjectId: mapping.projectId
                ? (mappingState?.resolvedProjectId ?? undefined)
                : undefined,
            filePatterns: mapping.filePatterns,
            excludePatterns: mapping.excludePatterns,
        });
        // init() 解析并返回确定的 projectId / rootFileId，写回 SQLite 缓存
        const initResult = await remoteFs.init();
        if (!initResult.ok) {
            const msg = `远端初始化失败: ${initResult.error}`;
            console.error(`[Scheduler][${mapping.mappingId}] ${msg}`);
            this.db.upsertMappingState({ mappingId: mapping.mappingId, lastError: msg });
            return;
        }
        const resolved = initResult.value;
        this.db.upsertMappingState({
            mappingId: mapping.mappingId,
            resolvedRootFileId: resolved.rootFileId,
            resolvedProjectId: resolved.projectId,
        });
        console.log(`[Scheduler][${mapping.mappingId}] 远端初始化完成: projectId=${resolved.projectId} rootFileId=${resolved.rootFileId} path="${resolved.rootFolderPath}"`);
        const engine = new syncEngine_1.SyncEngine(localFs, remoteFs, this.db, { ...mapping, syncDirection: mapping.syncDirection ?? this.config.syncDirection }, {
            downloadConcurrency: this.config.downloadConcurrency ?? constants_1.DOWNLOAD_CONCURRENCY,
            uploadConcurrency: this.config.uploadConcurrency ?? constants_1.UPLOAD_CONCURRENCY,
        });
        let stats;
        try {
            stats = await engine.runSync((msg) => console.log(`  [${mapping.mappingId}] ${msg}`), lastSyncSince, {
                forceFullScan: forceFullScan.force,
                forceFullScanReason: forceFullScan.reason,
            });
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            console.error(`[Scheduler][${mapping.mappingId}] 同步异常:`, msg);
            this.db.upsertMappingState({
                mappingId: mapping.mappingId,
                lastError: msg,
            });
            return;
        }
        // 仅在无系统性失败时推进水位
        if (stats.failed === 0 && stats.newSince) {
            this.db.upsertMappingState({
                mappingId: mapping.mappingId,
                lastSyncSince: stats.newSince,
                lastServerTime: stats.newSince,
                lastSuccessAt: Date.now(),
                ...(stats.fullScan ? { lastFullScanAt: Date.now() } : {}),
                lastError: null,
                lastStats: stats,
            });
            console.log(`[Scheduler][${mapping.mappingId}] 水位已推进: ${stats.newSince} (${new Date(stats.newSince).toLocaleString('zh-CN')})`);
        }
        else if (stats.failed > 0) {
            const errSummary = stats.errors.slice(0, 3).join('; ');
            this.db.upsertMappingState({
                mappingId: mapping.mappingId,
                lastError: `${stats.failed} 个文件失败: ${errSummary}`,
                lastStats: stats,
            });
            console.warn(`[Scheduler][${mapping.mappingId}] 存在 ${stats.failed} 个失败文件，水位未推进，下轮将重试`);
        }
        console.log(`[Scheduler][${mapping.mappingId}] ===== 同步完成 ↑${stats.uploaded} ↓${stats.downloaded} ✗${stats.deleted} fail:${stats.failed} =====`);
    }
    /** 获取当前生效的配置（供 ManagementApi 读取） */
    getConfig() {
        return this.config;
    }
    shouldForceFullScan(mappingState, intervalSec) {
        if (intervalSec <= 0)
            return { force: false };
        if (!mappingState?.lastSyncSince)
            return { force: false };
        if (!mappingState.lastFullScanAt) {
            return { force: true, reason: '尚未记录成功的全量对账' };
        }
        const elapsedMs = Date.now() - mappingState.lastFullScanAt;
        if (elapsedMs >= intervalSec * 1000) {
            return {
                force: true,
                reason: `距上次全量对账已 ${Math.round(elapsedMs / 1000)}s，超过配置间隔 ${intervalSec}s`,
            };
        }
        return { force: false };
    }
    /**
     * 完全重置指定 mapping 的同步状态（文件记录 + 水位 + 远端 ID 缓存）。
     * 修改身份字段（localRoot / remoteRootFolderPath / projectId / appKey）后调用，
     * 确保下次同步以全量对账模式重建正确基准，而非用旧状态做错误决策。
     */
    resetMappingState(mappingId) {
        this.db.resetMappingState(mappingId);
        console.log(`[Scheduler] 已重置 mapping 同步状态: ${mappingId}`);
    }
    /** 获取所有 mapping 的当前状态摘要 */
    getStatus() {
        const result = {};
        for (const [mappingId, runState] of this.runStates) {
            result[mappingId] = {
                isSyncing: runState.isSyncing,
                pendingSync: runState.pendingSync,
                lastState: this.db.getMappingState(mappingId),
            };
        }
        return result;
    }
}
exports.SyncScheduler = SyncScheduler;
//# sourceMappingURL=scheduler.js.map