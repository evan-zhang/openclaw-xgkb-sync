import { LocalFsAdapter } from './localFs';
import { RemoteFsAdapter } from './remoteFs';
import { SyncStateDb } from './syncStateDb';
import { SyncMapping, SyncStats } from './types';
type ProgressCallback = (msg: string) => void;
/**
 * 核心同步引擎（OpenClaw 版）
 * 与 Obsidian 版的主要差异：
 * - 使用 mappingId 隔离多条映射规则的状态
 * - 状态库操作基于 SQLite（SyncStateDb）
 * - 本地/远端文件操作基于 LocalFsAdapter / RemoteFsAdapter
 */
export declare class SyncEngine {
    private readonly localFs;
    private readonly remoteFs;
    private readonly db;
    private readonly mapping;
    private stats;
    private progress;
    private readonly filePatterns;
    private readonly excludePatterns;
    private readonly downloadConcurrency;
    private readonly uploadConcurrency;
    constructor(localFs: LocalFsAdapter, remoteFs: RemoteFsAdapter, db: SyncStateDb, mapping: SyncMapping, opts?: {
        downloadConcurrency?: number;
        uploadConcurrency?: number;
    });
    private delay;
    /** 判断路径是否应纳入同步范围 */
    private matchesSync;
    private emptyStats;
    /**
     * 执行一轮同步（增量优先，降级全量）。
     * @param onProgress 进度回调
     * @param lastSyncSince 上次成功同步的水位时间戳（毫秒）；undefined = 首次全量
     */
    runSync(onProgress?: ProgressCallback, lastSyncSince?: number, opts?: {
        forceFullScan?: boolean;
        forceFullScanReason?: string;
    }): Promise<SyncStats>;
    private pruneRemoteEmptyDirectories;
    /**
     * 从 DB 记录中构建「本地相对目录路径 → 远端 folderId」映射。
     * 用于 reconcileEngine 在生成 move-remote 计划时解析目标 folderId。
     */
    private buildFolderPathToRemoteId;
    /**
     * 打印 inode 对账阶段生成的计划明细（用于排查目录被拆散、冲突自动改名等问题）。
     */
    private logRenamePlans;
    /**
     * 构建远端文件 Map，优先走增量路径，遇到无法解析的新目录降级全量。
     */
    private buildRemoteMap;
    /**
     * 增量路径：listChanges + batchGetMeta。
     * 若遇到无法解析路径的新增文件，返回 null 触发全量降级。
     */
    private tryIncrementalRemoteMap;
    /** 全量扫描（listDescendantFiles 分页） */
    private fullRemoteMap;
    /**
     * 知识库允许「文件节点」下再挂文件；本地不能把同名路径既当文件又当目录。
     * 简单策略：保留祖先路径对应的文件，移除其下所有更深的路径条目。
     */
    private removePathsUnderFileNodes;
    private decide;
    /**
     * 按 concurrency 分批并发执行计划列表，批间插入 EXECUTE_BATCH_PAUSE_MS 的间隔。
     * 真正的请求限速由 KbApiClient 内置的 RateLimiter 负责，这里的 pause 只是平滑突发。
     */
    private executePlansInQueue;
    /**
     * @param remoteMap 可选：rename/move 执行后需同步更新远端视图，保持路径对账视图一致性
     */
    private executePlan;
    private doUploadNew;
    private doUploadUpdate;
    private doDownloadNew;
    private doDownloadUpdate;
    private doDeleteLocal;
    private doDeleteRemote;
    /**
     * 目录级 rename-remote：对文件夹 fileId 调用一次 updateFileName，并批量更新子文件 state。
     * 同父目录下改名（如 dirA → dirB）时使用，不涉及 moveFile。
     */
    private doRenameRemoteDirectory;
    /**
     * 执行远端重命名（同目录内改名）。
     * 成功后：删除旧 DB 记录，以新路径写入新 DB 记录，并同步更新 remoteMap。
     */
    private resolveRenameConflictStrategy;
    private resolveMoveConflictStrategy;
    /** 从 moveFile 最小契约收集 id 映射（normalizeMoveFileResult 已保证 idChanged 时有 mappings） */
    private collectMoveIdMappings;
    private doRenameRemote;
    /**
     * 执行远端移动（跨目录移动，可同时改名）。
     * targetParentId 为空时降级为 delete-remote + upload-new（退化路径）。
     * 成功后：处理 idMappings，删除旧 DB 记录，以新路径写入新 DB 记录，更新 remoteMap。
     */
    private doMoveRemote;
    /**
     * 目录级 move-remote：对文件夹 fileId 调用一次 moveFile，并批量更新子文件 state。
     */
    private doMoveRemoteDirectory;
    /** 拉取单个文件内容，由 KbApiClient 内置限速器控制请求速率 */
    private fetchContent;
}
export {};
//# sourceMappingURL=syncEngine.d.ts.map