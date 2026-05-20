# openclaw-xgkb-sync

OpenClaw 节点与玄关知识库（XGKB）文件双向同步 Agent。

不依赖 Obsidian 客户端，直接作为 Node.js 后台服务运行，支持多台 OpenClaw 节点并行同步到同一知识库空间。

> 架构设计、同步流程与可靠性说明详见 [DESIGN.md](./docs/DESIGN.md)。

---

## 给 AI / 部署者（请先读本节）

若你（或你的 AI 助手）首次接触本项目，**按顺序完成下方「从零部署清单」即可独立部署**。本文 + `config.example.json` 已包含部署所需信息；HTTP 接口完整契约见 [docs/MANAGEMENT_API.md](./docs/MANAGEMENT_API.md)。

### 文档导航

| 文档 | 何时阅读 |
|------|----------|
| **本文 README.md** | 安装、配置、启动、Web 控制台、生产部署、排错 |
| [config.example.json](./config.example.json) | 复制为 `config.json` 的配置模板 |
| [docs/MANAGEMENT_API.md](./docs/MANAGEMENT_API.md) | 用 curl / 脚本 / AI 自动化增删改查 mapping 与全局配置 |
| [docs/DESIGN.md](./docs/DESIGN.md) | 同步架构、增量策略、可靠性设计（非部署必读） |

### 部署前向用户确认的信息

| 信息 | 说明 | 写入位置 |
|------|------|----------|
| 知识库 Open API 地址 | 形如 `https://your-host/open-api/`（注意末尾斜杠） | `serverUrl` |
| AppKey | 玄关开放平台签发的 Open API 密钥 | 全局 `appKey` **或** 每条 `mappings[].appKey`（至少一处非空） |
| 本地同步目录 | **绝对路径**，Agent 产出文件所在文件夹 | `mappings[].localRoot` |
| 远端目录路径 | 知识库内逻辑路径，用 `/` 分隔，如 `OpenClaw/Output` | `mappings[].remoteRootFolderPath`（推荐填写） |
| 空间 ID（可选） | 不填则自动使用**个人空间** | `mappings[].projectId` |

> **安全**：`config.json` 含密钥，已在 `.gitignore` 中忽略，**勿提交仓库**。分发项目时使用 `config.example.json`。

### 从零部署清单

按顺序执行，每步后用「验证」确认成功再继续：

| 步骤 | 操作 | 验证 |
|------|------|------|
| 1 | 确认 Node.js >= 18：`node -v` | 输出版本号且无报错 |
| 2 | 进入项目目录，安装依赖：`npm install` | `node_modules/` 已生成 |
| 3 | 创建配置文件（见下方「各平台命令」）；**若省略此步**，首次启动会自动生成默认 `config.json` | 存在 `config.json`（可仅含默认字段与空 `mappings`） |
| | 若 `config.json` 为 `{}`、内容不完整或 JSON 损坏，启动时也会**自动合并/重置为默认配置**（不阻止启动） | |
| 4 | 编辑 `config.json`：填密钥、至少 1 条 mapping（`localRoot` 必填）；`serverUrl` 可省略（默认生产地址） | JSON 可被编辑器正常解析 |
| 5 | 构建：`npm run build` | 生成 `dist/index.js` |
| 6 | 启动：`npm start`（或开发模式 `npm run dev`） | 控制台出现 `[OpenClaw Sync] 服务已启动` 与 `[ManagementApi] 已启动` |
| 7 | 探活 | `GET /health` 返回 200 且 `"ok": true`（见下方 curl 示例） |
| 8 | **（推荐）** 浏览器打开 `http://127.0.0.1:9090/` | 看到「OpenClaw 同步管理」控制台 |
| 9 | 在控制台「同步映射」新增/确认 mapping，或编辑 `config.json` 后 `POST /reload` | `GET /mappings` 的 `total` >= 1 |
| 10 | 触发同步：控制台「全部同步」或 `POST /sync` | `GET /status` 中对应 mapping 出现 `lastState.lastSuccessAt` |

**各平台：创建 config.json**

```bash
# Linux / macOS
cp config.example.json config.json

# Windows（CMD）
copy config.example.json config.json

# Windows（PowerShell）
Copy-Item config.example.json config.json
```

**各平台：验证 health（注意 Windows 请用 curl.exe）**

```bash
curl http://127.0.0.1:9090/health
# Windows PowerShell 若 curl 报错，改用：
curl.exe http://127.0.0.1:9090/health
```

### 部署完成标准

满足以下全部条件即视为部署成功：

1. 进程持续运行，无反复崩溃退出
2. `GET /health` → `mappingCount >= 1`（至少一条 mapping）
3. `GET /status` → 目标 mapping 的 `lastState.lastError` 为空，或已有 `lastSuccessAt`
4. 在本地 `localRoot` 放入测试文件（匹配 `filePatterns`）后触发同步，远端对应目录可见该文件（push/bidirectional 场景）

### 配置 mapping 的两种方式

**方式 A — Web 控制台（推荐，适合人工或非技术用户）**

1. 启动服务后访问 `http://127.0.0.1:9090/`
2. 在「全局配置」填写 `serverUrl` 等并保存
3. 在「同步映射」点击「新增映射」，填写本地目录、远端路径、AppKey（若全局未配置）
4. 保存后自动写入 `config.json` 并热重载，无需重启进程

**方式 B — 直接编辑 config.json**

1. 参考 [config.example.json](./config.example.json) 与下方「配置参考」
2. 保存文件后执行 `curl -X POST http://127.0.0.1:9090/reload`，或重启进程

新建 mapping 时**若全局无 `appKey`**，必须在 mapping 或 Web 表单中填写非空 `appKey`，否则 API 返回 400（`errorCode: MAPPING_APPKEY_REQUIRED_WHEN_NO_GLOBAL_APPKEY`）。可先 `GET /mappings` 查看 `hasGlobalAppKey`。

---

## 功能特性

- **增量优先**：`listChanges` 拉取变更，仅处理有差异的文件；全量兜底保证一致性
- **双向同步**：LWW 策略，支持 `bidirectional / push / pull` 三种方向
- **多 Mapping**：单节点可配置多条本地目录 ↔ 云端目录映射，每条独立配置方向与文件过滤
- **按用户限速**：每个 `appKey` 独享令牌桶，多用户场景互不干扰
- **Web 管理控制台**：浏览器访问 `/` 即可可视化增删改查 mapping 与全局配置
- **HTTP 管理 API**：内置轻量 HTTP 服务，支持远程查看状态、触发同步、热重载配置（供 AI / 脚本调用）
- **SQLite 状态库**：持久化同步水位与文件状态，无需外部依赖

---

## 快速开始

完整步骤见上文 **「从零部署清单」**。以下为常用命令速查：

```bash
cd openclaw-xgkb-sync
npm install
cp config.example.json config.json   # Windows: copy config.example.json config.json
# 编辑 config.json
npm run build
npm start                            # 生产：读取 ./config.json
```

```bash
# 指定配置文件
node dist/index.js --config /path/to/my-config.json

# 日志落盘（路径按系统调整）
node dist/index.js --config config.json --log-file /var/log/openclaw-xgkb-sync.log
# 或环境变量：OPENCLAW_SYNC_LOG_FILE=/var/log/openclaw-xgkb-sync.log

# 开发模式（改 TS 源码后需重启；无需先 build）
npm run dev
npm run dev:config                   # 显式使用 ./config.json
```

**npm scripts 说明**

| 命令 | 说明 |
|------|------|
| `npm run build` | 编译 TypeScript → `dist/` |
| `npm start` | 运行 `dist/index.js`（默认 `./config.json`） |
| `npm run start:config` | 同 `npm start`，显式 `--config config.json` |
| `npm run dev` | `ts-node` 直接运行源码（开发调试） |

---

## 配置参考

### 全局字段

| 字段 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `serverUrl` | 否 | `https://sg-al-cwork-web.mediportal.com.cn/open-api/` | 知识库 Open API 地址；省略时使用生产环境默认地址 |
| `appKey` | 否 | — | **玄关开放平台**签发的 Open API 密钥（个人/应用 `appKey`）；可省略或留空。单条 mapping 未单独配置 `appKey` 时使用此值；**通过管理 API 新建/更新 mapping 时，若此处为空则必须在请求体中为该条提供非空 `appKey`**（见 [docs/MANAGEMENT_API.md](./docs/MANAGEMENT_API.md)）。**全局与各 mapping 均无有效密钥时，同步会失败** |
| `syncDirection` | 否 | `bidirectional` | 全局同步方向：`bidirectional` / `push`（仅上传）/ `pull`（仅下载） |
| `autoSyncIntervalSec` | 否 | `180` | 自动同步间隔（秒），`0` = 关闭定时同步 |
| `stateDbPath` | 否 | `./openclaw-sync-state.db` | SQLite 状态库路径 |
| `maxConcurrentMappings` | 否 | `2` | 最大并发 mapping 数。多 mapping 场景建议调高，参考：[多实例与大规模部署](#多实例与大规模部署) |
| `maxRequestsPerMinute` | 否 | `60` | 每 appKey 每分钟最大请求数（令牌桶稳态速率）。每个 `appKey` 独立计算，互不干扰 |
| `rateLimitBurst` | 否 | `8` | 令牌桶突发容量，允许短时间内连续发出最多 N 个请求后再按稳态补充 |
| `rateLimitCooldownSec` | 否 | `60` | 收到限流响应（HTTP 429 或 resultCode 610012）后的冷却时间（秒） |
| `downloadConcurrency` | 否 | `5` | 单次同步中并发下载文件数 |
| `uploadConcurrency` | 否 | `3` | 单次同步中并发上传文件数 |
| `startupJitterMaxSec` | 否 | `20` | 启动后首次同步的随机抖动上限（秒）。多实例同时重启时分散请求，设为 `0` 禁用 |
| `managementPort` | 否 | `9090` | HTTP 管理 API 监听端口，设为 `0` 禁用管理 API |
| `managementHost` | 否 | `0.0.0.0` | HTTP 管理 API 监听地址；默认允许局域网访问，本机浏览器请用 `127.0.0.1`（注意防火墙） |

### 每条 Mapping 字段

| 字段 | 必填 | 说明 |
|------|------|------|
| `mappingId` | 是\* | 唯一标识，同一节点内不可重复。\*`POST /mappings` 请求体可省略，由服务端自动生成 |
| `localRoot` | 是 | 本地绝对目录路径 |
| `enabled` | 否 | 是否启用此映射，默认 `true` |
| `appKey` | 否\* | **玄关开放平台** Open API 密钥；填写后**优先于全局 `appKey`**。\***当根级全局 `appKey` 未配置时，通过管理 API 新建或更新后的本条 mapping 必须带非空 `appKey`**（见 [docs/MANAGEMENT_API.md](./docs/MANAGEMENT_API.md)） |
| `projectId` | 否 | 知识库空间 ID。不填则自动调用 `getPersonalProjectId` 获取个人空间 |
| `remoteRootFileId` | 否 | 远端根目录 fileId。 |
| `remoteRootFolderPath` | 否 | 远端根目录路径，如 `"OpenClaw/OutputA"`。**路径在远端不存在时会自动逐级创建**；不填表示同步 projectId 空间根目录 |
| `filePatterns` | 否 | 匹配文件的 glob 模式，默认同步常见文本、源码、工程配置、网页、脚本和结构化数据文件，如 `.md`、`.json`、`.txt`、`.html`、`.css`、`.js`、`.ts`、`.py`、`.go`、`.java`、`.rs`、`.yaml`、`.sql`、`Dockerfile`、`Makefile`、`.gitignore` 等 |
| `excludePatterns` | 否 | 排除文件的 glob 模式，默认排除冲突文件、临时目录、依赖目录、构建产物、版本库目录、`.env` 与常见密钥文件 |
| `syncDirection` | 否 | 单条 mapping 的同步方向，覆盖全局配置 |

### `remoteRootFileId` 与 `remoteRootFolderPath` 组合

| `remoteRootFileId` | `remoteRootFolderPath` | 行为 |
|---|---|---|
| 不填 | 不填 | 同步 `projectId` 空间**根目录**下所有匹配文件 |
| 不填 | 填路径 | 启动时自动解析路径 → fileId，路径不存在则自动创建；解析结果缓存到 SQLite |
| 填写 | 不填 | 使用指定 fileId，启动时通过 `batchGetMeta` 反向解析路径 |
| 填写 | 填路径 | 最优配置，零额外 API 调用 |

### 配置示例

```json
{
  "serverUrl": "https://sg-al-cwork-web.mediportal.com.cn/open-api/",
  "appKey": "global-app-key",
  "syncDirection": "bidirectional",
  "autoSyncIntervalSec": 120,
  "maxConcurrentMappings": 5,
  "managementPort": 9090,
  "managementHost": "0.0.0.0",
  "mappings": [
    {
      "mappingId": "user-alice",
      "enabled": true,
      "localRoot": "/sandboxes/alice/workspace",
      "appKey": "alice-personal-app-key",
      "remoteRootFolderPath": "AgentOutput/Alice",
      "syncDirection": "push"
    }
  ]
}
```

---

## HTTP 管理 API

服务启动后，内置 HTTP 管理接口可供运维与自动化使用。**完整契约（参数、返回值、必填/默认、错误码、给 AI 的决策表）**见 **[docs/MANAGEMENT_API.md](./docs/MANAGEMENT_API.md)**；以下仅为速查与常用示例。

### 接口一览

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/health` | 存活探针，返回版本、PID、uptime、mapping 数量 |
| `GET` | `/status` | 详细状态：所有 mapping 的同步时间、是否正在同步、上次错误 |
| `GET` | `/config` | 全局配置摘要（不含 appKey 明文） |
| `PUT` | `/config` | 部分更新全局配置，自动写入并热重载 |
| `GET` | `/mappings` | 列出所有 mapping 配置摘要（appKey 字段不回显） |
| `POST` | `/mappings` | 新增一条 mapping，**自动写入 config.json 并热重载** |
| `PUT` | `/mappings/:mappingId` | 更新指定 mapping，自动写入并热重载 |
| `DELETE` | `/mappings/:mappingId` | 删除指定 mapping，自动写入并热重载 |
| `POST` | `/sync` | 立即触发**所有** mapping 同步 |
| `POST` | `/sync/:mappingId` | 立即触发**指定** mapping 同步 |
| `POST` | `/reload` | 手动热重载 `config.json` |
| `GET` | `/` | **管理控制台**（内置 Web UI，见下文） |

### 管理控制台（Web UI）

服务启动后，在浏览器打开：

```
http://127.0.0.1:9090/
```

（若 `managementHost` 为 `0.0.0.0`，本机访问时用 `127.0.0.1` 或实际 IP；端口以 `config.json` 中 `managementPort` 为准。）

控制台提供：

- **同步映射**：列表展示、新增、编辑、删除、单条触发同步
- **全局配置**：serverUrl、同步方向、自动间隔、限速等（AppKey 不回显，需输入新值才会覆盖）
- **运行状态**：各 mapping 同步进度、上次成功/错误时间
- 工具栏：**全部同步**、**重载配置**、**刷新**

> 管理 API 当前无 HTTP 鉴权；默认监听 `0.0.0.0`，请勿在公网暴露，并做好防火墙隔离。

### 常用命令

```bash
# 查看服务健康状态和版本
curl http://10.0.0.5:9090/health

# 列出所有 mapping
curl http://10.0.0.5:9090/mappings

# 新增一条 mapping（写入 config.json 并立即生效）
curl -X POST http://10.0.0.5:9090/mappings \
  -H "Content-Type: application/json" \
  -d '{
    "mappingId": "user-bob",
    "localRoot": "/sandboxes/bob/workspace",
    "appKey": "bob-personal-app-key",
    "remoteRootFolderPath": "AgentOutput/Bob",
    "syncDirection": "push"
  }'

# 修改 mapping 配置（部分更新，只传要改的字段，其余字段保持原值）

# 仅禁用（不影响其他字段）
curl -X PUT http://10.0.0.5:9090/mappings/user-bob \
  -H "Content-Type: application/json" \
  -d '{ "enabled": false }'

# 仅修改同步方向
curl -X PUT http://10.0.0.5:9090/mappings/user-bob \
  -H "Content-Type: application/json" \
  -d '{ "syncDirection": "push" }'

# 清空 remoteRootFolderPath（传空字符串即可，其他字段不受影响）
curl -X PUT http://10.0.0.5:9090/mappings/user-bob \
  -H "Content-Type: application/json" \
  -d '{ "remoteRootFolderPath": "" }'

# 删除一条 mapping
curl -X DELETE http://10.0.0.5:9090/mappings/user-bob

# 手动触发某个 mapping 立即同步
curl -X POST http://10.0.0.5:9090/sync/user-alice

# 触发所有 mapping 立即同步
curl -X POST http://10.0.0.5:9090/sync
```

### 热重载说明

调用 `/reload` 时，服务内部执行：

1. 重新读取磁盘上的 `config.json`
2. 停止当前调度器（清理定时器，不影响正在进行中的同步）
3. 用新配置启动新调度器
4. HTTP 管理服务全程不停机，对调用方透明

> **注意**：`managementPort` 和 `managementHost` 在热重载中**不会**生效，这两个字段需要重启进程才能变更。

---

## 生产部署建议

程序仅向 **stdout/stderr** 打日志，不配置时不会自动生成日志文件。

**日志收集方式（四选一）：**

1. **systemd + journald（推荐 Linux）**
   `journalctl -u openclaw-xgkb-sync -f`，无需改命令行。

2. **launchd + 标准输出文件（推荐 macOS）**
   使用 `StandardOutPath` / `StandardErrorPath`，或使用下文「macOS 部署」中的 `--log-file` 与 plist 示例。

3. **本进程双写**
   设置 `OPENCLAW_SYNC_LOG_FILE` 环境变量或 `--log-file` 参数，控制台与文件同时输出。

4. **Shell 重定向**
   `node dist/index.js >> /var/log/app.log 2>&1`（路径按系统调整，macOS 可写到 `~/Library/Logs/`）

**systemd 服务示例：**

```ini
[Unit]
Description=OpenClaw XGKB Sync Agent
After=network.target

[Service]
WorkingDirectory=/opt/openclaw-xgkb-sync
ExecStart=/usr/bin/node dist/index.js --config /opt/openclaw-xgkb-sync/config.json
Environment=OPENCLAW_SYNC_LOG_FILE=/var/log/openclaw-xgkb-sync.log
Restart=on-failure
RestartSec=10
User=openclaw

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now openclaw-xgkb-sync
journalctl -u openclaw-xgkb-sync -f
```

### macOS 部署

与 Linux 相同，本项目为纯 Node.js 进程，**无需 Xcode 或原生编译 SQLite**。在 Mac 上按下面步骤即可常驻运行。

#### 1. 安装 Node.js

任选其一（建议 LTS，且满足 `>= 18`）：

- [Node.js 官网](https://nodejs.org/) 安装包
- [Homebrew](https://brew.sh/)：`brew install node`
- [nvm](https://github.com/nvm-sh/nvm)：`nvm install 20 && nvm use 20`

在终端执行 `node -v` 确认版本。

#### 2. 安装依赖、构建与本地运行

```bash
cd /path/to/openclaw-xgkb-sync
npm install
cp config.example.json config.json
# 编辑 config.json：mappings[].localRoot 请使用绝对路径，例如 /Users/你的用户名/workspace
npm run build
npm start
# 或指定配置
node dist/index.js --config /path/to/config.json
```

日志可选：`--log-file "$HOME/Library/Logs/openclaw-xgkb-sync.log"` 或环境变量 `OPENCLAW_SYNC_LOG_FILE`（与 Linux 说明一致）。

#### 3. 登录时自动启动（launchd，推荐）

使用用户级 LaunchAgent，无需 root。先确认本机 Node 路径（Apple Silicon 常见为 `/opt/homebrew/bin/node`，Intel 常见为 `/usr/local/bin/node`）：

```bash
which node
```

在 `~/Library/LaunchAgents/com.openclaw.xgkb-sync.plist` 写入（请把 `YOUR_USER`、`项目目录`、`node 路径` 改成你的实际值）：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.openclaw.xgkb-sync</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>/Users/YOUR_USER/path/to/openclaw-xgkb-sync/dist/index.js</string>
    <string>--config</string>
    <string>/Users/YOUR_USER/path/to/openclaw-xgkb-sync/config.json</string>
    <string>--log-file</string>
    <string>/Users/YOUR_USER/Library/Logs/openclaw-xgkb-sync.log</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/Users/YOUR_USER/path/to/openclaw-xgkb-sync</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/Users/YOUR_USER/Library/Logs/openclaw-xgkb-sync.stdout.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/YOUR_USER/Library/Logs/openclaw-xgkb-sync.stderr.log</string>
</dict>
</plist>
```

加载与查看状态：

```bash
launchctl load ~/Library/LaunchAgents/com.openclaw.xgkb-sync.plist
# 修改 plist 后需 unload 再 load
launchctl unload ~/Library/LaunchAgents/com.openclaw.xgkb-sync.plist
launchctl load ~/Library/LaunchAgents/com.openclaw.xgkb-sync.plist
```

取消开机自启：`launchctl unload ~/Library/LaunchAgents/com.openclaw.xgkb-sync.plist` 后删除该 plist 即可。

#### 4. 管理 API 与防火墙

默认 `managementHost` 为 `0.0.0.0`（监听所有网卡）。本机调试：

```bash
curl http://127.0.0.1:9090/health
```

若需限制仅本机访问，将 `managementHost` 改为 `127.0.0.1` 并重启进程。使用 `0.0.0.0` 时，请在 **系统设置 → 网络 → 防火墙** 中按需放行对应端口。

> `config.json` 含密钥，勿提交仓库；生产路径与文件权限按安全规范收紧。

### Windows 部署

与 Linux/macOS 相同，纯 Node.js 进程，**无需 Visual Studio 或 native 编译**。

#### 1. 安装 Node.js

从 [Node.js 官网](https://nodejs.org/) 安装 LTS（>= 18），PowerShell 执行 `node -v` 确认。

#### 2. 安装、配置、运行

```powershell
cd D:\path\to\openclaw-xgkb-sync
npm install
Copy-Item config.example.json config.json
# 用编辑器修改 config.json（见下方路径说明）
npm run build
npm start
```

**Windows 路径写法（`config.json` 内）**

- `localRoot` 必须为**绝对路径**
- JSON 中**推荐正斜杠**：`"C:/Users/Alice/.openclaw/workspace/out"`
- 若用反斜杠，每个 `\` 须写成 `\\`：`"C:\\Users\\Alice\\out"`

**最小可运行 mapping 示例（Windows）**

```json
{
  "serverUrl": "https://sg-al-cwork-web.mediportal.com.cn/open-api/",
  "appKey": "your-app-key",
  "syncDirection": "bidirectional",
  "autoSyncIntervalSec": 120,
  "managementPort": 9090,
  "managementHost": "0.0.0.0",
  "mappings": [
    {
      "mappingId": "my-workspace",
      "enabled": true,
      "localRoot": "C:/Users/Alice/.openclaw/workspace",
      "remoteRootFolderPath": "OpenClaw/Alice"
    }
  ]
}
```

#### 3. 开机自启（可选）

可用 **任务计划程序** 创建「登录时运行」任务：

- 程序：`C:\Program Files\nodejs\node.exe`（以 `where node` 为准）
- 参数：`dist\index.js --config D:\path\to\config.json`
- 起始于：项目根目录 `D:\path\to\openclaw-xgkb-sync`

或使用 [nssm](https://nssm.cc/) 注册为 Windows 服务。

#### 4. 验证与管理

```powershell
curl.exe http://127.0.0.1:9090/health
# 浏览器打开管理控制台
start http://127.0.0.1:9090/
```

> PowerShell 中 `curl` 默认是 `Invoke-WebRequest` 的别名，HTTP 调试请用 **`curl.exe`**。

---

## 常见问题（排错）

| 现象 | 可能原因 | 处理 |
|------|----------|------|
| 启动报「配置文件不存在」 | 旧版本行为；当前版本会自动生成默认 `config.json` | 重启服务，或手动 `cp config.example.json config.json` |
| 启动报配置校验失败 | mapping 条目字段错误（如缺 `localRoot`） | 对照「配置参考」；空 `{}` 会自动回填默认全局配置 |
| `POST /mappings` 返回 400 + `MAPPING_APPKEY_REQUIRED_WHEN_NO_GLOBAL_APPKEY` | 全局与各 mapping 均无有效 AppKey | 在全局或该条 mapping 填写非空 `appKey` |
| 同步失败 / `lastError` 含 401 / 鉴权 | AppKey 错误或过期 | 在玄关开放平台核对密钥 |
| 同步失败 / 限流 429 或 610012 | API 调用过频 | 降低 `maxRequestsPerMinute` 或增大 `autoSyncIntervalSec` |
| 本地文件未上传 | `enabled: false`、方向为 `pull`、或路径不匹配 `filePatterns` | 检查 mapping 配置与 `filePatterns` |
| 管理控制台打不开 | 端口被占用、`managementPort: 0`、或防火墙拦截 | 查启动日志端口；本机用 `127.0.0.1` 访问 |
| 修改 `managementPort` / `managementHost` 不生效 | 这两项需**重启进程**才改变监听 | 停止后重新 `npm start` |
| PowerShell 下 curl 异常 | 别名冲突 | 使用 `curl.exe` |

**日志位置**：默认仅输出到控制台；可通过 `--log-file` 或 `OPENCLAW_SYNC_LOG_FILE` 落盘（见「生产部署建议」）。

---

## 多实例与大规模部署

### 多台服务器同步同一知识库

- **共用 appKey 时**：三台服务器共享同一 appKey 的限流额度，建议将 `maxRequestsPerMinute` 设为 `总限额 ÷ 实例数`（如限额 120，三台各配 `40`）
- **各用独立 appKey 时**：每台均可配满 `maxRequestsPerMinute`，互不干扰
- 保持 `startupJitterMaxSec` 默认值（20s），分散多实例同时重启时的请求突刺

### 数百个 Mapping 场景

适用于云端部署多个个人助理 Agent、每个 Agent 对应一位用户知识库的场景：

- 每个 mapping 配置独立 `appKey`（用户各自的密钥），限速器按 appKey 独立管理
- 调高 `maxConcurrentMappings`（建议 10～20），提升并发吞吐
- 增量模式下若本地和远端均无变化，决策阶段会被完全跳过，单轮同步仅需几毫秒
- `autoSyncIntervalSec` 建议设为 `120` 或以上，给每轮完整扫描留足时间

---

## 环境要求

- Node.js >= 18（使用内置 `fetch`）
- SQLite 通过 `node-sqlite3-wasm`（WebAssembly）提供，**无需 Visual Studio 或 native 编译工具**
- 网络可访问 `config.json` 中的 `serverUrl`（知识库 Open API）

## 仓库结构（供 AI 定位代码）

```
openclaw-xgkb-sync/
├── config.example.json   # 配置模板（复制为 config.json）
├── config.json           # 本地配置（gitignore，含密钥）
├── public/               # Web 管理控制台静态文件
│   ├── index.html
│   └── static/
├── src/
│   ├── index.ts          # 进程入口
│   ├── managementApi.ts  # HTTP 管理 API + 静态页面服务
│   ├── scheduler.ts      # 定时调度
│   └── syncEngine.ts     # 同步引擎
├── docs/
│   ├── MANAGEMENT_API.md # HTTP API 完整契约
│   └── DESIGN.md         # 架构设计
└── dist/                 # npm run build 输出（勿手改）
```
