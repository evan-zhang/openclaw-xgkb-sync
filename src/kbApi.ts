import {
  ApiResult,
  BatchGetContentItem,
  BatchGetMetaParams,
  CreateFolderParams,
  DownloadInfoVO,
  FileMeta,
  FileListItem,
  ListChangesParams,
  ListChangesResponse,
  ListDescendantFilesParams,
  ListDescendantFilesResponse,
  MoveFileParams,
  MoveFileResult,
  SaveFileToProjectParams,
  SaveResourceParams,
  SliceCheckResult,
  UpdateFileNameParams,
  UpdateFileNameResult,
  UpdateFileVersionParams,
  UploadContentParams,
  UploadContentResult,
  UploadFileSliceParams,
} from './types';
import {
  API_ERROR_LOG_MAX_CHARS,
  API_ERROR_MESSAGE_BODY_MAX,
  API_PATHS,
  MAX_RETRIES,
  RATE_LIMIT_RESULT_CODES,
  REQUEST_TIMEOUT_MS,
  RETRY_BASE_DELAY_MS,
  TRANSIENT_RESULT_CODES,
} from './constants';
import { RateLimiter } from './rateLimiter';

function truncateForLog(s: string, max = API_ERROR_LOG_MAX_CHARS): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}… [truncated ${s.length - max} chars]`;
}

/** 日志用参数摘要（省略大字段如正文 content） */
function summarizeParams(params?: Record<string, unknown>): string {
  if (!params || Object.keys(params).length === 0) return '{}';
  const summarized: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(params)) {
    if (key === 'content' && typeof val === 'string') {
      summarized[key] = `<omitted ${val.length} chars>`;
      continue;
    }
    if (key === 'files' && Array.isArray(val)) {
      const arr = val as { fileId?: string }[];
      summarized[key] = {
        count: arr.length,
        sampleFileIds: arr.slice(0, 8).map((x) => x?.fileId ?? x),
      };
      continue;
    }
    if (typeof val === 'string' && val.length > 800) {
      summarized[key] = `${val.slice(0, 800)}… (${val.length} chars)`;
      continue;
    }
    summarized[key] = val;
  }
  try {
    return truncateForLog(JSON.stringify(summarized));
  } catch {
    return truncateForLog(String(params));
  }
}

/**
 * 玄关知识库 Open API 客户端（Node.js 版）
 * 使用 Node 18+ 内置 fetch，移除 Obsidian requestUrl 依赖。
 */
export class KbApiClient {
  private static requestSeq = 0;
  private readonly serverUrl: string;
  private readonly appKey: string;
  private readonly limiter?: RateLimiter;

  constructor(serverUrl: string, appKey: string, limiter?: RateLimiter) {
    this.serverUrl = serverUrl.endsWith('/') ? serverUrl : serverUrl + '/';
    this.appKey = appKey;
    this.limiter = limiter;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async request<T>(
    method: 'GET' | 'POST',
    apiPath: string,
    params?: Record<string, unknown>,
  ): Promise<ApiResult<T>> {
    const requestId = ++KbApiClient.requestSeq;
    const reqStart = Date.now();
    const baseUrl = this.serverUrl + apiPath;
    let url = baseUrl;
    let body: string | undefined;

    if (method === 'GET' && params) {
      const qs = Object.entries(params)
        .filter(([, v]) => v !== undefined && v !== null)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
        .join('&');
      url = qs ? `${baseUrl}?${qs}` : baseUrl;
    } else if (method === 'POST' && params) {
      body = JSON.stringify(params);
    }

    const paramsSummary = summarizeParams(params);
    console.log(
      `[KbApi] request#${requestId} start method=${method} path=${apiPath}\n` +
        `  params: ${paramsSummary}`,
    );
    let lastError = '';
    let lastErrorWasRateLimit = false;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      // 每次 attempt 前申请令牌：
      // - 正常情况下走令牌桶的稳态限速；
      // - 429 后 limiter 已设置冷却窗口，此处自动等待冷却结束，再发下一次请求。
      if (this.limiter) await this.limiter.acquire();

      // 429 冷却已由 limiter 处理，其余错误才加指数退避，避免双重等待。
      if (attempt > 0 && !lastErrorWasRateLimit) {
        await this.delay(RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1));
      }
      lastErrorWasRateLimit = false;

      try {
        const attemptStart = Date.now();
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        let resp: Response;
        try {
          resp = await fetch(url, {
            method,
            headers: {
              'Content-Type': 'application/json',
              appKey: this.appKey,
            },
            body,
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timeoutId);
        }

        const rawText = await resp.text();
        const urlForLog = truncateForLog(url);

        if (!resp.ok) {
          const bodySnippet = truncateForLog(rawText, API_ERROR_MESSAGE_BODY_MAX);
          console.error(
            `[KbApi] request#${requestId} HTTP 错误 method=${method} path=${apiPath} status=${resp.status} ${resp.statusText} attempt=${attempt + 1}/${MAX_RETRIES} elapsed=${Date.now() - attemptStart}ms\n` +
              `  url: ${urlForLog}\n` +
              `  params: ${paramsSummary}\n` +
              `  responseBody: ${truncateForLog(rawText)}`,
          );
          const shortErr = `HTTP ${resp.status}: ${resp.statusText}${rawText ? ` | body=${bodySnippet}` : ''}`;

          if (resp.status === 429) {
            // 解析 Retry-After（单位秒）
            const retryAfterHeader = resp.headers.get('Retry-After');
            const retryAfterMs = retryAfterHeader
              ? Math.ceil(parseFloat(retryAfterHeader) * 1000)
              : undefined;
            this.limiter?.onRateLimited(retryAfterMs);
            lastError = shortErr;
            lastErrorWasRateLimit = true;
            continue;
          }

          // 其他 4xx 客户端错误不重试
          if (resp.status >= 400 && resp.status < 500) {
            return { ok: false, error: shortErr };
          }
          // 5xx 服务端错误：进入指数退避重试
          lastError = shortErr;
          continue;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(rawText);
        } catch {
          console.error(
            `[KbApi] request#${requestId} 响应非 JSON method=${method} path=${apiPath} attempt=${attempt + 1}/${MAX_RETRIES} elapsed=${Date.now() - attemptStart}ms\n` +
              `  url: ${urlForLog}\n` +
              `  params: ${paramsSummary}\n` +
              `  raw: ${truncateForLog(rawText)}`,
          );
          return {
            ok: false,
            error: `响应非合法 JSON: ${truncateForLog(rawText, API_ERROR_MESSAGE_BODY_MAX)}`,
          };
        }

        const result = parsed as {
          resultCode: number;
          resultMsg: string;
          data: T;
        };

        if (result.resultCode !== 1) {
          const dataStr =
            result.data !== undefined && result.data !== null
              ? truncateForLog(JSON.stringify(result.data), API_ERROR_MESSAGE_BODY_MAX)
              : '';
          const shortErr =
            `API error ${result.resultCode}: ${result.resultMsg}` + (dataStr ? ` | data=${dataStr}` : '');

          // 业务层限流（如 610012）：可恢复，触发限速器冷却后重试
          if (RATE_LIMIT_RESULT_CODES.has(result.resultCode)) {
            console.warn(
              `[KbApi] request#${requestId} 业务层限流 code=${result.resultCode} method=${method} path=${apiPath}` +
                ` attempt=${attempt + 1}/${MAX_RETRIES} elapsed=${Date.now() - attemptStart}ms\n` +
                `  url: ${urlForLog}\n` +
                `  params: ${paramsSummary}\n` +
                `  msg: ${result.resultMsg}`,
            );
            this.limiter?.onRateLimited();
            lastError = shortErr;
            lastErrorWasRateLimit = true;
            continue;
          }

          // 业务层临时服务端错误（如 uploadContent 偶发 "文件信息查询失败"）：
          // HTTP 是 200，但 resultCode 表示服务端短暂失败，按 5xx 语义退避重试。
          if (TRANSIENT_RESULT_CODES.has(result.resultCode)) {
            console.warn(
              `[KbApi] request#${requestId} 业务层临时错误 code=${result.resultCode} method=${method} path=${apiPath}` +
                ` attempt=${attempt + 1}/${MAX_RETRIES} elapsed=${Date.now() - attemptStart}ms\n` +
                `  url: ${urlForLog}\n` +
                `  params: ${paramsSummary}\n` +
                `  msg: ${result.resultMsg}`,
            );
            lastError = shortErr;
            continue;
          }

          // 其他业务错误：参数错误、权限不足等永久性错误，不重试
          console.error(
            `[KbApi] request#${requestId} 业务错误 method=${method} path=${apiPath} attempt=${attempt + 1}/${MAX_RETRIES} elapsed=${Date.now() - attemptStart}ms\n` +
              `  url: ${urlForLog}\n` +
              `  params: ${paramsSummary}\n` +
              `  response: ${truncateForLog(JSON.stringify(parsed))}`,
          );
          return { ok: false, error: shortErr };
        }

        const dataSummary =
          result.data != null ? summarizeParams({ data: result.data as unknown as Record<string, unknown> }) : '{}';
        console.log(
          `[KbApi] request#${requestId} success method=${method} path=${apiPath}` +
            ` attempt=${attempt + 1}/${MAX_RETRIES} elapsed=${Date.now() - attemptStart}ms total=${Date.now() - reqStart}ms\n` +
            `  data: ${dataSummary}`,
        );
        return { ok: true, value: result.data };
      } catch (e) {
        if (e instanceof Error && e.name === 'AbortError') {
          lastError = `请求超时(>${REQUEST_TIMEOUT_MS}ms)`;
        } else {
          lastError = e instanceof Error ? e.message : String(e);
        }
        console.error(
          `[KbApi] request#${requestId} 请求异常 method=${method} path=${apiPath} attempt=${attempt + 1}/${MAX_RETRIES}\n` +
            `  params: ${paramsSummary}\n` +
            `  error: ${lastError}`,
        );
      }
    }

    console.error(
      `[KbApi] request#${requestId} 已达最大重试 method=${method} path=${apiPath} total=${Date.now() - reqStart}ms\n` +
        `  params: ${paramsSummary}\n` +
        `  lastError: ${lastError}`,
    );
    return { ok: false, error: `请求失败(重试${MAX_RETRIES}次): ${lastError}` };
  }

  // ==================== 空间/目录 ====================

  /** 获取个人知识库空间 ID */
  async getPersonalProjectId(): Promise<ApiResult<string>> {
    const r = await this.request<string>('GET', API_PATHS.getPersonalProjectId);
    if (!r.ok) return r;
    return { ok: true, value: String(r.value) };
  }

  /** 获取一级目录列表 */
  async getLevel1Folders(projectId: string): Promise<ApiResult<FileListItem[]>> {
    return this.request<FileListItem[]>('GET', API_PATHS.getLevel1Folders, { projectId });
  }

  /** 子目录/文件浏览 */
  async getChildFiles(
    parentId: string,
    type?: number,
  ): Promise<ApiResult<FileListItem[]>> {
    const params: Record<string, unknown> = { parentId };
    if (type !== undefined) params.type = type;
    return this.request<FileListItem[]>('GET', API_PATHS.getChildFiles, params);
  }

  /** 子树扁平列举（含路径字段） */
  async listDescendantFiles(
    params: ListDescendantFilesParams,
  ): Promise<ApiResult<ListDescendantFilesResponse>> {
    return this.request<ListDescendantFilesResponse>(
      'GET',
      API_PATHS.listDescendantFiles,
      params as unknown as Record<string, unknown>,
    );
  }

  /** 增量变更列表 */
  async listChanges(params: ListChangesParams): Promise<ApiResult<ListChangesResponse>> {
    return this.request<ListChangesResponse>(
      'GET',
      API_PATHS.listChanges,
      params as unknown as Record<string, unknown>,
    );
  }

  // ==================== 文件内容 ====================

  /**
   * 获取文件下载凭据（4.2）。
   * 传 forceDownload=true 时 downloadUrl 为 OSS 签名直链，可直接 fetch 获取原始字节。
   */
  async getDownloadInfo(
    fileId: string,
    forceDownload = true,
  ): Promise<ApiResult<DownloadInfoVO>> {
    return this.request<DownloadInfoVO>('GET', API_PATHS.getDownloadInfo, {
      fileId,
      forceDownload,
    });
  }

  /** 读取文件全文（AI 提取通道，仅作兜底，优先用 getDownloadInfo） */
  async getFullFileContent(fileId: string): Promise<ApiResult<string>> {
    return this.request<string>('GET', API_PATHS.getFullFileContent, { fileId });
  }

  /**
   * 批量获取多个文件的提纯全文（4.15）
   * 建议单次 ≤10 个文件
   */
  async batchGetContent(
    files: { fileId: string }[],
  ): Promise<ApiResult<BatchGetContentItem[]>> {
    return this.request<BatchGetContentItem[]>('POST', API_PATHS.batchGetContent, { files });
  }

  /** 批量元数据（4.23） */
  async batchGetMeta(
    fileIds: string[],
    projectId?: string,
    opts?: Pick<BatchGetMetaParams, 'includePath' | 'rootFileId' | 'includeContentHash'>,
  ): Promise<ApiResult<FileMeta[]>> {
    return this.request<FileMeta[]>('POST', API_PATHS.batchGetMeta, {
      fileIds,
      projectId,
      ...(opts?.includePath !== undefined && { includePath: opts.includePath }),
      ...(opts?.rootFileId && { rootFileId: opts.rootFileId }),
      ...(opts?.includeContentHash !== undefined && { includeContentHash: opts.includeContentHash }),
    });
  }

  /**
   * 文件/文件夹重命名（同目录内改名）。
   * 不支持移动；需同时移动时请用 moveFile。
   */
  async updateFileName(params: UpdateFileNameParams): Promise<ApiResult<UpdateFileNameResult>> {
    return this.request<UpdateFileNameResult>('POST', API_PATHS.updateFileName, {
      fileId: params.fileId,
      newName: params.newName,
      ...(params.projectId !== undefined && { projectId: params.projectId }),
      ...(params.nameConflictStrategy !== undefined && {
        nameConflictStrategy: params.nameConflictStrategy,
      }),
      ...(params.rootFileId !== undefined && { rootFileId: params.rootFileId }),
    });
  }

  async moveFile(params: MoveFileParams): Promise<ApiResult<MoveFileResult>> {
    const body: Record<string, unknown> = {
      fileId: params.fileId,
      targetParentId: params.targetParentId,
    };
    if (params.projectId !== undefined) body.projectId = params.projectId;
    if (params.nameConflictStrategy !== undefined) {
      body.nameConflictStrategy = params.nameConflictStrategy;
    }
    if (params.rootFileId !== undefined) body.rootFileId = params.rootFileId;
    // 同步侧不传 newName；换目录+改名由 move 成功后 updateFileName 完成
    return this.request<MoveFileResult>('POST', API_PATHS.moveFile, body);
  }

  /**
   * 上传/更新文件（轻量高速通道）
   * - 新建：不传 updateFileId
   * - 更新：传 updateFileId → 自动创建新版本
   */
  async uploadContent(params: UploadContentParams): Promise<ApiResult<UploadContentResult>> {
    return this.request<UploadContentResult>('POST', API_PATHS.uploadContent, {
      ...params,
    });
  }

  // ==================== 分片上传 ====================

  /** 预检分片 MD5，支持秒传 */
  async getSliceIdByMd5V2(md5: string, size: number, suffix?: string): Promise<ApiResult<SliceCheckResult>> {
    const params: Record<string, unknown> = { md5, size };
    if (suffix) params.suffix = suffix;
    return this.request<SliceCheckResult>('GET', API_PATHS.getSliceIdByMd5V2, params);
  }

  /** 注册已物理上传的分片 */
  async uploadFileSliceV2(params: UploadFileSliceParams): Promise<ApiResult<number>> {
    return this.request<number>('POST', API_PATHS.uploadFileSliceV2, { ...params });
  }

  /** 合并所有分片生成 resourceId */
  async saveResource(params: SaveResourceParams): Promise<ApiResult<number>> {
    return this.request<number>('POST', API_PATHS.saveResource, { ...params });
  }

  // ==================== 物理文件入库 ====================

  /** 通过路径保存文件到项目（自动递归创建目录），返回 fileId */
  async saveFileByPath(params: SaveFileToProjectParams): Promise<ApiResult<number>> {
    return this.request<number>('POST', API_PATHS.saveFileByPath, { ...params });
  }

  /** 通过父目录 ID 保存文件到项目，返回 fileId */
  async saveFileByParentId(params: SaveFileToProjectParams): Promise<ApiResult<number>> {
    return this.request<number>('POST', API_PATHS.saveFileByParentId, { ...params });
  }

  /** 上传新文件内容以更新文件版本，返回 fileId */
  async updateFileVersion(params: UpdateFileVersionParams): Promise<ApiResult<number>> {
    return this.request<number>('POST', API_PATHS.updateFileVersion, { ...params });
  }

  /** 删除文件 */
  async deleteFile(fileId: string): Promise<ApiResult<boolean>> {
    const r = await this.request<unknown>('POST', API_PATHS.deleteFile, { fileId });
    if (!r.ok) return r;
    return { ok: true, value: true };
  }

  /** 显式创建空目录（4.24） */
  async createFolder(params: CreateFolderParams): Promise<ApiResult<string>> {
    const r = await this.request<string>('POST', API_PATHS.createFolder, {
      ...params,
    });
    if (!r.ok) return r;
    return { ok: true, value: String(r.value) };
  }

  /** 获取版本列表（调试用） */
  async getVersionList(fileId: string): Promise<ApiResult<unknown[]>> {
    return this.request<unknown[]>('GET', API_PATHS.getVersionList, { fileId });
  }
}
