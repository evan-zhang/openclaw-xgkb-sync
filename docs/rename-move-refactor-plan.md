# 文件(夹)移动与重命名 — 同步服务重构方案与实现计划

> **状态**：方案定稿，待开发  
> **读者**：openclaw-xgkb-sync 维护者、联调测试  
> **关联文档**：
> - 现网行为（改前）：[local-change-scenarios.md](./local-change-scenarios.md)
> - KB v2 已实现说明：`d:\dingding\kb-api-requirements-for-sync.md`（或 dev-guide API 明细 v2）
> - 架构基线：[DESIGN.md](./DESIGN.md)

---

## 1. 为什么要重构

### 1.1 现状问题

当前同步引擎以 **`local_path` 为身份键**，每轮 `walk` 后与 SQLite、远端 path 做**路径并集**决策（`decide()`）。rename/move 在语义上等价于：

```
旧路径 → delete-remote + 删 state
新路径 → upload-new（全量读盘 + uploadContent）
```

当目录下有 **N 个文件**时，一次文件夹 rename 约 **2N 次写 API + N 倍带宽**，且 **remote fileId 全部换新**，状态库与版本链断裂。

详见 [local-change-scenarios.md](./local-change-scenarios.md)。

### 1.2 目标

| 目标 | 说明 |
|------|------|
| **本地 rename/move 元数据化** | 同卷内改 path 时调用 KB **`updateFileName` / `moveFile`**，不重传内容 |
| **远端 rename/move 可感知** | 无 `listChanges.move` 事件下，靠 **`relativePath` + moveHint** 对账 |
| **身份与路径分离** | 状态库以 **`remote_file_id` 为主**；`local_path` 可变；本地用 **`dev:ino`** 发现 path 变化 |
| **独立进程** | 不依赖 OpenClaw Agent；默认可无 FS watch，定时 scan + inode 兜底 |
| **可降级** | inode 不可用 / 配对失败时，仍 honest 走 delete+create，并告警 |

### 1.3 KB 侧现状（已完成）

知识库已按 v2 落地（分支 `feature/kb-sync-api-p0` 及后续），同步客户端**待改造**。要点：

| 能力 | 接口 |
|------|------|
| 同目录改名 | `POST .../updateFileName` |
| 移动（文件/文件夹） | `POST .../moveFile` |
| Meta / 路径 | `batchGetMeta`（`includePath` + `rootFileId` → `relativePath`） |
| 全量对账 | `listDescendantFiles`（`includeFolders` + `includePath`） |
| 增量 | `listChanges`（`includePath` + **`includeMoveHint`**） |
| 路径解析 | `resolvePath` |
| 废弃 | `updateFileProperty`（open-api 返回 400） |

完整契约见 **`kb-api-requirements-for-sync.md`（KB 实现版）** 或 dev-guide §1.x。

---

## 2. 设计原则

### 2.1 三层模型

```
┌─────────────────────────────────────────────────────────┐
│ L1 身份层    remote_file_id ←→ local_path + local_inode │
│ L2 观测层    walk(+stat) [+ 可选 FS watch journal]       │
│ L3 执行层    reconcile → updateFileName / moveFile / …   │
└─────────────────────────────────────────────────────────┘
```

- **路径不是身份**；path 变、inode 不变 → **move/rename**，不是 delete+upload。
- **默认可无 watch**（模式 B）：定时 walk 取 `stats.dev` + `stats.ino` 即可发现同卷 rename。
- **watch 为增强**（模式 A，P2）：目录 rename 一条事件，延迟更低。

### 2.2 本地身份：`dev:ino`

| 平台 | Node `fs.stat` | 同卷 rename |
|------|----------------|-------------|
| Linux / macOS | `dev` + `ino` | 通常不变 |
| Windows | `dev` + `ino`（实为 fileIndex） | NTFS 通常不变 |
| 网络盘 / ino=0 | `localFileKey=null` | 降级 hash 或 delete+create |

### 2.3 KB 冲突策略（同步默认）

| 接口 | 参数 | 同步默认 | 原因 |
|------|------|----------|------|
| `updateFileName` | `nameConflictStrategy` | **1（报错）** | 避免远端静默 `B(1).md` 与本地 path 不一致 |
| `moveFile` | `nameConflictStrategy` | **2（报错）** | 避免静默覆盖；策略 1 会 **换 fileId** |

配置项预留（后续）：`renameConflictStrategy` / `moveConflictStrategy`，默认上述值；**不使用 cover/overwrite 除非产品显式开启**。

### 2.4 写接口调用约定

所有写接口请求带 **`rootFileId`**（mapping 解析后的 `resolvedRootFileId`），以便响应填充 **`relativePath`**，减少额外 `batchGetMeta`。

```
同目录仅改名     → updateFileName(fileId, newName)
换父目录/夹移动   → moveFile(fileId, targetParentId, newName?)
同时换目录+改名   → moveFile(..., newName)  // KB 先 move 再 rename
```

**不再调用** `updateFileProperty`。

---

## 3. 目标架构

### 3.1 一轮同步（新流程）

```
Scheduler.doSync(mapping)
  │
  ├─ RemoteFsAdapter.init()          // 不变
  │
  ├─ ReconcileEngine.run()         // 替代「纯 path 并集 decide」
  │     │
  │     ├─ 1. 采集
  │     │     localSnapshot = walk(path, mtime, size, dev, ino)
  │     │     [可选] drain FsWatchJournal
  │     │     remoteSnapshot = buildRemoteMap(
  │     │         listChanges(includePath, includeMoveHint),
  │     │         batchGetMeta(includePath),
  │     │         或 listDescendantFiles 全量)
  │     │     state = loadAllFileStates(by remote_file_id 索引)
  │     │
  │     ├─ 2. 对账（Identity Reconcile）
  │     │     2a 远端：同 fileId，relativePath ≠ state → remote-move-local
  │     │     2b 本地：同 inode，path ≠ state → 分类：
  │     │         - 仅 name 变、parent 不变 → rename-remote (updateFileName)
  │     │         - parent 变 → move-remote (moveFile)
  │     │         - 文件夹：优先对 folderId 一次 moveFile
  │     │     2c 未配对 disappear + appear → hash/size 启发式或 delete+create
  │     │     2d 内容：path+fileId 不变，mtime 变 → upload/download update
  │     │
  │     ├─ 3. 生成 SyncPlan（扩展 op 类型）
  │     │
  │     └─ 4. 执行（顺序）
  │           rename-remote / move-remote
  │           → delete-local / delete-remote
  │           → download-*
  │           → upload-*
  │           → pruneRemoteEmptyDirectories
  │
  └─ 更新 mapping 水位 + lastStats
```

### 3.2 新增 SyncOp

在现有 op 基础上增加：

| SyncOp | 方向 | KB 调用 |
|--------|------|---------|
| `rename-remote` | 本地改名 → 推远端 | `updateFileName` |
| `move-remote` | 本地换目录/夹 → 推远端 | `moveFile` |
| `rename-local` | 远端改名 → 拉本地 | `fs.rename` |
| `move-local` | 远端移动 → 拉本地 | `fs.rename` / 建目录 |

执行顺序：**元数据 move/rename → delete → download → upload → prune**。

### 3.3 远端 move 推断（无 move 事件）

优先级：

1. **`listChanges` + `includeMoveHint=true`**：`previousParentId` / `previousName` 辅助判断。
2. **`batchGetMeta(includePath=true)`**：同 `fileId`，`relativePath` ≠ `state.local_path` → 远端 move。
3. **全量 `listDescendantFiles`**：周期性校正 drift。

### 3.4 `moveFile` 响应（最小契约 §4.2.1）

同步端**仅**解析：`fileId`、`sourceFileId`、`idChanged`、`name`、`parentId`、`updateTime`、可选 `relativePath` / `idMappings` / `mainSkipped`。

- 默认策略 **3（跳过）**，`mainSkipped=true` 时不改 state；
- 策略 **1（覆盖）**：`idChanged=true` + `idMappings` 批量改 `remote_file_id`（无 mappings 时用 `sourceFileId→fileId` 兜底）；
- **不解析** `details` / `skippedItems`；规范化见 `src/kbMoveFileContract.ts`。

---

## 4. 数据模型变更

### 4.1 `sync_file_state` 表（迁移）

**现 PRIMARY KEY**：`(mapping_id, local_path)`  
**目标 PRIMARY KEY**：`(mapping_id, remote_file_id)`（`remote_file_id` 非空行）

| 列 | 变更 |
|----|------|
| `remote_file_id` | 主键组成部分；NOT NULL（同步成功后） |
| `local_path` | 保留，**可 UPDATE** |
| `local_dev` | **新增** TEXT，nullable |
| `local_ino` | **新增** INTEGER，nullable |
| `remote_relative_path` | **新增** TEXT，nullable，上次已知 KB relativePath |
| `content_hash` | 已有列，P2 用于 inode 不可用配对 |

**索引**：

```sql
CREATE INDEX idx_file_local_path ON sync_file_state(mapping_id, local_path);
CREATE INDEX idx_file_local_inode ON sync_file_state(mapping_id, local_dev, local_ino);
```

### 4.2 可选：`sync_folder_state`

缓存「本地目录 path → remote folderId」，加速 `moveFile` 的 `targetParentId` 解析（也可用 `resolvePath`）。

### 4.3 可选：`sync_change_journal`（P2 watch）

FS 事件队列，进程重启可丢失（walk 校准）。

### 4.4 迁移策略

1. 启动时检测旧 schema（无 `local_ino` 列）→ `ALTER TABLE` 迁移。
2. 旧数据 PRIMARY KEY 仍为 path；**首次全量对账**后 rewrite 为 remote_file_id 主键行。
3. 迁移期间允许只读告警，不自动 delete 大批量远端。

---

## 5. 模块改造清单

| 模块 | 改动 |
|------|------|
| **`constants.ts`** | 新增 API_PATHS：`updateFileName`、`moveFile`、`resolvePath`；冲突策略枚举 |
| **`types.ts`** | `LocalFileEntry` +dev/ino；FileState 新字段；KB 请求/响应 VO；扩展 `ListChangesItem`（moveHint）；新 SyncOp |
| **`kbApi.ts`** | 实现 v2 读写在方法；`batchGetMeta` 带 `includePath`/`rootFileId`/`includeContentHash`；解析 `errorCode` |
| **`localFs.ts`** | walk 时 stat 取 ino；`rename`/`move` 本地文件；`renameDirectory` 辅助 |
| **`remoteFs.ts`** | `updateFileName`、`moveFile`；`buildRemoteMap` 用 relativePath；处理 `idMappings` |
| **`syncStateDb.ts`** | schema 迁移；`getByRemoteId`/`updateLocalPath`/`applyIdMappings` |
| **`reconcileEngine.ts`** | **新文件**：身份对账 + 计划生成（从 syncEngine 抽离） |
| **`syncEngine.ts`** | 瘦身为执行器 + 保留 buildRemoteMap 增量/全量；接入 reconcile |
| **`scheduler.ts`** | 传 `rootFileId`/`projectId` 给引擎；统计新 op |
| **`config.ts` / types** | 可选：`watchEnabled`、`moveConflictStrategy` |
| **文档** | 更新 DESIGN.md、local-change-scenarios.md、README |

---

## 6. 分阶段实现计划

### Phase 0 — 基础设施（约 3～5 天）

| # | 任务 | 产出 | 验收 |
|---|------|------|------|
| 0.1 | `kbApi` 封装 v2 接口 + 类型 + 错误码映射 | 可单测 mock 调用 | 对测试环境能调通 updateFileName/moveFile |
| 0.2 | SQLite 迁移 + FileState 新字段 | 启动不破坏旧 db | 旧 mapping 能跑完一轮（仍旧逻辑） |
| 0.3 | `localFs` 采集 dev/ino | LocalFileEntry 扩展 | 本机 rename 后 ino 不变可日志验证 |

### Phase 1 — 本地 → 远端 rename/move（约 5～7 天）**MVP**

| # | 任务 | 产出 | 验收 |
|---|------|------|------|
| 1.1 | `reconcileEngine`：inode 相同 path 不同 → rename/move 计划 | ✅ | `a.md→b.md` → `updateFileName` |
| 1.2 | 文件夹：对 **folder remote id** 调一次 moveFile | ✅ | `collapseDirectoryPlans` 合并同目录下全部文件 |
| 1.3 | 执行器：`rename-remote` / `move-remote` + 更新 state | ✅ | 含 `doMoveRemoteDirectory`；stats moved/renamed |
| 1.4 | `remoteFs` + `kbMoveFileContract` 最小响应 §4.2.1 | ✅ | `rootFileId`、`mainSkipped`、`idMappings` |
| 1.5 | mapping 可配冲突策略；失败写 `lastError` | ✅ | 默认 rename=1、move=3；目录/文件失败批量标记 |

**Phase 1 完成标准**：本地同卷 rename/move **不再** delete+upload；与 [local-change-scenarios.md](./local-change-scenarios.md) 场景 1～2 行为更新一致。

### Phase 2 — 远端 → 本地 move（约 4～5 天）

| # | 任务 | 产出 | 验收 |
|---|------|------|------|
| 2.1 | `buildRemoteMap` 使用 batchGetMeta.relativePath | | 增量 listChanges + includePath |
| 2.2 | listChanges `includeMoveHint` | | 写接口后下一轮 hint 可用 |
| 2.3 | reconcile：远端 path 变 → rename-local / move-local | | KB 控制台改 path，本地跟随 |
| 2.4 | 全量 listDescendantFiles 校准（includeFolders） | | 1h 周期纠正 drift |

### Phase 3 — 降级与边界（约 3～4 天）

| # | 任务 | 产出 | 验收 |
|---|------|------|------|
| 3.1 | ino=0 / 跨卷：size+mtime 配对 | | SMB 或 copy 场景不误 move |
| 3.2 | 配对失败 → delete+create + warn | | 日志含 reason |
| 3.3 | moveFile `idMappings` 处理（配置开启策略 1 时） | | 单测 id 切换 |
| 3.4 | pull/push 方向下 skip rename/move | | 与 syncDirection 一致 |
| 3.5 | `resolvePath` 解析 targetParentId | | 减少 getChildFiles 深度 |

### Phase 4 — 可选增强（约 3～5 天）

| # | 任务 | 说明 |
|---|------|------|
| 4.1 | FS watch + change journal | chokidar；失败自动降级 |
| 4.2 | batchGetMeta.contentHash 配对 | 网络盘场景 |
| 4.3 | Web 控制台展示 moved/renamed 统计 | managementApi /status |
| 4.4 | 配置项 UI：冲突策略 | 高级设置 |

---

## 7. 测试计划

| 层级 | 内容 |
|------|------|
| **单元** | reconcile：inode 配对、路径差分、冲突策略选择；idMappings 应用 |
| **集成** | 对接 KB 测试环境：单文件 rename、跨目录 move、文件夹 rename、冲突报错 |
| **回归** | 纯内容修改、delete、首次 upload、pull-only/push-only、prune 空目录 |
| **性能** | 1000 文件目录 rename：API 调用次数、耗时、带宽（应≈0 内容上传） |
| **脚本** | 复用 `devmanage/apitest/test_kb_api_v2_all.py` + 同步端 e2e 脚本（待增） |

---

## 8. 风险与对策

| 风险 | 对策 |
|------|------|
| 旧 state 仅 path 主键，无 ino | 首次全量后回填；一轮内 path diff 仍可能 delete+upload，文档说明升级窗口 |
| open-api 失败无 errorCode | 用 resultCode=400001 等映射；日志打全 body |
| 文件夹 move 子项部分 skip（策略 3） | 主节点 `mainSkipped`；子项靠下轮 batchGetMeta / 全量对账 |
| inode 误配对 | 限定同一 reconcile 轮；配对需 size 一致；失败降级 |
| 与 Obsidian 插件方案分叉 | 本文档仅 openclaw-xgkb-sync；概念可对齐 obsidian-xgkb-sync |

---

## 9. 文档与联调交付物

| 文档 | 动作 |
|------|------|
| [local-change-scenarios.md](./local-change-scenarios.md) | ✅ Phase 1 已更新场景 1～2 |
| [DESIGN.md](./DESIGN.md) | 增加 Reconcile 流程图、新 SyncOp |
| [kb-api-requirements-for-sync.md](./kb-api-requirements-for-sync.md) | 与 KB 实现版对齐（或链到 dev-guide） |
| README | 简短说明 v2 rename/move 能力 |

---

## 10. 里程碑时间表（建议）

| 里程碑 | 内容 | 建议时间 |
|--------|------|----------|
| **M0** | Phase 0 完成，kbApi v2 可调 | 第 1 周 |
| **M1** | Phase 1 MVP：本地 rename/move 不上传 | 第 2 周 |
| **M2** | Phase 2 双向 path 对齐 | 第 3 周 |
| **M3** | Phase 3 降级 + 生产试运行 | 第 4 周 |
| **M4** | Phase 4 watch 等增强（按需） |  backlog |

---

## 11. 附录 A：reconcile 伪代码（本地 push）

```typescript
for (const local of localSnapshot) {
  const record = stateByInode.get(local.inoKey) ?? stateByPath.get(local.path);
  if (!record?.remoteFileId) continue;

  if (local.path !== record.localPath) {
    const oldParts = splitPath(record.localPath);
    const newParts = splitPath(local.path);
    const sameParent = oldParts.parent === newParts.parent;

    if (sameParent) {
      plans.push({ op: 'rename-remote', fileId, newName: newParts.name });
    } else {
      const targetParentId = await resolveFolderId(newParts.parent);
      plans.push({ op: 'move-remote', fileId, targetParentId, newName: newParts.name });
    }
    continue;
  }

  if (contentChanged(local, record)) {
    plans.push({ op: 'upload-update', ... });
  }
}
```

## 附录 B：KB 错误码（联调）

| errorCode | 同步处理 |
|-----------|----------|
| `TARGET_NAME_CONFLICT` | 失败，写 lastError，不推进水位 |
| `CYCLE_MOVE_FORBIDDEN` | 失败，告警 |
| `FILE_NOT_FOUND` | 清 state 或触发 re-upload |
| `MOVE_RESULT_UNRESOLVED` | 失败，建议下轮全量 |

完整列表见 KB 实现说明 §6。
