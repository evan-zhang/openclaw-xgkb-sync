# HTTP 管理 API 契约说明（给 AI / 自动化调用）

本文描述进程内嵌的 **管理 HTTP 服务** 的全部路由。实现代码位于 `src/managementApi.ts`；**appKey 与密钥相关的业务规则**与校验辅助函数位于 `src/managementApiCredentials.ts`。

- **Base URL**：`http://{managementHost}:{managementPort}`，默认监听 `0.0.0.0:9090`（本机访问可用 `http://127.0.0.1:9090`，以 `config.json` 为准）。
- **字符编码**：请求/响应体均为 **UTF-8 JSON**。
- **鉴权**：当前版本 **无** HTTP 头鉴权；请仅在可信网络暴露 `managementHost`/`managementPort`。
- **通用错误体**（`4xx` / `5xx` 且 body 为 JSON 时）：

```json
{
  "ok": false,
  "error": "人类可读的中文错误说明，应原样展示给用户或上游系统",
  "errorCode": "仅在部分业务错误时出现，见各接口说明"
}
```

---

## 全局规则：appKey 与「能否保存 mapping」

以下规则适用于 **`POST /mappings`**（新建）与 **`PUT /mappings/:id`**（更新后合并结果）。文中 **`appKey`** 均指 **玄关开放平台**签发的 Open API 鉴权密钥（个人或应用维度以平台控制台为准）；与字段语义、限速等并列说明见仓库 [README.md](../README.md) **「## 配置参考」**。

1. **有效 appKey**指：经 `trim()` 后长度大于 `0` 的字符串。
2. **根级全局 appKey**：指当前已加载配置 `config.json` 中根字段 `appKey`（与 `mappings` 数组同级）。未出现、为 `null`、为 `""`、或仅空白，均视为 **未配置全局 appKey**。
3. **本条 mapping 的 appKey**：指该 mapping 对象上的可选字段 `appKey`。
4. **最终用于调用知识库 API 的密钥**（「有效密钥」）为：  
   `mapping.appKey`（若为非空字符串）**否则** `config` 根级 `appKey`。
5. **保存条件**：在写入 `config.json` 且执行校验时，**必须**存在有效密钥（上一条非空）。否则接口返回 **HTTP 400**，且：
   - `error`：固定风格的长文案，说明必须配置根级或本条 `appKey`；
   - `errorCode`：固定为字符串 **`MAPPING_APPKEY_REQUIRED_WHEN_NO_GLOBAL_APPKEY`**。

**给 AI 的决策表**：

| 根级全局 `appKey` 已配置（非空） | 请求体中本条 mapping 的 `appKey` | 是否允许保存 |
|----------------------------------|-----------------------------------|----------------|
| 是 | 省略 / 空（则使用全局） | 允许 |
| 是 | 非空 | 允许（本条优先于全局） |
| 否 | 非空 | 允许 |
| 否 | 省略 / 空 | **不允许** → 400 + 上述 `errorCode` |

**如何在不读完整配置文件的情况下判断**：先调用 **`GET /mappings`**，读取响应根字段 **`hasGlobalAppKey`**（布尔值）。若为 `false`，则 **`POST /mappings` 与 `PUT /mappings/:id` 的请求体必须包含非空 `appKey`**（针对被创建/被更新的那条 mapping）。

---

## 数据类型约定

| 类型 | 含义 |
|------|------|
| `string` | JSON 字符串 |
| `number` | JSON 数字 |
| `boolean` | JSON `true` / `false` |
| `object` | JSON 对象 |
| `array` | JSON 数组 |
| `T \| null` | 允许 JSON `null` |
| `可选` | 字段可省略；若省略则行为见「默认值」列 |

---

## 1. `GET /health`

**功能**：存活探针；不读磁盘上的 `config.json`，使用**当前内存中**已加载的配置统计 mapping 数量。

| 项目 | 说明 |
|------|------|
| 路径 | `/health` |
| 方法 | `GET` |
| 请求体 | 无 |
| 成功码 | `200` |

### 响应字段（`200`，根对象）

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `ok` | `boolean` | 是 | 恒为 `true` |
| `version` | `string` | 是 | 进程内读取的 npm 包版本 |
| `pid` | `number` | 是 | 进程号 |
| `uptime` | `number` | 是 | 管理 HTTP 服务启动至今的秒数 |
| `startedAt` | `string` | 是 | ISO8601 时间戳 |
| `mappingCount` | `number` | 是 | 当前配置中 mapping 条数 |
| `enabledMappingCount` | `number` | 是 | `enabled !== false` 的 mapping 条数 |
| `nodeVersion` | `string` | 是 | Node.js 版本 |

---

## 2. `GET /status`

**功能**：返回运行状态、配置摘要（**不含**任何 appKey 明文）、各 mapping 的同步运行态与 SQLite 中的上次状态。

| 项目 | 说明 |
|------|------|
| 路径 | `/status` |
| 方法 | `GET` |
| 请求体 | 无 |
| 成功码 | `200` |

### 响应根字段（`200`）

| 字段 | 类型 | 说明 |
|------|------|------|
| `version` | `string` | 同 `/health` |
| `pid` | `number` | 同 `/health` |
| `uptime` | `number` | 同 `/health` |
| `startedAt` | `string` | 同 `/health` |
| `nodeVersion` | `string` | 同 `/health` |
| `config` | `object` | 非敏感配置摘要（无 `appKey`） |
| `mappings` | `object` | **键**为 `mappingId`，**值**为该 mapping 的状态对象 |

### `config` 子对象字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `serverUrl` | `string` | 知识库 API 根地址 |
| `syncDirection` | `string` | `bidirectional` \| `push` \| `pull` |
| `autoSyncIntervalSec` | `number` | 定时 sync 兜底间隔（秒）；watch 启用时仍为兜底 |
| `fullReconcileIntervalSec` | `number` \| 省略 | 强制全量对账间隔秒，默认 `3600`；`0` = 关闭 |
| `watchEnabled` | `boolean` \| 省略 | 全局是否启用 chokidar 本地监听，默认 `true` |
| `pushDebounceMs` | `number` \| 省略 | watch debounce 毫秒，默认 `1500` |
| `watchUsePolling` | `boolean` \| 省略 | NFS/Docker 等环境改用轮询，默认 `false` |
| `maxConcurrentMappingsMode` | `string` \| 省略 | `auto` \| `manual`，默认 `auto` |
| `maxConcurrentMappings` | `number` \| 省略 | 手动模式下的最大并发 mapping 数 |
| `effectiveMaxConcurrentMappings` | `number` | 当前实际生效的并发 mapping 数（`auto` 模式下为计算值） |
| `maxRequestsPerMinute` | `number` \| 省略 | 每 appKey 限速 |
| `mappingCount` | `number` | mapping 总数 |
| `enabledMappingCount` | `number` | 已启用 mapping 数 |

### `mappings[mappingId]` 子对象字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `enabled` | `boolean` | 是否启用 |
| `localRoot` | `string` | 本地根路径 |
| `remoteRootFolderPath` | `string` \| 省略 | 远端路径 |
| `syncDirection` | `string` | 本条或回退到全局 |
| `watchEnabledEffective` | `boolean` | 本条是否实际启用 watch（综合全局/本条配置与 sync 方向） |
| `watchActive` | `boolean` | chokidar 是否已启动 |
| `lastTriggerReason` | `string` \| `null` | 最近一次 sync 触发源：`watch` \| `timer` \| `startup` \| `manual` |
| `lastWatchTriggerAt` | `number` \| `null` | 最近一次 watch 触发的本地时间戳（毫秒） |
| `isSyncing` | `boolean` | 是否正在同步 |
| `pendingSync` | `boolean` | 是否在排队等待再次同步 |
| `lastState` | `object` \| 省略 | SQLite 中该 mapping 的状态摘要（见下表） |

### `lastState` 子对象字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `lastSyncSince` | `number` \| `null` | 上次成功同步的水位时间戳（毫秒） |
| `lastServerTime` | `number` \| `null` | 服务端时间戳 |
| `lastSuccessAt` | `number` \| `null` | 上次成功完成同步的本地时间戳（毫秒） |
| `lastFullScanAt` | `number` \| `null` | 上次成功全量对账的本地时间戳（毫秒） |
| `lastError` | `string` \| `null` | 上次错误摘要 |
| `lastStats` | `object` \| `null` | 最近一次同步的统计（见下表） |
| `resolvedRootFileId` | `string` \| `null` | 缓存的远端根 fileId |
| `resolvedProjectId` | `string` \| `null` | 缓存的空间 ID |

### `lastStats` 子对象字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `uploaded` | `number` | 上传文件数 |
| `downloaded` | `number` | 下载文件数 |
| `deleted` | `number` | 删除文件数 |
| `prunedRemoteDirs` | `number` \| 省略 | 清理的远端空目录数 |
| `skipped` | `number` | 跳过路径数 |
| `failed` | `number` | 失败数 |
| `errors` | `array` | 错误消息字符串列表 |
| `newSince` | `number` \| 省略 | 本次同步推进后的水位 |
| `fullScan` | `boolean` \| 省略 | 本次是否为全量对账 |

---

## 3. `GET /mappings`

**功能**：列出所有 mapping 的**非敏感**配置摘要（**永不返回** `appKey` 原文）。

| 项目 | 说明 |
|------|------|
| 路径 | `/mappings` |
| 方法 | `GET` |
| 请求体 | 无 |
| 成功码 | `200` |

### 响应根字段（`200`）

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `ok` | `boolean` | 是 | 恒为 `true` |
| `total` | `number` | 是 | mapping 条数 |
| `hasGlobalAppKey` | `boolean` | 是 | 根级全局 `appKey` 是否已配置且非空。**`false` 时，后续 `POST`/`PUT` 保存 mapping 必须在请求体中带非空 `appKey`**（见上文全局规则） |
| `mappings` | `array` | 是 | 每项为 `mappingSummary`（见下表） |

### `mappingSummary` 数组元素字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `mappingId` | `string` | 唯一 ID |
| `enabled` | `boolean` | 是否启用 |
| `localRoot` | `string` | 本地根路径 |
| `hasOwnAppKey` | `boolean` | 本条是否单独配置了 `appKey`（不暴露值） |
| `projectId` | `string` \| 省略 | 空间 ID |
| `remoteRootFolderPath` | `string` \| 省略 | 远端路径 |
| `remoteRootFileId` | `string` \| 省略 | 远端根 fileId |
| `syncDirection` | `string` \| 省略 | 覆盖全局方向 |
| `filePatterns` | `array` | glob 列表 |
| `excludePatterns` | `array` | glob 列表 |
| `enableFileIndex` | `boolean` \| 省略 | 是否同步 mapping 根目录 `.openclaw-sync-map.json` 索引，默认 `false` |
| `watchEnabled` | `boolean` \| 省略 | 覆盖全局 watch 开关 |
| `pushDebounceMs` | `number` \| 省略 | 覆盖全局 debounce（毫秒） |
| `watchUsePolling` | `boolean` \| 省略 | 覆盖全局轮询模式 |
| `watchEnabledEffective` | `boolean` | 实际是否启用 watch（只读，列表响应） |
| `effectivePushDebounceMs` | `number` | 实际 debounce（只读） |
| `effectiveWatchUsePolling` | `boolean` | 实际是否轮询（只读） |

---

## 4. `POST /mappings`

**功能**：**新增**一条 mapping：校验 → 写入磁盘 `config.json` → **热重载**使配置立即生效。

| 项目 | 说明 |
|------|------|
| 路径 | `/mappings` |
| 方法 | `POST` |
| `Content-Type` | 应为 `application/json` |
| 成功码 | `201` |
| 失败码 | `400`（校验/业务）、`500`（已写入但重载失败） |

### 请求体（JSON 对象）字段

除另有说明外，语义与 `config.json` 中 `mappings[]` 单条一致，经 `validateMapping` 校验（实现：`src/config.ts`）。

| 字段 | 必填 | 默认值 / 生成规则 | 说明 |
|------|------|-------------------|------|
| `mappingId` | **否** | 若省略、为 `null`、非字符串、或 trim 后为空，则服务端生成 **`map-` + 16 字节随机十六进制**，且与现有所有 `mappingId` 不冲突 | 唯一标识 |
| `localRoot` | **是** | 无 | 本机磁盘上的**绝对路径**（同步根目录）。写法示例见下节 **「localRoot 与 remoteRootFolderPath 示例」** |
| `enabled` | 否 | `true` | 是否启用 |
| `appKey` | **条件必填** | 无 | **玄关开放平台**为个人/应用签发的 **Open API `appKey`**（鉴权密钥）。当 `hasGlobalAppKey === false` 时本条 **必填且非空**。与根级 `appKey`、限速等说明以 [README.md](../README.md) 为准，请在该文档中定位 **「## 配置参考」** → **「### 全局字段」**、**「### 每条 Mapping 字段」** |
| `projectId` | 否 | 无 | 知识库空间 ID；不填则由 Agent 按接口拉取个人空间。说明见 [README.md](../README.md) 同节 **「### 每条 Mapping 字段」** |
| `remoteRootFileId` | 否 | 无 | 远端根目录在知识库内的 **fileId**。**通过本接口新增 mapping 时，调用方通常无法预先知道该 id**，不建议作为首选；若已知可填以减少启动时解析调用 |
| `remoteRootFolderPath` | 否 | 无 | 远端根目录在知识库内的**逻辑路径**（见下节）。**新建 mapping 时推荐传入本字段**；路径不存在时服务端会按知识库 API 约定逐级创建。与 `remoteRootFileId` 的组合行为见 [README.md](../README.md) 中带反引号字段名的 **「remoteRootFileId 与 remoteRootFolderPath 组合」** 小节表格 |
| `filePatterns` | 否 | 省略时使用下方「默认 glob 常量」 | `string[]`，glob 规则与 [README.md](../README.md) **「### 每条 Mapping 字段」** 中 `filePatterns` 说明一致 |
| `excludePatterns` | 否 | 省略时使用下方「默认 glob 常量」 | `string[]`，同上 |
| `syncDirection` | 否 | 继承全局 `syncDirection` | `bidirectional` \| `push` \| `pull`；含义见 [README.md](../README.md) **「### 全局字段」** 中 `syncDirection` |
| `enableFileIndex` | 否 | `false` | 是否启用 mapping 根目录 `.openclaw-sync-map.json` 映射索引；见 [README.md](../README.md) **「### 映射索引文件（enableFileIndex）」** |
| `watchEnabled` | 否 | 继承全局（默认 `true`） | push/bidirectional 是否启用 chokidar 即时 push |
| `pushDebounceMs` | 否 | 继承全局（默认 `1500`） | watch debounce 毫秒 |
| `watchUsePolling` | 否 | 继承全局（默认 `false`） | NFS/Docker 卷轮询监听 |

#### 默认 glob 常量（与 `src/constants.ts` 一致，省略 `filePatterns` / `excludePatterns` 时生效）

`filePatterns` 默认值：

```json
["**/*.md"]
```

`excludePatterns` 默认值：

```json
["**/_conflict_*", "**/.tmp/**"]
```

**`localRoot`（本机绝对路径）**

- 必须为**绝对路径**；相对路径（如 `./data`）无效。
- **Linux**：单层目录示例 `/srv/openclaw/out`；多层示例 `/home/alice/projects/openclaw/workspace/run-01`。
- **macOS**：单层 `/Users/alice/OpenClaw`；多层 `/Users/alice/Library/Application Support/OpenClaw/workspace`（路径中含空格时 JSON 内照常写字符串即可）。
- **Windows**：在 JSON 字符串中**推荐使用正斜杠**（避免反斜杠转义出错）：单层 `"C:/OpenClaw/out"`；多层 `"D:/Company/OpenClaw/TeamA/out"`。若必须使用 Windows 原生反斜杠，请在 JSON 中对每个 `\` 写成 `\\`（例如 `C:\\OpenClaw\\out`）。盘符与目录名以本机实际为准。

**`remoteRootFolderPath`（知识库内逻辑路径）**

- 与客户端操作系统无关，**一律使用正斜杠 `/`** 分段。
- **单层**（根空间下一级目录名）：`"AgentOutput"`。
- **多层**（多级目录）：`"OpenClaw/Output/Alice"`、`"团队文档/2026/归档"`（示例仅说明格式；实际目录名以知识库为准）。
- 与 `remoteRootFileId` 同时填写时的优先级、以及「仅填其一 / 都不填」的行为，**以 [README.md](../README.md) 小节「remoteRootFileId 与 remoteRootFolderPath 组合」中的表格为准**；若与实现有出入，以 `README.md` + 源码为准。

> **与 README 对齐**：`localRoot` 的补充提示见 [README.md](../README.md) **「### macOS 部署」** 下安装步骤中的注释（`# 编辑 config.json：mappings[].localRoot…`）；配置字段表见 **「## 配置参考」**。

### 成功响应（`201`）

| 字段 | 类型 | 说明 |
|------|------|------|
| `ok` | `boolean` | `true` |
| `message` | `string` | 人类可读说明 |
| `mapping` | `object` | 同 `GET /mappings` 中的 `mappingSummary`，含最终生效的 `mappingId` |

### 失败响应要点

| `errorCode` | 场景 |
|-------------|------|
| `MAPPING_APPKEY_REQUIRED_WHEN_NO_GLOBAL_APPKEY` | 全局无有效 `appKey` 且本条也未提供 |

---

## 5. `PUT /mappings/:mappingId`

**功能**：**Upsert**（存在则更新，不存在则创建）。URL 中的 `mappingId` 为唯一键。

- **已存在**：与磁盘上现有记录**部分合并**（未传字段保留原值）→ 校验 → 若有实际变更则写 `config.json` 并热重载。
- **不存在**：将 URL 中的 `mappingId` 与请求体合并为**新建**条目（语义等同带固定 id 的 `POST /mappings`）→ 校验 → 写盘并热重载。

| 项目 | 说明 |
|------|------|
| 路径 | `/mappings/{mappingId}`，`mappingId` 为 URL 路径段（应 `encodeURIComponent` 若含特殊字符） |
| 方法 | `PUT` |
| 请求体 | JSON 对象。更新时至少包含一个要修改的字段；**新建**时须含 `validateMapping` 要求的必填字段（至少 `localRoot` 等非空字符串，见 `POST /mappings` 字段表） |
| 成功码 | `201`（新建）、`200`（更新或有/无实际变化） |
| 失败码 | `400`、`500`（已写盘但重载失败） |

### 请求体特殊规则

| 规则 | 说明 |
|------|------|
| `mappingId` | 若请求体包含该字段，**必须**与 URL 中的 `mappingId` **完全一致**，否则 `400` |
| 清空可选路径字段 | 对 `remoteRootFolderPath`、`remoteRootFileId` 传 `""` 表示清空 |

**远端根**：与 **`POST /mappings`** 相同——调用方通常**不知道** `remoteRootFileId`，应优先维护 **`remoteRootFolderPath`**（知识库内 `/` 分隔逻辑路径）；组合语义仍以 [README.md](../README.md) 小节「remoteRootFileId 与 remoteRootFolderPath 组合」为准。

### 合并后的「有效密钥」校验

合并并 `validateMapping` 之后，对**合并后的整条 mapping** 执行与 `POST /mappings` 相同的 **appKey 全局规则**。不满足则 **`400`**，且带 `errorCode: MAPPING_APPKEY_REQUIRED_WHEN_NO_GLOBAL_APPKEY`。

### 成功响应（`201`，新建）

| 字段 | 类型 | 说明 |
|------|------|------|
| `ok` | `boolean` | `true` |
| `created` | `boolean` | `true` |
| `message` | `string` | 说明 |
| `mapping` | `object` | `mappingSummary` |

### 成功响应（`200`，更新且有变更）

| 字段 | 类型 | 说明 |
|------|------|------|
| `ok` | `boolean` | `true` |
| `created` | `boolean` | `false` |
| `message` | `string` | 说明 |
| `changed` | `array` | 实际发生变化的字段名列表 |
| `warnings` | `array` \| 省略 | 若身份字段变更，提示下次全量对账 |
| `mapping` | `object` | `mappingSummary` |

### 成功响应（`200`，更新但无变更）

| 字段 | 类型 | 说明 |
|------|------|------|
| `ok` | `boolean` | `true` |
| `created` | `boolean` | `false` |
| `message` | `string` | 说明未重载 |
| `changed` | `array` | 空数组 |

---

## 6. `DELETE /mappings/:mappingId`

**功能**：删除指定 mapping，写盘并热重载。

| 项目 | 说明 |
|------|------|
| 路径 | `/mappings/{mappingId}` |
| 方法 | `DELETE` |
| 请求体 | 无 |
| 成功码 | `200` |
| 失败码 | `404`（不存在）、`500`（已删但重载失败） |

### 成功响应（`200`）

| 字段 | 类型 | 说明 |
|------|------|------|
| `ok` | `boolean` | `true` |
| `message` | `string` | 说明 |

---

## 7. `POST /sync`

**功能**：对当前所有 **`enabled` 为真** 的 mapping **异步**触发一次同步（不等待完成）。

| 项目 | 说明 |
|------|------|
| 路径 | `/sync` |
| 方法 | `POST` |
| 请求体 | 无 |
| 成功码 | `200` |

### 成功响应（`200`）

| 字段 | 类型 | 说明 |
|------|------|------|
| `ok` | `boolean` | `true` |
| `message` | `string` | 说明 |
| `triggered` | `array` | 字符串数组，为已触发同步的 `mappingId` 列表 |

---

## 8. `POST /sync/:mappingId`

**功能**：对**单条** mapping 触发异步同步。

| 项目 | 说明 |
|------|------|
| 路径 | `/sync/{mappingId}` |
| 方法 | `POST` |
| 请求体 | 无 |
| 成功码 | `200` |
| 失败码 | `404`（无此 id）、`400`（`enabled=false`） |

### 成功响应（`200`）

| 字段 | 类型 | 说明 |
|------|------|------|
| `ok` | `boolean` | `true` |
| `message` | `string` | 说明 |

### `404` 响应额外字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `availableMappings` | `array` | 当前存在的 `mappingId` 列表 |

---

## 9. `POST /reload`

**功能**：从磁盘**重新读取** `config.json`，重建调度器；**不**重启 HTTP 监听端口。

| 项目 | 说明 |
|------|------|
| 路径 | `/reload` |
| 方法 | `POST` |
| 请求体 | 无 |
| 成功码 | `200` |
| 失败码 | `400`（配置校验失败） |

### 成功响应（`200`）

| 字段 | 类型 | 说明 |
|------|------|------|
| `ok` | `boolean` | `true` |
| `message` | `string` | 说明 |
| `mappingCount` | `number` | 重载后 mapping 数 |
| `enabledMappingCount` | `number` | 已启用数 |

---

## 10. `GET /config`

**功能**：读取当前全局配置摘要（**不含** `appKey` 明文）。

| 项目 | 说明 |
|------|------|
| 路径 | `/config` |
| 方法 | `GET` |
| 请求体 | 无 |
| 成功码 | `200` |

### 响应根字段（`200`）

| 字段 | 类型 | 说明 |
|------|------|------|
| `ok` | `boolean` | 恒为 `true` |
| `hasGlobalAppKey` | `boolean` | 根级全局 `appKey` 是否已配置 |
| `config` | `object` | 非敏感全局配置（见下表） |

### `config` 子对象字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `serverUrl` | `string` | 知识库 API 根地址 |
| `appKeyMasked` | `string` \| 省略 | 全局 AppKey 脱敏展示（前 4 + 后 4 位）；未配置时省略 |
| `syncDirection` | `string` | 默认同步方向 |
| `autoSyncIntervalSec` | `number` | 自动同步间隔秒 |
| `fullReconcileIntervalSec` | `number` | 强制全量对账间隔秒，默认 `3600`；`0` = 关闭 |
| `stateDbPath` | `string` | SQLite 状态库路径 |
| `maxConcurrentMappingsMode` | `string` | `auto` \| `manual` |
| `maxConcurrentMappings` | `number` | 手动模式下的最大并发 mapping 数 |
| `effectiveMaxConcurrentMappings` | `number` | 当前实际生效的并发 mapping 数 |
| `maxRequestsPerMinute` | `number` | API 限速 |
| `rateLimitBurst` | `number` | 令牌桶突发容量 |
| `rateLimitCooldownSec` | `number` | 429 冷却秒数 |
| `downloadConcurrency` | `number` | 下载并发 |
| `uploadConcurrency` | `number` | 上传并发 |
| `startupJitterMaxSec` | `number` | 启动抖动上限 |
| `managementPort` | `number` | 管理 API 端口 |
| `managementHost` | `string` | 管理 API 监听地址 |

---

## 11. `PUT /config`

**功能**：部分更新全局配置，写入 `config.json` 并热重载。

| 项目 | 说明 |
|------|------|
| 路径 | `/config` |
| 方法 | `PUT` |
| `Content-Type` | 应为 `application/json` |
| 成功码 | `200` |
| 失败码 | `400`、`500`（已写入但重载失败） |

### 请求体（JSON 对象，至少一个字段）

可修改字段：`serverUrl`、`appKey`（传空字符串或 `null` 清除）、`syncDirection`、`autoSyncIntervalSec`、`fullReconcileIntervalSec`、`stateDbPath`、`maxConcurrentMappingsMode`（`auto` \| `manual`）、`maxConcurrentMappings`、`maxRequestsPerMinute`、`rateLimitBurst`、`rateLimitCooldownSec`、`downloadConcurrency`、`uploadConcurrency`、`startupJitterMaxSec`、`managementPort`、`managementHost`、`watchEnabled`、`pushDebounceMs`（≥100）、`watchUsePolling`。

> **注意**：`managementPort` 与 `managementHost` 写入磁盘后**需重启进程**才会改变 HTTP 监听；响应中可能带 `warnings` 提示。

### 成功响应（`200`）

| 字段 | 类型 | 说明 |
|------|------|------|
| `ok` | `boolean` | `true` |
| `message` | `string` | 说明 |
| `hasGlobalAppKey` | `boolean` | 更新后是否仍有全局 appKey |
| `config` | `object` | 同 `GET /config` |
| `warnings` | `array` \| 省略 | 需重启才生效的字段提示 |

---

## 12. 管理控制台（静态页面）

| 项目 | 说明 |
|------|------|
| 路径 | `/` 或 `/index.html` |
| 方法 | `GET` |
| 静态资源 | `/static/*`（CSS / JS） |

浏览器访问 `http://{managementHost}:{managementPort}/` 即可打开内置管理控制台，支持：

- 查看服务健康与运行状态（含每条 mapping 最近同步统计摘要）
- 全局配置的查看与保存（普通/高级分组；全局 AppKey 脱敏展示）
- 同步映射卡片化管理、复制本地路径、增删改查、单条/全部触发同步
- 手动重载配置

静态资源响应头为 `Cache-Control: no-cache`，避免浏览器强缓存旧版 JS/CSS。

---

## AI 操作清单（避免误判）

1. **新增 mapping 前**：`GET /mappings` → 读 `hasGlobalAppKey`。若为 `false`，**必须在** `POST /mappings` 的 JSON 里写 **`appKey`: "<非空>"`**。
2. **修改 mapping 前**：若打算删掉本条独立 `appKey`（改全局依赖），先确认根级已有全局 `appKey`，否则合并后会触发 **`MAPPING_APPKEY_REQUIRED_WHEN_NO_GLOBAL_APPKEY`**。
3. **不要**依赖响应里的 `hasOwnAppKey` 推断全局是否有密钥；**仅以** `hasGlobalAppKey` **与**根配置文件为准。
4. **`mappingId`**：`POST /mappings` 新建时可省略（服务端自动生成）；**`PUT /mappings/:id` 的 upsert、删除、单路同步** 须在 URL 中给出确定的 `mappingId`（不存在时 PUT 会创建该 id）。
5. **远端根**：新建或修改时，若不知道知识库内的 `remoteRootFileId`，**请传 `remoteRootFolderPath`**（`/`-分隔逻辑路径）；勿猜测 fileId。组合行为见 [README.md](../README.md) 小节「remoteRootFileId 与 remoteRootFolderPath 组合」。
