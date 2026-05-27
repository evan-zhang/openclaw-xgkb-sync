# 方案二评估与执行计划：chokidar 本地即时推送

> 基于 [方案二-PushPull分离与chokidar实时推送.md](./方案二-PushPull分离与chokidar实时推送.md) 与当前 `openclaw-xgkb-sync` 实现（2026-05）的对照修订。
> **核心诉求**：本地文件变更后尽快推到知识库，而不是等 `autoSyncIntervalSec` 定时器。
> **与方案一关系**：方案一（映射索引）**已实现**；本方案与其正交，可叠加。

---

## 1. 需求理解

| 项 | 说明 |
|----|------|
| **问题** | 当前所有同步由 `setInterval(autoSyncIntervalSec)` 驱动（默认 180s）。本地保存后最长要等一个周期才上传 |
| **目标** | 本地 push 侧：**秒级**感知变更并触发同步（典型延迟 1.5～3s，可配置 debounce） |
| **非目标（v1）** | 不改造 pull 时效（仍靠定时器）；不重写 upload 链路；不做 Obsidian 插件侧 watch |
| **适用部署** | OpenClaw 服务器 `push` / 单机 `bidirectional`；**不适用**纯 `pull` mapping |

---

## 2. 总体结论

| 维度 | 结论 |
|------|------|
| **大方向** | **正确**。行业通用模式：FS watch 做实时 + 定时 scan 做兜底 |
| **技术选型** | **chokidar** 合适。Linux（inotify）/ macOS（FSEvents）/ Windows（ReadDirectoryChangesW）均通过 chokidar 统一封装 |
| **关键修正** | **不要**新建 `doPushBatch` 直调 `uploadContent`；应 **debounce 后触发现有 `SyncEngine.runSync()`**，复用 Phase1 rename/move、Phase2 对账、FileUploader、方案一索引 |
| **工作量** | 分 3 个 Phase，合计约 **4～6 人日**（含联调）；原稿 ~275 行估算偏乐观 |
| **风险** | 可控：默认 watch + 定时兜底双轨；`watchEnabled: false` 可一键回退纯轮询 |

---

## 3. 架构设计

### 3.1 原则

1. **watch 只负责「何时 sync」**，不负责「如何 sync」
2. **单一同步引擎**：watch / 定时器 / 手动 API 三条入口，最终都走 `scheduler → doSync → engine.runSync()`
3. **定时器保留为兜底**：watch 漏事件（Docker 挂载、NFS、编辑器异常写入）时仍靠周期 sync 修正
4. **渐进交付**：Phase 1 先上 push 场景（收益最大、ignoreSet 可省略）；bidirectional 的 echo 抑制 Phase 2 再做

### 3.2 总览

```
┌─ 触发源 ─────────────────────────────────────────────┐
│  ① chokidar（push/bidirectional，watchEnabled）       │
│  ② setInterval(autoSyncIntervalSec)  兜底/ pull     │
│  ③ Management API 手动 trigger                        │
└──────────────────────────┬───────────────────────────┘
                           │ debounce + 串行锁（现有 isSyncing）
                           ▼
              SyncScheduler.scheduleMapping(reason)
                           │
                           ▼
              doSync → SyncEngine.runSync()
                ├─ Phase1  inode rename/move（push 侧）
                ├─ Phase1.5 远端 rename/move（pull 侧）
                ├─ Phase2  路径对账 upload/download/delete
                └─ FileIndex publish/consume（若 enableFileIndex）
```

### 3.3 与 Obsidian 方案的差异

Obsidian 插件（[上传与移动重命名改造方案](../../../obsidian-xgkb-sync/docs/上传与移动重命名改造方案.md)）用 **Vault 事件** 驱动，且无 inode。
本 Agent 是 **Node 独立进程**，用 **chokidar + 现有 inode 对账**，不移植 Obsidian 事件层，但 **upload/rename 语义与 openclaw SyncEngine 一致**。

---

## 4. 模块设计

### 4.1 新增 `src/fileWatcher.ts`

职责：封装 chokidar，输出「该 sync 了」信号，不碰 KB API。

```typescript
/** 每个 enabled mapping 至多一个 FileWatcher 实例 */
export class FileWatcher {
  constructor(opts: {
    mappingId: string;
    localRoot: string;
    filePatterns: string[];
    excludePatterns: string[];
    debounceMs: number;
    usePolling: boolean;
    /** bidirectional pull 写入时由 SyncEngine 注册，watch 回调内过滤 */
    shouldIgnore: (relativePath: string) => boolean;
    onBatchReady: (reason: string) => void;
  });

  start(): void;
  stop(): void;
  /** 供 ignoreSet：pull 写入前批量注册 */
  addIgnore(paths: Iterable<string>): void;
  clearIgnore(): void;
}
```

**chokidar 推荐配置**（与项目 exclude/filePatterns 对齐）：

```typescript
chokidar.watch(localRoot, {
  ignored: (absPath) => !isUnderSyncScope(absPath), // 复用 micromatch + 点文件排除
  ignoreInitial: true,
  persistent: true,
  awaitWriteFinish: {
    stabilityThreshold: 300,
    pollInterval: 100,
  },
  usePolling: config.usePolling ?? false,
});
```

**事件处理规则**：

| 事件 | 处理 |
|------|------|
| `add` / `change` / `unlink` | 转相对路径 → `shouldIgnore` → 入 `pendingPaths` → debounce |
| `addDir` / `unlinkDir` | 同上（目录变更最终由 Phase1 inode 或全量兜底处理） |
| `ready` | 打日志；**不**把 initial 当变更（`ignoreInitial: true`） |
| `error` | warn + 依赖定时器兜底 |

**硬编码排除（始终 ignore）**：

- `.openclaw-sync-map.json`（方案一 consume 写入，避免 echo）
- `**/_conflict_*`、`**/.tmp/**`（已有 exclude）
- 隐藏文件/目录（`.` 开头，与 `LocalFsAdapter.walk` 一致）

**debounce 逻辑**：

```
pendingPaths.add(path)
clearTimeout(debounceTimer)
debounceTimer = setTimeout(() => {
  if (pendingPaths.size === 0) return
  pendingPaths.clear()
  onBatchReady('watch')   // → scheduler.scheduleMapping
}, pushDebounceMs)
```

不在 watcher 内做 rename 配对——目录 rename 仍交给 **SyncEngine Phase1 `detectLocalRenames`**，避免两套逻辑分叉。

### 4.2 改造 `src/scheduler.ts`

| 改动 | 说明 |
|------|------|
| 启动 | 对每个 `enabled && needsPush(mapping)` 创建并 `start()` FileWatcher |
| 停止 | `stop()` 时关闭所有 watcher |
| 触发 | `onBatchReady` → `scheduleMapping(mapping, 'watch')` |
| 日志 | `===== 开始同步 (watch) =====` / `(timer)` / `(manual)` |
| 串行 | **沿用** `isSyncing + pendingSync`；watch 触发时若已在 sync，设 `pendingSync=true`（与现逻辑一致） |

```typescript
function needsPush(mapping: SyncMapping, globalDir: SyncDirection): boolean {
  const dir = mapping.syncDirection ?? globalDir;
  return dir === 'push' || dir === 'bidirectional';
}

function needsWatch(mapping: SyncMapping, config: SyncConfig): boolean {
  if (!needsPush(mapping, config.syncDirection)) return false;
  return mapping.watchEnabled ?? config.watchEnabled ?? true; // 默认开
}
```

**定时器语义（兼容升级）**：

| syncDirection | autoSyncIntervalSec | 作用 |
|---------------|---------------------|------|
| `push` | 仍生效 | watch 失效时的**兜底**；建议默认改为 1800s（30min），watch 承担主路径 |
| `bidirectional` | 仍生效 | **pull 周期 + 全量兜底**；本地变更主要靠 watch |
| `pull` | 仍生效 | 唯一触发源；不启 watch |

> v1 **不**改变 `autoSyncIntervalSec` 字段名，仅在 README 中说明语义：push 场景下为兜底间隔。避免破坏现有 config。

### 4.3 改造 `SyncEngine` / `LocalFsAdapter`（Phase 2，bidirectional）

**问题**：pull 下载写本地 → chokidar 误以为用户修改 → 无意义 push。

**解决**：mapping 级 `ignoreSet`（内存 Set，不入库）。

```
runSync 开始（syncDirection 含 pull）:
  ignoreSet.clear()

Phase2 每次 download / rename-local / writeFile 前:
  ignoreSet.add(relativePath)

runSync finally:
  ignoreSet.clear()
  通知 FileWatcher.clearIgnore()
```

实现位置优先级：

1. `LocalFsAdapter.writeFile(relativePath, ...)` 增加可选 `onBeforeWrite` 回调
2. 或 `SyncEngine` 下载/重命名入口显式 `watcher.addIgnore([path])`

**Phase 1（仅 push mapping）可跳过 ignoreSet**：push 不写本地内容（除 enableFileIndex consume，已在 watcher 硬排除）。

### 4.4 水位与增量

watch 触发的 `runSync` **完全沿用现有逻辑**：

- 仍调用 `listChanges(since=lastSyncSince - safetyWindow)`
- 成功后 scheduler 推进 `lastSyncSince`（`stats.newSince`）
- 远端 0 变更 + 本地有修改 → 走已有增量快速通道上传（见 `syncEngine.ts` L272-293）

**无需**为 watch 单独维护水位。

---

## 5. 配置

### 5.1 新增字段

```typescript
// SyncConfig（全局默认）
interface SyncConfig {
  /** 是否启用本地文件监听触发 push，默认 true */
  watchEnabled?: boolean;
  /** watch debounce（毫秒），默认 1500 */
  pushDebounceMs?: number;
  /** watch 不可靠环境（NFS/Docker 卷）改用轮询，默认 false */
  watchUsePolling?: boolean;
}

// SyncMapping（可覆盖全局）
interface SyncMapping {
  watchEnabled?: boolean;
  pushDebounceMs?: number;
  watchUsePolling?: boolean;
}
```

### 5.2 常量（`constants.ts`）

```typescript
export const DEFAULT_PUSH_DEBOUNCE_MS = 1500;
export const DEFAULT_WATCH_ENABLED = true;
export const DEFAULT_WATCH_USE_POLLING = false;
export const WATCH_AWAIT_WRITE_STABILITY_MS = 300;
export const WATCH_AWAIT_WRITE_POLL_MS = 100;
```

### 5.3 推荐 config（OpenClaw push 服务器）

```json
{
  "autoSyncIntervalSec": 1800,
  "fullReconcileIntervalSec": 3600,
  "watchEnabled": true,
  "pushDebounceMs": 1500,
  "mappings": [{
    "mappingId": "output",
    "syncDirection": "push",
    "watchEnabled": true
  }]
}
```

---

## 6. 分阶段执行计划

### Phase 1：watch → runSync（push 主场景）— 约 2 人日

| 任务 | 验收标准 |
|------|----------|
| 新增 `fileWatcher.ts` | 单元/手测：改 md → debounce 后 scheduler 收到 watch 触发 |
| scheduler 集成 start/stop | 启停服务无泄漏；disabled mapping 不建 watcher |
| 配置解析 + 默认值 | `tsc` 通过；缺省 `watchEnabled=true` |
| 排除 `.openclaw-sync-map.json` | consume 后不触发 watch push |
| 日志 | `[FileWatcher][id] ready` / `batch N paths` / `[Scheduler] 开始同步 (watch)` |

**风险**：低。失败时设 `watchEnabled: false` 回退。

**手测清单**：

1. push mapping，改一个 md → **≤3s** 内日志出现 `↑1`
2. 连改同一文件 3 次 → 仅 **1～2 次** sync（debounce 合并）
3. 停 watch（`watchEnabled: false`）→ 仅定时器触发
4. 新建 / 删除 / 重命名目录 → 仍走 Phase1/2，行为与改前一致

### Phase 2：bidirectional ignoreSet — 约 1.5 人日

| 任务 | 验收标准 |
|------|----------|
| ignoreSet 注册/清理 | pull 下载 10 文件 → watch **不**触发 push |
| FileIndex consume 路径 | 已在 Phase1 硬排除；回归通过 |
| 互斥 + pending | pull 进行中 save 本地 → pendingSync，pull 完再 push |

**手测清单**：

1. bidirectional：远端改文件 → pull 下来 → **无**多余 upload
2. pull 进行中本地再改 → pull 结束后本地变更被 push

### Phase 3：可观测性与文档 — ✅ 已完成

| 任务 | 状态 |
|------|------|
| Management API `/status` | ✅ `watchActive`、`lastWatchTriggerAt`、`lastTriggerReason`、`watchEnabledEffective` |
| PUT `/config` | ✅ `watchEnabled`、`pushDebounceMs`、`watchUsePolling` |
| Web UI | ✅ 全局 + mapping 表单；运行状态展示监听与触发源 |
| README / MANAGEMENT_API | ✅ 已更新 |
| config.example.json | ✅ 已有示例 |

---

## 7. 风险矩阵

| 风险 | 等级 | 缓解 |
|------|------|------|
| Docker/NFS 上 inotify 不可用 | 中 | `watchUsePolling: true` + `autoSyncIntervalSec` 兜底 |
| 编辑器多次 write | 低 | `awaitWriteFinish` + debounce |
| watch 与 timer 同时触发 | 低 | 现有 `isSyncing` 串行 + `pendingSync` |
| pull 写本地 echo push | 中（bidirectional） | Phase2 ignoreSet |
| API 限流 429 | 低 | 现有 RateLimiter；debounce 合并减少突发 |
| 大目录 watch 内存 | 低 | 典型 vault <1 万文件；异常可关 watch |
| chokidar 进程 crash | 低 | try/catch on error；定时器兜底 |

---

## 8.  deliberately 不做（v1 范围外）

| 项 | 原因 |
|----|------|
| 独立 `doPushBatch` upload 路径 | 与 SyncEngine 行为分叉，rename/delete/索引会错 |
| watcher 内目录 rename 100ms 配对 | 已有 `reconcileEngine.detectLocalRenames` |
| push/pull 双定时器 + 双锁 | 复杂度高；单 `runSync` + 触发源标签足够 |
| 增量「只 scan 变更路径」 | `listFiles()` 仍全量 walk；v1 接受（变更延迟已解决） |
| 修改 `autoSyncIntervalSec` 字段名 | 破坏现有部署 |

---

## 9. 文件改动清单

| 文件 | Phase | 约行数 |
|------|-------|--------|
| `src/fileWatcher.ts` | 1 | +150 |
| `src/scheduler.ts` | 1 | +80 |
| `src/constants.ts` | 1 | +10 |
| `src/types.ts` | 1 | +15 |
| `src/config.ts` | 1 | +25 |
| `src/syncEngine.ts` | 2 | +40 |
| `src/localFs.ts` | 2 | +15 |
| `src/managementApi.ts` | 3 | +30 |
| `public/index.html` | 3 | +20 |
| `README.md` / `config.example.json` | 3 | 文档 |

**合计约 400～500 行**（含注释与日志）。

---

## 10. 依赖

```json
{
  "dependencies": {
    "chokidar": "^4.0.0"
  },
  "devDependencies": {
    "@types/chokidar": "^2.1.0"
  }
}
```

chokidar v4 支持 Node 18+（与 `package.json engines` 一致）。

---

## 11. 成功指标

| 指标 | 目标 |
|------|------|
| 本地保存 → 首次 upload 完成 | P50 **< 5s**（debounce 1.5s + sync 耗时） |
| 无变更时 watch 触发 | **0 次** upload（依赖现有增量 skip） |
| 兜底 | 关闭 watch 后行为与当前版本一致 |
| 方案一索引 | publish skip 逻辑不受影响 |

---

## 12. 建议排期

```
Week 1: Phase 1 开发 + push 场景联调
Week 2: Phase 2 bidirectional + Phase 3 文档/API
```

**优先上线 Phase 1** 即可满足 OpenClaw 服务器「本地产出笔记即时入库」的核心诉求；bidirectional 单机用户随后跟进 Phase 2。

---

## 13. 参考

- [方案二-PushPull分离与chokidar实时推送.md](./方案二-PushPull分离与chokidar实时推送.md)（初稿，部分实现路径已修订）
- [关于文件(夹)移动和重命名的优化方案.md](./关于文件(夹)移动和重命名的优化方案.md)（模式 A watch + 模式 B scan）
- [sync-logic-reference-for-obsidian.md](../sync-logic-reference-for-obsidian.md)
- [方案一-映射文件独立同步-评估与执行计划.md](./方案一-映射文件独立同步-评估与执行计划.md)（已实现）
