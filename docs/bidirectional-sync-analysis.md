# 双向同步架构分析与设计

> 日期：2026-05-25  
> 背景：当前系统已完成 Phase 1（本地→远端 rename/move），需全面分析双向同步的难点、风险和实现方案。

---

## 1. 现状评估

### 1.1 已具备的能力

| 能力 | 方向 | 状态 |
|------|------|------|
| 文件内容上传（新建/更新） | 本地→远端 | ✅ |
| 文件内容下载（新建/更新） | 远端→本地 | ✅ |
| 文件删除 | 双向 | ✅（有安全阈值） |
| 本地 rename/move → 远端 updateFileName/moveFile | 本地→远端 | ✅ |
| 远端 rename/move → 本地 fs.rename | 远端→本地 | ❌ 未实现 |
| 冲突检测 | 双端同时修改 | ✅（LWW，无冲突文件） |
| inode 身份追踪 | 本地 | ✅ |
| 远端身份追踪 | 远端 fileId | ✅（sync_file_state.remoteFileId） |

### 1.2 `decide()` 决策逻辑概要

`decide()` 是路径对账的核心。它基于四个信号做决策：
- `local`：本地文件是否存在，mtime 是多少
- `remote`：远端文件是否存在，mtime 是多少
- `record`：上次同步成功时记录的 localMtime / remoteMtime
- `syncDirection`：push / pull / bidirectional

**双向模式（bidirectional）下的危险决策**：

| 场景 | 决策 | 风险 |
|------|------|------|
| 记录有、本地在、远端缺失、本地无修改 | `delete-local` | **P0 风险**：若远端 API 异常漏报文件 → 误删本地 |
| 记录有、远端在、本地缺失、远端无修改 | `delete-remote` | 若本地因 rename/move 消失（inode 未匹配）→ 误删远端 |
| 双端均变 | LWW | 较弱的一方内容丢失，无冲突备份 |

---

## 2. 核心难点分析

### 2.1 难点一：远端 rename/move 无法精准检测

**问题描述**：知识库的 `listChanges` 接口**不支持 `move` 事件**。远端文件被移动后，表现为：
- 旧路径 "消失"（从 listDescendantFiles 视角）
- 新路径 "出现"

当前引擎会将其误判为：
- 旧路径：`delete-local`（删除本地文件）
- 新路径：`download-new`（重新下载）

**后果**：功能正确（最终一致），但：
1. 不必要的网络传输（大文件重新下载）
2. 本地文件的 inode 改变，可能破坏上层应用的文件引用

**可能的解决方案**：

| 方案 | 可行性 | 说明 |
|------|--------|------|
| `listChanges` + `includeMoveHint` | ⚠️ KB 暂不支持 | `previousParentId`/`previousName` 字段已定义但 KB 未实现 |
| `batchGetMeta` + `includePath` + `rootFileId` | ⚠️ KB 返回 null | 当前 `relativePath` 始终返回 null |
| **fileId 配对推断** | ✅ 可自行实现 | 用 `sync_file_state.remoteFileId` 比对增量列表中的 fileId，若 fileId 相同但 parentId/name 变了 → rename/move |

**推荐方案：基于 fileId 的远端 rename/move 推断**

```
对于增量 listChanges 返回的每个 upsert 条目：
  if (fileId 在 sync_file_state 中存在) {
    从 DB 取出旧 record（含 remoteFolderId、localPath）
    if (新 parentId != record.remoteFolderId || 新 name != basename(record.localPath)) {
      → 远端发生了 rename 或 move
      → 生成 rename-local / move-local 计划
    }
  }
```

优点：不依赖 KB 新增字段，完全基于已有数据。

### 2.2 难点二：delete-local 误删的 P0 风险

**场景还原**：
1. 文件 A 已同步，记录存在
2. 远端 API 暂时异常 / 限流 / 响应缺失
3. 增量 listChanges 返回空（或全量 listDescendantFiles 漏报）
4. 引擎判定：记录有、本地在、远端缺失 → `delete-local`
5. 本地文件被永久删除

**现有保护**：
- 10 分钟安全窗口：刚同步的文件不删
- mtime 检查：本地有修改的不删

**仍然不够的场景**：
- 文件 10 分钟前同步，之后远端 API 彻底挂了 → 窗口过期后仍会删
- 全量对账周期（如 1 小时重建）若此时远端有大面积故障 → 批量误删

**增强方案**：

| 增强 | 说明 |
|------|------|
| **批量删除阈值** | 单轮计划中 `delete-local` 数量超过 N（如 10）或比例超过 30% 时，暂停执行并告警 |
| **软删除 / 回收站** | 不直接 `fs.unlink`，先 move 到 `.openclaw/trash/` 目录，保留 7 天 |
| **远端健康检查** | 执行 delete-local 前，额外调用一次 `batchGetMeta([fileId])` 确认文件确实不存在 |
| **dryRun 模式** | 配置 `deleteSafety: 'dryRun' | 'trash' | 'delete'`，默认 trash |

### 2.3 难点三：冲突处理（双端同时修改）

**现状**：LWW (Last-Writer-Wins) — mtime 大的覆盖小的。

**问题**：
- 本地编辑完存盘 → mtime 更新 → 同一秒远端也有人编辑 → mtime 近似
- mtime 精度（KB 返回毫秒时间戳，本地 fs.stat 也是毫秒），但可能有时钟偏差

**增强方案**：

| 级别 | 方案 | 适用 |
|------|------|------|
| 保守（推荐初版） | LWW + **冲突备份文件**（`file.conflict.md`） | 文本文件 |
| 中等 | 基于 contentHash 判断（KB 未来会支持） | 内容相同则不冲突 |
| 激进 | 三方合并（base + local + remote） | Markdown 文件理论可行，实现复杂 |

**初版建议**：保持 LWW，但增加冲突备份——被覆盖的一方保存为 `filename.conflict-2026-05-25.md`。

### 2.4 难点四：本地操作过快导致同步混乱

**场景**：
1. 同步周期 30 秒
2. 第 1 秒：用户创建文件 A → 引擎扫描到 A，计划 upload-new
3. 第 3 秒：用户将 A rename 为 B → 此时上传尚未开始或正在进行
4. 上传完成后，远端有 A，本地只有 B
5. 下一轮：检测到 A→B rename → moveFile

**问题**：中间状态会导致远端短暂存在"脏"文件名。

**更严重的场景**：
1. 上传 A 进行中（耗时 5 秒）
2. 用户删除 A
3. 上传成功 → record 写入 A
4. 下一轮：本地无 A、远端有 A → `delete-remote`（浪费了一次上传+一次删除）

**解决思路**：

| 方案 | 说明 | 代价 |
|------|------|------|
| **执行前 re-check** | 每个计划执行前重新 stat 本地文件，文件不存在则跳过 | 额外 stat 开销（可接受） |
| **fs.watch / chokidar** | 实时监听变更，积累事件队列，debounce 后批量处理 | 实现复杂，跨平台稳定性存疑 |
| **乐观锁** | 上传时记录起始 mtime，完成后比较，若 mtime 变了则标记需重传 | 简单有效 |

**推荐初版**：执行前 re-check（stat 验证文件仍在 + mtime 未变），成本极低且能覆盖大部分竞态。

### 2.5 难点五：远端→本地 rename/move 与本地→远端 rename/move 同时发生

**场景**：
1. 本地将 `a.md` rename 为 `b.md`（inode 不变）
2. 同一时间远端将 `a.md` rename 为 `c.md`（fileId 不变）
3. 同步引擎看到：
   - inode 检测：本地 `a.md` → `b.md`（plan: rename-remote to b.md）
   - fileId 检测：远端 `a.md` → `c.md`（plan: rename-local to c.md）
4. 两个 plan 指向同一个文件，且方向冲突

**解决方案**：
- **检测冲突**：如果同一个 fileId/inode 同时出现在 rename-remote 和 rename-local 计划中 → 冲突
- **解决策略**：LWW（mtime 大的赢），或配置 `local-wins` / `remote-wins`
- **实现**：在 plan 生成后、执行前，做一轮 plan 去重/冲突合并

---

## 3. 远端→本地 Rename/Move 的实现设计

### 3.1 检测时机

在 `buildRemoteMap()` 增量路径中，对每个 upsert 的已知文件（fileId 在 DB 中存在的）：

```typescript
// 伪代码
for (const item of upsertKnown) {
  const record = fileIdToRecord.get(item.fileId);
  if (!record) continue;
  
  const oldFolderId = record.remoteFolderId;
  const oldName = basename(record.localPath);
  const newFolderId = String(item.parentId);
  const newName = item.name;
  
  if (newFolderId !== oldFolderId || newName !== oldName) {
    // 远端发生了 rename/move
    remoteMoveDetected.push({ fileId, record, newParentId: newFolderId, newName });
  }
}
```

### 3.2 路径推导

知道了 `newParentId`，需要推导出本地新路径。方法：
1. 优先从 `sync_folder_state` 查 `remoteFolderId → localPath`
2. 回退：从 `folderIdToPath` 映射（buildRemoteMap 已经在构建）

### 3.3 执行

```typescript
case 'rename-local':
  // 同目录改名
  await this.localFs.rename(oldPath, newPath);
  // 更新 sync_file_state 的 localPath
  this.db.deleteFileState(mappingId, oldPath);
  this.db.upsertFileState({ ...record, localPath: newPath });
  break;

case 'move-local':
  // 跨目录移动（可能需先创建本地目录）
  await fs.mkdir(dirname(newAbsPath), { recursive: true });
  await this.localFs.rename(oldPath, newPath);
  this.db.deleteFileState(mappingId, oldPath);
  this.db.upsertFileState({ ...record, localPath: newPath, remoteFolderId: newFolderId });
  break;
```

### 3.4 与 inode 检测的冲突避免

**关键约束**：远端 rename/move 的检测和计划生成必须在 `detectLocalRenames()` **之前**完成。

流程调整：
```
1. buildRemoteMap() → 同时检测远端 rename/move → 生成 remoteMoveHints
2. detectLocalRenames() 执行时，排除 remoteMoveHints 涉及的 fileId/path
3. 若同一文件同时有本地和远端 rename → 冲突解决
4. 执行各计划
```

---

## 4. 安全策略总结

### 4.1 delete-local 保护（核心安全机制）

```
三道防线：
├─ 第 1 道：10 分钟安全窗口（已有）
├─ 第 2 道：批量删除阈值（新增）
│   └─ 单轮 delete-local > 10 个 或 > 30% → 暂停 + 告警
├─ 第 3 道：回收站（新增）
│   └─ 文件 move 到 .openclaw/trash/YYYY-MM-DD/ 下
│   └─ 7 天后自动清理
└─ 第 4 道：远端确认（可选）
    └─ 执行前 batchGetMeta 二次确认
```

### 4.2 执行前验证（防竞态）

```
每个计划执行前：
├─ upload：重新 stat → mtime 不一致则跳过（等下轮）
├─ delete-local：重新 stat → mtime 变了则跳过
├─ rename-local/move-local：检查目标路径是否已被占用
└─ download：检查本地文件是否被修改
```

### 4.3 同步锁

```
├─ 同一 mapping 不并发（已有：scheduler 串行）
├─ 文件级锁：不需要（单线程 event loop + 串行执行）
└─ 全量对账互斥：全量扫描期间不接受手动触发
```

---

## 5. 性能考量

### 5.1 快速操作导致中间状态

| 场景 | 后果 | 缓解 |
|------|------|------|
| 创建后立即删除 | 上传后又删除（2 次 API） | 执行前 re-check |
| rename 后又 rename | 两次 updateFileName | 执行前 re-check 当前 path |
| 批量 move 1000 文件 | 1000 次 moveFile 调用 | 目录级 inode 检测已覆盖 |
| 远端短时间大量变更 | listChanges 分页多 | 已有分页机制 |

### 5.2 API 调用优化

| 优化点 | 现状 | 建议 |
|------|------|------|
| 远端 rename/move 检测 | 不需要额外 API 调用（基于 listChanges 已返回的 parentId + name） | ✅ 零额外开销 |
| delete-local 确认 | 无 | 可选：对 delete-local 列表做一次批量 batchGetMeta |
| 全量对账频率 | 1 小时 | 可动态调整：连续无冲突 → 2 小时 |

### 5.3 同步周期与变更频率

| 配置 | 默认值 | 建议 |
|------|--------|------|
| autoSyncIntervalSec | 30s | 保持，足够低延迟 |
| fullReconcileIntervalSec | 3600s | 保持，作为兜底 |
| 执行超时 | 无 | 建议增加：单轮同步超 5 分钟告警 |

---

## 6. 实施路线（建议）

### Phase 2A：远端→本地 Rename/Move（~3 天）

1. 在 `buildRemoteMap` 增量路径中检测远端 rename/move（基于 fileId + parentId/name 变化）
2. 生成 `rename-local` / `move-local` 计划
3. 在 `executePlan` 中实现 `case 'rename-local'` 和 `case 'move-local'`
4. 解决与 `detectLocalRenames` 的冲突（互斥排除）

### Phase 2B：安全增强（~2 天）

1. 批量删除阈值：`delete-local` 超限暂停
2. 回收站机制：`.openclaw/trash/` 目录
3. 执行前 re-check（stat 验证）

### Phase 2C：冲突处理增强（~1 天）

1. 双端 rename 冲突检测与解决
2. 冲突备份文件（被 LWW 覆盖的一方 → `.conflict` 文件）

---

## 7. 暂不实现（风险过高或 ROI 过低）

| 项目 | 原因 |
|------|------|
| fs.watch 实时监听 | 跨平台稳定性差，Windows 的 ReadDirectoryChangesW 存在丢事件问题 |
| 三方合并 | Markdown 合并复杂度高，用户预期不明确 |
| 多设备冲突 | 当前架构为单 agent 单设备，暂不考虑 |
| 远端目录级 rename-local 逐文件处理 | 已决定用 fs.rename 整体处理，不做逐文件 |

---

## 8. 已确认的决策（2026-05-25）

| 决策项 | 结论 |
|--------|------|
| delete-local 安全策略 | **回收站模式** `~/.openclaw/trash/{mappingId}/YYYY-MM-DD/`（批量阈值已移除，回收站已足够） |
| 冲突策略 | 不跨时钟比 mtime，默认 **local-wins**（可配置 `conflictStrategy`） |
| push 模式下远端 rename/move | **完全忽略**（push = 本地是权威源） |
| 远端目录 rename → 本地 | **整棵子树 fs.rename**（一步到位） |
| listChanges 行为 | rename 仅更新本条；move 更新本条+所有下级 |

## 9. 已完成的实现（Phase 2B — 安全底座）

| 模块 | 文件 | 内容 |
|------|------|------|
| 回收站 | `src/trashBin.ts` | `moveToTrash()` + `cleanupTrash()`（7 天自动清理） |
| 冲突策略 | `src/syncEngine.ts` + `src/types.ts` | `conflictStrategy: 'local-wins' | 'remote-wins'` |
| 执行前验证 | `src/syncEngine.ts` | upload/delete 前 stat re-check，文件消失或 mtime 变化则 skip |

## 10. 已完成的实现（Phase 2A — 远端→本地 rename/move）

| 任务 | 文件 | 内容 |
|------|------|------|
| 增量检测 | `src/syncEngine.ts` | `tryIncrementalRemoteMap` 中比对 `batchGetMeta` 返回的 parentId+name 与 DB，生成 `RemoteMoveHint` |
| 全量检测 | `src/syncEngine.ts` | `detectRemoteMovesFromFullScan` 通过 remoteFileId 匹配 DB 记录，检测路径差异 |
| 目录级聚合 | `src/syncEngine.ts` | 同一旧目录下 ≥80% 文件共享路径前缀变化 → 合并为一个目录 hint |
| 文件级执行 | `src/syncEngine.ts` | `doRemoteMoveToLocal`：fs.rename 单文件 + 更新 sync_file_state |
| 目录级执行 | `src/syncEngine.ts` | `doRemoteDirMoveToLocal`：fs.rename 整个目录 + 批量更新 file/folder state 路径前缀 |
| DB 批量路径更新 | `src/syncStateDb.ts` | `renameFilePaths` + `renameFolderPaths` 支持路径前缀替换 |

---

## 11. 结论

**双向同步的核心风险是 `delete-local` 误删，这是唯一的 P0 级事故场景。** 已通过"回收站 + 执行前验证"两道防线完成防护。

冲突策略已从不可靠的跨时钟 LWW 改为明确的 `local-wins` / `remote-wins` 配置，消除了时钟偏差导致的不确定性。

远端→本地 rename/move 的检测不依赖 KB 新增接口，完全基于已有的 `listChanges` 返回的 `fileId + parentId + name` 与 DB 记录比对实现，零额外 API 开销。**Phase 2A 和 2B 均已完成实现。**
