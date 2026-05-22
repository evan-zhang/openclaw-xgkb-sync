import { KbApiClient } from './kbApi';
import { ApiResult, FileMeta, ListChangesItem, MoveFileParams, MoveFileResult, RemoteFileEntry, UpdateFileNameParams, UpdateFileNameResult } from './types';
export interface RemoteFsOptions {
    /** Knowledge base project ID. If omitted, init() resolves the personal project ID. */
    projectId?: string;
    /**
     * Remote root folder fileId. If omitted, it can be resolved from remoteRootFolderPath.
     * If both fields are omitted, the mapping targets the project root.
     */
    remoteRootFileId?: string;
    /**
     * Remote root folder path, separated by "/"; for example "OpenClaw/OutputA".
     * Also used as the folderName prefix for uploadContent.
     */
    remoteRootFolderPath?: string;
    /** Cached rootFileId from SQLite, passed by Scheduler. */
    cachedRootFileId?: string;
    /** Cached projectId from SQLite, passed by Scheduler. */
    cachedProjectId?: string;
    /** File include patterns, used for API suffix inference and client-side filtering. */
    filePatterns?: string[];
    /** File exclude patterns, used for client-side filtering. */
    excludePatterns?: string[];
}
/** Resolved IDs returned by init() for Scheduler to persist. */
export interface RemoteFsInitResult {
    projectId: string;
    rootFileId: string;
    rootFolderPath: string;
}
export interface PruneEmptyDirectoriesResult {
    deleted: number;
    failed: number;
    errors: string[];
}
/**
 * Remote knowledge-base filesystem adapter for OpenClaw.
 * Handles root resolution, listing, downloads, uploads, and deletes.
 */
export declare class RemoteFsAdapter {
    private readonly api;
    private readonly opts;
    private readonly filePatterns;
    private readonly excludePatterns;
    private resolvedProjectId;
    private resolvedRootFileId;
    private resolvedRootFolderPath;
    constructor(api: KbApiClient, opts: RemoteFsOptions);
    getRootFileId(): string;
    getProjectId(): string;
    getRootFolderPath(): string;
    /**
     * Resolve projectId and rootFileId with priority:
     * explicit config > SQLite cache > API lookup.
     */
    init(): Promise<ApiResult<RemoteFsInitResult>>;
    /**
     * Resolve a remote folder path to fileId.
     * Example resolveFileIdFromPath("OpenClaw/OutputA", projectId):
     * - getLevel1Folders finds "OpenClaw"(id=100)
     * - getChildFiles(100, type=1) finds "OutputA"(id=200)
     * - returns "200"
     */
    private resolveFileIdFromPath;
    /**
     * Resolve a folder path from fileId for configs that only provide remoteRootFileId.
     */
    private resolvePathFromFileId;
    /**
     * Full remote listing via paginated listDescendantFiles.
     * suffix is inferred from filePatterns for API-side filtering; complex patterns are filtered locally.
     */
    listFiles(): Promise<ApiResult<RemoteFileEntry[]>>;
    /**
     * Read remote file content.
     * Prefer getDownloadInfo(forceDownload=true) OSS URL; fall back to getFullFileContent.
     */
    readFile(fileId: string): Promise<ApiResult<string>>;
    /**
     * Batch-read file content through getDownloadInfo + OSS fetch.
     * Single-file failures are warned here; callers can retry on cache miss.
     */
    readFilesBatch(fileIds: string[]): Promise<Map<string, string>>;
    /**
     * Create a remote file through uploadContent without updateFileId.
     * @param relativePath Relative path, for example "folder/2024.md".
     */
    createFile(relativePath: string, content: string): Promise<ApiResult<{
        remoteFileId: string;
        remoteFolderId: string;
    }>>;
    /**
     * Update a remote file version through uploadContent + updateFileId.
     */
    updateFile(remoteFileId: string, fileName: string, content: string): Promise<ApiResult<string>>;
    /**
     * 重命名远端文件或文件夹（同目录内改名，不移动）。
     * 对应 KB v2 updateFileName 接口。
     */
    renameFile(params: UpdateFileNameParams): Promise<ApiResult<UpdateFileNameResult>>;
    /**
     * 移动远端节点。同步侧不传 newName（换目录+改名时由调用方先 move 再 updateFileName）。
     */
    moveFile(params: MoveFileParams): Promise<ApiResult<MoveFileResult>>;
    /** Delete remote file. */
    deleteFile(remoteFileId: string): Promise<ApiResult<void>>;
    /**
     * 后序清理远端空目录。
     * - 不删除 mapping 根目录自身；
     * - 若本地仍存在同名目录，即使为空也保留；
     * - 只删除知识库中真正没有任何子项的目录，避免误删含非同步文件的目录。
     */
    pruneEmptyDirectories(localDirectoryPaths: Set<string>): Promise<ApiResult<PruneEmptyDirectoriesResult>>;
    private pruneFolderNode;
    /**
     * Incremental change listing through listChanges.
     * @param since Last successful sync watermark.
     */
    listAllChanges(since: number): Promise<ApiResult<{
        items: ListChangesItem[];
        serverTime?: number;
    }>>;
    /**
     * Batch metadata lookup through batchGetMeta, returning fileId -> FileMeta.
     * Failed batches are warned and skipped; callers handle missing metadata.
     */
    batchGetMetaAll(fileIds: string[]): Promise<Map<string, FileMeta>>;
}
//# sourceMappingURL=remoteFs.d.ts.map