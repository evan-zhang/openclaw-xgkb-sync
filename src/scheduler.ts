import { KbApiClient } from './kbApi';
import { FileWatcher } from './fileWatcher';
import { LocalFsAdapter } from './localFs';
import { RateLimiter } from './rateLimiter';
import { RemoteFsAdapter, RemoteFsInitResult } from './remoteFs';
import { SyncEngine } from './syncEngine';
import { SyncStateDb } from './syncStateDb';
import { SyncConfig, SyncMapping, SyncStats, SyncTriggerReason } from './types';
import {
  DEFAULT_DB_PATH,
  DEFAULT_EXCLUDE_PATTERNS,
  DEFAULT_FILE_PATTERNS,
  DEFAULT_FULL_RECONCILE_INTERVAL_SEC,
  DEFAULT_MAX_CONCURRENT_MAPPINGS,
  DEFAULT_MAX_REQUESTS_PER_MINUTE,
  DEFAULT_RATE_LIMIT_BURST,
  DOWNLOAD_CONCURRENCY,
  RATE_LIMIT_COOLDOWN_MS,
  STARTUP_JITTER_MAX_MS,
  UPLOAD_CONCURRENCY,
} from './constants';
import {
  formatSyncTriggerReason,
  resolvePushDebounceMs,
  resolveWatchEnabled,
  resolveWatchUsePolling,
} from './watchHelpers';

interface MappingRunState {
  isSyncing: boolean;
  /** 当前正在同步时收到新触发，完成后立刻再执行一轮 */
  pendingSync: boolean;
  /** 挂起同步的触发来源（watch 优先于 timer） */
  pendingReason?: SyncTriggerReason;
  lastTriggerReason?: SyncTriggerReason;
  /** 最近一次由 watch 触发的本地时间戳（毫秒） */
  lastWatchTriggerAt?: number;
}

export function resolveMaxConcurrentMappings(config: SyncConfig): number {
  const enabledMappings = config.mappings.filter((m) => m.enabled);
  if (enabledMappings.length === 0) return 0;

  if (config.maxConcurrentMappingsMode === 'manual') {
    return Math.max(1, config.maxConcurrentMappings ?? DEFAULT_MAX_CONCURRENT_MAPPINGS);
  }

  const appKeySet = new Set(
    enabledMappings.map((m) => (m.appKey ?? config.appKey ?? '').trim()).filter(Boolean),
  );
  const allUseIndependentKeys = appKeySet.size >= enabledMappings.length;

  if (enabledMappings.length <= 2) return enabledMappings.length;
  if (allUseIndependentKeys) return Math.min(5, enabledMappings.length);
  return Math.min(3, enabledMappings.length);
}

/**
 * 多 Mapping 同步调度器
 * - 同一 mappingId 严格串行（防重入）
 * - 不同 mappingId 可受控并发（maxConcurrentMappings）
 * - 定时触发 + 手动触发双路径
 */
export class SyncScheduler {
  private readonly config: SyncConfig;
  private readonly db: SyncStateDb;
  /** 按 appKey 分组的限速器，每个 appKey 独享自己的令牌桶 */
  private readonly limiters = new Map<string, RateLimiter>();
  private readonly runStates = new Map<string, MappingRunState>();
  private readonly watchers = new Map<string, FileWatcher>();
  private timers: NodeJS.Timeout[] = [];
  private running = false;

  constructor(config: SyncConfig) {
    this.config = config;
    const dbPath = config.stateDbPath ?? DEFAULT_DB_PATH;
    this.db = new SyncStateDb(dbPath);
    console.log(`[Scheduler] 状态库: ${dbPath}`);
  }

  /**
   * 按 appKey 获取或创建对应的限速器。
   * 同一 appKey 的所有请求共享一个令牌桶，不同 appKey 互不干扰。
   */
  private getLimiter(appKey: string): RateLimiter {
    if (!this.limiters.has(appKey)) {
      const rpm = this.config.maxRequestsPerMinute ?? DEFAULT_MAX_REQUESTS_PER_MINUTE;
      const burst = this.config.rateLimitBurst ?? DEFAULT_RATE_LIMIT_BURST;
      const cooldownMs = (this.config.rateLimitCooldownSec ?? RATE_LIMIT_COOLDOWN_MS / 1000) * 1000;
      const limiter = new RateLimiter({
        requestsPerMinute: rpm,
        burst,
        cooldownMs,
        label: `KbApi(${appKey.slice(0, 8)}…)`,
      });
      this.limiters.set(appKey, limiter);
      console.log(
        `[Scheduler] 新建限速器 appKey=${appKey.slice(0, 8)}… ${rpm} req/min 突发=${burst} 冷却=${cooldownMs / 1000}s`,
      );
    }
    return this.limiters.get(appKey)!;
  }

  /** 启动调度器：注册定时器，并立即触发一轮全量对账 */
  start(): void {
    if (this.running) return;
    this.running = true;

    const enabledMappings = this.config.mappings.filter((m) => m.enabled);
    console.log(
      `[Scheduler] 启动，映射规则: ${enabledMappings.length} 条，自动同步间隔: ${this.config.autoSyncIntervalSec}s`,
    );

    for (const mapping of enabledMappings) {
      this.runStates.set(mapping.mappingId, { isSyncing: false, pendingSync: false });
    }

    this.startWatchers(enabledMappings);

    // 启动后加随机抖动再触发首次同步，分散多实例同时启动的请求突刺
    const jitterMaxMs =
      (this.config.startupJitterMaxSec ?? STARTUP_JITTER_MAX_MS / 1000) * 1000;
    const jitterMs = jitterMaxMs > 0 ? Math.floor(Math.random() * jitterMaxMs) : 0;
    if (jitterMs > 500) {
      console.log(
        `[Scheduler] 启动抖动 ${Math.round(jitterMs / 1000)}s，首次同步约在 ${new Date(Date.now() + jitterMs).toLocaleTimeString('zh-CN')} 开始`,
      );
      setTimeout(() => this.triggerAll('启动后初始同步', 'startup'), jitterMs);
    } else {
      this.triggerAll('启动后初始同步', 'startup');
    }

    const intervalSec = this.config.autoSyncIntervalSec;
    if (intervalSec > 0) {
      const timer = setInterval(() => {
        this.triggerAll('定时同步', 'timer');
      }, intervalSec * 1000);
      this.timers.push(timer);
      console.log(`[Scheduler] 定时器已注册，间隔 ${intervalSec}s`);
    }
  }

  /** 停止调度器，清理定时器和数据库连接 */
  stop(): void {
    this.running = false;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    void this.stopWatchers();
    this.limiters.clear();
    this.db.close();
    console.log('[Scheduler] 已停止');
  }

  private startWatchers(mappings: SyncMapping[]): void {
    for (const mapping of mappings) {
      if (!resolveWatchEnabled(mapping, this.config)) continue;

      const watcher = new FileWatcher({
        mappingId: mapping.mappingId,
        localRoot: mapping.localRoot,
        filePatterns: mapping.filePatterns ?? DEFAULT_FILE_PATTERNS,
        excludePatterns: mapping.excludePatterns ?? DEFAULT_EXCLUDE_PATTERNS,
        debounceMs: resolvePushDebounceMs(mapping, this.config),
        usePolling: resolveWatchUsePolling(mapping, this.config),
        onBatchReady: (pathCount) => {
          console.log(
            `[FileWatcher][${mapping.mappingId}] batch ${pathCount} path(s) → trigger sync`,
          );
          this.scheduleMapping(mapping, 'watch');
        },
      });
      watcher.start();
      this.watchers.set(mapping.mappingId, watcher);
    }

    if (this.watchers.size > 0) {
      console.log(`[Scheduler] 文件监听已启动: ${this.watchers.size} 条 mapping`);
    }
  }

  private async stopWatchers(): Promise<void> {
    const stops = [...this.watchers.values()].map((w) => w.stop());
    await Promise.all(stops);
    this.watchers.clear();
  }

  /** 手动触发指定 mapping 同步 */
  triggerMapping(mappingId: string): void {
    const mapping = this.config.mappings.find(
      (m) => m.mappingId === mappingId && m.enabled,
    );
    if (!mapping) {
      console.warn(`[Scheduler] 未找到或未启用的 mapping: ${mappingId}`);
      return;
    }
    this.scheduleMapping(mapping, 'manual');
  }

  /** 触发所有已启用 mapping */
  private triggerAll(reason: string, trigger: SyncTriggerReason): void {
    const enabledMappings = this.config.mappings.filter((m) => m.enabled);
    console.log(`[Scheduler] 触发全部同步（${reason}），共 ${enabledMappings.length} 条`);

    const maxConcurrent = resolveMaxConcurrentMappings(this.config);

    // 按并发度批次触发
    let queued = 0;
    for (const mapping of enabledMappings) {
      queued++;
      if (queued <= maxConcurrent) {
        this.scheduleMapping(mapping, trigger);
      } else {
        // 超出并发限制的，稍后触发
        setTimeout(() => this.scheduleMapping(mapping, trigger), (queued - maxConcurrent) * 500);
      }
    }
  }

  private scheduleMapping(
    mapping: SyncMapping,
    reason: SyncTriggerReason = 'manual',
  ): void {
    let state = this.runStates.get(mapping.mappingId);
    if (!state) {
      state = { isSyncing: false, pendingSync: false };
      this.runStates.set(mapping.mappingId, state);
    }

    if (state.isSyncing) {
      state.pendingSync = true;
      if (reason === 'watch' || state.pendingReason !== 'watch') {
        state.pendingReason = reason;
      }
      console.log(
        `[Scheduler][${mapping.mappingId}] 已在同步中，标记为待执行 (${formatSyncTriggerReason(reason)})`,
      );
      return;
    }

    state.lastTriggerReason = reason;
    if (reason === 'watch') {
      state.lastWatchTriggerAt = Date.now();
    }
    this.runMappingSync(mapping, state, reason).catch((e) => {
      console.error(`[Scheduler][${mapping.mappingId}] 意外异常:`, e);
    });
  }

  private async runMappingSync(
    mapping: SyncMapping,
    state: MappingRunState,
    reason: SyncTriggerReason,
  ): Promise<void> {
    state.isSyncing = true;
    state.pendingSync = false;
    state.pendingReason = undefined;

    const watcher = this.watchers.get(mapping.mappingId);
    watcher?.pause();

    let pullTouchPaths: string[] = [];
    try {
      pullTouchPaths = await this.doSync(mapping, reason);
    } finally {
      watcher?.resumeAfterSync(pullTouchPaths);
      state.isSyncing = false;

      // 若同步期间有新触发，再执行一轮
      if (state.pendingSync) {
        const pendingReason = state.pendingReason ?? 'manual';
        state.pendingSync = false;
        state.pendingReason = undefined;
        console.log(
          `[Scheduler][${mapping.mappingId}] 执行待挂起的同步 (${formatSyncTriggerReason(pendingReason)})`,
        );
        setTimeout(() => this.scheduleMapping(mapping, pendingReason), 0);
      }
    }
  }

  private async doSync(mapping: SyncMapping, reason: SyncTriggerReason): Promise<string[]> {
    console.log(
      `[Scheduler][${mapping.mappingId}] ===== 开始同步 (${formatSyncTriggerReason(reason)}) =====`,
    );
    console.log(`  localRoot: ${mapping.localRoot}`);
    console.log(`  projectId: ${mapping.projectId}  remoteRootFileId: ${mapping.remoteRootFileId}`);

    // 读取上次同步状态（含水位 + 已缓存的远端 ID，一次查询复用）
    const mappingState = this.db.getMappingState(mapping.mappingId);
    const lastSyncSince =
      mappingState?.lastSyncSince != null ? mappingState.lastSyncSince : undefined;

    const fullReconcileIntervalSec =
      this.config.fullReconcileIntervalSec ?? DEFAULT_FULL_RECONCILE_INTERVAL_SEC;
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
    const api = new KbApiClient(this.config.serverUrl, effectiveAppKey, limiter);
    if (mapping.appKey?.trim()) {
      console.log(`[Scheduler][${mapping.mappingId}] 使用 mapping 独立 appKey（身份隔离），独立限速器`);
    }
    const localFs = new LocalFsAdapter(
      mapping.localRoot,
      mapping.filePatterns,
      mapping.excludePatterns,
    );

    const remoteFs = new RemoteFsAdapter(api, {
      projectId: mapping.projectId,
      remoteRootFileId: mapping.remoteRootFileId,
      remoteRootFolderPath: mapping.remoteRootFolderPath,
      // 始终传入 SQLite 缓存：init() 内部按 "显式配置 > 缓存 > API 解析" 优先级处理。
      // 用户修改 remoteRootFolderPath/projectId 后 Web UI 会调 clearResolvedCache 使缓存失效。
      cachedRootFileId: mappingState?.resolvedRootFileId ?? undefined,
      cachedProjectId: mappingState?.resolvedProjectId ?? undefined,
      filePatterns: mapping.filePatterns,
      excludePatterns: mapping.excludePatterns,
    });

    // init() 解析并返回确定的 projectId / rootFileId，写回 SQLite 缓存
    const initResult = await remoteFs.init();
    if (!initResult.ok) {
      const msg = `远端初始化失败: ${initResult.error}`;
      console.error(`[Scheduler][${mapping.mappingId}] ${msg}`);
      this.db.upsertMappingState({ mappingId: mapping.mappingId, lastError: msg });
      return [];
    }
    const resolved: RemoteFsInitResult = initResult.value;
    this.db.upsertMappingState({
      mappingId: mapping.mappingId,
      resolvedRootFileId: resolved.rootFileId,
      resolvedProjectId: resolved.projectId,
    });
    console.log(
      `[Scheduler][${mapping.mappingId}] 远端初始化完成: projectId=${resolved.projectId} rootFileId=${resolved.rootFileId} path="${resolved.rootFolderPath}"`,
    );

    const engine = new SyncEngine(
      localFs,
      remoteFs,
      this.db,
      { ...mapping, syncDirection: mapping.syncDirection ?? this.config.syncDirection },
      {
        downloadConcurrency: this.config.downloadConcurrency ?? DOWNLOAD_CONCURRENCY,
        uploadConcurrency: this.config.uploadConcurrency ?? UPLOAD_CONCURRENCY,
      },
    );

    let stats: SyncStats;
    let pullTouchPaths: string[] = [];
    try {
      stats = await engine.runSync(
        (msg) => console.log(`  [${mapping.mappingId}] ${msg}`),
        lastSyncSince,
        {
          forceFullScan: forceFullScan.force,
          forceFullScanReason: forceFullScan.reason,
        },
      );
      pullTouchPaths = engine.getPullLocalTouchPaths();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[Scheduler][${mapping.mappingId}] 同步异常:`, msg);
      this.db.upsertMappingState({
        mappingId: mapping.mappingId,
        lastError: msg,
      });
      return pullTouchPaths;
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
      console.log(
        `[Scheduler][${mapping.mappingId}] 水位已推进: ${stats.newSince} (${new Date(stats.newSince).toLocaleString('zh-CN')})`,
      );
    } else if (stats.failed > 0) {
      const errSummary = stats.errors.slice(0, 3).join('; ');
      this.db.upsertMappingState({
        mappingId: mapping.mappingId,
        lastError: `${stats.failed} 个文件失败: ${errSummary}`,
        lastStats: stats,
      });
      console.warn(
        `[Scheduler][${mapping.mappingId}] 存在 ${stats.failed} 个失败文件，水位未推进，下轮将重试`,
      );
    }

    console.log(
      `[Scheduler][${mapping.mappingId}] ===== 同步完成 ↑${stats.uploaded} ↓${stats.downloaded} ✗${stats.deleted} fail:${stats.failed} =====`,
    );
    return pullTouchPaths;
  }

  /** 获取当前生效的配置（供 ManagementApi 读取） */
  getConfig(): SyncConfig {
    return this.config;
  }

  private shouldForceFullScan(
    mappingState: ReturnType<SyncStateDb['getMappingState']>,
    intervalSec: number,
  ): { force: boolean; reason?: string } {
    if (intervalSec <= 0) return { force: false };
    if (!mappingState?.lastSyncSince) return { force: false };
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
  resetMappingState(mappingId: string): void {
    this.db.resetMappingState(mappingId);
    console.log(`[Scheduler] 已重置 mapping 同步状态: ${mappingId}`);
  }

  /** 获取所有 mapping 的当前状态摘要 */
  getStatus(): Record<
    string,
    {
      isSyncing: boolean;
      pendingSync: boolean;
      lastTriggerReason?: SyncTriggerReason;
      lastWatchTriggerAt?: number;
      watchActive: boolean;
      lastState: unknown;
    }
  > {
    const result: Record<
      string,
      {
        isSyncing: boolean;
        pendingSync: boolean;
        lastTriggerReason?: SyncTriggerReason;
        lastWatchTriggerAt?: number;
        watchActive: boolean;
        lastState: unknown;
      }
    > = {};
    for (const [mappingId, runState] of this.runStates) {
      result[mappingId] = {
        isSyncing: runState.isSyncing,
        pendingSync: runState.pendingSync,
        lastTriggerReason: runState.lastTriggerReason,
        lastWatchTriggerAt: runState.lastWatchTriggerAt,
        watchActive: this.watchers.get(mappingId)?.isActive() ?? false,
        lastState: this.db.getMappingState(mappingId),
      };
    }
    return result;
  }
}
