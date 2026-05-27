export interface FileWatcherOptions {
    mappingId: string;
    localRoot: string;
    filePatterns: string[];
    excludePatterns: string[];
    debounceMs: number;
    usePolling: boolean;
    onBatchReady: (pathCount: number) => void;
}
/**
 * mapping 级 chokidar 封装：debounce 合并变更，sync 期间 pause，pull 写入 echo 过滤。
 * 硬排除 `.openclaw-sync-map.json`（方案一索引 consume 写入，避免误触发 push）。
 */
export declare class FileWatcher {
    private readonly opts;
    private readonly ignoreSet;
    private watcher;
    private pendingPaths;
    private debounceTimer;
    private ignoreTailTimer;
    private paused;
    private started;
    constructor(opts: FileWatcherOptions);
    start(): void;
    stop(): Promise<void>;
    /** sync 开始前暂停，丢弃期间所有 FS 事件 */
    pause(): void;
    /**
     * sync 结束后恢复；将 pull 写入路径加入 ignoreSet 一段时间，防止 resume 后 echo push。
     */
    resumeAfterSync(pullWrittenPaths?: Iterable<string>): void;
    addIgnore(paths: Iterable<string>): void;
    clearIgnore(): void;
    isActive(): boolean;
    private onFsEvent;
    private scheduleDebounce;
    private clearDebounce;
    private toRelativePath;
    /** 与 SyncEngine.matchesSync 一致：仅纳入同步范围的文件路径 */
    private matchesSyncScope;
    /**
     * chokidar ignored：排除索引文件和 exclude 目录。
     * 点文件可能是待同步的工程配置（如 .gitignore），由 filePatterns/excludePatterns 判定。
     * 勿在此处按 filePatterns 排除，也勿 ignore 同步根（rel===''），否则 Windows 上可能收不到任何子路径事件。
     */
    private shouldIgnoreWatchTarget;
}
//# sourceMappingURL=fileWatcher.d.ts.map