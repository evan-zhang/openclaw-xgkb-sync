# 知识库 Open API 需求说明（双向文件同步 · v2）

> **读者**：知识库后端 / Open API 同事  
> **来源**：[openclaw-xgkb-sync](https://github.com/xgjk/openclaw-xgkb-sync) 独立同步进程  
> **版本**：v2 — **不再使用** `updateFileProperty`；改为 **`updateFileName` + `moveFile`**

---

## 1. 背景

同步进程在**本地目录**与**知识库**之间按 mapping 规则做双向同步。本地 rename/move 若走「删旧 + 全量上传」，大目录下 API 与带宽开销不可接受。

**v2 方案**：

- **改名**（同目录、仅 `name` 变化）→ 新接口 **`updateFileName`**
- **移动**（换父目录；可同时换名）→ 新接口 **`moveFile`**（节点可为**文件或文件夹**）
- **不支持批量**；每次只操作**一个**节点（文件夹会递归处理其子树，见 §3.2）
- **`listChanges` 仍不增加 `move` 事件**（现设计限制）；远端 path 变化靠 meta 对账 + 全量校准

---

## 2. 总览

| 类别 | 接口 | 优先级 |
|------|------|--------|
| **新增** | `updateFileName` | **P0** |
| **新增** | `moveFile` | **P0** |
| **修改** | `batchGetMeta` 响应字段 | **P0** |
| **修改** | `listDescendantFiles` 响应字段 | **P0** |
| **修改（可选）** | `listChanges` items 附加字段 | **P1** |
| **新增（可选）** | `resolvePath` | **P2** |
| **明确不做** | 批量 rename/move；`listChanges.move` 事件；同步侧调用 `updateFileProperty` | — |

---

## 3. P0：新增接口

### 3.1 `updateFileName` — 同目录改名

**建议路径**：`POST /document-database/file/updateFileName`  
**用途**：仅修改节点在**当前父目录下**的名称；**不**改变 `parentId`。

#### 请求体

| 字段 | 类型 | 必填 | 含义 |
|------|------|------|------|
| `fileId` | Long | 是 | 文件或文件夹 id |
| `newName` | String | 是 | 新名称（含扩展名，如 `B.md`） |
| `projectId` | Long | 建议 | 空间 id，鉴权与隔离 |
| `nameConflictStrategy` | Integer | 否 | 同目录**重名**时的策略，见下表；**默认建议 1** |

#### `nameConflictStrategy`（仅 2 种，**不支持覆盖**）

| 值 | 含义 | 示例：同目录已有 `B.md`，将 `A.md` 改为 `B.md` |
|----|------|--------------------------------------------------|
| **0** | 自动重命名（避让） | 改为 `B(1).md` 等，**保留**原 `B.md` |
| **1** | **抛异常 / 失败**（默认推荐） | 操作失败，`A.md` 仍为 `A.md`，`B.md` 保留 |

> **不支持**「先删目标再改名」类覆盖语义。

#### 响应 `data`（成功时）

| 字段 | 类型 | 必填 | 含义 |
|------|------|------|------|
| `fileId` | Long | 是 | 操作后节点 id（**正常情况与请求相同**） |
| `type` | Integer | 是 | `1` 文件夹，`2` 文件 |
| `name` | String | 是 | **最终**名称（策略 0 时可能带后缀） |
| `parentId` | Long | 是 | 父目录 id（与操作前相同） |
| `updateTime` | Long | 是 | 服务端更新时间（毫秒） |

#### 可选响应字段

| 字段 | 没有会怎样 | 有了有什么好处 |
|------|------------|----------------|
| `relativePath` | 同步需再调 `batchGetMeta` 更新 path | 一次调用后可直接写状态库 |
| `renamedDueToConflict` | 无法区分用户意图名与最终名 | `true` 表示因策略 0 自动加了后缀 |

#### 错误响应（策略 1 冲突等）

建议返回稳定 `errorCode`，如 `TARGET_NAME_CONFLICT`。

#### 同步进程默认策略

| 参数 | 默认值 | 原因 |
|------|--------|------|
| `nameConflictStrategy` | **1（抛异常）** | 避免远端 path 与本地 path  silently 不一致 |

---

### 3.2 `moveFile` — 移动节点（文件或文件夹）

**建议路径**：`POST /document-database/file/moveFile`  
**用途**：将节点移动到 `targetParentId` 下；可选指定目标名称 `newName`（省略则**保留原名**）。

- **仅支持单个节点一次调用**（不支持 batch）。
- `fileId` 可为**文件**或**文件夹**。
- 移动**文件夹**时：子树内所有文件、子文件夹**一并移动**；对子树中**每个节点**在目标位置的同名冲突，均按同一 `nameConflictStrategy` **逐个处理**（见 §3.2.3）。

#### 请求体

| 字段 | 类型 | 必填 | 含义 |
|------|------|------|------|
| `fileId` | Long | 是 | 被移动的节点 id（文件或文件夹） |
| `targetParentId` | Long | 是 | 目标父目录 id |
| `newName` | String | 否 | 移动后的名称；省略表示沿用原 `name` |
| `projectId` | Long | 建议 | 空间 id |
| `nameConflictStrategy` | Integer | 否 | 目标位置**同名冲突**策略，见下表；**同步默认 2** |

#### `nameConflictStrategy`（4 种）

| 值 | 名称 | 行为说明 |
|----|------|----------|
| **0** | 重命名 | 对**当前冲突节点**自动避让命名（如加 `(1)` 后缀），**保留**目标位已有同名节点 |
| **1** | **覆盖** | 见 §3.2.2 **特殊语义**（**fileId 会变**） |
| **2** | 抛异常 | 遇冲突**整次操作失败**（或该冲突节点失败，见 §3.2.3） |
| **3** | 跳过 | 该冲突节点**不移动**，其余照常；需在响应中列出 skipped |

#### 3.2.1 策略 0 / 2 / 3（fileId 通常不变）

- **0**：移动后节点 id **不变**；最终 `name` 可能带后缀。
- **2**：发生冲突则失败，源节点保持原位。
- **3**：冲突项跳过，不移动；同步需根据 `skippedItems` 对账。

#### 3.2.2 策略 1「覆盖」— 必须写清的语义 ⚠️

当目标目录已存在**同名节点**（文件或文件夹）时：

1. **保留目标位已有节点的 `fileId`**（称为 **保留 id**）；
2. 将被移动节点的**内容**合并为保留 id 的**新版本**（文件：新版本；文件夹：按 KB 版本模型定义）；
3. **删除被移动的源节点**（源 `fileId` 失效）；
4. 调用方若持有源 `fileId`，必须改用**保留 id** → **`fileId` 发生变化**。

**文件示例**

```
目标目录已有 B.md (id=200)
移动 A.md (id=100) 到该目录，同名冲突，策略=1

结果：
  - id=200 的 B.md 存在，内容/version 来自原 A.md 的合并结果
  - id=100 已删除
  - 同步状态库须：local_path 仍对应本地 A 的路径，remote_file_id 从 100 改为 200
```

> **同步进程默认不使用策略 1**，除非产品明确配置；因 state 库 `remote_file_id` 必须重写。

**文件夹示例**

目标目录已有同名文件夹 `old/`(id=F2)，移动源文件夹 `src/`(id=F1)，策略=1：

- 保留 **F2**；
- 将 F1 子树内容按覆盖规则合并进 F2（具体合并规则请 KB 文档定义：同名子文件是否也走覆盖等）；
- 删除 **F1**；
- 文件夹 id 从 F1 → 以 F2 为准。

#### 3.2.3 移动文件夹时的递归与冲突

当 `fileId` 为**文件夹**时：

1. 先处理**该文件夹自身**在 `targetParentId` 下的同名冲突（按 `nameConflictStrategy`）；
2. 再对子树内**每个**文件、子文件夹，在其**各自目标路径**上按**相同** `nameConflictStrategy` **逐个**处理冲突；
3. **不支持**一次 batch 传多个 id；递归由**服务端在一次 `moveFile` 调用内**完成。

请 KB 明确：

| 问题 | 需约定 |
|------|--------|
| 子项冲突时，父文件夹是否整体回滚？ | 建议：**部分成功**时返回明细（`results`/`skippedItems`/`failedItems`），或声明「全有或全无」 |
| 策略 2 遇第一个冲突 | 整棵子树是否全部不移动？ |
| 策略 3 跳过子项 | 跳过项是否仍留在源路径？ |

#### 响应 `data`（成功时，建议结构）

| 字段 | 类型 | 必填 | 含义 |
|------|------|------|------|
| `fileId` | Long | 是 | **操作后主节点**的有效 id（策略 1 可能 ≠ 请求中的 `fileId`） |
| `sourceFileId` | Long | 建议 | 请求传入的源 id；若与 `fileId` 不同则发生过覆盖 |
| `idChanged` | Boolean | 是 | 是否因覆盖等导致 id 切换 |
| `type` | Integer | 是 | `1` 文件夹 / `2` 文件 |
| `name` | String | 是 | 最终名称 |
| `parentId` | Long | 是 | 最终父 id |
| `updateTime` | Long | 是 | 更新时间 |

#### 可选响应字段

| 字段 | 类型 | 没有会怎样 | 有了有什么好处 |
|------|------|------------|----------------|
| `relativePath` | String | 需额外 meta 查询 | 直接更新状态库 path |
| `affectedCount` | Integer | 仅影响日志 | 文件夹移动影响节点数 |
| `details` | Array | 文件夹移动失败难以定位 | 子树逐节点结果，见下表 |
| `skippedItems` | Array | 策略 3 时同步不知哪些未动 | `{ fileId, name, reason }` |
| `idMappings` | Array | 策略 1 时同步难批量改 state | `[{ sourceFileId, targetFileId, relativePath }]` **强烈建议** |

**`details[]` 建议元素**（文件夹移动或部分成功时）

| 字段 | 含义 |
|------|------|
| `sourceFileId` | 移动前 id |
| `fileId` | 移动后有效 id |
| `idChanged` | 是否覆盖换 id |
| `relativePath` | 最终逻辑路径 |
| `status` | `ok` / `skipped` / `failed` |
| `errorCode` | 失败或跳过原因 |

#### 错误与禁止

| 场景 | 期望 |
|------|------|
| 移动到自身子孙目录内 | 错误，如 `CYCLE_MOVE_FORBIDDEN` |
| 策略 2 同名冲突 | `TARGET_NAME_CONFLICT` |
| 源节点不存在 / 无权限 | 明确 `errorCode` |

#### 同步进程默认策略

| 参数 | 默认值 | 原因 |
|------|--------|------|
| `nameConflictStrategy` | **2（抛异常）** | 避免静默改 id、改 path；冲突交人工或对账 |

配置允许时可改为 **0**（自动重命名）；**1（覆盖）** 仅在有 `idMappings` 返回且同步实现 id 重写后启用。

---

## 4. P0：修改现有接口

### 4.1 `batchGetMeta`

现网：`POST /document-database/file/batchGetMeta`  
已有：`fileId`, `parentId`, `name`, `updateTime`, `size`, `deleted`

#### 必须新增字段

| 字段 | 类型 | 没有会怎样 | 有了有什么好处 |
|------|------|------------|----------------|
| **`type`** | Integer | 无法区分文件/文件夹 | rename/move/prune 正确 |
| **`suffix`** | String | upload 参数需猜测 | 与 `uploadContent` 一致 |
| **`relativePath`** | String | **无法推断远端 move**（无 listChanges.move） | 与本地 path 对比的核心字段 |

> `relativePath` 规则须与 `listDescendantFiles`（`includePath=true`）**一致**。

#### 可选

| 字段/参数 | 没有会怎样 | 有了有什么好处 |
|-----------|------------|----------------|
| 请求 `includePath` | 默认不算 path | 按需算 path |
| `contentHash` / `etag` | 无 inode 时配对 rename 易误判 | 网络盘场景兜底（P2） |

---

### 4.2 `listDescendantFiles`

#### 必须新增

| 字段 | 没有会怎样 | 有了有什么好处 |
|------|------------|----------------|
| **`type`** | 全量对账缺文件夹信息 | 与 batchGetMeta 对齐 |

#### 行为约定

- `includePath=true` 时 `relativePath` **稳定必填**。

---

## 5. P1：可选增强

### 5.1 扩展 `listChanges` items（不新增 event 类型）

仍仅 `upsert` / `delete`。可选附加：

| 字段 | 没有会怎样 | 有了有什么好处 |
|------|------------|----------------|
| `relativePath` | 每条 upsert 需 batchGetMeta | 省 API |
| `previousParentId` / `previousName` | move 推断弱 | 辅助对账 |

### 5.2 `resolvePath`（P2）

`GET .../resolvePath?projectId=&rootFileId=&path=` → `{ fileId, type, exists }`  
减少 move 前逐级 `getChildFiles`。

---

## 6. 现网继续使用的接口

| 接口 | 用途 |
|------|------|
| `uploadContent`（无 `updateFileId`） | 新建 |
| `uploadContent`（有 `updateFileId`） | **同路径**更新内容 |
| `deleteFile` | 真删除；空目录清理 |
| `listChanges` | 增量 upsert/delete |
| `createFolder` | mapping 根解析 |
| `getChildFiles` 等 | 树遍历 |

**同步侧不再调用**：`updateFileProperty`

---

## 7. 同步端调用约定（联调参考）

```
本地同目录改名（inode 不变，仅文件名变）
  → updateFileName(fileId, newName, nameConflictStrategy=1)
  → 更新 state.local_path

本地换目录 / 目录整体移动（inode 不变，path 变）
  → moveFile(fileId, targetParentId, newName?, nameConflictStrategy=2)
  → 若 response.idChanged：按 idMappings 重写 state.remote_file_id
  → 更新 state.local_path / relativePath

远端变更（listChanges upsert，无 move 事件）
  → batchGetMeta(includePath=true)
  → 同 fileId 且 relativePath 与 state 不同 → 本地 rename/move

定期全量
  → listDescendantFiles(includePath=true)
  → 以 fileId 校准 path；处理 id 已在 KB 侧合并的情况
```

---

## 8. 决策矩阵

| 范围 | 能力 |
|------|------|
| **P0 最小集** | `updateFileName` + `moveFile` + meta/path 字段；本地 rename/move **不再 delete+全量 upload** |
| **+ idMappings** | 支持 move 策略 1（覆盖换 id）时的状态库修复 |
| **+ listChanges 附加 path** | 增量更省 |
| **不做 batch move** | 大目录 N 个文件需 N 次 `moveFile`（文件夹尽量 1 次 folderId）；接受 RTT 换语义清晰 |

### P0 checklist

- [ ] 新增 **`updateFileName`**（策略 0/1，**无覆盖**）
- [ ] 新增 **`moveFile`**（策略 0/1/2/3；文件夹递归 + 逐子项冲突；**策略 1 写清换 id 规则**）
- [ ] 两接口成功响应含 **`fileId/type/name/parentId/updateTime`**；move 含 **`idChanged`**；策略 1 含 **`idMappings`**
- [ ] **`batchGetMeta`** 增加 **`type`、`suffix`、`relativePath`**
- [ ] **`listDescendantFiles`** 增加 **`type`**
- [ ] dev-guide 文档：**不推荐使用 `updateFileProperty` 做同步**

---

## 9. 相关文档

- 本地变更场景（当前实现）：[local-change-scenarios.md](./local-change-scenarios.md)
- 同步仓库：`xgjk/openclaw-xgkb-sync`
