export interface SyncMapping {
    mappingId: string;
    enabled: boolean;
    localRoot: string;
    /**
     * 单条 mapping 的 API 鉴权密钥，用于多用户/多身份场景。
     * 填写后优先于全局 appKey，不填则使用全局 appKey。
     */
    appKey?: string;
    /**
     * 知识库空间 ID。
     * 可不填：若不填则 Agent 启动时自动调用 getPersonalProjectId() 获取个人空间 ID。
     */
    projectId?: string;
    /**
     * 用于 listChanges / listDescendantFiles 的远端根目录 fileId。
     * 可不填：若不填且配置了 remoteRootFolderPath，则 Agent 启动时通过路径解析获得；
     * 两者都不填时表示同步整个 projectId 空间的根目录。
     */
    remoteRootFileId?: string;
    /**
     * 远端根目录的完整路径（"/" 分隔），例如 "OpenClaw/OutputA"。
     * 同时作为 uploadContent 的 folderName 前缀使用。
     * 若不填，Agent 启动时会通过 batchGetMeta 逐级向上解析（需额外 API 调用）。
     * 推荐填写以获得最佳性能。
     */
    remoteRootFolderPath?: string;
    /** 文件匹配模式，默认 ["**\/*.md"] */
    filePatterns?: string[];
    /** 排除模式，默认 ["**\/_conflict_*", "**\/.tmp\/**"] */
    excludePatterns?: string[];
    /**
     * 单条 mapping 的同步方向，覆盖全局配置。
     * 若不填，则使用全局 syncDirection。
     */
    syncDirection?: 'bidirectional' | 'push' | 'pull';
    /**
     * moveFile 目标位同名冲突策略：0=重命名，1=覆盖，2=抛异常，3=跳过。
     * 默认 3（跳过）。策略 2 失败时整次未移动；策略 1 需处理 idMappings。
     */
    moveNameConflictStrategy?: 0 | 1 | 2 | 3;
    /**
     * updateFileName 同目录重名策略：0=自动重命名，1=抛异常。
     * 默认 1。
     */
    renameNameConflictStrategy?: 0 | 1;
    /**
     * 双端同时修改同一文件时的冲突策略（仅 bidirectional 模式生效）：
     * - 'local-wins'：本地版本上传覆盖远端（远端旧版本由 KB 版本历史保留）
     * - 'remote-wins'：远端版本下载覆盖本地（本地旧版本移入回收站）
     * 默认 'local-wins'。
     */
    conflictStrategy?: 'local-wins' | 'remote-wins';
    /**
     * 是否启用路径→remoteFileId 索引文件（`.openclaw-sync-map.json`）独立同步。
     * push/bidirectional 在同步成功后 publish；pull/bidirectional 在同步开始前 consume。
     * 默认 false。
     */
    enableFileIndex?: boolean;
}
export interface SyncConfig {
    /** 知识库 Open API 根地址；省略时使用生产环境默认地址（见 constants.DEFAULT_SERVER_URL） */
    serverUrl: string;
    /**
     * 全局 API 密钥。可省略或留空；与单条 mapping 的 `appKey` 至少其一有值时才能正常调用知识库 API。
     */
    appKey?: string;
    syncDirection: 'bidirectional' | 'push' | 'pull';
    /** 自动同步间隔（秒），0 表示关闭 */
    autoSyncIntervalSec: number;
    /**
     * 强制全量对账间隔（秒），默认 3600。
     * 增量同步依赖 listChanges + SQLite 状态；周期性全量扫描可发现历史漏记录。
     * 设为 0 表示关闭周期性全量对账。
     */
    fullReconcileIntervalSec?: number;
    /** SQLite 状态库路径，默认 ./openclaw-sync-state.db */
    stateDbPath?: string;
    /** mapping 并发策略：auto 自动适配，manual 使用 maxConcurrentMappings */
    maxConcurrentMappingsMode?: 'auto' | 'manual';
    /** 手动模式下的最大并发 mapping 数量，默认 2 */
    maxConcurrentMappings?: number;
    /**
     * API 限速：每分钟最大请求数（令牌桶稳态速率），默认 60。
     * 多台服务器共享同一知识库时，建议各自降低此值（如 30）以避免聚合超限。
     */
    maxRequestsPerMinute?: number;
    /**
     * 令牌桶突发容量，默认 8。
     * 允许短时间内连续发出最多 burst 个请求，随后按 maxRequestsPerMinute 补充。
     */
    rateLimitBurst?: number;
    /**
     * 收到 429 后的冷却时间（秒），默认 60。
     * 冷却期间所有请求排队等待，不会继续打穿限流。
     */
    rateLimitCooldownSec?: number;
    /**
     * 下载并发数，默认 5。控制同时进行的文件下载操作数量。
     */
    downloadConcurrency?: number;
    /**
     * 上传并发数，默认 3。控制同时进行的文件上传操作数量。
     */
    uploadConcurrency?: number;
    /**
     * 启动后首次同步的随机抖动上限（秒），默认 20。
     * 多台服务器同时启动时，随机延迟可分散请求突刺。设为 0 禁用抖动。
     */
    startupJitterMaxSec?: number;
    /**
     * HTTP 管理 API 监听端口，默认 9090。设为 0 禁用管理 API。
     */
    managementPort?: number;
    /**
     * HTTP 管理 API 监听地址，默认 "0.0.0.0"（允许局域网访问；本机浏览器请用 127.0.0.1）。
     * 注意做好网络隔离，勿在公网暴露。
     */
    managementHost?: string;
    mappings: SyncMapping[];
}
export type ApiOk<T> = {
    ok: true;
    value: T;
};
export type ApiErr = {
    ok: false;
    error: string;
};
export type ApiResult<T> = ApiOk<T> | ApiErr;
export interface LocalFileEntry {
    /** 相对于 localRoot 的路径，如 "日常笔记/2024.md" */
    path: string;
    name: string;
    mtime: number;
    size: number;
    /**
     * 文件系统设备号（字符串形式，保留完整精度）。
     * Linux/macOS: stat.dev；Windows NTFS: 卷标识。
     * 与 ino 合并为 localFileKey（`${dev}:${ino}`），用于跨路径追踪同一文件。
     * "0" 表示平台或文件系统不支持，此时降级为路径对账。
     */
    dev: string;
    /**
     * 文件 inode/NTFS 文件索引号（字符串形式，保留完整 64 位精度）。
     * 使用 fs.stat({bigint:true}) 获取，避免 Number 精度丢失。
     * "0" 表示平台不支持，此时降级为路径对账。
     */
    ino: string;
}
export interface RemoteFileEntry {
    path: string;
    name: string;
    mtime: number;
    size?: number;
    remoteFileId: string;
    remoteFolderId: string;
}
export interface ListChangesItem {
    fileId: string | number;
    event: 'create' | 'update' | 'delete' | string;
    name?: string;
    updateTime?: number;
    parentId?: string | number | null;
    /**
     * 相对于 rootFileId 的完整路径（仅 listChanges 传 includePath=true 时返回）。
     * 可用于在增量路径中直接获知文件当前位置，无需逐级 batchGetMeta 推导路径。
     */
    relativePath?: string;
    /**
     * 移动前的父目录 fileId（仅 includeMoveHint=true 且该节点发生移动时返回）。
     * 与 previousName 结合可推断出移动前的路径，从而触发本地 rename/move 操作而非 delete+download。
     */
    previousParentId?: string | number | null;
    /**
     * 移动/重命名前的文件名（仅 includeMoveHint=true 且发生改名时返回）。
     */
    previousName?: string;
}
export interface ListChangesResponse {
    items: ListChangesItem[];
    nextCursor?: string | null;
    serverTime?: number;
}
export interface ListDescendantFilesParams {
    rootFileId: string;
    projectId?: string;
    /**
     * 文件后缀过滤。不传时 KB 默认 `md`。
     * 支持：`md` | `md,png,pdf`（逗号分隔多后缀）| `*`（全部类型）。
     */
    suffix?: string;
    limit?: number;
    cursor?: string;
    includePath?: boolean;
    /**
     * 是否在结果中包含目录节点（type=1）。
     * 默认 false（仅返回文件）。有此字段时可一次性获取完整目录树，
     * 省去后续 batchGetMeta 推导目录 fileId 的开销。
     */
    includeFolders?: boolean;
}
export interface ListDescendantFilesItem {
    fileId: string | number;
    name: string;
    relativePath?: string;
    updateTime?: number;
    size?: number;
    parentId?: string | number | null;
    type?: number;
}
export interface ListDescendantFilesResponse {
    files: ListDescendantFilesItem[];
    nextCursor?: string | null;
}
/** batchGetMeta 返回的元数据（fileId 字段） */
export interface FileMeta {
    fileId: string | number;
    name: string;
    updateTime?: number;
    parentId?: string | number | null;
    deleted?: boolean;
    type?: number;
    /**
     * 相对于请求时传入的 rootFileId 的完整路径（仅 includePath=true 时返回）。
     * 用于 Phase 2 远端重命名/移动检测：与 DB 中的 remoteRelativePath 对比，
     * 若不同则表明远端已改名或移动，触发对应的本地 rename/move 操作。
     */
    relativePath?: string;
    /**
     * 文件内容哈希（仅 includeContentHash=true 时返回）。
     * 可用于精确冲突检测，避免仅凭 mtime 误判内容是否变更。
     * 缺省时退化为纯 mtime 比较。
     */
    contentHash?: string | null;
}
/** batchGetMeta 扩展请求参数 */
export interface BatchGetMetaParams {
    fileIds: string[];
    projectId?: string;
    /**
     * 是否返回每个文件相对于 rootFileId 的完整路径。
     * 需同时传入 rootFileId 才有意义。
     */
    includePath?: boolean;
    /**
     * 计算 relativePath 时的根节点 fileId，省略则以空间根为基准。
     */
    rootFileId?: string;
    /**
     * 是否返回文件内容哈希。
     */
    includeContentHash?: boolean;
}
/** getLevel1Folders / getChildFiles 返回的目录/文件项（id 字段） */
export interface FileListItem {
    id: string | number;
    name: string;
    type: number;
    parentId?: string | number | null;
    suffix?: string;
    size?: number;
    hasChild?: boolean;
    updateTime?: number;
}
export interface BatchGetContentItem {
    fileId: string | number;
    status?: string;
    content?: string;
}
export interface DownloadInfoVO {
    fileId: string | number;
    downloadUrl?: string;
    previewUrl?: string;
    fileName?: string;
    suffix?: string;
    size?: number;
}
export interface UploadContentParams {
    content: string;
    fileName: string;
    fileSuffix?: string;
    folderName?: string;
    updateFileId?: string;
    versionRemark?: string;
    projectId?: string;
}
export interface UploadContentResult {
    fileId: string | number;
    folderId?: string | number | null;
}
/** getSliceIdByMd5V2 响应 */
export interface SliceCheckResult {
    sliceId?: number | null;
    uploadUrl?: string | null;
    fullPath?: string | null;
    storageType?: string | null;
}
/** uploadFileSliceV2 请求 */
export interface UploadFileSliceParams {
    filePath: string;
    md5: string;
    size: number;
    storageType: string;
}
/** saveResource 请求 */
export interface SaveResourceParams {
    name: string;
    sliceIds: number[];
    suffix?: string;
    size?: number;
}
/** saveFileByParentId / saveFileByPath 请求 */
export interface SaveFileToProjectParams {
    projectId: string;
    parentId?: string;
    path?: string;
    name: string;
    fileType: string;
    suffix?: string;
    size?: number;
    resourceId: number;
    nameConflictStrategy?: number;
    isSensitive?: number;
}
/** updateFileVersion 请求 */
export interface UpdateFileVersionParams {
    id: string;
    projectId: string;
    resourceId: number;
    name?: string;
    versionStatus?: number;
    versionName?: string;
    versionRemark?: string;
    suffix?: string;
    size?: number;
}
export interface CreateFolderParams {
    projectId: string;
    parentId: string;
    name: string;
}
export interface ListChangesParams {
    projectId: string;
    /** 不传时扫描整个 projectId 空间（等价于传项目根 rootFileId=0） */
    rootFileId?: string;
    since?: number;
    cursor?: string;
    limit?: number;
    /**
     * 是否在每条变更记录中附带文件当前路径（relativePath）。
     * 开启后可在增量路径直接得知文件位置，无需再调 batchGetMeta 推导路径。
     */
    includePath?: boolean;
    /**
     * 是否在变更记录中附带移动前的父目录/文件名（previousParentId / previousName）。
     * 仅 upsert 类型事件支持。开启后可在增量路径检测远端 rename/move，
     * 触发本地对应操作而非 delete+download。
     */
    includeMoveHint?: boolean;
}
/** OpenUpdateFileNameParam — 见 kb-api-requirements-for-sync.md §4.1 */
export interface UpdateFileNameParams {
    fileId: string;
    newName: string;
    projectId?: string;
    nameConflictStrategy?: 0 | 1;
    rootFileId?: string;
}
/** updateFileName 成功响应最小契约 — 见 kb-api-requirements-for-sync.md §4.1.1 */
export interface UpdateFileNameResult {
    fileId: string;
    name: string;
    parentId?: string;
    updateTime?: number;
    /** 请求带 rootFileId 时 KB 应返回 */
    relativePath?: string;
    renamedDueToConflict?: boolean;
}
/** OpenMoveFileParam — 见 kb-api-requirements-for-sync.md §4.2 */
export interface MoveFileParams {
    fileId: string;
    targetParentId: string;
    newName?: string;
    projectId?: string;
    nameConflictStrategy?: 0 | 1 | 2 | 3;
    rootFileId?: string;
}
/**
 * moveFile 成功响应 — 同步客户端最小契约（见 kb-api-requirements-for-sync.md §4.2.1）。
 * KB 可额外返回 details/skippedItems 等字段，同步端忽略。
 */
export interface MoveFileIdMapping {
    sourceFileId: string;
    targetFileId: string;
}
/** moveFile 成功响应（FileMoveResultVO 最小子集） */
export interface MoveFileResult {
    /** 操作后主节点有效 id（覆盖策略时可能 ≠ 请求 fileId） */
    fileId: string | number;
    /** 恒等于请求 fileId */
    sourceFileId: string | number;
    /** 是否因覆盖等发生 id 切换 */
    idChanged: boolean;
    /** 主节点最终名称 */
    name: string;
    /** 主节点最终父目录 id */
    parentId: string | number;
    /** 更新时间（毫秒） */
    updateTime: number;
    /**
     * 相对 mapping 根（请求 rootFileId）的路径。
     * 请求带 rootFileId 时 KB **必须**返回，否则同步端用本地 toPath 兜底。
     */
    relativePath?: string;
    /**
     * idChanged=true 时 **必须**返回，且至少含主节点一条映射。
     * 子树节点映射 KB 可逐步补齐；未返回时同步端仅更新主节点 state。
     */
    idMappings?: MoveFileIdMapping[];
    /**
     * 策略 3 且主节点因同名冲突未移动时为 true。
     * 为 true 时同步端不更新 SQLite / remoteMap。
     */
    mainSkipped?: boolean;
}
export interface MappingState {
    mappingId: string;
    lastSyncSince?: number | null;
    lastServerTime?: number | null;
    lastSuccessAt?: number | null;
    lastFullScanAt?: number | null;
    lastError?: string | null;
    lastStats?: SyncStats | null;
    /** 从 remoteRootFolderPath 解析后缓存的 rootFileId，避免每次启动重新解析 */
    resolvedRootFileId?: string | null;
    /** 自动解析或手动配置的 projectId 缓存 */
    resolvedProjectId?: string | null;
    /** 索引文件 `.openclaw-sync-map.json` 在 KB 上的 fileId（Pull consume 加速） */
    indexFileRemoteId?: string | null;
    /** 上次成功 publish 的索引 JSON 内容 hash（SHA256 hex） */
    indexContentHash?: string | null;
}
/** 映射索引 JSON 文档（根目录全量表） */
export interface FileIndexDocument {
    version: number;
    mappingId: string;
    updatedAt: string;
    fileCount: number;
    files: Record<string, string>;
}
export interface FileState {
    mappingId: string;
    localPath: string;
    remoteFileId?: string | null;
    remoteFolderId?: string | null;
    localMtime?: number | null;
    remoteMtime?: number | null;
    contentHash?: string | null;
    syncStatus: 'done' | 'failed' | 'done_with_conflict';
    lastSyncAt?: number | null;
    lastError?: string | null;
    /**
     * 本地文件的设备号（字符串形式保留完整精度）。
     * NULL = 尚未采集；"0" = 平台不支持。
     */
    localDev?: string | null;
    /**
     * 本地文件的 inode/NTFS 文件索引号（字符串形式保留完整精度）。
     * NULL = 尚未采集；"0" = 平台不支持。
     */
    localIno?: string | null;
    /**
     * 文件在远端的相对路径（相对于 remoteRootFileId）。
     * 用于 Phase 2 远端 rename/move 检测：下次 batchGetMeta includePath 返回的 relativePath
     * 若与此值不符，则触发本地 rename/move 而非 delete+download。
     * NULL = 尚未记录（旧记录或路径未变化）。
     */
    remoteRelativePath?: string | null;
}
export interface LocalDirEntry {
    path: string;
    dev: string;
    ino: string;
}
export interface FolderState {
    mappingId: string;
    localPath: string;
    remoteFolderId: string;
    localDev?: string | null;
    localIno?: string | null;
}
export type SyncOp = 'upload-new' | 'upload-update' | 'download-new' | 'download-update' | 'delete-local' | 'delete-remote'
/** 本地文件在同目录内改名 → 调用 updateFileName 同步到远端 */
 | 'rename-remote'
/** 本地文件移动到其他目录（可同时改名）→ 调用 moveFile 同步到远端 */
 | 'move-remote'
/** 远端文件在同目录内改名 → 本地 rename */
 | 'rename-local'
/** 远端文件移动到其他目录（可同时改名）→ 本地 rename/move */
 | 'move-local' | 'skip';
export interface SyncPlan {
    /** 目标路径（rename/move 时为新路径，其他情况与原路径相同） */
    path: string;
    /** 源路径，仅 rename/move 操作时有值 */
    fromPath?: string;
    /** 新文件名，仅 rename-remote 时有值 */
    newName?: string;
    /**
     * move-remote 移动完成后若需改名（不同步传 moveFile.newName，先 move 再 updateFileName）。
     */
    renameAfterMoveName?: string;
    /**
     * 目标父目录的远端 fileId，仅 move-remote 操作时有值。
     * 为空字符串表示目标父目录无法解析，执行时降级为 delete-remote + upload-new。
     */
    targetParentId?: string;
    /**
     * true 表示对远端文件夹执行一次 updateFileName / moveFile（Phase 1.2），
     * 而非对单个文件逐条调用。
     */
    isDirectory?: boolean;
    /** 目录移动/改名时的旧目录相对路径（如 `proj/old`） */
    directoryOldPath?: string;
    /** 目录移动/改名后的新目录相对路径（如 `proj/new`） */
    directoryNewPath?: string;
    /** 目录操作涵盖的 SQLite 文件记录（该目录下所有同步文件） */
    affectedRecords?: FileState[];
    /** 远端文件夹 fileId（取自子文件的 remoteFolderId） */
    remoteFolderFileId?: string;
    local?: LocalFileEntry;
    remote?: RemoteFileEntry;
    record?: FileState;
    op: SyncOp;
}
export interface SyncStats {
    uploaded: number;
    downloaded: number;
    deleted: number;
    prunedRemoteDirs?: number;
    skipped: number;
    failed: number;
    errors: string[];
    newSince?: number;
    fullScan?: boolean;
    /** 本轮执行的远端重命名操作数（updateFileName） */
    renamed?: number;
    /** 本轮执行的远端移动操作数（moveFile） */
    moved?: number;
}
//# sourceMappingURL=types.d.ts.map