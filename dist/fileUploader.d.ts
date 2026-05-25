import { KbApiClient } from './kbApi';
import { ApiResult } from './types';
export interface FileUploadCreateParams {
    content: string;
    fileName: string;
    fileSuffix?: string;
    /** 远端目标目录全路径（KB path 语义），空串表示项目根目录 */
    folderName: string;
    projectId: string;
}
export interface FileUploadCreateResult {
    remoteFileId: string;
    remoteFolderId: string;
}
export interface FileUploadUpdateParams {
    content: string;
    fileName: string;
    fileSuffix?: string;
    /** 目标文件的 remoteFileId，更新时作为新版本追加 */
    updateFileId: string;
    /** projectId 用于 updateFileVersion */
    projectId?: string;
}
export interface FileUploadUpdateResult {
    remoteFileId: string;
}
/**
 * 文件上传器 —— 负责将文件内容上传到知识库。
 *
 * 流程：分片上传(getSliceIdByMd5V2 → PUT MinIO → uploadFileSliceV2 → saveResource)
 *       → 获得 resourceId
 *       → 新建文件: saveFileByPath
 *       → 更新版本: updateFileVersion
 */
export declare class FileUploader {
    private readonly api;
    constructor(api: KbApiClient);
    /**
     * 新建文件上传。
     * 1. 分片上传得到 resourceId
     * 2. 调用 saveFileByPath 在知识库中建立文件节点
     */
    create(params: FileUploadCreateParams): Promise<ApiResult<FileUploadCreateResult>>;
    /**
     * 更新已有文件（追加新版本）。
     * 1. 分片上传得到 resourceId
     * 2. 调用 updateFileVersion 绑定新版本
     */
    update(params: FileUploadUpdateParams): Promise<ApiResult<FileUploadUpdateResult>>;
    /**
     * 核心：将 Buffer 通过分片上传流程上传到文件服务，返回 resourceId。
     *
     * 流程（每个分片）：
     * 1. getSliceIdByMd5V2 预检 → 命中秒传则直接拿到 sliceId
     * 2. 未命中：PUT 二进制流到 MinIO 预签名 URL
     * 3. uploadFileSliceV2 注册分片 → 拿到 sliceId
     * 4. 所有分片完成后 saveResource 合并 → 拿到 resourceId
     */
    private uploadToResource;
    /** 直接 PUT 二进制到 MinIO 预签名 URL */
    private putToMinIO;
}
//# sourceMappingURL=fileUploader.d.ts.map