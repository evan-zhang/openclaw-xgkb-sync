import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { SyncScheduler } from './scheduler';
import { resolveMaxConcurrentMappings } from './scheduler';
import { SyncConfig, SyncMapping } from './types';
import { generateUniqueMappingId, validateMapping } from './config';
import { getMappingCredentialsViolation } from './managementApiCredentials';

/** 读取 package.json 里的版本号，失败则返回 'unknown' */
function readVersion(): string {
  try {
    const pkgPath = path.resolve(__dirname, '../package.json');
    const raw = fs.readFileSync(pkgPath, 'utf-8');
    const pkg = JSON.parse(raw) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

const VERSION = readVersion();

/** 静态管理页面目录（与 dist/ 或 src/ 同级的 public/） */
const PUBLIC_DIR = path.resolve(__dirname, '../public');

/** 仅用于界面展示的脱敏 AppKey，避免返回明文。 */
function maskSecret(value?: string): string | undefined {
  const secret = value?.trim();
  if (!secret) return undefined;
  if (secret.length <= 8) return `${secret[0] ?? ''}${'•'.repeat(Math.max(secret.length - 2, 1))}${secret.slice(-1)}`;
  return `${secret.slice(0, 4)}${'•'.repeat(Math.min(secret.length - 8, 24))}${secret.slice(-4)}`;
}

/** 可通过 PUT /config 修改的全局字段（managementPort/Host 需重启进程才生效） */
const EDITABLE_CONFIG_FIELDS = [
  'serverUrl',
  'appKey',
  'syncDirection',
  'autoSyncIntervalSec',
  'fullReconcileIntervalSec',
  'stateDbPath',
  'maxConcurrentMappingsMode',
  'maxConcurrentMappings',
  'maxRequestsPerMinute',
  'rateLimitBurst',
  'rateLimitCooldownSec',
  'downloadConcurrency',
  'uploadConcurrency',
  'startupJitterMaxSec',
  'managementPort',
  'managementHost',
] as const;

type EditableConfigField = (typeof EDITABLE_CONFIG_FIELDS)[number];

export type ReloadResult = { ok: true; config: SyncConfig } | { ok: false; error: string };

export interface ManagementApiOptions {
  port: number;
  host: string;
  /** config.json 的绝对路径，供 mapping CRUD 接口读写 */
  configPath: string;
  /** 获取当前 scheduler 实例（reload 后引用会变） */
  getScheduler: () => SyncScheduler;
  /** 热重载回调：重新读取配置文件并重建 scheduler，返回新配置或错误 */
  onReload: () => ReloadResult;
}

/**
 * HTTP 管理 API 服务
 *
 * 路由速览见类内 `start()` 日志。完整契约见仓库 **docs/MANAGEMENT_API.md**（给 AI / 自动化）；appKey 保存规则见 **src/managementApiCredentials.ts**。
 */
export class ManagementApi {
  private readonly opts: ManagementApiOptions;
  private readonly startedAt = Date.now();
  private server: http.Server | null = null;

  constructor(opts: ManagementApiOptions) {
    this.opts = opts;
  }

  start(): void {
    if (this.opts.port === 0) {
      console.log('[ManagementApi] port=0，管理 API 已禁用');
      return;
    }

    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((e) => {
        console.error('[ManagementApi] 请求处理异常:', e);
        this.sendJson(res, 500, { ok: false, error: 'internal error' });
      });
    });

    this.server.listen(this.opts.port, this.opts.host, () => {
      console.log(
        `[ManagementApi] 已启动，监听 http://${this.opts.host}:${this.opts.port}`,
      );
      console.log(`[ManagementApi] 可用接口:`);
      console.log(`  GET    /health`);
      console.log(`  GET    /status`);
      console.log(`  GET    /mappings`);
      console.log(`  POST   /mappings          新增 mapping`);
      console.log(`  PUT    /mappings/:id       upsert mapping（存在则更新，不存在则创建）`);
      console.log(`  DELETE /mappings/:id       删除 mapping`);
      console.log(`  POST   /mappings/:id/reset 重置同步状态（清空 DB）`);
      console.log(`  POST   /sync/:mappingId`);
      console.log(`  POST   /sync  （触发所有）`);
      console.log(`  POST   /reload`);
      console.log(`  GET    /config`);
      console.log(`  PUT    /config`);
      console.log(`  GET    /          管理控制台（静态页面）`);
    });

    this.server.on('error', (e) => {
      console.error('[ManagementApi] 服务器错误:', e);
    });
  }

  stop(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
      console.log('[ManagementApi] 已停止');
    }
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    const url = req.url ?? '/';
    const urlPath = url.split('?')[0];

    // GET / — 管理控制台
    if (method === 'GET' && (urlPath === '/' || urlPath === '/index.html')) {
      return this.serveStaticFile(res, 'index.html');
    }

    // GET /static/*
    if (method === 'GET' && urlPath.startsWith('/static/')) {
      const rel = 'static/' + urlPath.slice('/static/'.length);
      return this.serveStaticFile(res, rel);
    }

    // GET /health
    if (method === 'GET' && urlPath === '/health') {
      return this.handleHealth(res);
    }

    // GET /status
    if (method === 'GET' && urlPath === '/status') {
      return this.handleStatus(res);
    }

    // POST /reload
    if (method === 'POST' && urlPath === '/reload') {
      return this.handleReload(res);
    }

    // POST /sync  （触发所有 mapping）
    if (method === 'POST' && urlPath === '/sync') {
      return this.handleSyncAll(res);
    }

    // POST /sync/:mappingId
    const syncMatch = urlPath.match(/^\/sync\/(.+)$/);
    if (method === 'POST' && syncMatch) {
      return this.handleSyncOne(res, decodeURIComponent(syncMatch[1]));
    }

    // GET /config
    if (method === 'GET' && urlPath === '/config') {
      return this.handleGetConfig(res);
    }

    // PUT /config
    if (method === 'PUT' && urlPath === '/config') {
      return this.handleUpdateConfig(req, res);
    }

    // GET /mappings
    if (method === 'GET' && urlPath === '/mappings') {
      return this.handleListMappings(res);
    }

    // POST /mappings  （新增）
    if (method === 'POST' && urlPath === '/mappings') {
      return this.handleCreateMapping(req, res);
    }

    // POST /mappings/:mappingId/reset  （重置同步状态：清空文件/文件夹记录+水位）
    const resetMatch = urlPath.match(/^\/mappings\/([^/]+)\/reset$/);
    if (method === 'POST' && resetMatch) {
      return this.handleResetMapping(res, decodeURIComponent(resetMatch[1]));
    }

    // PUT /mappings/:mappingId  （upsert：存在则更新，不存在则创建）
    const putMatch = urlPath.match(/^\/mappings\/(.+)$/);
    if (method === 'PUT' && putMatch) {
      return this.handleUpsertMapping(req, res, decodeURIComponent(putMatch[1]));
    }

    // DELETE /mappings/:mappingId  （删除）
    const deleteMatch = urlPath.match(/^\/mappings\/(.+)$/);
    if (method === 'DELETE' && deleteMatch) {
      return this.handleDeleteMapping(res, decodeURIComponent(deleteMatch[1]));
    }

    this.sendJson(res, 404, { ok: false, error: `未知路由: ${method} ${urlPath}` });
  }

  // ==================== 路由处理 ====================

  private handleHealth(res: http.ServerResponse): void {
    const scheduler = this.opts.getScheduler();
    const config = scheduler.getConfig();
    const enabledCount = config.mappings.filter((m) => m.enabled).length;

    this.sendJson(res, 200, {
      ok: true,
      version: VERSION,
      pid: process.pid,
      uptime: Math.floor((Date.now() - this.startedAt) / 1000),
      startedAt: new Date(this.startedAt).toISOString(),
      mappingCount: config.mappings.length,
      enabledMappingCount: enabledCount,
      nodeVersion: process.version,
    });
  }

  private handleStatus(res: http.ServerResponse): void {
    const scheduler = this.opts.getScheduler();
    const config = scheduler.getConfig();
    const runStatus = scheduler.getStatus();

    // 整理 mapping 状态，附加配置摘要，隐藏敏感字段
    const mappings: Record<string, unknown> = {};
    for (const [mappingId, state] of Object.entries(runStatus)) {
      const mapping = config.mappings.find((m) => m.mappingId === mappingId);
      mappings[mappingId] = {
        enabled: mapping?.enabled ?? true,
        localRoot: mapping?.localRoot,
        remoteRootFolderPath: mapping?.remoteRootFolderPath,
        syncDirection: mapping?.syncDirection ?? config.syncDirection,
        isSyncing: state.isSyncing,
        pendingSync: state.pendingSync,
        lastState: state.lastState,
      };
    }

    this.sendJson(res, 200, {
      version: VERSION,
      pid: process.pid,
      uptime: Math.floor((Date.now() - this.startedAt) / 1000),
      startedAt: new Date(this.startedAt).toISOString(),
      nodeVersion: process.version,
      config: {
        serverUrl: config.serverUrl,
        syncDirection: config.syncDirection,
        autoSyncIntervalSec: config.autoSyncIntervalSec,
        fullReconcileIntervalSec: config.fullReconcileIntervalSec,
        maxConcurrentMappings: config.maxConcurrentMappings,
        maxConcurrentMappingsMode: config.maxConcurrentMappingsMode,
        effectiveMaxConcurrentMappings: resolveMaxConcurrentMappings(config),
        maxRequestsPerMinute: config.maxRequestsPerMinute,
        mappingCount: config.mappings.length,
        enabledMappingCount: config.mappings.filter((m) => m.enabled).length,
      },
      mappings,
    });
  }

  private handleReload(res: http.ServerResponse): void {
    console.log('[ManagementApi] 收到 /reload 请求，重载配置...');
    const result = this.opts.onReload();
    if (!result.ok) {
      console.error('[ManagementApi] 配置重载失败:', result.error);
      return this.sendJson(res, 400, { ok: false, error: result.error });
    }
    const config = result.config;
    console.log('[ManagementApi] 配置重载成功，mapping 数量:', config.mappings.length);
    this.sendJson(res, 200, {
      ok: true,
      message: `配置已重载，mapping 数量: ${config.mappings.length}（已启用: ${config.mappings.filter((m) => m.enabled).length}）`,
      mappingCount: config.mappings.length,
      enabledMappingCount: config.mappings.filter((m) => m.enabled).length,
    });
  }

  private handleSyncAll(res: http.ServerResponse): void {
    const scheduler = this.opts.getScheduler();
    const config = scheduler.getConfig();
    const enabled = config.mappings.filter((m) => m.enabled);
    for (const m of enabled) {
      scheduler.triggerMapping(m.mappingId);
    }
    this.sendJson(res, 200, {
      ok: true,
      message: `已触发 ${enabled.length} 个 mapping 同步`,
      triggered: enabled.map((m) => m.mappingId),
    });
  }

  private handleSyncOne(res: http.ServerResponse, mappingId: string): void {
    const scheduler = this.opts.getScheduler();
    const config = scheduler.getConfig();
    const mapping = config.mappings.find((m) => m.mappingId === mappingId);
    if (!mapping) {
      return this.sendJson(res, 404, {
        ok: false,
        error: `未找到 mapping: "${mappingId}"`,
        availableMappings: config.mappings.map((m) => m.mappingId),
      });
    }
    if (!mapping.enabled) {
      return this.sendJson(res, 400, {
        ok: false,
        error: `mapping "${mappingId}" 已禁用（enabled=false）`,
      });
    }
    scheduler.triggerMapping(mappingId);
    this.sendJson(res, 200, { ok: true, message: `已触发同步: ${mappingId}` });
  }

  // ==================== 全局配置 ====================

  private handleGetConfig(res: http.ServerResponse): void {
    const config = this.opts.getScheduler().getConfig();
    this.sendJson(res, 200, {
      ok: true,
      hasGlobalAppKey: !!(config.appKey && config.appKey.trim()),
      config: this.globalConfigSummary(config),
    });
  }

  private async handleUpdateConfig(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    let body: unknown;
    try {
      body = await this.readBody(req);
    } catch (e) {
      return this.sendJson(res, 400, {
        ok: false,
        error: `请求体解析失败: ${e instanceof Error ? e.message : String(e)}`,
      });
    }

    if (typeof body !== 'object' || body === null) {
      return this.sendJson(res, 400, { ok: false, error: '请求体必须是 JSON 对象' });
    }

    const bodyObj = body as Record<string, unknown>;
    const unknownKeys = Object.keys(bodyObj).filter(
      (k) => !EDITABLE_CONFIG_FIELDS.includes(k as EditableConfigField),
    );
    if (unknownKeys.length > 0) {
      return this.sendJson(res, 400, {
        ok: false,
        error: `不支持的配置字段: ${unknownKeys.join(', ')}`,
      });
    }

    if (Object.keys(bodyObj).length === 0) {
      return this.sendJson(res, 400, { ok: false, error: '请至少提供一个要修改的字段' });
    }

    const prevConfig = this.opts.getScheduler().getConfig();
    const requiresRestartFields: string[] = [];

    const writeResult = this.modifyConfigRoot((raw) => {
      for (const key of EDITABLE_CONFIG_FIELDS) {
        if (!(key in bodyObj)) continue;
        const val = bodyObj[key];
        if (key === 'appKey') {
          if (val === null || val === '') {
            delete raw.appKey;
          } else if (typeof val === 'string') {
            raw.appKey = val.trim();
          } else {
            throw new Error('appKey 必须是字符串或 null');
          }
          continue;
        }
        if (key === 'serverUrl') {
          if (typeof val !== 'string' || !val.trim()) {
            throw new Error('serverUrl 必须是非空字符串');
          }
          raw.serverUrl = val.trim();
          continue;
        }
        if (key === 'syncDirection') {
          if (!['bidirectional', 'push', 'pull'].includes(val as string)) {
            throw new Error('syncDirection 必须是 bidirectional | push | pull');
          }
          raw.syncDirection = val;
          continue;
        }
        if (key === 'managementHost') {
          if (typeof val !== 'string' || !val.trim()) {
            throw new Error('managementHost 必须是非空字符串');
          }
          if (val !== prevConfig.managementHost) requiresRestartFields.push('managementHost');
          raw.managementHost = val.trim();
          continue;
        }
        if (key === 'managementPort') {
          if (typeof val !== 'number' || !Number.isInteger(val) || val < 0) {
            throw new Error('managementPort 必须是非负整数');
          }
          if (val !== prevConfig.managementPort) requiresRestartFields.push('managementPort');
          raw.managementPort = val;
          continue;
        }
        if (
          key === 'autoSyncIntervalSec' ||
          key === 'fullReconcileIntervalSec' ||
          key === 'maxRequestsPerMinute' ||
          key === 'rateLimitBurst' ||
          key === 'rateLimitCooldownSec' ||
          key === 'downloadConcurrency' ||
          key === 'uploadConcurrency' ||
          key === 'startupJitterMaxSec'
        ) {
          if (typeof val !== 'number' || val < 0) {
            throw new Error(`${key} 必须是非负数`);
          }
          raw[key] = val;
          continue;
        }
        if (key === 'maxConcurrentMappingsMode') {
          if (val !== 'auto' && val !== 'manual') {
            throw new Error('maxConcurrentMappingsMode 必须是 auto | manual');
          }
          raw.maxConcurrentMappingsMode = val;
          continue;
        }
        if (key === 'maxConcurrentMappings') {
          if (typeof val !== 'number' || !Number.isInteger(val) || val < 1) {
            throw new Error('maxConcurrentMappings 必须是正整数');
          }
          raw.maxConcurrentMappings = val;
          continue;
        }
        if (key === 'stateDbPath') {
          if (typeof val !== 'string' || !val.trim()) {
            throw new Error('stateDbPath 必须是非空字符串');
          }
          raw.stateDbPath = val.trim();
        }
      }
      return raw;
    });

    if (!writeResult.ok) {
      return this.sendJson(res, 400, { ok: false, error: writeResult.error });
    }

    const reloadResult = this.opts.onReload();
    if (!reloadResult.ok) {
      return this.sendJson(res, 500, {
        ok: false,
        error: `配置已写入但重载失败: ${reloadResult.error}`,
      });
    }

    console.log('[ManagementApi] 全局配置已更新');
    this.sendJson(res, 200, {
      ok: true,
      message: '全局配置已更新并生效',
      hasGlobalAppKey: !!(reloadResult.config.appKey && reloadResult.config.appKey.trim()),
      config: this.globalConfigSummary(reloadResult.config),
      ...(requiresRestartFields.length > 0 && {
        warnings: [
          `字段 [${requiresRestartFields.join(', ')}] 已写入 config.json，但需重启进程后才会生效`,
        ],
      }),
    });
  }

  // ==================== Mapping CRUD ====================

  private handleListMappings(res: http.ServerResponse): void {
    const config = this.opts.getScheduler().getConfig();
    this.sendJson(res, 200, {
      ok: true,
      total: config.mappings.length,
      /** 根级全局 appKey 是否已配置（非空）。为 false 时，新建/更新 mapping 必须在请求体中带非空 appKey，见 docs/MANAGEMENT_API.md */
      hasGlobalAppKey: !!(config.appKey && config.appKey.trim()),
      mappings: config.mappings.map((m) => this.mappingSummary(m)),
    });
  }

  private async handleCreateMapping(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    let body: unknown;
    try {
      body = await this.readBody(req);
    } catch (e) {
      return this.sendJson(res, 400, { ok: false, error: `请求体解析失败: ${e instanceof Error ? e.message : String(e)}` });
    }

    if (typeof body !== 'object' || body === null) {
      return this.sendJson(res, 400, { ok: false, error: '请求体必须是 JSON 对象' });
    }

    const bodyObj = { ...(body as Record<string, unknown>) };
    const existingIds = this.opts.getScheduler().getConfig().mappings.map((m) => m.mappingId);
    const mid = bodyObj.mappingId;
    if (typeof mid !== 'string' || !mid.trim()) {
      bodyObj.mappingId = generateUniqueMappingId(existingIds);
    }

    // 校验 mapping 字段（配置文件中的条目仍要求 mappingId；此处已为 POST 补全）
    let mapping: SyncMapping;
    try {
      mapping = validateMapping(bodyObj, 0, '<API 请求>');
    } catch (e) {
      return this.sendJson(res, 400, { ok: false, error: e instanceof Error ? e.message : String(e) });
    }

    const cfg = this.opts.getScheduler().getConfig();
    const cred = getMappingCredentialsViolation(cfg, mapping);
    if (cred) {
      return this.sendJson(res, 400, {
        ok: false,
        error: cred.error,
        errorCode: cred.errorCode,
      });
    }

    // 写入 config.json
    const writeResult = this.modifyConfigMappings((mappings) => {
      if (mappings.some((m) => m.mappingId === mapping.mappingId)) {
        throw new Error(`mappingId "${mapping.mappingId}" 已存在，如需修改请使用 PUT /mappings/${mapping.mappingId}`);
      }
      return [...mappings, mapping];
    });
    if (!writeResult.ok) {
      return this.sendJson(res, 400, { ok: false, error: writeResult.error });
    }

    // 热重载使新 mapping 立即生效
    const reloadResult = this.opts.onReload();
    if (!reloadResult.ok) {
      return this.sendJson(res, 500, { ok: false, error: `mapping 已写入但重载失败: ${reloadResult.error}` });
    }

    console.log(`[ManagementApi] 新增 mapping: ${mapping.mappingId}`);
    this.sendJson(res, 201, {
      ok: true,
      message: `mapping "${mapping.mappingId}" 已创建并生效`,
      mapping: this.mappingSummary(mapping),
    });
  }

  /** PUT /mappings/:mappingId — 存在则部分更新，不存在则按请求体创建（upsert） */
  private async handleUpsertMapping(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    mappingId: string,
  ): Promise<void> {
    let body: unknown;
    try {
      body = await this.readBody(req);
    } catch (e) {
      return this.sendJson(res, 400, { ok: false, error: `请求体解析失败: ${e instanceof Error ? e.message : String(e)}` });
    }

    if (typeof body !== 'object' || body === null) {
      return this.sendJson(res, 400, { ok: false, error: '请求体必须是 JSON 对象' });
    }

    const bodyObj = body as Record<string, unknown>;
    if ('mappingId' in bodyObj && bodyObj.mappingId !== mappingId) {
      return this.sendJson(res, 400, {
        ok: false,
        error: `请求体中的 mappingId "${bodyObj.mappingId}" 与 URL 中的 "${mappingId}" 不一致`,
      });
    }

    const IDENTITY_FIELDS: (keyof SyncMapping)[] = [
      'localRoot', 'remoteRootFolderPath', 'remoteRootFileId', 'projectId', 'appKey',
    ];

    let mapping!: SyncMapping;
    let existingMapping: SyncMapping | undefined;
    let created = false;

    const writeResult = this.modifyConfigMappings((mappings) => {
      const idx = mappings.findIndex((m) => m.mappingId === mappingId);
      const cfg = this.opts.getScheduler().getConfig();

      if (idx === -1) {
        created = true;
        const merged: Record<string, unknown> = { ...bodyObj, mappingId };
        mapping = validateMapping(merged, 0, '<API 请求>');

        const cred = getMappingCredentialsViolation(cfg, mapping);
        if (cred) {
          const err = new Error(cred.error) as Error & { errorCode: string };
          err.errorCode = cred.errorCode;
          throw err;
        }

        return [...mappings, mapping];
      }

      existingMapping = mappings[idx];
      const merged: Record<string, unknown> = { ...existingMapping, ...bodyObj, mappingId };
      mapping = validateMapping(merged, 0, '<API 请求>');

      const cred = getMappingCredentialsViolation(cfg, mapping);
      if (cred) {
        const err = new Error(cred.error) as Error & { errorCode: string };
        err.errorCode = cred.errorCode;
        throw err;
      }

      const updated = [...mappings];
      updated[idx] = mapping;
      return updated;
    });

    if (!writeResult.ok) {
      return this.sendJson(res, 400, {
        ok: false,
        error: writeResult.error,
        ...(writeResult.errorCode ? { errorCode: writeResult.errorCode } : {}),
      });
    }

    if (created) {
      const reloadResult = this.opts.onReload();
      if (!reloadResult.ok) {
        return this.sendJson(res, 500, { ok: false, error: `mapping 已写入但重载失败: ${reloadResult.error}` });
      }

      console.log(`[ManagementApi] upsert 新建 mapping: ${mappingId}`);
      return this.sendJson(res, 201, {
        ok: true,
        created: true,
        message: `mapping "${mappingId}" 已创建并生效`,
        mapping: this.mappingSummary(mapping),
      });
    }

    const changedFields = (Object.keys(bodyObj) as (keyof SyncMapping)[]).filter(
      (k) => JSON.stringify(existingMapping![k]) !== JSON.stringify(mapping[k]),
    );

    if (changedFields.length === 0) {
      return this.sendJson(res, 200, {
        ok: true,
        created: false,
        message: `mapping "${mappingId}" 无字段发生实际变化，跳过重载`,
        changed: [],
      });
    }

    const changedIdentityFields = changedFields.filter((f) => IDENTITY_FIELDS.includes(f));
    if (changedIdentityFields.length > 0) {
      this.opts.getScheduler().resetMappingState(mappingId);
      console.log(
        `[ManagementApi] 身份字段已变更 [${changedIdentityFields.join(', ')}]，已重置 mapping "${mappingId}" 的同步状态`,
      );
    }

    const reloadResult = this.opts.onReload();
    if (!reloadResult.ok) {
      return this.sendJson(res, 500, { ok: false, error: `mapping 已写入但重载失败: ${reloadResult.error}` });
    }

    console.log(`[ManagementApi] upsert 更新 mapping: ${mappingId}，变更字段: [${changedFields.join(', ')}]`);
    this.sendJson(res, 200, {
      ok: true,
      created: false,
      message: `mapping "${mappingId}" 已更新并生效`,
      changed: changedFields,
      ...(changedIdentityFields.length > 0 && {
        warnings: [
          `身份字段 [${changedIdentityFields.join(', ')}] 已变更，同步状态已清除，下次同步将执行全量对账`,
        ],
      }),
      mapping: this.mappingSummary(mapping),
    });
  }

  private handleDeleteMapping(res: http.ServerResponse, mappingId: string): void {
    const writeResult = this.modifyConfigMappings((mappings) => {
      if (!mappings.some((m) => m.mappingId === mappingId)) {
        throw new Error(`未找到 mapping "${mappingId}"`);
      }
      return mappings.filter((m) => m.mappingId !== mappingId);
    });
    if (!writeResult.ok) {
      const status = writeResult.error.includes('未找到') ? 404 : 400;
      return this.sendJson(res, status, { ok: false, error: writeResult.error });
    }

    const reloadResult = this.opts.onReload();
    if (!reloadResult.ok) {
      return this.sendJson(res, 500, { ok: false, error: `mapping 已删除但重载失败: ${reloadResult.error}` });
    }

    console.log(`[ManagementApi] 删除 mapping: ${mappingId}`);
    this.sendJson(res, 200, { ok: true, message: `mapping "${mappingId}" 已删除` });
  }

  private handleResetMapping(res: http.ServerResponse, mappingId: string): void {
    const scheduler = this.opts.getScheduler();
    const config = scheduler.getConfig();
    const mapping = config.mappings.find((m) => m.mappingId === mappingId);
    if (!mapping) {
      return this.sendJson(res, 404, { ok: false, error: `未找到 mapping "${mappingId}"` });
    }
    scheduler.resetMappingState(mappingId);
    console.log(`[ManagementApi] 已重置 mapping "${mappingId}" 的同步状态（DB 已清空）`);
    this.sendJson(res, 200, { ok: true, message: `mapping "${mappingId}" 的同步状态已清空` });
  }

  // ==================== config.json 读写工具 ====================

  /**
   * 原子修改 config.json 根对象字段。
   */
  private modifyConfigRoot(
    modifier: (raw: Record<string, unknown>) => Record<string, unknown>,
  ): { ok: true } | { ok: false; error: string } {
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(fs.readFileSync(this.opts.configPath, 'utf-8')) as Record<string, unknown>;
    } catch (e) {
      return { ok: false, error: `读取 config.json 失败: ${e instanceof Error ? e.message : String(e)}` };
    }

    try {
      raw = modifier(raw);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }

    return this.writeConfigRaw(raw);
  }

  /**
   * 原子修改 config.json 中的 mappings 数组。
   * 先写临时文件再重命名，防止写入中断导致配置损坏。
   */
  private modifyConfigMappings(
    modifier: (mappings: SyncMapping[]) => SyncMapping[],
  ): { ok: true } | { ok: false; error: string; errorCode?: string } {
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(fs.readFileSync(this.opts.configPath, 'utf-8')) as Record<string, unknown>;
    } catch (e) {
      return { ok: false, error: `读取 config.json 失败: ${e instanceof Error ? e.message : String(e)}` };
    }

    const existingMappings = Array.isArray(raw.mappings)
      ? (raw.mappings as SyncMapping[])
      : [];

    let newMappings: SyncMapping[];
    try {
      newMappings = modifier(existingMappings);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const errorCode =
        e &&
        typeof e === 'object' &&
        'errorCode' in e &&
        typeof (e as { errorCode: unknown }).errorCode === 'string'
          ? (e as { errorCode: string }).errorCode
          : undefined;
      return errorCode ? { ok: false, error: msg, errorCode } : { ok: false, error: msg };
    }

    raw.mappings = newMappings;
    return this.writeConfigRaw(raw);
  }

  private writeConfigRaw(raw: Record<string, unknown>): { ok: true } | { ok: false; error: string } {
    const tmpPath = this.opts.configPath + '.tmp';
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(raw, null, 2) + '\n', 'utf-8');
      fs.renameSync(tmpPath, this.opts.configPath);
    } catch (e) {
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      return { ok: false, error: `写入 config.json 失败: ${e instanceof Error ? e.message : String(e)}` };
    }
    return { ok: true };
  }

  /** 解析 HTTP 请求体为 JSON 对象 */
  private readBody(req: http.IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
        } catch (e) {
          reject(new Error('请求体不是合法 JSON'));
        }
      });
      req.on('error', reject);
    });
  }

  /** 隐藏 appKey 敏感字段的 mapping 摘要 */
  private mappingSummary(m: SyncMapping): Record<string, unknown> {
    return {
      mappingId: m.mappingId,
      enabled: m.enabled,
      localRoot: m.localRoot,
      hasOwnAppKey: !!m.appKey,
      projectId: m.projectId,
      remoteRootFolderPath: m.remoteRootFolderPath,
      remoteRootFileId: m.remoteRootFileId,
      syncDirection: m.syncDirection,
      filePatterns: m.filePatterns,
      excludePatterns: m.excludePatterns,
      moveNameConflictStrategy: m.moveNameConflictStrategy,
      renameNameConflictStrategy: m.renameNameConflictStrategy,
      enableFileIndex: m.enableFileIndex,
    };
  }

  // ==================== 工具方法 ====================

  /** 非敏感全局配置摘要（不含 appKey 明文） */
  private globalConfigSummary(config: SyncConfig): Record<string, unknown> {
    return {
      serverUrl: config.serverUrl,
      appKeyMasked: maskSecret(config.appKey),
      syncDirection: config.syncDirection,
      autoSyncIntervalSec: config.autoSyncIntervalSec,
      fullReconcileIntervalSec: config.fullReconcileIntervalSec,
      stateDbPath: config.stateDbPath,
      maxConcurrentMappingsMode: config.maxConcurrentMappingsMode,
      maxConcurrentMappings: config.maxConcurrentMappings,
      effectiveMaxConcurrentMappings: resolveMaxConcurrentMappings(config),
      maxRequestsPerMinute: config.maxRequestsPerMinute,
      rateLimitBurst: config.rateLimitBurst,
      rateLimitCooldownSec: config.rateLimitCooldownSec,
      downloadConcurrency: config.downloadConcurrency,
      uploadConcurrency: config.uploadConcurrency,
      startupJitterMaxSec: config.startupJitterMaxSec,
      managementPort: config.managementPort,
      managementHost: config.managementHost,
    };
  }

  private serveStaticFile(res: http.ServerResponse, relativePath: string): void {
    const safe = path.normalize(relativePath).replace(/^(\.\.(\/|\\|$))+/, '');
    if (safe.startsWith('..') || path.isAbsolute(safe)) {
      return this.sendJson(res, 400, { ok: false, error: '非法路径' });
    }

    const filePath = path.resolve(PUBLIC_DIR, safe);
    const publicRoot = path.resolve(PUBLIC_DIR);
    if (!filePath.startsWith(publicRoot + path.sep) && filePath !== publicRoot) {
      return this.sendJson(res, 400, { ok: false, error: '非法路径' });
    }

    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      return this.sendJson(res, 404, { ok: false, error: '文件不存在' });
    }

    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes: Record<string, string> = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon',
      '.png': 'image/png',
      '.woff2': 'font/woff2',
    };

    const contentType = mimeTypes[ext] ?? 'application/octet-stream';
    const data = fs.readFileSync(filePath);
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': data.length,
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  }

  private sendJson(res: http.ServerResponse, status: number, body: unknown): void {
    const json = JSON.stringify(body, null, 2);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(json),
    });
    res.end(json);
  }
}
