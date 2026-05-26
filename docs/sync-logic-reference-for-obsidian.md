# 同步逻辑参考文档（Obsidian 插件优化用）

> **用途**：本文档描述 `openclaw-xgkb-sync` 当前实现的完整同步逻辑，供 Obsidian 知识库同步插件对照、借鉴与优化。  
> **版本基准**：2026-05 当前主干实现（含 inode 对账、远端 rename/move、双向安全机制）。  
> **代码入口**：`src/syncEngine.ts`、`src/reconcileEngine.ts`、`src/scheduler.ts`、`src/syncStateDb.ts`

---

## 1. 设计目标与核心原则

### 1.1 要解决的问题

传统「路径 diff」同步把 **rename/move** 误解为 **delete + create**，导致：

- 大目录改名时触发海量上传/下载
- 远端 `fileId` 变化，版本历史断裂
- 本地 inode 变化，破坏编辑器/插件对文件的引用

本项目的核心思路是 **身份对账（Identity-based Reconciliation）**：

| 维度 | 本地身份 | 远端身份 |
|------|----------|----------|
| 文件 | `(dev, ino)` 字符串对 | `remoteFileId` |
| 文件夹 | `(dev, ino)` 字符串对 | `remoteFolderId`（文件夹节点 fileId） |
| 路径 | 可变，仅作索引键 | 可变，由 `parentId + name` 或 `relativePath` 表达 |

**路径是视图，身份是真相。** 路径变化时，优先用身份匹配执行 rename/move，而不是 delete+upload。

### 1.2 同步模式

每条映射（Mapping）支持三种方向：

| 模式 | 行为 |
|------|------|
| `push` | 只上传、只删远端；忽略远端 rename/move |
| `pull` | 只下载、只删本地（回收站）；不修改远端 |
| `bidirectional` | 双向同步；冲突用 `conflictStrategy` 配置 |

### 1.3 一轮同步的高层结构

```
Scheduler.doSync(mapping)
  │
  ├─ 0. 读取 SQLite（lastSyncSince、resolvedRootFileId 等）
  ├─ 1. RemoteFsAdapter.init()（解析 projectId / rootFileId）
  │
  └─ 2. SyncEngine.runSync()
         ├─ 本地扫描：listFiles() + listDirectories()
         ├─ 远端视图：buildRemoteMap()（增量优先，失败降级全量）
         ├─ Phase 1   本地 → 远端 rename/move（inode 对账，push/bidirectional）
         ├─ Phase 1.5 远端 → 本地 rename/move（fileId 对账，pull/bidirectional）
         ├─ Phase 2   路径对账 + decide() + 执行 upload/download/delete
         └─ 收尾：pruneRemoteEmptyDirectories、cleanupTrash
  │
  └─ 3. 推进水位（仅 stats.failed === 0 时更新 lastSyncSince）
```

---

## 2. 状态模型（SQLite）

Obsidian 插件可用 IndexedDB / 插件 data 等等价实现，语义保持一致即可。

### 2.1 `sync_mapping_state`（映射级）

| 字段 | 含义 |
|------|------|
| `mapping_id` | 映射唯一 ID |
| `last_sync_since` | 增量同步水位（毫秒时间戳） |
| `last_server_time` | 服务端返回的时间 |
| `last_success_at` | 最近一次无系统性失败的时间 |
| `last_full_scan_at` | 最近一次成功全量扫描时间 |
| `resolved_root_file_id` | 缓存的远端根 folder fileId |
| `resolved_project_id` | 缓存的 projectId |
| `last_error` / `last_stats_json` | 诊断信息 |

**水位推进规则**：本轮 `stats.failed === 0` 且 `newSince` 有效时才写入 `last_sync_since`；否则下轮仍用旧水位重试。

### 2.2 `sync_file_state`（文件级）

| 字段 | 含义 |
|------|------|
| `local_path` | 当前本地相对路径（主键之一） |
| `remote_file_id` | 远端文件节点 ID（身份） |
| `remote_folder_id` | 文件直接父目录的远端 folderId |
| `local_mtime` / `remote_mtime` | 上次同步时记录的 mtime |
| `local_dev` / `local_ino` | 本地 `(dev, ino)`，**TEXT 存字符串**（Windows NTFS 大 inode 防精度丢失） |
| `remote_relative_path` | 上次已知的远端相对路径 |
| `sync_status` | `done` / `failed` |
| `last_sync_at` | 上次成功同步时间（用于安全窗口） |

### 2.3 `sync_folder_state`（文件夹级）

| 字段 | 含义 |
|------|------|
| `local_path` | 本地目录相对路径 |
| `remote_folder_id` | 该目录在 KB 中的 folder fileId |
| `local_dev` / `local_ino` | 目录自身的 inode（用于文件夹 rename 检测） |

> 空目录也会写入（在有文件上传或全量扫描持久化后）。文件夹 rename/move 依赖此表 + inode。

---

## 3. 本地扫描

### 3.1 文件扫描 `listFiles()`

- 递归 walk `localRoot`
- 对每个文件 `fs.stat(path, { bigint: true })`，取：
  - `mtimeMs` → `mtime`
  - `dev` / `ino` → **`.toString()` 存为字符串**
- 用 `micromatch` 过滤 `filePatterns` / `excludePatterns`

### 3.2 目录扫描 `listDirectories()`

- 递归 walk 所有目录（不含文件本身）
- 同样取 `dev` / `ino`（bigint → string）
- 供 Phase 1 文件夹 rename 检测

### 3.3 inode 注意事项（Obsidian 需同样处理）

| 平台 | 说明 |
|------|------|
| Windows NTFS | `ino` 可能超过 `Number.MAX_SAFE_INTEGER`，**必须用 BigInt 再转 string** |
| Linux/macOS | 常规 inode，同样建议 string 存储 |
| 跨卷 copy | 新 inode，无法配对 → 退化为路径 diff |
| `ino === '0'` | 不支持或 stat 失败，跳过 inode 对账 |

---

## 4. 远端视图构建 `buildRemoteMap()`

输出：`Map<relativePath, RemoteFileEntry>`，以及 `remoteDeltaCount`、`fullScan`、`remoteMoveHints`。

### 4.1 触发条件

| 条件 | 路径 |
|------|------|
| 无 `lastSyncSince`（首轮 / 上轮失败） | 全量 |
| `forceFullScan`（周期性全量，默认 3600s） | 全量 |
| 增量 `listChanges` 失败 | 降级全量 |
| 增量中有「全新目录」下的新文件且无法解析 parentId | 降级全量 |
| 增量中远端 move 目标目录无法解析 | 降级全量 |
| 其他 | 增量 |

### 4.2 增量路径 `tryIncrementalRemoteMap()`

```
listChanges(safeSince)     // safeSince = lastSyncSince - 5000ms
  ├─ 分类：deleteIds / knownUpsertIds / unknownUpsertIds
  ├─ 构建 folderIdToPath（来自 DB 已有 record.remoteFolderId）
  ├─ unknownUpsert：用 parentId + name 重建路径；失败 → 降级全量
  ├─ knownUpsert：batchGetMeta → 刷新 mtime/parentId
  │     └─ parentId 或 name 变化 → 生成 RemoteMoveHint（Phase 1.5 用）
  └─ 组装 remoteMap（已知文件用 effectivePath，可能是新路径）
```

### 4.3 全量路径 `fullRemoteMap()`

```
listDescendantFiles(rootFileId, 分页 limit=500, includePath=true)
  → 按 relativePath 建 Map
  → persistFolderStatesFromRemoteEntries() 写 sync_folder_state
```

### 4.4 远端 rename/move 检测（Phase 1.5 输入）

**增量模式**：在 `knownUpsert` 的 `batchGetMeta` 中，若 `parentId` 或 `name` 与 DB 中 `remoteFolderId` / 文件名不同 → `RemoteMoveHint`。

**全量模式**：`detectRemoteMovesFromFullScan()` — 用 `remoteFileId` 匹配 DB，路径不同即 rename/move；同目录下 ≥80% 文件共享前缀变化 → 合并为目录级 hint。

---

## 5. Phase 1：本地 → 远端 rename/move

**适用**：`syncDirection !== 'pull'`  
**入口**：`reconcileEngine.detectLocalRenames()`

### 5.1 前置准备

1. `backfillInodes()`：补全迁移后 NULL 的 inode
2. `syncFolderInodes()`：目录 inode 写入 `sync_folder_state`
3. `buildFolderPathToRemoteId()` + `enrichFolderPathToRemoteId(createIfMissing=false)`  
   - **关键**：对账阶段只 lookup 已有目录，**不提前 createFolder**，避免与 pending rename 冲突

### 5.2 检测顺序

```
第一轮 detectFolderRenames()
  └─ sync_folder_state 中有 inode 的记录
  └─ inode 对应当前 localDirs 中路径 ≠ 旧 local_path
  └─ 同父目录 → rename-remote（目录级 updateFileName）
  └─ 跨目录   → move-remote（目录级 moveFile）
  └─ 只保留最外层目录候选

第二轮 detectSingleFileMoves()
  └─ sync_file_state 中有 inode + remoteFileId
  └─ inode 对应当前路径 ≠ 旧 local_path
  └─ 跳过 Phase 1 已消费的 from/to 路径
  └─ 同父目录 → rename-remote（updateFileName）
  └─ 跨目录   → move-remote（moveFile；targetParentId 空则执行时创建目录）
```

### 5.3 执行顺序

目录级 plan **先于** 文件级 plan；每个 plan 调用 KB API 后更新 SQLite 与 `remoteMap`。

| 操作 | KB API | DB 更新 |
|------|--------|---------|
| 文件 rename-remote | `updateFileName(fileId, newName)` | 删旧路径 record，写新路径，**fileId 不变** |
| 文件 move-remote | `moveFile(fileId, targetParentId, ...)` | 同上；若 `idChanged` 处理 `idMappings` |
| 目录 rename-remote | `updateFileName(folderFileId, newName)` | 批量更新子文件路径前缀 + folder_state |
| 目录 move-remote | `moveFile(folderFileId, targetParentId)` | 同上 |

**冲突策略**（mapping 级配置）：

- `moveNameConflictStrategy`：0 重命名 / 1 覆盖 / 2 异常 / 3 跳过（默认 3）
- `renameNameConflictStrategy`：0 重命名 / 1 异常（默认 1）

---

## 6. Phase 1.5：远端 → 本地 rename/move

**适用**：`syncDirection !== 'push'`

### 6.1 执行逻辑

```
收集 RemoteMoveHint（增量或全量检测）
  → 过滤：与 Phase 1 已消费路径冲突的 skip
  → 目录级 hint 优先
  → doRemoteMoveToLocal / doRemoteDirMoveToLocal
       ├─ 检查旧路径存在、新路径不存在
       ├─ localFs.rename(old, new)
       ├─ 更新 sync_file_state / sync_folder_state 路径前缀
       └─ 刷新 localMap（必须！否则 Phase 2 误判）
```

### 6.2 Obsidian 对照

| OpenClaw | Obsidian 等价 |
|----------|---------------|
| `localFs.rename()` | `vault.rename()` / `adapter.rename()` |
| `renameFilePaths()` | 批量更新插件 state 中的 path 字段 |
| 刷新 `localMap` | 重读 vault 文件列表或更新内存索引 |

---

## 7. Phase 2：路径对账与决策

### 7.1 增量快速通道

当 `remoteDeltaCount === 0` 且本地无新增/修改/删除（排除 Phase 1/1.5 已消费路径）→ **整轮 skip**，毫秒级返回。

### 7.2 路径集合

```
allPaths = (localMap.keys \ consumedToPaths) ∪ (remoteMap.keys \ consumedFromPaths)
```

对每个 path 调用 `decide(local, remote, record)`。

### 7.3 决策表 `decide()`（当前实现）

> **注意**：双端冲突已改为 `conflictStrategy`（`local-wins` / `remote-wins`），**不再**用跨时钟 mtime LWW。

| 条件 | push | pull | bidirectional |
|------|------|------|---------------|
| 无 record，仅 local | upload-new | skip | upload-new |
| 无 record，仅 remote | skip | download-new | download-new |
| 无 record，双端都有 | upload-update | download-update | conflictStrategy 决定 |
| 双端都消失 | skip | skip | skip |
| 无 local，有 remote，remote 变了 | skip | download-update | download-update |
| 无 local，有 remote，remote 未变 | skip | delete-remote* | delete-remote* |
| 有 local，无 remote，local 变了 | upload-new | skip | upload-new |
| 有 local，无 remote，local 未变 | delete-local** | skip | delete-local** |
| 仅 local 变 | upload-update | skip | upload-update |
| 仅 remote 变 | skip | download-update | download-update |
| 双端都变（冲突） | upload-update | download-update | conflictStrategy 决定 |
| 双端都未变 | skip | skip | skip |

\* `delete-remote` 前有 **10 分钟 recently-synced 安全窗口**（有 record 时）。  
\*\* `delete-local` 走**回收站**（见 §8），无 record 时**无**安全窗口——清空 DB 后首轮风险点。

### 7.4 执行顺序

```
1. delete-local / delete-remote（串行）
2. download-new / download-update（downloadConcurrency 并发）
3. upload-new / upload-update（uploadConcurrency 并发）
4. pruneRemoteEmptyDirectories（push/bidirectional）
```

每个 upload/download/delete 执行前有 **re-check**（stat 验证文件仍存在且 mtime 未变）。

---

## 8. 安全机制

### 8.1 delete-local → 回收站

不直接 `unlink`，移至 `~/.openclaw/trash/{mappingId}/{YYYY-MM-DD}/{relativePath}`，保留 7 天。

Obsidian 建议：vault 内 `.trash/` 或系统废纸篓，同样避免 P0 误删。

### 8.2 recently-synced 窗口（10 分钟）

有 record 且 `syncStatus=done` 且 `lastSyncAt` 在 10 分钟内：

- 远端列表暂时看不到文件 → **不 delete-local**
- 本地还在但远端刚上传完 → **不 delete-remote**（配合 listDescendantFiles 延迟）

### 8.3 执行前 re-check

| 操作 | 跳过条件 |
|------|----------|
| upload | 文件已不存在；mtime 与计划时不一致 |
| delete-local | 文件已不存在；mtime 已变化（用户又改了） |

### 8.4 水位保守提交

任一本轮 `stats.failed > 0` → 不推进 `lastSyncSince`，下轮重试。

### 8.5 全量兜底

增量失败、路径无法重建、周期性 `fullReconcileIntervalSec`（默认 3600s）→ 强制 `listDescendantFiles` 全量对账。

---

## 9. 知识库 API 使用摘要

### 9.1 列表与增量

| API | 用途 |
|-----|------|
| `listChanges(since, rootFileId?)` | 增量变更 |
| `listDescendantFiles(rootFileId, cursor, includePath)` | 全量文件列表 |
| `batchGetMeta(fileIds)` | 刷新 parentId/name/mtime |

### 9.2 内容同步

| 场景 | 流程 |
|------|------|
| 新建文件 | 分片上传 → `saveResource` → `saveFileByPath` |
| 更新文件 | 分片上传 → `saveResource` → `updateFileVersion` |
| 下载 | `getDownloadInfo` → OSS URL；失败降级 `getFullFileContent` |

### 9.3 结构同步（rename/move）

| 场景 | API |
|------|-----|
| 同目录改名 | `updateFileName(fileId, newName, nameConflictStrategy)` |
| 跨目录移动 | `moveFile(fileId, targetParentId, nameConflictStrategy)` |

`moveFile` 覆盖策略下 `idChanged=true` 时需处理 `idMappings`（sourceFileId → targetFileId）。

### 9.4 目录解析（init 阶段）

```
getLevel1Folders → getChildFiles（逐级）→ 不存在则 createFolder
```

对账阶段 `createIfMissing=false`，仅在实际 upload/move 执行时创建。

---

## 10. 调度与并发

### 10.1 定时触发

- `autoSyncIntervalSec`：全局定时器，触发所有 enabled mapping
- 启动时额外触发一轮「启动后初始同步」（带 `startupJitterMaxSec` 抖动）

### 10.2 并发模型

| 层级 | 规则 |
|------|------|
| 同一 mapping | 严格串行；同步中再触发 → `pendingSync=true`（布尔，合并为最多补 1 轮） |
| 不同 mapping | `maxConcurrentMappings`：共用 appKey 最多 3，独立 appKey 最多 5 |
| HTTP 请求 | 按 appKey 令牌桶：`maxRequestsPerMinute`（默认 60）、burst 8、429 冷却 60s |
| 文件传输 | upload 并发 3、download 并发 5 |

### 10.3 性能建议（Obsidian 同样适用）

| mapping 数量 | 建议 `autoSyncIntervalSec` |
|-------------|---------------------------|
| 1～5 | 60～120 |
| 5～20 | 120～180 |
| 20+ | 180～300+ |

30 秒 + 多 mapping + 共用 appKey → 极易 429 限流与队列积压。

---

## 11. 典型场景速查

### 11.1 本地单文件改名（同目录）

```
Phase 1: inode 匹配 → rename-remote (updateFileName)
Phase 2: 旧路径 consumed，不参与路径对账
```

### 11.2 本地文件移动到新目录

```
Phase 1: inode 匹配 → move-remote (moveFile)
  └─ 目标目录无 folderId → 执行时 createFolder 再 move
```

### 11.3 本地文件夹改名

```
Phase 1: folder inode 匹配 → rename-remote 目录级 (一次 updateFileName)
  └─ 子文件 DB 路径前缀批量更新，无需逐文件 API
```

### 11.4 远端网页端改名

```
Phase 1.5: batchGetMeta parentId/name 变化 → 本地 fs.rename
  └─ 全量模式：remoteFileId 路径对比兜底
```

### 11.5 无法 inode 配对（跨卷复制、ino=0）

```
Phase 1: 跳过
Phase 2: 旧路径 delete-* + 新路径 upload/download（退化行为）
```

### 11.6 清空 DB 后首轮全量

```
无 record → 同路径双端存在 → upload-update / download-update（会传内容，不单建索引）
无 record + 远端列表漏报 → delete-local 风险（无 10 分钟窗口）
建议：KB 健康时操作；push 模式相对安全；盯日志 fail/delete 计数
```

---

## 12. Obsidian 插件适配建议

### 12.1 可直接复用的逻辑

1. **三表状态模型**（mapping / file / folder）+ 水位机制  
2. **Phase 顺序**：本地 rename/move → 远端 rename/move → 路径 diff  
3. **inode / fileId 身份对账** 优先于路径 diff  
4. **decide() 三态输入**（local, remote, record）+ syncDirection 过滤  
5. **delete-local 回收站** + recently-synced 窗口 + 执行前 re-check  
6. **增量快速通道**（远端 0 变更 + 本地无变化 → skip）  
7. **全量周期性兜底** + 增量失败降级  
8. **对账阶段不预创建远端目录**

### 12.2 Obsidian 特有能力可加强的部分

| OpenClaw 限制 | Obsidian 机会 |
|---------------|---------------|
| 定时 scan，无 FS watch | 可用 `vault.on('rename')` / `modify` 事件加速 |
| Node fs.stat bigint | `app.vault.adapter.stat()`；注意移动端 inode 可用性 |
| 单进程 SQLite | 插件 data + 可选 LevelDB |
| 无 UI 冲突文件 | 可弹窗让用户选 local/remote/merge |
| mtime 冲突 | 可用 `contentHash`（若 KB 支持）或三方合并 |

### 12.3 Obsidian 需特别注意

1. **Vault 内 rename** 由 Obsidian API 触发，比纯 scan 更可靠  
2. **移动端** inode 可能不可用 → 文件夹 rename 检测需降级策略  
3. **`.obsidian/` 等目录** 应排除在 filePatterns 外  
4. **同步周期** 不建议低于 60s（Obsidian 主线程/IO 压力）  
5. **rename-local 后** 必须刷新 vault 文件索引，等同 OpenClaw 刷新 `localMap`

### 12.4 推荐插件架构对照

```
Obsidian Plugin
├── SyncStateStore        ← syncStateDb.ts
├── LocalVaultAdapter     ← localFs.ts（vault API 封装）
├── RemoteKbAdapter       ← remoteFs.ts + kbApi.ts
├── ReconcileEngine       ← reconcileEngine.ts（可复用算法）
├── SyncEngine            ← syncEngine.ts（Phase 1/1.5/2）
├── SyncScheduler         ← scheduler.ts（或 Obsidian interval + 防重入）
└── SettingsTab           ← mapping 配置、conflictStrategy 等
```

---

## 13. 配置项速查

| 配置 | 默认 | 说明 |
|------|------|------|
| `autoSyncIntervalSec` | 180 | 0=关闭定时 |
| `fullReconcileIntervalSec` | 3600 | 周期性全量；0=关闭 |
| `syncDirection` | bidirectional | push/pull/bidirectional |
| `conflictStrategy` | local-wins | 双端同改：local-wins / remote-wins |
| `moveNameConflictStrategy` | 3（跳过） | moveFile 冲突 |
| `renameNameConflictStrategy` | 1（报错） | updateFileName 冲突 |
| `maxRequestsPerMinute` | 60 | 每 appKey 限速 |
| `downloadConcurrency` | 5 | |
| `uploadConcurrency` | 3 | |

---

## 14. 已知限制（移植时需知晓）

1. `listChanges` **不支持 move 事件**；远端目录 rename 可能漏检，靠全量 `remoteFileId` 对比兜底  
2. 增量 rename 检测要求 DB 中已有 `remoteFolderId`  
3. 全量目录 rename 聚合用 **80% 覆盖率启发式**，极端情况退化为逐文件 rename  
4. 双端同时 rename 同一文件：Phase 1（本地）优先，Phase 1.5 跳过已消费路径  
5. 清空 DB 后无 record 保护，首轮 delete-local 风险升高  
6. `pendingSync` 为布尔，同步耗时 > 定时间隔时中间触发会被合并  
7. KB 允许「文件节点下挂文件」时，本地无法镜像，会 shadow 跳过子路径  

---

## 15. 相关文档

| 文档 | 内容 |
|------|------|
| [local-change-scenarios.md](./local-change-scenarios.md) | 本地三种变更场景的 API 参数 |
| [kb-api-requirements-for-sync.md](./kb-api-requirements-for-sync.md) | KB 需提供的接口契约 |
| [bidirectional-sync-analysis.md](./bidirectional-sync-analysis.md) | 双向同步风险与决策 |
| [DESIGN.md](./DESIGN.md) | 模块结构（部分决策表已过时，以本文为准） |

---

## 16. 一句话总结

**先按身份（inode / fileId）对齐 rename/move，再按路径 diff 处理内容增删改；增量优先、全量兜底、删除走回收站、冲突可配置——这是 openclaw-xgkb-sync 与 Obsidian 插件应共用的同步范式。**
