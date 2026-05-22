"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.VERSION_REMARK = exports.DEFAULT_MAX_CONCURRENT_MAPPINGS = exports.DEFAULT_MANAGEMENT_HOST = exports.DEFAULT_MANAGEMENT_PORT = exports.DEFAULT_FULL_RECONCILE_INTERVAL_SEC = exports.DEFAULT_AUTO_SYNC_INTERVAL_SEC = exports.DEFAULT_SERVER_URL = exports.DEFAULT_DB_PATH = exports.DEFAULT_EXCLUDE_PATTERNS = exports.DEFAULT_FILE_PATTERNS = exports.MTIME_TOLERANCE_MS = exports.API_ERROR_MESSAGE_BODY_MAX = exports.API_ERROR_LOG_MAX_CHARS = exports.REQUEST_TIMEOUT_MS = exports.RETRY_BASE_DELAY_MS = exports.MAX_RETRIES = exports.CHANGES_SAFETY_WINDOW_MS = exports.STARTUP_JITTER_MAX_MS = exports.TRANSIENT_RESULT_CODES = exports.RATE_LIMIT_RESULT_CODES = exports.RATE_LIMIT_COOLDOWN_MS = exports.DEFAULT_RATE_LIMIT_BURST = exports.DEFAULT_MAX_REQUESTS_PER_MINUTE = exports.EXECUTE_BATCH_PAUSE_MS = exports.UPLOAD_CONCURRENCY = exports.DOWNLOAD_CONCURRENCY = exports.BATCH_GET_META_MAX = exports.BATCH_GET_CONTENT_MAX = exports.DEFAULT_RENAME_NAME_CONFLICT_STRATEGY = exports.DEFAULT_MOVE_NAME_CONFLICT_STRATEGY = exports.MOVE_FILE_CONFLICT = exports.UPDATE_FILE_NAME_CONFLICT = exports.API_PATHS = void 0;
exports.cleanContent = cleanContent;
exports.extractUniqueSuffix = extractUniqueSuffix;
exports.API_PATHS = {
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
};
/**
 * updateFileName 名称冲突策略。
 * 冲突是指目标目录下已存在同名节点。
 */
exports.UPDATE_FILE_NAME_CONFLICT = {
    /** 自动追加后缀重命名（如 "file (1).md"），不报错 */
    RENAME: 0,
    /** 抛出异常，由调用方决策 */
    ERROR: 1,
};
/**
 * moveFile 名称冲突策略。
 * 冲突是指目标父目录下已存在同名节点。
 *
 * 注意：COVER 策略会导致 fileId 变更，调用方需处理 idMappings。
 */
exports.MOVE_FILE_CONFLICT = {
    /** 自动追加后缀重命名目标侧节点，不删除任何文件 */
    RENAME: 0,
    /** 覆盖目标：保留冲突文件的 fileId，将移动文件作为其新版本；fileId 随之变更 */
    COVER: 1,
    /** 抛出异常，由调用方决策 */
    ERROR: 2,
    /** 跳过该冲突项 */
    SKIP: 3,
};
/** moveFile 默认冲突策略：3=跳过（用户可在 mapping.moveNameConflictStrategy 覆盖） */
exports.DEFAULT_MOVE_NAME_CONFLICT_STRATEGY = exports.MOVE_FILE_CONFLICT.SKIP;
/** updateFileName 默认冲突策略：1=抛异常（KB 省略时亦为 1） */
exports.DEFAULT_RENAME_NAME_CONFLICT_STRATEGY = exports.UPDATE_FILE_NAME_CONFLICT.ERROR;
/** batchGetContent 单批最大文件数 */
exports.BATCH_GET_CONTENT_MAX = 10;
/** batchGetMeta 单批最大文件数 */
exports.BATCH_GET_META_MAX = 50;
/** 并发下载 OSS 文件的最大并发数（默认值，可被 config.downloadConcurrency 覆盖） */
exports.DOWNLOAD_CONCURRENCY = 5;
/** 并发上传文件的最大并发数（默认值，可被 config.uploadConcurrency 覆盖） */
exports.UPLOAD_CONCURRENCY = 3;
/** 每批执行完成后的间隔（毫秒），为限速器补充令牌、平滑突发 */
exports.EXECUTE_BATCH_PAUSE_MS = 300;
/** 默认每分钟最大 API 请求数（令牌桶稳态速率） */
exports.DEFAULT_MAX_REQUESTS_PER_MINUTE = 60;
/** 默认令牌桶突发容量 */
exports.DEFAULT_RATE_LIMIT_BURST = 8;
/** 收到 429 后限速器默认冷却时间（毫秒） */
exports.RATE_LIMIT_COOLDOWN_MS = 60_000;
/**
 * 知识库业务层限流错误码集合。
 * 收到这些 resultCode 时应视为可恢复的限流，触发限速器冷却后重试，而非永久错误。
 * 610012 = "请求太过频繁，请稍候再试！"（按 appKey 全局限流）
 */
exports.RATE_LIMIT_RESULT_CODES = new Set([610012]);
/** 业务层临时服务端错误码：HTTP 为 200 但 resultCode 表示服务端短暂失败，应退避重试 */
exports.TRANSIENT_RESULT_CODES = new Set([500]);
/** 启动时随机抖动最大值（毫秒），分散多实例同时启动导致的请求突刺 */
exports.STARTUP_JITTER_MAX_MS = 20_000;
/** listChanges 安全回拨窗口（毫秒），避免时钟偏差漏事件 */
exports.CHANGES_SAFETY_WINDOW_MS = 5_000;
/** HTTP 请求最大重试次数 */
exports.MAX_RETRIES = 3;
/** 指数退避基础延迟（毫秒） */
exports.RETRY_BASE_DELAY_MS = 1_000;
/** HTTP 请求超时（毫秒），防止服务端挂起永久阻塞 */
exports.REQUEST_TIMEOUT_MS = 30_000;
/** API 失败时控制台诊断日志中单段文本最大长度 */
exports.API_ERROR_LOG_MAX_CHARS = 4096;
/** API 失败时写入 ApiResult.error / SQLite lastError 的响应摘要最大长度 */
exports.API_ERROR_MESSAGE_BODY_MAX = 800;
/** mtime 比较容差（毫秒），消除精度误差 */
exports.MTIME_TOLERANCE_MS = 1_000;
/** 默认同步文件匹配模式 */
exports.DEFAULT_FILE_PATTERNS = ['**/*.md'];
/** 默认排除匹配模式 */
exports.DEFAULT_EXCLUDE_PATTERNS = ['**/_conflict_*', '**/.tmp/**'];
/** 默认状态库文件路径 */
exports.DEFAULT_DB_PATH = './openclaw-sync-state.db';
/** 默认知识库 Open API 根地址（生产环境） */
exports.DEFAULT_SERVER_URL = 'https://sg-al-cwork-web.mediportal.com.cn/open-api/';
/** 默认自动同步间隔（秒） */
exports.DEFAULT_AUTO_SYNC_INTERVAL_SEC = 180;
/** 默认强制全量对账间隔（秒），用于修复 listChanges 或本地状态库漏记录 */
exports.DEFAULT_FULL_RECONCILE_INTERVAL_SEC = 3600;
/** 默认 HTTP 管理 API 端口 */
exports.DEFAULT_MANAGEMENT_PORT = 9090;
/** 默认 HTTP 管理 API 监听地址 */
exports.DEFAULT_MANAGEMENT_HOST = '0.0.0.0';
/** 默认最大并发 mapping 数 */
exports.DEFAULT_MAX_CONCURRENT_MAPPINGS = 2;
/** 版本备注 */
exports.VERSION_REMARK = 'OpenClaw Sync Agent';
/**
 * 清理知识库返回的正文（去除分页页脚等）。
 * raw 为 null/undefined 时返回空字符串。
 */
function cleanContent(raw) {
    if (raw == null)
        return '';
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
function extractUniqueSuffix(patterns) {
    const suffixes = new Set();
    for (const p of patterns) {
        const m = p.match(/\*\.([a-zA-Z0-9]+)$/);
        if (!m)
            return undefined; // 含有非扩展名的复杂 pattern，无法推断
        suffixes.add(m[1].toLowerCase());
    }
    return suffixes.size === 1 ? [...suffixes][0] : undefined;
}
//# sourceMappingURL=constants.js.map