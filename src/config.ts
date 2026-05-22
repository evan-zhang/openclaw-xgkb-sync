import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { SyncConfig, SyncMapping } from './types';
import {
  DEFAULT_AUTO_SYNC_INTERVAL_SEC,
  DEFAULT_DB_PATH,
  DEFAULT_EXCLUDE_PATTERNS,
  DEFAULT_FILE_PATTERNS,
  DEFAULT_FULL_RECONCILE_INTERVAL_SEC,
  DEFAULT_MANAGEMENT_HOST,
  DEFAULT_MANAGEMENT_PORT,
  DEFAULT_MAX_CONCURRENT_MAPPINGS,
  DEFAULT_MAX_REQUESTS_PER_MINUTE,
  DEFAULT_RATE_LIMIT_BURST,
  DEFAULT_SERVER_URL,
  DOWNLOAD_CONCURRENCY,
  RATE_LIMIT_COOLDOWN_MS,
  STARTUP_JITTER_MAX_MS,
  UPLOAD_CONCURRENCY,
} from './constants';

const DEFAULT_CONFIG_PATH = './config.json';

export type LoadConfigResult = {
  config: SyncConfig;
  /** 本次是否新建或回填/合并了 config.json */
  bootstrapped: boolean;
};

/**
 * 默认 config.json 内容（可序列化对象，不含 appKey）。
 * 服务可在无 mapping、无密钥时启动，通过 Web 控制台或管理 API 后续补全。
 */
export function getDefaultConfigRaw(): Record<string, unknown> {
  return {
    serverUrl: DEFAULT_SERVER_URL,
    syncDirection: 'bidirectional',
    autoSyncIntervalSec: DEFAULT_AUTO_SYNC_INTERVAL_SEC,
    fullReconcileIntervalSec: DEFAULT_FULL_RECONCILE_INTERVAL_SEC,
    stateDbPath: DEFAULT_DB_PATH,
    maxConcurrentMappingsMode: 'auto',
    maxConcurrentMappings: DEFAULT_MAX_CONCURRENT_MAPPINGS,
    maxRequestsPerMinute: DEFAULT_MAX_REQUESTS_PER_MINUTE,
    rateLimitBurst: DEFAULT_RATE_LIMIT_BURST,
    rateLimitCooldownSec: RATE_LIMIT_COOLDOWN_MS / 1000,
    downloadConcurrency: DOWNLOAD_CONCURRENCY,
    uploadConcurrency: UPLOAD_CONCURRENCY,
    startupJitterMaxSec: STARTUP_JITTER_MAX_MS / 1000,
    managementPort: DEFAULT_MANAGEMENT_PORT,
    managementHost: DEFAULT_MANAGEMENT_HOST,
    mappings: [],
  };
}

/** 将内存中的 SyncConfig 转为可写入 config.json 的对象（省略 undefined 字段） */
export function configToRaw(config: SyncConfig): Record<string, unknown> {
  const raw: Record<string, unknown> = {
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
    mappings: config.mappings,
  };
  if (config.appKey) raw.appKey = config.appKey;
  return raw;
}

/** 原子写入 config.json */
export function writeConfigFile(configPath: string, raw: Record<string, unknown>): void {
  const absPath = path.resolve(configPath);
  const dir = path.dirname(absPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmpPath = absPath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(raw, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmpPath, absPath);
}

function isEmptyConfigRaw(raw: unknown): boolean {
  if (raw === null || raw === undefined) return true;
  if (typeof raw !== 'object' || Array.isArray(raw)) return true;
  return Object.keys(raw as Record<string, unknown>).length === 0;
}

function isIncompleteConfigRaw(obj: Record<string, unknown>): boolean {
  const defaults = getDefaultConfigRaw();
  for (const key of Object.keys(defaults)) {
    if (key === 'mappings') {
      if (!Array.isArray(obj.mappings)) return true;
      continue;
    }
    if (!(key in obj)) return true;
  }
  return false;
}

/** 用默认值补全部分配置；保留用户已填的 appKey、mappings 等字段 */
function mergeWithDefaultConfigRaw(partial: Record<string, unknown>): Record<string, unknown> {
  const defaults = getDefaultConfigRaw();
  const merged: Record<string, unknown> = { ...defaults, ...partial };

  merged.mappings = Array.isArray(partial.mappings) ? partial.mappings : [];

  const appKey = partial.appKey;
  if (typeof appKey === 'string' && appKey.trim()) {
    merged.appKey = appKey.trim();
  } else {
    delete merged.appKey;
  }

  return merged;
}

function readConfigRaw(absPath: string): unknown {
  const text = fs.readFileSync(absPath, 'utf-8').trim();
  if (text === '') return {};
  return JSON.parse(text) as unknown;
}

/**
 * 从 JSON 文件加载并验证配置。
 * 文件不存在、为空、`{}`、不完整或 JSON 解析失败时，自动合并/写入默认 config.json 并继续启动。
 */
export function loadConfig(configPath: string = DEFAULT_CONFIG_PATH): SyncConfig {
  return loadConfigWithMeta(configPath).config;
}

export function loadConfigWithMeta(configPath: string = DEFAULT_CONFIG_PATH): LoadConfigResult {
  const absPath = path.resolve(configPath);
  let bootstrapped = false;
  let bootstrapReason = '';
  let raw: unknown;

  if (!fs.existsSync(absPath)) {
    raw = getDefaultConfigRaw();
    bootstrapped = true;
    bootstrapReason = '配置文件不存在，已生成默认配置';
  } else {
    try {
      raw = readConfigRaw(absPath);
    } catch (e) {
      raw = getDefaultConfigRaw();
      bootstrapped = true;
      bootstrapReason = `配置文件解析失败，已重置为默认配置（${e instanceof Error ? e.message : String(e)}）`;
    }

    if (!bootstrapped) {
      if (isEmptyConfigRaw(raw)) {
        raw = getDefaultConfigRaw();
        bootstrapped = true;
        bootstrapReason = '配置文件为空，已写入默认配置';
      } else if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        raw = getDefaultConfigRaw();
        bootstrapped = true;
        bootstrapReason = '配置文件格式无效，已重置为默认配置';
      } else {
        const obj = raw as Record<string, unknown>;
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

function validateConfig(raw: unknown, filePath: string): SyncConfig {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`配置文件内容必须是 JSON 对象: ${filePath}`);
  }

  const obj = raw as Record<string, unknown>;

  const serverUrl =
    typeof obj.serverUrl === 'string' && obj.serverUrl.trim()
      ? obj.serverUrl.trim()
      : DEFAULT_SERVER_URL;

  const rawAppKey = obj.appKey;
  const globalAppKey =
    typeof rawAppKey === 'string' && rawAppKey.trim() !== '' ? rawAppKey.trim() : undefined;

  const mappingsInput = Array.isArray(obj.mappings) ? obj.mappings : [];

  const syncDirection = (obj.syncDirection as string) ?? 'bidirectional';
  if (!['bidirectional', 'push', 'pull'].includes(syncDirection)) {
    throw new Error(`配置 "syncDirection" 必须是 "bidirectional" | "push" | "pull": ${filePath}`);
  }

  const mappings: SyncMapping[] = mappingsInput.map((m, idx) =>
    validateMapping(m, idx, filePath),
  );

  // 校验同一 localRoot 不映射到多个云端根
  const localRootSet = new Map<string, string>();
  for (const m of mappings) {
    const norm = path.resolve(m.localRoot);
    if (localRootSet.has(norm)) {
      throw new Error(
        `配置错误: localRoot "${m.localRoot}" 被多个 mapping 使用（mappingId: ${localRootSet.get(norm)} 和 ${m.mappingId}），可能引起回环`,
      );
    }
    localRootSet.set(norm, m.mappingId);
  }

  return {
    serverUrl,
    ...(globalAppKey !== undefined ? { appKey: globalAppKey } : {}),
    syncDirection: syncDirection as SyncConfig['syncDirection'],
    autoSyncIntervalSec:
      typeof obj.autoSyncIntervalSec === 'number'
        ? obj.autoSyncIntervalSec
        : DEFAULT_AUTO_SYNC_INTERVAL_SEC,
    fullReconcileIntervalSec:
      typeof obj.fullReconcileIntervalSec === 'number'
        ? obj.fullReconcileIntervalSec
        : DEFAULT_FULL_RECONCILE_INTERVAL_SEC,
    stateDbPath:
      typeof obj.stateDbPath === 'string' && obj.stateDbPath.trim()
        ? obj.stateDbPath.trim()
        : DEFAULT_DB_PATH,
    maxConcurrentMappingsMode:
      obj.maxConcurrentMappingsMode === 'manual' ? 'manual' : 'auto',
    maxConcurrentMappings:
      typeof obj.maxConcurrentMappings === 'number'
        ? obj.maxConcurrentMappings
        : DEFAULT_MAX_CONCURRENT_MAPPINGS,
    maxRequestsPerMinute:
      typeof obj.maxRequestsPerMinute === 'number'
        ? obj.maxRequestsPerMinute
        : DEFAULT_MAX_REQUESTS_PER_MINUTE,
    rateLimitBurst:
      typeof obj.rateLimitBurst === 'number' ? obj.rateLimitBurst : DEFAULT_RATE_LIMIT_BURST,
    rateLimitCooldownSec:
      typeof obj.rateLimitCooldownSec === 'number'
        ? obj.rateLimitCooldownSec
        : RATE_LIMIT_COOLDOWN_MS / 1000,
    downloadConcurrency:
      typeof obj.downloadConcurrency === 'number' ? obj.downloadConcurrency : DOWNLOAD_CONCURRENCY,
    uploadConcurrency:
      typeof obj.uploadConcurrency === 'number' ? obj.uploadConcurrency : UPLOAD_CONCURRENCY,
    startupJitterMaxSec:
      typeof obj.startupJitterMaxSec === 'number'
        ? obj.startupJitterMaxSec
        : STARTUP_JITTER_MAX_MS / 1000,
    managementPort:
      typeof obj.managementPort === 'number' ? obj.managementPort : DEFAULT_MANAGEMENT_PORT,
    managementHost:
      typeof obj.managementHost === 'string' && obj.managementHost.trim()
        ? obj.managementHost.trim()
        : DEFAULT_MANAGEMENT_HOST,
    mappings,
  };
}

export function validateMapping(raw: unknown, idx: number, filePath: string): SyncMapping {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`mappings[${idx}] 必须是对象: ${filePath}`);
  }

  const m = raw as Record<string, unknown>;
  const loc = `mappings[${idx}]`;

  assertString(m, 'mappingId', filePath, loc);
  assertString(m, 'localRoot', filePath, loc);

  const hasFileId =
    typeof m.remoteRootFileId === 'string' && (m.remoteRootFileId as string).trim() !== '';
  const hasFolderPath =
    typeof m.remoteRootFolderPath === 'string' && (m.remoteRootFolderPath as string).trim() !== '';
  // 两者均不填时表示同步 projectId 空间的根目录，合法。

  if (m.enabled !== undefined && typeof m.enabled !== 'boolean') {
    throw new Error(`${loc}.enabled 必须是 boolean: ${filePath}`);
  }

  const filePatterns = Array.isArray(m.filePatterns)
    ? (m.filePatterns as string[])
    : DEFAULT_FILE_PATTERNS;

  const excludePatterns = Array.isArray(m.excludePatterns)
    ? (m.excludePatterns as string[])
    : DEFAULT_EXCLUDE_PATTERNS;

  const mappingAppKey =
    typeof m.appKey === 'string' && (m.appKey as string).trim()
      ? (m.appKey as string).trim()
      : undefined;

  const validDirections = ['bidirectional', 'push', 'pull'] as const;
  const rawDir = m.syncDirection as string | undefined;
  if (rawDir !== undefined && !validDirections.includes(rawDir as (typeof validDirections)[number])) {
    throw new Error(`${loc}.syncDirection 必须是 "bidirectional" | "push" | "pull": ${filePath}`);
  }
  const mappingSyncDirection =
    rawDir && validDirections.includes(rawDir as (typeof validDirections)[number])
      ? (rawDir as 'bidirectional' | 'push' | 'pull')
      : undefined;

  const moveNameConflictStrategy = parseMoveConflictStrategy(
    m.moveNameConflictStrategy,
    filePath,
    loc,
  );
  const renameNameConflictStrategy = parseRenameConflictStrategy(
    m.renameNameConflictStrategy,
    filePath,
    loc,
  );

  return {
    mappingId: m.mappingId as string,
    enabled: typeof m.enabled === 'boolean' ? m.enabled : true,
    localRoot: m.localRoot as string,
    appKey: mappingAppKey,
    projectId: typeof m.projectId === 'string' ? m.projectId : undefined,
    remoteRootFileId: hasFileId ? (m.remoteRootFileId as string) : undefined,
    remoteRootFolderPath: hasFolderPath ? (m.remoteRootFolderPath as string) : undefined,
    filePatterns,
    excludePatterns,
    syncDirection: mappingSyncDirection,
    moveNameConflictStrategy,
    renameNameConflictStrategy,
  };
}

function parseMoveConflictStrategy(
  raw: unknown,
  filePath: string,
  loc: string,
): 0 | 1 | 2 | 3 | undefined {
  if (raw === undefined || raw === null) return undefined;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (![0, 1, 2, 3].includes(n)) {
    throw new Error(`${loc}.moveNameConflictStrategy 必须是 0|1|2|3: ${filePath}`);
  }
  return n as 0 | 1 | 2 | 3;
}

function parseRenameConflictStrategy(
  raw: unknown,
  filePath: string,
  loc: string,
): 0 | 1 | undefined {
  if (raw === undefined || raw === null) return undefined;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (![0, 1].includes(n)) {
    throw new Error(`${loc}.renameNameConflictStrategy 必须是 0|1: ${filePath}`);
  }
  return n as 0 | 1;
}

/**
 * 为 POST /mappings 生成不与现有列表冲突的 mappingId。
 */
export function generateUniqueMappingId(existingIds: readonly string[]): string {
  const used = new Set(existingIds);
  for (let n = 0; n < 64; n++) {
    const id = `map-${randomBytes(8).toString('hex')}`;
    if (!used.has(id)) return id;
  }
  throw new Error('无法自动生成唯一 mappingId，请在请求体中显式指定 mappingId');
}

function assertString(
  obj: Record<string, unknown>,
  key: string,
  filePath: string,
  prefix?: string,
): void {
  const label = prefix ? `${prefix}.${key}` : key;
  if (typeof obj[key] !== 'string' || !(obj[key] as string).trim()) {
    throw new Error(`配置 "${label}" 必须是非空字符串: ${filePath}`);
  }
}
