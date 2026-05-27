"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.getDefaultConfigRaw = getDefaultConfigRaw;
exports.configToRaw = configToRaw;
exports.writeConfigFile = writeConfigFile;
exports.loadConfig = loadConfig;
exports.loadConfigWithMeta = loadConfigWithMeta;
exports.validateMapping = validateMapping;
exports.generateUniqueMappingId = generateUniqueMappingId;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const crypto_1 = require("crypto");
const constants_1 = require("./constants");
const DEFAULT_CONFIG_PATH = './config.json';
/**
 * 默认 config.json 内容（可序列化对象，不含 appKey）。
 * 服务可在无 mapping、无密钥时启动，通过 Web 控制台或管理 API 后续补全。
 */
function getDefaultConfigRaw() {
    return {
        serverUrl: constants_1.DEFAULT_SERVER_URL,
        syncDirection: 'bidirectional',
        autoSyncIntervalSec: constants_1.DEFAULT_AUTO_SYNC_INTERVAL_SEC,
        fullReconcileIntervalSec: constants_1.DEFAULT_FULL_RECONCILE_INTERVAL_SEC,
        stateDbPath: constants_1.DEFAULT_DB_PATH,
        maxConcurrentMappingsMode: 'auto',
        maxConcurrentMappings: constants_1.DEFAULT_MAX_CONCURRENT_MAPPINGS,
        maxRequestsPerMinute: constants_1.DEFAULT_MAX_REQUESTS_PER_MINUTE,
        rateLimitBurst: constants_1.DEFAULT_RATE_LIMIT_BURST,
        rateLimitCooldownSec: constants_1.RATE_LIMIT_COOLDOWN_MS / 1000,
        downloadConcurrency: constants_1.DOWNLOAD_CONCURRENCY,
        uploadConcurrency: constants_1.UPLOAD_CONCURRENCY,
        startupJitterMaxSec: constants_1.STARTUP_JITTER_MAX_MS / 1000,
        managementPort: constants_1.DEFAULT_MANAGEMENT_PORT,
        managementHost: constants_1.DEFAULT_MANAGEMENT_HOST,
        watchEnabled: constants_1.DEFAULT_WATCH_ENABLED,
        pushDebounceMs: constants_1.DEFAULT_PUSH_DEBOUNCE_MS,
        watchUsePolling: constants_1.DEFAULT_WATCH_USE_POLLING,
        mappings: [],
    };
}
/** 将内存中的 SyncConfig 转为可写入 config.json 的对象（省略 undefined 字段） */
function configToRaw(config) {
    const raw = {
        serverUrl: config.serverUrl,
        syncDirection: config.syncDirection,
        autoSyncIntervalSec: config.autoSyncIntervalSec,
        fullReconcileIntervalSec: config.fullReconcileIntervalSec,
        stateDbPath: config.stateDbPath,
        maxConcurrentMappingsMode: config.maxConcurrentMappingsMode,
        maxConcurrentMappings: config.maxConcurrentMappings,
        maxRequestsPerMinute: config.maxRequestsPerMinute,
        rateLimitBurst: config.rateLimitBurst,
        rateLimitCooldownSec: config.rateLimitCooldownSec,
        downloadConcurrency: config.downloadConcurrency,
        uploadConcurrency: config.uploadConcurrency,
        startupJitterMaxSec: config.startupJitterMaxSec,
        managementPort: config.managementPort,
        managementHost: config.managementHost,
        watchEnabled: config.watchEnabled,
        pushDebounceMs: config.pushDebounceMs,
        watchUsePolling: config.watchUsePolling,
        mappings: config.mappings,
    };
    if (config.appKey)
        raw.appKey = config.appKey;
    return raw;
}
/** 原子写入 config.json */
function writeConfigFile(configPath, raw) {
    const absPath = path.resolve(configPath);
    const dir = path.dirname(absPath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    const tmpPath = absPath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(raw, null, 2) + '\n', 'utf-8');
    fs.renameSync(tmpPath, absPath);
}
function isEmptyConfigRaw(raw) {
    if (raw === null || raw === undefined)
        return true;
    if (typeof raw !== 'object' || Array.isArray(raw))
        return true;
    return Object.keys(raw).length === 0;
}
function isIncompleteConfigRaw(obj) {
    const defaults = getDefaultConfigRaw();
    for (const key of Object.keys(defaults)) {
        if (key === 'mappings') {
            if (!Array.isArray(obj.mappings))
                return true;
            continue;
        }
        if (!(key in obj))
            return true;
    }
    return false;
}
/** 用默认值补全部分配置；保留用户已填的 appKey、mappings 等字段 */
function mergeWithDefaultConfigRaw(partial) {
    const defaults = getDefaultConfigRaw();
    const merged = { ...defaults, ...partial };
    merged.mappings = Array.isArray(partial.mappings) ? partial.mappings : [];
    const appKey = partial.appKey;
    if (typeof appKey === 'string' && appKey.trim()) {
        merged.appKey = appKey.trim();
    }
    else {
        delete merged.appKey;
    }
    return merged;
}
function readConfigRaw(absPath) {
    const text = fs.readFileSync(absPath, 'utf-8').trim();
    if (text === '')
        return {};
    return JSON.parse(text);
}
/**
 * 从 JSON 文件加载并验证配置。
 * 文件不存在、为空、`{}`、不完整或 JSON 解析失败时，自动合并/写入默认 config.json 并继续启动。
 */
function loadConfig(configPath = DEFAULT_CONFIG_PATH) {
    return loadConfigWithMeta(configPath).config;
}
function loadConfigWithMeta(configPath = DEFAULT_CONFIG_PATH) {
    const absPath = path.resolve(configPath);
    let bootstrapped = false;
    let bootstrapReason = '';
    let raw;
    if (!fs.existsSync(absPath)) {
        raw = getDefaultConfigRaw();
        bootstrapped = true;
        bootstrapReason = '配置文件不存在，已生成默认配置';
    }
    else {
        try {
            raw = readConfigRaw(absPath);
        }
        catch (e) {
            raw = getDefaultConfigRaw();
            bootstrapped = true;
            bootstrapReason = `配置文件解析失败，已重置为默认配置（${e instanceof Error ? e.message : String(e)}）`;
        }
        if (!bootstrapped) {
            if (isEmptyConfigRaw(raw)) {
                raw = getDefaultConfigRaw();
                bootstrapped = true;
                bootstrapReason = '配置文件为空，已写入默认配置';
            }
            else if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
                raw = getDefaultConfigRaw();
                bootstrapped = true;
                bootstrapReason = '配置文件格式无效，已重置为默认配置';
            }
            else {
                const obj = raw;
                if (isIncompleteConfigRaw(obj)) {
                    raw = mergeWithDefaultConfigRaw(obj);
                    bootstrapped = true;
                    bootstrapReason = '配置文件不完整，已合并默认配置';
                }
            }
        }
    }
    const config = validateConfig(raw, absPath);
    if (bootstrapped) {
        writeConfigFile(absPath, configToRaw(config));
        console.log(`[Config] ${bootstrapReason}: ${absPath}`);
    }
    return { config, bootstrapped };
}
function validateConfig(raw, filePath) {
    if (typeof raw !== 'object' || raw === null) {
        throw new Error(`配置文件内容必须是 JSON 对象: ${filePath}`);
    }
    const obj = raw;
    const serverUrl = typeof obj.serverUrl === 'string' && obj.serverUrl.trim()
        ? obj.serverUrl.trim()
        : constants_1.DEFAULT_SERVER_URL;
    const rawAppKey = obj.appKey;
    const globalAppKey = typeof rawAppKey === 'string' && rawAppKey.trim() !== '' ? rawAppKey.trim() : undefined;
    const mappingsInput = Array.isArray(obj.mappings) ? obj.mappings : [];
    const syncDirection = obj.syncDirection ?? 'bidirectional';
    if (!['bidirectional', 'push', 'pull'].includes(syncDirection)) {
        throw new Error(`配置 "syncDirection" 必须是 "bidirectional" | "push" | "pull": ${filePath}`);
    }
    const mappings = mappingsInput.map((m, idx) => validateMapping(m, idx, filePath));
    // 校验同一 localRoot 不映射到多个云端根
    const localRootSet = new Map();
    for (const m of mappings) {
        const norm = path.resolve(m.localRoot);
        if (localRootSet.has(norm)) {
            throw new Error(`配置错误: localRoot "${m.localRoot}" 被多个 mapping 使用（mappingId: ${localRootSet.get(norm)} 和 ${m.mappingId}），可能引起回环`);
        }
        localRootSet.set(norm, m.mappingId);
    }
    return {
        serverUrl,
        ...(globalAppKey !== undefined ? { appKey: globalAppKey } : {}),
        syncDirection: syncDirection,
        autoSyncIntervalSec: typeof obj.autoSyncIntervalSec === 'number'
            ? obj.autoSyncIntervalSec
            : constants_1.DEFAULT_AUTO_SYNC_INTERVAL_SEC,
        fullReconcileIntervalSec: typeof obj.fullReconcileIntervalSec === 'number'
            ? obj.fullReconcileIntervalSec
            : constants_1.DEFAULT_FULL_RECONCILE_INTERVAL_SEC,
        stateDbPath: typeof obj.stateDbPath === 'string' && obj.stateDbPath.trim()
            ? obj.stateDbPath.trim()
            : constants_1.DEFAULT_DB_PATH,
        maxConcurrentMappingsMode: obj.maxConcurrentMappingsMode === 'manual' ? 'manual' : 'auto',
        maxConcurrentMappings: typeof obj.maxConcurrentMappings === 'number'
            ? obj.maxConcurrentMappings
            : constants_1.DEFAULT_MAX_CONCURRENT_MAPPINGS,
        maxRequestsPerMinute: typeof obj.maxRequestsPerMinute === 'number'
            ? obj.maxRequestsPerMinute
            : constants_1.DEFAULT_MAX_REQUESTS_PER_MINUTE,
        rateLimitBurst: typeof obj.rateLimitBurst === 'number' ? obj.rateLimitBurst : constants_1.DEFAULT_RATE_LIMIT_BURST,
        rateLimitCooldownSec: typeof obj.rateLimitCooldownSec === 'number'
            ? obj.rateLimitCooldownSec
            : constants_1.RATE_LIMIT_COOLDOWN_MS / 1000,
        downloadConcurrency: typeof obj.downloadConcurrency === 'number' ? obj.downloadConcurrency : constants_1.DOWNLOAD_CONCURRENCY,
        uploadConcurrency: typeof obj.uploadConcurrency === 'number' ? obj.uploadConcurrency : constants_1.UPLOAD_CONCURRENCY,
        startupJitterMaxSec: typeof obj.startupJitterMaxSec === 'number'
            ? obj.startupJitterMaxSec
            : constants_1.STARTUP_JITTER_MAX_MS / 1000,
        managementPort: typeof obj.managementPort === 'number' ? obj.managementPort : constants_1.DEFAULT_MANAGEMENT_PORT,
        managementHost: typeof obj.managementHost === 'string' && obj.managementHost.trim()
            ? obj.managementHost.trim()
            : constants_1.DEFAULT_MANAGEMENT_HOST,
        watchEnabled: typeof obj.watchEnabled === 'boolean' ? obj.watchEnabled : constants_1.DEFAULT_WATCH_ENABLED,
        pushDebounceMs: typeof obj.pushDebounceMs === 'number'
            ? Math.max(100, obj.pushDebounceMs)
            : constants_1.DEFAULT_PUSH_DEBOUNCE_MS,
        watchUsePolling: typeof obj.watchUsePolling === 'boolean'
            ? obj.watchUsePolling
            : constants_1.DEFAULT_WATCH_USE_POLLING,
        mappings,
    };
}
function validateMapping(raw, idx, filePath) {
    if (typeof raw !== 'object' || raw === null) {
        throw new Error(`mappings[${idx}] 必须是对象: ${filePath}`);
    }
    const m = raw;
    const loc = `mappings[${idx}]`;
    assertString(m, 'mappingId', filePath, loc);
    assertString(m, 'localRoot', filePath, loc);
    const hasFileId = typeof m.remoteRootFileId === 'string' && m.remoteRootFileId.trim() !== '';
    const hasFolderPath = typeof m.remoteRootFolderPath === 'string' && m.remoteRootFolderPath.trim() !== '';
    // 两者均不填时表示同步 projectId 空间的根目录，合法。
    if (m.enabled !== undefined && typeof m.enabled !== 'boolean') {
        throw new Error(`${loc}.enabled 必须是 boolean: ${filePath}`);
    }
    const filePatterns = Array.isArray(m.filePatterns)
        ? m.filePatterns
        : constants_1.DEFAULT_FILE_PATTERNS;
    const excludePatterns = (0, constants_1.mergeDefaultExcludePatterns)(Array.isArray(m.excludePatterns) ? m.excludePatterns : undefined);
    const mappingAppKey = typeof m.appKey === 'string' && m.appKey.trim()
        ? m.appKey.trim()
        : undefined;
    const validDirections = ['bidirectional', 'push', 'pull'];
    const rawDir = m.syncDirection;
    if (rawDir !== undefined && !validDirections.includes(rawDir)) {
        throw new Error(`${loc}.syncDirection 必须是 "bidirectional" | "push" | "pull": ${filePath}`);
    }
    const mappingSyncDirection = rawDir && validDirections.includes(rawDir)
        ? rawDir
        : undefined;
    const moveNameConflictStrategy = parseMoveConflictStrategy(m.moveNameConflictStrategy, filePath, loc);
    const renameNameConflictStrategy = parseRenameConflictStrategy(m.renameNameConflictStrategy, filePath, loc);
    if (m.enableFileIndex !== undefined && typeof m.enableFileIndex !== 'boolean') {
        throw new Error(`${loc}.enableFileIndex 必须是 boolean: ${filePath}`);
    }
    if (m.watchEnabled !== undefined && typeof m.watchEnabled !== 'boolean') {
        throw new Error(`${loc}.watchEnabled 必须是 boolean: ${filePath}`);
    }
    if (m.pushDebounceMs !== undefined && typeof m.pushDebounceMs !== 'number') {
        throw new Error(`${loc}.pushDebounceMs 必须是 number: ${filePath}`);
    }
    if (m.watchUsePolling !== undefined && typeof m.watchUsePolling !== 'boolean') {
        throw new Error(`${loc}.watchUsePolling 必须是 boolean: ${filePath}`);
    }
    return {
        mappingId: m.mappingId,
        enabled: typeof m.enabled === 'boolean' ? m.enabled : true,
        localRoot: m.localRoot,
        appKey: mappingAppKey,
        projectId: typeof m.projectId === 'string' ? m.projectId : undefined,
        remoteRootFileId: hasFileId ? m.remoteRootFileId : undefined,
        remoteRootFolderPath: hasFolderPath ? m.remoteRootFolderPath : undefined,
        filePatterns,
        excludePatterns,
        syncDirection: mappingSyncDirection,
        moveNameConflictStrategy,
        renameNameConflictStrategy,
        enableFileIndex: typeof m.enableFileIndex === 'boolean' ? m.enableFileIndex : undefined,
        watchEnabled: typeof m.watchEnabled === 'boolean' ? m.watchEnabled : undefined,
        pushDebounceMs: typeof m.pushDebounceMs === 'number' ? m.pushDebounceMs : undefined,
        watchUsePolling: typeof m.watchUsePolling === 'boolean' ? m.watchUsePolling : undefined,
    };
}
function parseMoveConflictStrategy(raw, filePath, loc) {
    if (raw === undefined || raw === null)
        return undefined;
    const n = typeof raw === 'number' ? raw : Number(raw);
    if (![0, 1, 2, 3].includes(n)) {
        throw new Error(`${loc}.moveNameConflictStrategy 必须是 0|1|2|3: ${filePath}`);
    }
    return n;
}
function parseRenameConflictStrategy(raw, filePath, loc) {
    if (raw === undefined || raw === null)
        return undefined;
    const n = typeof raw === 'number' ? raw : Number(raw);
    if (![0, 1].includes(n)) {
        throw new Error(`${loc}.renameNameConflictStrategy 必须是 0|1: ${filePath}`);
    }
    return n;
}
/**
 * 为 POST /mappings 生成不与现有列表冲突的 mappingId。
 */
function generateUniqueMappingId(existingIds) {
    const used = new Set(existingIds);
    for (let n = 0; n < 64; n++) {
        const id = `map-${(0, crypto_1.randomBytes)(8).toString('hex')}`;
        if (!used.has(id))
            return id;
    }
    throw new Error('无法自动生成唯一 mappingId，请在请求体中显式指定 mappingId');
}
function assertString(obj, key, filePath, prefix) {
    const label = prefix ? `${prefix}.${key}` : key;
    if (typeof obj[key] !== 'string' || !obj[key].trim()) {
        throw new Error(`配置 "${label}" 必须是非空字符串: ${filePath}`);
    }
}
//# sourceMappingURL=config.js.map