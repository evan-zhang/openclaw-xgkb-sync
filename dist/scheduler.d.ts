import { SyncConfig } from './types';
export declare function resolveMaxConcurrentMappings(config: SyncConfig): number;
/**
 * 多 Mapping 同步调度器
 * - 同一 mappingId 严格串行（防重入）
 * - 不同 mappingId 可受控并发（maxConcurrentMappings）
 * - 定时触发 + 手动触发双路径
 */
export declare class SyncScheduler {
    private readonly config;
    private readonly db;
    /** 按 appKey 分组的限速器，每个 appKey 独享自己的令牌桶 */
    private readonly limiters;
    private readonly runStates;
    private readonly mappingQueue;
    private readonly queuedMappingIds;
    private timers;
    private activeMappingRuns;
    private running;
    constructor(config: SyncConfig);
    /**
     * 按 appKey 获取或创建对应的限速器。
     * 同一 appKey 的所有请求共享一个令牌桶，不同 appKey 互不干扰。
     */
    private getLimiter;
    /** 启动调度器：注册定时器，并立即触发一轮全量对账 */
    start(): void;
    /** 停止调度器，清理定时器和数据库连接 */
    stop(): void;
    /** 手动触发指定 mapping 同步 */
    triggerMapping(mappingId: string): void;
    /** 触发所有已启用 mapping */
    private triggerAll;
    private scheduleMapping;
    private startMappingSync;
    private runMappingSync;
    private drainMappingQueue;
    private doSync;
    /** 获取当前生效的配置（供 ManagementApi 读取） */
    getConfig(): SyncConfig;
    private shouldForceFullScan;
    /**
     * 完全重置指定 mapping 的同步状态（文件记录 + 水位 + 远端 ID 缓存）。
     * 修改身份字段（localRoot / remoteRootFolderPath / projectId / appKey）后调用，
     * 确保下次同步以全量对账模式重建正确基准，而非用旧状态做错误决策。
     */
    resetMappingState(mappingId: string): void;
    /** 获取所有 mapping 的当前状态摘要 */
    getStatus(): Record<string, {
        isSyncing: boolean;
        pendingSync: boolean;
        lastState: unknown;
    }>;
}
//# sourceMappingURL=scheduler.d.ts.map