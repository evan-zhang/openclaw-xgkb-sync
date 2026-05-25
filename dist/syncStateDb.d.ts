import { FileState, FolderState, MappingState } from './types';
/** SQLite 状态库（使用 node-sqlite3-wasm，无需原生编译） */
export declare class SyncStateDb {
    private readonly db;
    constructor(dbPath?: string);
    private initSchema;
    getMappingState(mappingId: string): MappingState | undefined;
    upsertMappingState(state: Partial<Omit<MappingState, 'mappingId'>> & {
        mappingId: string;
    }): void;
    /**
     * 主动清除 mapping 的远端 ID 缓存（resolved_root_file_id / resolved_project_id）。
     * 在修改 remoteRootFolderPath / projectId 配置后调用，强制下次启动重新解析。
     */
    clearResolvedCache(mappingId: string): void;
    /**
     * 完全重置 mapping 的同步状态：
     * 1. 删除所有文件记录（sync_file_state）
     * 2. 重置同步水位（last_sync_since → NULL，下次强制全量对账）
     * 3. 清除远端 ID 缓存（resolved_root_file_id / resolved_project_id）
     *
     * 适用于修改了"身份字段"（localRoot / remoteRootFolderPath / projectId / appKey）之后，
     * 避免旧文件状态与新配置的同步目标产生错误决策。
     */
    resetMappingState(mappingId: string): void;
    getFileState(mappingId: string, localPath: string): FileState | undefined;
    getFileStateByRemoteId(mappingId: string, remoteFileId: string): FileState | undefined;
    getAllFileStates(mappingId: string): FileState[];
    upsertFileState(state: FileState): void;
    /**
     * 通过 inode 标识查找文件状态。
     * dev="0" 或 ino="0" 时直接返回 undefined（平台不支持，退化为路径查找）。
     */
    getFileStateByLocalKey(mappingId: string, dev: string, ino: string): FileState | undefined;
    /**
     * 批量更新因 moveFile(cover) 导致的远端 fileId 变更。
     * 适用于移动目录时子节点 fileId 随覆盖策略发生变更的场景。
     */
    applyRemoteIdMappings(mappingId: string, mappings: Array<{
        sourceFileId: string;
        targetFileId: string;
    }>): void;
    /**
     * 在单次事务中批量写入多条文件状态，比逐条写入快 10x 以上。
     * 用于同步完成后批量提交结果。
     */
    upsertFileStateBatch(states: FileState[]): void;
    deleteFileState(mappingId: string, localPath: string): void;
    /** 清除某 mapping 所有文件状态（用于强制全量重建） */
    clearMappingFiles(mappingId: string): void;
    getFolderState(mappingId: string, localPath: string): FolderState | undefined;
    getFolderStateByRemoteId(mappingId: string, remoteFolderId: string): FolderState | undefined;
    getAllFolderStates(mappingId: string): FolderState[];
    getFolderStateByLocalKey(mappingId: string, dev: string, ino: string): FolderState | undefined;
    upsertFolderState(state: FolderState): void;
    upsertFolderStateBatch(states: FolderState[]): void;
    deleteFolderState(mappingId: string, localPath: string): void;
    /** 批量删除路径前缀匹配的文件夹记录（目录被删除时级联清理子目录） */
    deleteFolderStatesUnder(mappingId: string, dirPrefix: string): void;
    /** 批量更新路径前缀（目录重命名/移动后更新所有子目录路径） */
    renameFolderPaths(mappingId: string, oldPrefix: string, newPrefix: string): void;
    /** 批量更新文件路径前缀（目录重命名/移动后更新所有子文件路径） */
    renameFilePaths(mappingId: string, oldPrefix: string, newPrefix: string): void;
    clearMappingFolders(mappingId: string): void;
    insertOpLog(entry: {
        idempotencyKey: string;
        mappingId: string;
        opType: string;
        target: string;
        requestPayload?: unknown;
        resultPayload?: unknown;
    }): void;
    close(): void;
}
//# sourceMappingURL=syncStateDb.d.ts.map