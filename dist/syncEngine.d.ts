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
    /**
     * 清理远端空目录：基于 sync_folder_state 中已记录但本地已不存在的目录。
     * 从叶子到根（路径最长优先）逐个检查，避免递归 getChildFiles。
     * 若远端目录下仍有子项（非同步文件或非同步子目录），则保留。
     */
    private pruneRemoteEmptyDirectories;
    /**
     * 将本地目录的 dev/ino 同步到 sync_folder_state（仅更新已有记录的 inode）。
     */
    private syncFolderInodes;
    /**
     * 从 DB 记录中构建「本地相对目录路径 → 远端 folderId」映射。
     * 用于 reconcileEngine 在生成 move-remote 计划时解析目标 folderId。
     */
    /**
     * 收集本地相对目录路径（不含文件名），用于补齐 folderPathToRemoteId。
     */
    private collectLocalDirPaths;
    /**
     * 为 inode 对账补齐「本地目录 → 远端 folderId」。
     * sync_file_state 只存文件不存文件夹；新目标目录若从未同步过文件，须通过 KB API 解析/创建。
     */
    /**
     * 补齐 map 中缺失的目录 folderId。
     * 由于 sync_folder_state 已被 buildFolderPathToRemoteId 优先加载，
     * 此方法仅在极少数情况（文件被移到全新目录）才调用 KB API。
     */
    private enrichFolderPathToRemoteId;
    /**
     * 补全因 INTEGER→TEXT 迁移被清空的 localDev/localIno。
     * 按路径匹配当前本地文件，将 bigint stat 的正确值写回 DB。
     */
    private backfillInodes;
    /**
     * 当未生成 rename/move 计划时，打印可能被路径对账误判为 upload 的 inode 移动线索。
     */
    private logInodeDetectionGaps;
    private buildFolderPathToRemoteId;
    /**
     * 上传/下载成功后，将文件的直接父目录写入 sync_folder_state（如尚不存在）。
     * 仅写直接父目录（该目录的 folderId 已从上传结果中获得），祖先由后续上传自然填充。
     */
    private persistFileFolderState;
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
     * 全量扫描模式下，通过 remoteFileId 匹配 DB 中的已知记录来检测远端 rename/move。
     * 如果一个文件的 remoteFileId 在 DB 中存在，但其路径（map key）与 DB 中的 localPath 不同，
     * 说明该文件在远端被 rename 或 move 了。
     *
     * 还会尝试聚合多个同目录文件的路径变化为目录级 rename/move hint，
     * 以便 doRemoteMoveToLocal 可以一次 fs.rename 整个目录。
     */
    private detectRemoteMovesFromFullScan;
    /**
     * 从远端文件列表中提取目录 → remoteFolderId 映射并批量写入 sync_folder_state。
     */
    private persistFolderStatesFromRemoteEntries;
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
    /**
     * 远端 rename/move → 本地 fs.rename + 更新 DB。
     * - 文件级：rename 单个文件，更新该文件的 DB 记录。
     * - 目录级：rename 整个目录，批量更新 DB 中所有相关文件/文件夹记录的路径前缀。
     */
    private doRemoteMoveToLocal;
    /**
     * 目录级远端 rename/move → 本地。
     * 整棵子树用一次 fs.rename，然后批量更新 sync_file_state 和 sync_folder_state 中的路径前缀。
     */
    private doRemoteDirMoveToLocal;
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