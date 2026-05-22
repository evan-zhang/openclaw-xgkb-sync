# 本地文件变更的三种场景：同步处理逻辑

以下基于当前 `github-openclaw-xgkb-sync` 源码整理。**v2（Phase 1 已落地）**：在路径对账之前增加 **inode 对账**（`reconcileEngine.ts`），本地同卷 rename/move 优先走 `updateFileName` / `moveFile`，不再默认 delete+upload。

---

## 一、通用机制（三种场景共用）

### 1.1 本地如何发现「变了」

每轮同步**不监听**文件系统事件，而是：

1. **`localFs.listFiles()`** — 递归 walk，对每个文件 `stat()` 取 `mtimeMs`、`dev`、`ino`
2. **`syncStateDb.getAllFileStates()`** — SQLite 记录含 `local_dev` / `local_ino` / `remote_relative_path`
3. **Phase 1 — inode 对账**（`detectLocalRenames`）：`dev:ino` 不变且 path 变 → `rename-remote` 或 `move-remote`；同目录下全部文件一起变 → **一次** `moveFile(文件夹Id)`
4. **Phase 2 — 路径对账**：对其余路径对比，得出三类变化：

| 变化类型 | 判定条件 |
|----------|----------|
| 新增 | 路径在本地 walk 结果中，但 SQLite 无记录 |
| 修改 | 路径两边都有，且 `local.mtime > record.localMtime + 1000ms` |
| 删除 | 路径在 SQLite 有记录，但本地 walk 已不存在 |

> 目录本身**不参与**文件 walk；只有目录下的 `.md` 等匹配文件才会被追踪。空目录、无匹配后缀的文件对同步透明。

### 1.2 远端如何构建视图

| 模式 | 接口 | 用途 |
|------|------|------|
| 增量（默认） | `listChanges` + `batchGetMeta` | 拉取自上次水位以来的变更 |
| 全量（首次 / 周期性） | `listDescendantFiles` | 列出 mapping 根下所有文件及真实路径 |

增量模式下，已知文件的远端路径**仍用 SQLite 里的 `local_path` 作键**（不随 KB 内 move 自动更新），周期性全量对账（默认 3600s）用于纠正路径漂移。

### 1.3 决策与执行顺序

对「本地路径 ∪ 远端路径 ∪ SQLite 路径」的并集，每个路径调用 `decide()`，得到操作码后按固定顺序执行：

```
删除（delete-local / delete-remote）
  → 下载（download-new / download-update）
  → 上传（upload-new / upload-update）
  → 远端空目录清理（pruneRemoteEmptyDirectories）
```

**Phase 1 之后**：同卷 rename/move **不再**走 delete+upload。无法 inode 配对（`ino=0`、跨卷复制等）时仍退化为路径对账 → delete+upload。

### 1.4 知识库 API 路径前缀

所有接口挂在 Open API 根地址下，例如：

```
{serverUrl}document-database/file/{method}
```

---

## 二、场景 1：本地文件或文件夹改了名字

### 2.1 本质（v2）

| 操作 | 识别方式 | 同步行为 |
|------|----------|----------|
| **单文件同目录改名** | 同一 `dev:ino`，父目录不变 | `POST updateFileName`（`rename-remote`） |
| **文件夹改名** | 目录下**全部**同步文件 `oldDir/*` → `newDir/*`，inode 一一对应 | **一次** `POST moveFile(文件夹fileId)` + 可选 `updateFileName` 改文件夹名（`collapseDirectoryPlans`） |
| **无法 inode 配对** | `ino=0` 或歧义 | 仍退化为路径对账 → `deleteFile` + `uploadContent` |

### 2.2 单文件改名示例：`notes/a.md` → `notes/b.md`

1. inode 对账命中 → `rename-remote`
2. **`POST updateFileName`**

| 参数 | 说明 |
|------|------|
| `fileId` | `record.remoteFileId` |
| `newName` | `b.md` |
| `nameConflictStrategy` | mapping 配置，默认 **1**（冲突报错） |
| `rootFileId` | mapping 根，用于响应 `relativePath` |

3. SQLite：`local_path` 改为 `notes/b.md`，`remote_file_id` **不变**

### 2.3 文件夹改名示例：`folderA/x.md` → `folderB/x.md`（含多个 .md）

1. 每个文件 inode 对账先产生 `move-remote` 计划
2. `collapseDirectoryPlans` 合并为 **1 条目录计划**
3. **`POST moveFile`**（仅 1 次）

| 参数 | 说明 |
|------|------|
| `fileId` | 子文件 `remoteFolderId`（文件夹 `folderA` 的 id） |
| `targetParentId` | `folderA`/`folderB` 的父目录远端 id |
| `nameConflictStrategy` | mapping 配置，默认 **3**（跳过） |
| `rootFileId` | mapping 根 |

4. 若文件夹名也从 `folderA` 变为 `folderB`：再 **`POST updateFileName`**（`renameAfterMoveName`）
5. 响应 `mainSkipped=true` → 不改 state，打日志
6. 响应 `idChanged=true` → 按 `idMappings` 更新子文件 `remote_file_id`
7. 批量更新 SQLite 中该目录下所有文件的 `local_path` 前缀

### 2.4 降级路径（仍可能发生）

未命中 inode 对账时，行为与旧版相同：

| 路径 | 决策 |
|------|------|
| `notes/a.md` | `delete-remote` |
| `notes/b.md` | `upload-new` |

#### 降级 — `POST deleteFile`

| 参数 | 说明 |
|------|------|
| `fileId` | `record.remoteFileId` |

对应代码：

```744:748:d:\code\plugins\github-openclaw-xgkb-sync\src\syncEngine.ts
  private async doDeleteRemote(path: string, record: FileState): Promise<void> {
    const result = await this.remoteFs.deleteFile(record.remoteFileId!);
    // ...
    this.db.deleteFileState(this.mapping.mappingId, path);
```

#### 步骤 2：建新路径 — `POST uploadContent`（新建，**不传** `updateFileId`）

路径 `notes/b.md` 经 `remoteFs.createFile()` 拆成：

| 参数 | 示例值 | 说明 |
|------|--------|------|
| `content` | 文件 UTF-8 正文 | 从本地读取 |
| `fileName` | `b.md` | 路径最后一段 |
| `fileSuffix` | `.md` | 从 fileName 解析 |
| `folderName` | `{remoteRootFolderPath}/notes` | mapping 根路径 + 文件所在子目录；根下文件则仅为 `remoteRootFolderPath` |
| `projectId` | mapping 的 projectId | 必填 |

```397:403:d:\code\plugins\github-openclaw-xgkb-sync\src\remoteFs.ts
    const r = await this.api.uploadContent({
      content,
      fileName,
      fileSuffix,
      folderName,
      projectId: this.resolvedProjectId!,
    });
```

> **不会调用** `updateFileId` 版本的 `uploadContent`，因此远端会生成**新的 fileId**，旧 fileId 已被 delete，版本链不连续。

#### 步骤 3：SQLite 更新

| 操作 | 结果 |
|------|------|
| 删旧 | `DELETE sync_file_state WHERE local_path = 'notes/a.md'` |
| 建新 | `INSERT/UPDATE local_path='notes/b.md', remoteFileId=新ID, localMtime, remoteMtime` |

#### 步骤 4：文件夹重命名后的空目录清理

旧文件夹 `folderA` 下文件全部迁走后，见**场景 3 的 prune 逻辑**。

### 2.4 边界情况

| 情况 | 行为 |
|------|------|
| 重命名时 OS 更新了 mtime | 仍倾向 delete-remote + upload-new；若旧路径远端也被他人改过，可能变成 `download-update`（把文件拉回旧路径） |
| `syncDirection = pull` | 本地改名**不会**推远端（旧路径 skip 删远端，新路径 skip 上传） |
| `syncDirection = push` | 正常推 delete + upload-new |

---

## 三、场景 2：文件从一个目录移动到另一个目录

### 3.1 v2 行为

例：`dir1/report.md` → `dir2/report.md`（同一 `dev:ino`）

| 阶段 | 行为 |
|------|------|
| inode 对账 | `move-remote`：`targetParentId` = 远端 `dir2` 的父文件夹 id |
| API | `POST moveFile(fileId=record.remoteFileId, targetParentId=…)`，**不传** `newName`（仅换目录且文件名不变时） |
| SQLite | `local_path` 更新为 `dir2/report.md`，`remote_file_id` 通常不变 |

整目录 `dir1/*` → `dir2/*` 时合并为 **一次** `moveFile(文件夹Id)`（见场景 1 §2.3）。

### 3.2 降级（与旧版相同）

无法 inode 配对时：

| 路径 | 决策 |
|------|------|
| `dir1/report.md` | `delete-remote` |
| `dir2/report.md` | `upload-new` |

### 3.3 降级时新建文件 `folderName` 的计算

`relativePath = "dir2/report.md"` 时：

```
subPath     = "dir2"
fileName    = "report.md"
folderName  = "{remoteRootFolderPath}/dir2"   // 若 mapping 配置了 remoteRootFolderPath
            或 "dir2"                          // 若同步的是 project 根目录
```

中间目录 **`dir2` 不需要事先存在** — `uploadContent` 会隐式创建路径上的文件夹。正常同步轮次**不调用** `createFolder`（`createFolder` 仅用于 init 时解析 mapping 根路径）。

### 3.3 调用的知识库接口

与场景 1 相同：

1. **`POST deleteFile`** — `{ fileId: 旧路径 record.remoteFileId }`
2. **`POST uploadContent`** — `{ content, fileName, fileSuffix, folderName: ".../dir2", projectId }`（无 `updateFileId`）
3. **prune** — 若 `dir1` 在远端变空且本地也无 `dir1` 目录，见场景 3

### 3.4 执行顺序的重要性

```191:206:d:\code\plugins\github-openclaw-xgkb-sync\src\syncEngine.ts
    // 1. 删除操作串行（避免竞态）
    for (const plan of deletePlans) { ... }
    // 2. 下载
    // 3. 上传
```

先删后传，避免同名冲突；rename/move 依赖此顺序保证旧 fileId 先释放。

---

## 四、场景 3：删除一个目录

分两层：**目录下的同步文件**，以及**目录节点本身**。

### 4.1 删除含同步文件的目录

例：删除本地 `project/old/` 及其下 `a.md`、`b.md`。

walk 后这两个路径从 `localMap` 消失，但 `recordMap` 仍有记录。对每个文件：

| 条件 | 决策 | 说明 |
|------|------|------|
| 本地无 + 远端有 + 远端 mtime **未变** | **`delete-remote`** | 典型「本地删文件/删目录」 |
| 本地无 + 远端有 + 远端 mtime **变了** | **`download-update`** | 远端有人改过 → 拉回本地（可能「复活」文件） |
| `syncDirection = push` + 本地无 + 远端有 | **`skip`** | 不删远端 |

每个被删文件的 API 调用：

**`POST deleteFile`**

| 参数 | 说明 |
|------|------|
| `fileId` | 该文件 `record.remoteFileId` |

成功后：`db.deleteFileState(mappingId, localPath)`，`stats.deleted++`。

### 4.2 删除空目录 / 仅含非同步文件的目录

- `listFiles()` **看不到**任何文件 → 无 per-file 删除计划
- 若目录下只有 `.txt` 而 mapping 只同步 `**/*.md`，同样无文件级操作
- 远端对应文件夹若仍存在，靠 **prune** 清理

### 4.3 远端空目录清理（prune）

每轮 sync 结束时（`pull` 模式跳过）：

```217:225:d:\code\plugins\github-openclaw-xgkb-sync\src\syncEngine.ts
  private async pruneRemoteEmptyDirectories(prog: ProgressCallback): Promise<void> {
    const dir = this.mapping.syncDirection ?? 'bidirectional';
    if (dir === 'pull') return;

    const localDirs = new Set(await this.localFs.listDirectories());
    const result = await this.remoteFs.pruneEmptyDirectories(localDirs);
```

**算法**：从 mapping 根 `resolvedRootFileId` 起**后序递归**：

#### 遍历 — `GET getChildFiles`

| 参数 | 说明 |
|------|------|
| `parentId` | 当前文件夹 fileId |
| `type` | 可选；不传则返回全部子项 |

对每个子项：
- `type !== 1`（文件）→ 目录不能删，标记 `hasChildAfterPrune = true`
- `type === 1`（子文件夹）→ 递归 prune

#### 删除空文件夹 — `POST deleteFile`

满足**全部**条件才删：

1. 不是 mapping 根目录
2. 递归后无任何子项残留
3. **本地不存在**同名目录路径（`localDirectoryPaths.has(relPath)` 为 false）

| 参数 | 说明 |
|------|------|
| `fileId` | 该空文件夹的 fileId |

> 若本地仍保留空目录（walk 会列入 `listDirectories()`），远端对应空目录**保留**，不会被 prune。

### 4.4 删目录完整 API 调用链（bidirectional / push）

假设删除 `project/old/`（含 2 个 `.md`）：

| 顺序 | API | 参数 |
|------|-----|------|
| 1 | `GET listChanges` 或 `GET listDescendantFiles` | 扫描远端现状 |
| 2 | `POST deleteFile` | `{ fileId: a.md 的 remoteFileId }` |
| 3 | `POST deleteFile` | `{ fileId: b.md 的 remoteFileId }` |
| 4 | `GET getChildFiles` | `{ parentId: old 文件夹Id }`（prune 递归，多次） |
| 5 | `POST deleteFile` | `{ fileId: old 空文件夹Id }`（若本地也无 `old/`） |

---

## 五、三场景对照总表

| 维度 | 文件/夹重命名 | 跨目录移动 | 删目录（含同步文件） |
|------|--------------|-----------|---------------------|
| 系统语义 | delete + create | delete + create | 逐文件 delete-remote + prune |
| 旧路径决策 | `delete-remote` | `delete-remote` | 每文件 `delete-remote` |
| 新路径决策 | `upload-new` | `upload-new` | — |
| 是否保留 fileId | **否**，新 fileId | **否** | 文件 fileId 被删 |
| 主要写接口 | `deleteFile` + `uploadContent` | 同左 | `deleteFile`（文件 + 空夹） |
| `uploadContent.updateFileId` | **不传** | **不传** | 不涉及 |
| 目录节点 | 隐式创建（upload） / prune 删空 | 同左 | prune 删远端空目录 |
| SQLite | 旧路径行删除，新路径新行 | 同左 | 各文件行删除 |

---

## 六、已知局限（评估行为时需知晓）

1. **无 rename 高保真**：同一物理文件改名/移动 = 全量 re-upload + 新 fileId，浪费带宽且丢失 KB 侧版本连续性的可能。
2. **状态库按路径索引**：`getFileStateByRemoteId()` 存在但决策未用，无法通过 fileId 关联「同文件换路径」。
3. **增量模式路径滞后**：若仅在 KB 控制台移动文件，增量视图可能仍挂旧路径，需等周期性全量对账纠正。
4. **`pull` 模式**：本地删目录/改名**不会**删或改远端；prune 也不执行。
5. **mtime 是唯一内容变更信号**：未使用 contentHash 做决策；rename 若不改 mtime，仍走 delete + create 而非 skip。


 