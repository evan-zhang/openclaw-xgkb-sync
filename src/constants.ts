export const API_PATHS = {
  getChildFiles: 'document-database/file/getChildFiles',
  listDescendantFiles: 'document-database/file/listDescendantFiles',
  listChanges: 'document-database/file/listChanges',
  batchGetMeta: 'document-database/file/batchGetMeta',
  createFolder: 'document-database/file/createFolder',
  getDownloadInfo: 'document-database/file/getDownloadInfo',
  getFileContent: 'document-database/file/getFileContent',
  getFullFileContent: 'document-database/file/getFullFileContent',
  uploadContent: 'document-database/file/uploadContent',
  searchFile: 'document-database/file/searchFile',
  getLevel1Folders: 'document-database/file/getLevel1Folders',
  deleteFile: 'document-database/file/deleteFile',
  getVersionList: 'document-database/file/getVersionList',
  getPersonalProjectId: 'document-database/project/personal/getProjectId',
  getProjectList: 'document-database/project/list',
  /** 见《03-AI与纯文本高速通道》4.15，建议单次不超过 10 个文件 */
  batchGetContent: 'document-database/ai/batchGetContent',
  /** 文件/文件夹重命名（同目录内改名，不移动） */
  updateFileName: 'document-database/file/updateFileName',
  /** 文件/文件夹移动到其他目录（可同时改名） */
  moveFile: 'document-database/file/moveFile',
} as const;

/**
 * updateFileName 名称冲突策略。
 * 冲突是指目标目录下已存在同名节点。
 */
export const UPDATE_FILE_NAME_CONFLICT = {
  /** 自动追加后缀重命名（如 "file (1).md"），不报错 */
  RENAME: 0,
  /** 抛出异常，由调用方决策 */
  ERROR: 1,
} as const;
export type UpdateFileNameConflict = (typeof UPDATE_FILE_NAME_CONFLICT)[keyof typeof UPDATE_FILE_NAME_CONFLICT];

/**
 * moveFile 名称冲突策略。
 * 冲突是指目标父目录下已存在同名节点。
 *
 * 注意：COVER 策略会导致 fileId 变更，调用方需处理 idMappings。
 */
export const MOVE_FILE_CONFLICT = {
  /** 自动追加后缀重命名目标侧节点，不删除任何文件 */
  RENAME: 0,
  /** 覆盖目标：保留冲突文件的 fileId，将移动文件作为其新版本；fileId 随之变更 */
  COVER: 1,
  /** 抛出异常，由调用方决策 */
  ERROR: 2,
  /** 跳过该冲突项 */
  SKIP: 3,
} as const;
export type MoveFileConflict = (typeof MOVE_FILE_CONFLICT)[keyof typeof MOVE_FILE_CONFLICT];

/** moveFile 默认冲突策略：3=跳过（用户可在 mapping.moveNameConflictStrategy 覆盖） */
export const DEFAULT_MOVE_NAME_CONFLICT_STRATEGY: MoveFileConflict = MOVE_FILE_CONFLICT.SKIP;

/** updateFileName 默认冲突策略：1=抛异常（KB 省略时亦为 1） */
export const DEFAULT_RENAME_NAME_CONFLICT_STRATEGY: UpdateFileNameConflict =
  UPDATE_FILE_NAME_CONFLICT.ERROR;

/** batchGetContent 单批最大文件数 */
export const BATCH_GET_CONTENT_MAX = 10;

/** batchGetMeta 单批最大文件数 */
export const BATCH_GET_META_MAX = 50;

/** 并发下载 OSS 文件的最大并发数（默认值，可被 config.downloadConcurrency 覆盖） */
export const DOWNLOAD_CONCURRENCY = 5;

/** 并发上传文件的最大并发数（默认值，可被 config.uploadConcurrency 覆盖） */
export const UPLOAD_CONCURRENCY = 3;

/** 每批执行完成后的间隔（毫秒），为限速器补充令牌、平滑突发 */
export const EXECUTE_BATCH_PAUSE_MS = 300;

/** 默认每分钟最大 API 请求数（令牌桶稳态速率） */
export const DEFAULT_MAX_REQUESTS_PER_MINUTE = 60;

/** 默认令牌桶突发容量 */
export const DEFAULT_RATE_LIMIT_BURST = 8;

/** 收到 429 后限速器默认冷却时间（毫秒） */
export const RATE_LIMIT_COOLDOWN_MS = 60_000;

/**
 * 知识库业务层限流错误码集合。
 * 收到这些 resultCode 时应视为可恢复的限流，触发限速器冷却后重试，而非永久错误。
 * 610012 = "请求太过频繁，请稍候再试！"（按 appKey 全局限流）
 */
export const RATE_LIMIT_RESULT_CODES = new Set<number>([610012]);

/** 业务层临时服务端错误码：HTTP 为 200 但 resultCode 表示服务端短暂失败，应退避重试 */
export const TRANSIENT_RESULT_CODES = new Set<number>([500]);

/** 启动时随机抖动最大值（毫秒），分散多实例同时启动导致的请求突刺 */
export const STARTUP_JITTER_MAX_MS = 20_000;

/** listChanges 安全回拨窗口（毫秒），避免时钟偏差漏事件 */
export const CHANGES_SAFETY_WINDOW_MS = 5_000;

/** HTTP 请求最大重试次数 */
export const MAX_RETRIES = 3;

/** 指数退避基础延迟（毫秒） */
export const RETRY_BASE_DELAY_MS = 1_000;

/** HTTP 请求超时（毫秒），防止服务端挂起永久阻塞 */
export const REQUEST_TIMEOUT_MS = 30_000;

/** API 失败时控制台诊断日志中单段文本最大长度 */
export const API_ERROR_LOG_MAX_CHARS = 4096;

/** API 失败时写入 ApiResult.error / SQLite lastError 的响应摘要最大长度 */
export const API_ERROR_MESSAGE_BODY_MAX = 800;

/** mtime 比较容差（毫秒），消除精度误差 */
export const MTIME_TOLERANCE_MS = 1_000;

/** 默认同步文件匹配模式 */
export const DEFAULT_FILE_PATTERNS = ['**/*.md'];

/** 默认排除匹配模式 */
export const DEFAULT_EXCLUDE_PATTERNS = ['**/_conflict_*', '**/.tmp/**'];

/** 默认状态库文件路径 */
export const DEFAULT_DB_PATH = './openclaw-sync-state.db';

/** 默认知识库 Open API 根地址（生产环境） */
export const DEFAULT_SERVER_URL = 'https://sg-al-cwork-web.mediportal.com.cn/open-api/';

/** 默认自动同步间隔（秒） */
export const DEFAULT_AUTO_SYNC_INTERVAL_SEC = 180;

/** 默认强制全量对账间隔（秒），用于修复 listChanges 或本地状态库漏记录 */
export const DEFAULT_FULL_RECONCILE_INTERVAL_SEC = 3600;

/** 默认 HTTP 管理 API 端口 */
export const DEFAULT_MANAGEMENT_PORT = 9090;

/** 默认 HTTP 管理 API 监听地址 */
export const DEFAULT_MANAGEMENT_HOST = '0.0.0.0';

/** 默认最大并发 mapping 数 */
export const DEFAULT_MAX_CONCURRENT_MAPPINGS = 2;

/** 版本备注 */
export const VERSION_REMARK = 'OpenClaw Sync Agent';

/**
 * 清理知识库返回的正文（去除分页页脚等）。
 * raw 为 null/undefined 时返回空字符串。
 */
export function cleanContent(raw: string | null | undefined): string {
  if (raw == null) return '';
  return raw.replace(/\n*Page \d+ of \d+\s*$/, '').trimEnd() + '\n';
}

/**
 * 从 filePatterns 中提取唯一的文件扩展名，用于 API 级别的 suffix 过滤。
 * - 若所有 pattern 均为 `**\/*.ext` 形式且扩展名相同，返回该扩展名
 * - 否则返回 undefined（由调用方做客户端过滤）
 *
 * @example
 *   extractUniqueSuffix(['**\/*.md']) => 'md'
 *   extractUniqueSuffix(['**\/*.md', '**\/*.txt']) => undefined
 *   extractUniqueSuffix(['**\/*.md', '**\/subdir\/*.md']) => 'md'
 */
export function extractUniqueSuffix(patterns: string[]): string | undefined {
  const suffixes = new Set<string>();
  for (const p of patterns) {
    const m = p.match(/\*\.([a-zA-Z0-9]+)$/);
    if (!m) return undefined; // 含有非扩展名的复杂 pattern，无法推断
    suffixes.add(m[1].toLowerCase());
  }
  return suffixes.size === 1 ? [...suffixes][0] : undefined;
}
