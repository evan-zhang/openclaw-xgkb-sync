import { ApiResult, BatchGetContentItem, BatchGetMetaParams, CreateFolderParams, DownloadInfoVO, FileMeta, FileListItem, ListChangesParams, ListChangesResponse, ListDescendantFilesParams, ListDescendantFilesResponse, MoveFileParams, MoveFileResult, UpdateFileNameParams, UpdateFileNameResult, UploadContentParams, UploadContentResult } from './types';
import { RateLimiter } from './rateLimiter';
/**
 * 玄关知识库 Open API 客户端（Node.js 版）
 * 使用 Node 18+ 内置 fetch，移除 Obsidian requestUrl 依赖。
 */
export declare class KbApiClient {
    private static requestSeq;
    private readonly serverUrl;
    private readonly appKey;
    private readonly limiter?;
    constructor(serverUrl: string, appKey: string, limiter?: RateLimiter);
    private delay;
    private request;
    /** 获取个人知识库空间 ID */
    getPersonalProjectId(): Promise<ApiResult<string>>;
    /** 获取一级目录列表 */
    getLevel1Folders(projectId: string): Promise<ApiResult<FileListItem[]>>;
    /** 子目录/文件浏览 */
    getChildFiles(parentId: string, type?: number): Promise<ApiResult<FileListItem[]>>;
    /** 子树扁平列举（含路径字段） */
    listDescendantFiles(params: ListDescendantFilesParams): Promise<ApiResult<ListDescendantFilesResponse>>;
    /** 增量变更列表 */
    listChanges(params: ListChangesParams): Promise<ApiResult<ListChangesResponse>>;
    /**
     * 获取文件下载凭据（4.2）。
     * 传 forceDownload=true 时 downloadUrl 为 OSS 签名直链，可直接 fetch 获取原始字节。
     */
    getDownloadInfo(fileId: string, forceDownload?: boolean): Promise<ApiResult<DownloadInfoVO>>;
    /** 读取文件全文（AI 提取通道，仅作兜底，优先用 getDownloadInfo） */
    getFullFileContent(fileId: string): Promise<ApiResult<string>>;
    /**
     * 批量获取多个文件的提纯全文（4.15）
     * 建议单次 ≤10 个文件
     */
    batchGetContent(files: {
        fileId: string;
    }[]): Promise<ApiResult<BatchGetContentItem[]>>;
    /** 批量元数据（4.23） */
    batchGetMeta(fileIds: string[], projectId?: string, opts?: Pick<BatchGetMetaParams, 'includePath' | 'rootFileId' | 'includeContentHash'>): Promise<ApiResult<FileMeta[]>>;
    /**
     * 文件/文件夹重命名（同目录内改名）。
     * 不支持移动；需同时移动时请用 moveFile。
     */
    updateFileName(params: UpdateFileNameParams): Promise<ApiResult<UpdateFileNameResult>>;
    moveFile(params: MoveFileParams): Promise<ApiResult<MoveFileResult>>;
    /**
     * 上传/更新文件（轻量高速通道）
     * - 新建：不传 updateFileId
     * - 更新：传 updateFileId → 自动创建新版本
     */
    uploadContent(params: UploadContentParams): Promise<ApiResult<UploadContentResult>>;
    /** 删除文件 */
    deleteFile(fileId: string): Promise<ApiResult<boolean>>;
    /** 显式创建空目录（4.24） */
    createFolder(params: CreateFolderParams): Promise<ApiResult<string>>;
    /** 获取版本列表（调试用） */
    getVersionList(fileId: string): Promise<ApiResult<unknown[]>>;
}
//# sourceMappingURL=kbApi.d.ts.map