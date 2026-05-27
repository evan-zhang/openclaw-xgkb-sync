# 知识库 Open API 实现说明（双向文件同步 · v2）

> **读者**：同步客户端 / Open API / 联调测试  
> **来源**：[openclaw-xgkb-sync](https://github.com/xgjk/openclaw-xgkb-sync) 独立同步进程  
> **版本**：v2（2026-05）— 以 **docdb `document-database` + open-api 透传** 为准  
> **状态**：P0 / P1 / P2 **均已落地**（分支 `feature/kb-sync-api-p0` 及后续提交）

---

## 1. 背景与设计约束

同步进程在**本地目录**与**知识库**之间按 mapping 规则做双向同步。本地 rename/move 若走「删旧 + 全量上传」，大目录下 API 与带宽开销不可接受。

**v2 方案（已实现）**：

| 场景 | 接口 |
|------|------|
| 同目录仅改名 | `POST /document-database/file/updateFileName` |
| 换父目录（可同时换名） | `POST /document-database/file/moveFile` |
| 单次仅一个节点 | 不支持 batch rename/move |
| 远端 path 变化 | **无** `listChanges` 的 `move` 事件；靠 `batchGetMeta.relativePath` + 全量 `listDescendantFiles` 对账 |
| 历史合并接口 | `updateFileProperty` **已废弃**（open-api 固定 `resultCode=400`） |

**实现入口（docdb）**：

| 能力 | 类 |
|------|-----|
| 写：改名 / 移动 | `FileSyncApiService` → `FileService.updateFileNameById` / `FileMoveService.moveFile` |
| 读：meta / 子树 / 增量 / 路径 | `FileQueryService` |
| 稳定错误码 | `SyncApiErrorCode` + `SyncApiExceptionHandler`（`FileController` / `FileQueryController`） |
| move 明细 | `MoveExecutionReport` + `MoveExecutionReportHolder` |
| move/rename 前快照 | `FileSyncMoveHintService`（Redis，供 `includeMoveHint`） |

Open API 路径前缀：`https://{域名}/open-api/document-database/file/...`（`DocumentDatabaseController` Feign 透传）。

---

## 2. 实现总览

| 类别 | 接口 / 能力 | 优先级 | 状态 |
|------|-------------|--------|------|
| 新增 | `updateFileName` | P0 | ✅ |
| 新增 | `moveFile` | P0 | ✅ |
| 修改 | `batchGetMeta`（`type`/`suffix`/`relativePath`/`contentHash`/`etag`） | P0 + P2 | ✅ |
| 修改 | `listDescendantFiles`（`type`、`includeFolders`、**`suffix` 多值/`*`**） | P0 + **待 KB** | 🔄 suffix 扩展中 |
| 修改 | `listChanges`（`includePath`、`includeMoveHint`） | P1 | ✅ |
| 新增 | `resolvePath` | P2 | ✅ |
| 错误响应 | `Result.data.errorCode`（`SyncApiErrorVO`） | — | ✅ docdb 直连；经 open-api 时 **可能** 仅有 `resultCode`（如 `400001`） |
| 明确不做 | batch rename/move；`listChanges.move` 事件；同步调用 `updateFileProperty` | — | — |

---

## 3. 路径语义（必读）

### 3.1 `relativePath`（`batchGetMeta` / `listDescendantFiles` / `listChanges` / 写接口响应）

- 由请求参数 **`rootFileId`（映射根）** 与节点 `fileId` 共同决定。
- 算法：取 `fileId` 到根的路径链，定位链上 **`rootFileId` 所在层级**，将其**之后**各级 `name` 用 `/` 拼接（见 `FileQueryService.resolveRelativePath`）。
- 示例：映射根为子树根文件夹 `10086`，文件在 `10086/AI生成/README.md` → `relativePath` 可能为 `AI生成/README.md`。

### 3.2 `resolvePath` 的 `path`（与 `relativePath` 不同）

- `GET .../resolvePath?projectId=&rootFileId=&path=` 中 **`path` 相对 `rootFileId` 目录**，支持多段（`a/b.md`），非必须把 `batchGetMeta` 的多级 `relativePath` 原样传入。
- 空 `path`：解析结果为 **`rootFileId` 自身**（`exists=true`）。
- 中间段按**文件夹**（`type=1`）逐级匹配；最后一段文件/文件夹均可匹配（`typeFilter` 末段为 null）。
- 无权限 / 不存在：`exists=false`，`fileId=null`（不抛错，便于客户端判断）。

---

## 4. 写接口

### 4.1 `updateFileName` — 同目录改名

**路径**：`POST /document-database/file/updateFileName`

#### 请求体（`OpenUpdateFileNameParam`）

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `fileId` | Long | 是 | 文件或文件夹 id |
| `newName` | String | 是 | 新名称（含扩展名） |
| `projectId` | Long | 建议 | 与节点 `projectId` 不一致时 `PROJECT_FILE_MISMATCH` |
| `nameConflictStrategy` | Integer | 否 | **0**=自动重命名；**1**=失败。**省略/null 等价于 1**（`autoRename=false`） |
| `rootFileId` | Long | 否 | 传入时在成功响应中填充 `relativePath` |

**不支持**「先删目标再改名」类覆盖（仅 0/1；非法值 → `INVALID_ARGUMENT`）。

#### 4.1.1 成功响应 — 同步客户端**最小契约**

| 字段 | 必填 | 说明 |
|------|------|------|
| `fileId` | 是 | 操作后 id（正常与请求相同） |
| `name` | 是 | **最终**名称（策略 0 可能带后缀） |
| `parentId` | 是 | 父目录 id |
| `updateTime` | 是 | 毫秒时间戳 |
| `relativePath` | 请求带 `rootFileId` 时 | 相对映射根路径 |
| `renamedDueToConflict` | 否 | `true` 表示因策略 0 自动加了后缀 |

不要求：`type`（同步端忽略）。

成功后写入 **move hint**（供 `includeMoveHint`）。

---

### 4.2 `moveFile` — 移动节点

**路径**：`POST /document-database/file/moveFile`

#### 请求体（`OpenMoveFileParam`）

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `fileId` | Long | 是 | 被移动节点（文件或文件夹） |
| `targetParentId` | Long | 是 | 目标父目录 id |
| `newName` | String | 否 | 移动**完成后**再改名；省略保留原名 |
| `projectId` | Long | 否 | 跨空间移动时传入 |
| `nameConflictStrategy` | Integer | 否 | **0** 重命名 / **1** 覆盖 / **2** 抛错 / **3** 跳过。**省略/null 默认为 2** |
| `rootFileId` | Long | 否 | 用于填充响应 `relativePath`（相对映射根） |

#### `nameConflictStrategy` 与内核（`MoveConflictStrategy`）

| 值 | 枚举 | 行为摘要 |
|----|------|----------|
| 0 | `RENAME` | 目标位同名则自动避让后缀后移动，`fileId` 通常不变 |
| 1 | `COVER` | 目标位同名则保留**目标 id**，合并源内容后删除源节点 → **`idChanged=true`** |
| 2 | `ERROR` | 遇同名冲突抛错（**同步推荐默认**） |
| 3 | `SKIP` | 主节点冲突时 `mainSkipped=true`；子树其余按内核逻辑，子项跳过靠下轮对账 |

非法值（非 0–3）→ `INVALID_ARGUMENT`。

#### 4.2.1 成功响应 — 同步客户端**最小契约**（`FileMoveResultVO` 子集）

> **说明**：下列字段为 **openclaw-xgkb-sync 唯一依赖** 的返回结构。`details`、`skippedItems`、`affectedCount`、`type` 等扩展字段 KB 可自行保留，**同步端不解析**。

**始终必填（`resultCode=1` 且主节点已处理时）**

| 字段 | 类型 | 说明 |
|------|------|------|
| `fileId` | Long | 操作后**主节点**有效 id |
| `sourceFileId` | Long | **恒等于**请求 `fileId` |
| `idChanged` | Boolean | 是否因覆盖等发生 id 切换；无冲突/重命名/跳过时为 `false` |
| `name` | String | 主节点最终名称 |
| `parentId` | Long | 主节点最终父 id（通常 = `targetParentId`） |
| `updateTime` | Long | 毫秒时间戳 |

**条件必填**

| 字段 | 条件 | 说明 |
|------|------|------|
| `relativePath` | 请求带 `rootFileId` | 相对映射根的路径；无则同步端用本地路径兜底 |
| `idMappings` | `idChanged=true` | 至少 1 条 `{ sourceFileId, targetFileId }`，**必须含主节点**（源 id → 有效 id） |
| `mainSkipped` | 策略 3 且**主节点**因同名未移动 | `true`；同步端不更新 state。子项跳过可不单独上报，靠下轮全量对账 |

**JSON 示例**

```json
// 无冲突，正常移动
{
  "fileId": 200,
  "sourceFileId": 100,
  "idChanged": false,
  "name": "note.md",
  "parentId": 50,
  "updateTime": 1716000000000,
  "relativePath": "subdir/note.md"
}

// 策略 1 覆盖，id 切换
{
  "fileId": 200,
  "sourceFileId": 100,
  "idChanged": true,
  "name": "note.md",
  "parentId": 50,
  "updateTime": 1716000000000,
  "relativePath": "subdir/note.md",
  "idMappings": [{ "sourceFileId": 100, "targetFileId": 200 }]
}

// 策略 3，主节点跳过
{
  "fileId": 100,
  "sourceFileId": 100,
  "idChanged": false,
  "name": "note.md",
  "parentId": 10,
  "updateTime": 1715990000000,
  "mainSkipped": true
}
```

**同步端行为摘要**

| 场景 | 同步端 |
|------|--------|
| `mainSkipped=true` | 记日志，**不**改 SQLite |
| `idChanged=false` | 更新 path/mtime；`remote_file_id` 不变 |
| `idChanged=true` | 按 `idMappings` 批量改 `remote_file_id`（无 `idMappings` 时用 `sourceFileId→fileId` 兜底） |
| 策略 2 冲突 | `resultCode≠1`，整次未移动 |

**不要求实现（可删或延后）**：`details[]`、`skippedItems[]`、`affectedCount`、`idMappings[].relativePath`。

**流程（KB 内部）**：`FileMoveService.moveFile` 递归子树 → 写 move hint → 按上表组装最小 VO。同步端**不传** `newName`；换目录+改名由客户端先 `moveFile` 再 `updateFileName`。

---

## 5. 读接口（同步相关）

### 5.1 `batchGetMeta`

`POST /document-database/file/batchGetMeta`（`BatchGetMetaParam`）

| 请求字段 | 说明 |
|----------|------|
| `fileIds` | 必填，按请求顺序返回 |
| `projectId` | 可选 |
| `includePath` | 默认 false；**true 时 `rootFileId` 必填** |
| `includeContentHash` | 默认 false；从 `Resource.hash` / `md5` 填充 `contentHash`、`etag` |

| 响应字段 | 说明 |
|----------|------|
| `type` / `suffix` | 节点存在且未标记 deleted 时返回 |
| `relativePath` | `includePath=true` 且未 deleted |
| `deleted` | `true`：不存在 / `status≠1` / **无读权限** |
| `contentHash` / `etag` | 无物理 `resourceId` 时可能为空（如 `uploadContent` 纯文本） |

---

### 5.2 `listDescendantFiles`

`GET .../listDescendantFiles`

| 参数 | 默认 | 说明 |
|------|------|------|
| `projectId` / `rootFileId` | 必填 | |
| `suffix` | `md`（**不传时**） | 单后缀如 `md`；**多后缀**逗号分隔如 `md,png,pdf`；**`*`** 表示不过滤类型、返回全部文件 |
| `limit` | 500，最大 2000 | |
| `includePath` | false | true 时返回 `relativePath` |
| `includeFolders` | **false** | false：仅文件（与现网一致）；true：含文件夹，项带 **`type`** |

响应 `files[]`：`fileId`、`parentId`、`name`、`type`、`size`、`updateTime`、`relativePath?`。

**suffix 扩展（KB 待上线，同步端已按此传参）**：

| 传值 | 行为 |
|------|------|
| 省略 | 仅 `md`（**同步端避免省略**，始终显式传 suffix） |
| `md` | 仅 md |
| `md,png,pdf` | 上述后缀并集 |
| `*` | 不过滤，返回全部类型 |

同步端 `buildListDescendantFilesSuffix(filePatterns)` 规则：单一 `**\/*.ext` → 该 ext；多个 ext → 逗号拼接；无法推断（如 `**\/*`）→ `*`。

---

### 5.3 `listChanges`

`GET .../listChanges`

| 参数 | 说明 |
|------|------|
| `projectId` | 可省略 → 默认**个人知识库**（需 `employeeId`，`corpId` 可反查） |
| `rootFileId` | 可选，限定子树 |
| `since` | 毫秒水位；**有 `cursor` 时忽略 since** |
| `cursor` | Base64 URL：`updateTimeMillis,fileId` |
| `limit` | 默认 200，最大 1000 |
| `includePath` | true 时 **`rootFileId` 必填**，upsert 项带 `relativePath` |
| `includeMoveHint` | true 时 upsert 项可带 `previousParentId`、`previousName`（见 §5.4） |

`items[]`：`fileId`、`parentId`、`type`、`name`、`updateTime`、`event`（`upsert` | `delete`）。**无 `move` 事件类型。**

响应含 `serverTime`（毫秒）、`nextCursor`。

---

### 5.4 `includeMoveHint`（最佳努力）

- 在 **`updateFileName` / `moveFile` 成功** 后，由 `FileSyncMoveHintService` 写入 Redis：`kb-sync:move-hint:{fileId}`，TTL **30 天**。
- `listChanges` 拉取 upsert 时读取；Redis 不可用或未经过同步写接口时字段为空。
- **不能**替代 `batchGetMeta` 路径对账；仅辅助判断「是否刚发生 rename/move」。

---

### 5.5 `resolvePath`（P2）

`GET .../resolvePath?projectId=&rootFileId=&path=`

响应 `ResolvePathVO`：`exists`、`fileId`、`type`、`path`（回显）。详见 §3.2。

---

## 6. 稳定错误码

失败时 docdb 返回 `resultCode`（非 1）+ `data: { errorCode, message }`（`SyncApiExceptionHandler`）。

| errorCode | resultCode | 典型场景 |
|-----------|------------|----------|
| `TARGET_NAME_CONFLICT` | 400001 | 同名冲突（策略 1/2） |
| `CYCLE_MOVE_FORBIDDEN` | 400002 | 移动到自身或子孙目录 |
| `FILE_NOT_FOUND` | 400003 | 节点不存在 |
| `PROJECT_FILE_MISMATCH` | 400004 | `fileId` 与 `projectId` 不匹配 |
| `INVALID_ARGUMENT` | 400005 | 非法 `nameConflictStrategy` 等 |
| `INSUFFICIENT_PERMISSION` | 400006 | 无 ADMIN/UPLOAD 等权限 |
| `MOVE_FAILED` | 400007 | 其它移动/改名失败（含未映射的内核异常） |
| `MOVE_RESULT_UNRESOLVED` | 400008 | 覆盖移动后无法解析有效节点 |

`SyncApiExceptionTranslator` 按内核 `BusinessException` 文案关键字映射（含「已存在」「无法移动到下层」等）。

**open-api 联调注意**：网关层失败时 `data.errorCode` 有时为空，可仅用 `resultCode=400001` 判断冲突。

---

## 7. 废弃：`updateFileProperty`

| 层级 | 行为 |
|------|------|
| **open-api** | `POST .../updateFileProperty` → `resultCode=400`，文案指引改用 `updateFileName` + `moveFile` |
| **docdb 内部** | `PropertyController.updateFileProperty` 仍存在（非 Open API 同步路径） |

同步客户端应：**先 `moveFile`，再 `updateFileName`**（若需同时换目录与改名）。

---

## 8. 同步端调用约定（联调参考）

```
本地同目录改名
  → updateFileName(fileId, newName, nameConflictStrategy=1, rootFileId=映射根)
  → 用响应 relativePath / renamedDueToConflict 更新 state

本地换目录 / 目录移动
  → moveFile(fileId, targetParentId, nameConflictStrategy=映射配置默认3, rootFileId=映射根)
  → 响应见 §4.2.1 最小契约；idChanged 时按 idMappings 改 remote_file_id
  → mainSkipped=true 时不更新 state；换名另调 updateFileName

远端 listChanges upsert（无 move 事件）
  → batchGetMeta(fileIds, includePath=true, rootFileId=映射根)
  → 同 fileId 且 relativePath ≠ state → 本地对齐 rename/move

可选：路径 → fileId
  → resolvePath(projectId, rootFileId=直接父或 mapping 根, path=相对该根的路径)

定期全量
  → listDescendantFiles(includeFolders=true, includePath=true)
```

---

## 9. 实现核对清单（docdb）

- [x] `updateFileName`（策略 0/1；`renamedDueToConflict`；可选 `relativePath`）
- [x] `moveFile`（策略 0–3；同步最小契约见 §4.2.1：`idChanged` / `idMappings` / `mainSkipped`）
- [x] `batchGetMeta`：`type`、`suffix`、`relativePath`、`includeContentHash`
- [x] `listDescendantFiles`：`type`、`includeFolders`
- [x] `listChanges`：`includePath`、`includeMoveHint`（Redis hint）
- [x] `resolvePath`
- [x] `SyncApiErrorCode` + `SyncApiExceptionHandler`
- [x] open-api 废弃 `updateFileProperty` 桩
- [ ] 消费方 **openclaw-xgkb-sync** 切 v2 接口（仓库外协同）

---

## 10. 相关文档与测试

| 文档 / 资产 | 路径 |
|-------------|------|
| 对外接口明细 | `dev-guide/.../API接口明细_v2/01-空间与目录树管理.md` |
| 全量联调脚本 | `devmanage/apitest/test-kb-api/test_kb_api_v2_all.py` |
| CMS 示例脚本 | `skill/cms-docdb`：`update-file-name.py`、`move-file.py` |
| 本地变更场景 | [local-change-scenarios.md](./local-change-scenarios.md) |
| 同步仓库 | `xgjk/openclaw-xgkb-sync` |

**代码锚点**：`apps/backend/document-database/src/main/java/com/xgjktech/document/service/FileSyncApiService.java`、`FileQueryService.java`（`batchGetMeta` / `listChanges` / `listDescendantFiles` / `resolvePath`）、`sync/SyncApiErrorCode.java`。
