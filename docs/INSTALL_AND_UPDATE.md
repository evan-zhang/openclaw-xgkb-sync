# openclaw-xgkb-sync 安装与更新指南

仓库地址：<https://github.com/xgjk/openclaw-xgkb-sync>

本文面向**首次安装**与**已有环境升级**，按步骤操作即可。配置细节见 [README.md](../README.md)、[config.example.json](../config.example.json)。

---

## 一、环境要求

| 项目 | 要求 |
|------|------|
| Node.js | **>= 18**（`node -v` 检查） |
| npm | 随 Node 自带 |
| Git | 用于克隆与更新 |
| 网络 | 能访问知识库 Open API 地址 |

---

## 二、首次安装（约 3 分钟）

安装阶段**无需**填写 AppKey、本地路径或任何 mapping。克隆、安装依赖、启动即可；所有业务配置在 **Web 管理控制台** 中完成。

### 1. 克隆仓库

```bash
git clone https://github.com/xgjk/openclaw-xgkb-sync.git
cd openclaw-xgkb-sync
```

Windows PowerShell 示例：

```powershell
git clone https://github.com/xgjk/openclaw-xgkb-sync.git
cd openclaw-xgkb-sync
```

### 2. 安装依赖

```bash
npm install
```

### 3. 编译并启动

**生产运行（推荐）：**

```bash
npm run build
npm start
```

**开发调试（改 TS 源码后需重启，无需先 build）：**

```bash
npm run dev
```

指定配置文件路径（可选，默认 `./config.json`）：

```bash
node dist/index.js --config D:\path\to\config.json
```

> **关于 `config.json`**  
> - 首次启动时若不存在，服务会**自动生成**默认 `config.json`（含全局默认值、`mappings: []`，**不含** AppKey）。  
> - **不必**手动 `cp config.example.json config.json`；若你已有自定义 `config.json`，启动时会保留其中已填内容。  
> - 控制台若出现 `请在 Web 控制台补充 AppKey 与同步映射`，表示已进入「零配置安装」模式，属正常现象。

### 4. 验证服务已启动

控制台应出现类似：

- `[OpenClaw Sync] 服务已启动`
- `[ManagementApi] 已启动，监听 http://0.0.0.0:9090`
- `[OpenClaw Sync] mapping 数量: 0（已启用: 0）`（首次安装时 mapping 为空是正常的）

**健康检查：**

```bash
curl http://127.0.0.1:9090/health
```

Windows 若 `curl` 异常，使用：

```powershell
curl.exe http://127.0.0.1:9090/health
```

期望返回 JSON 且 `"ok": true`。

---

## 三、首次配置（Web 管理控制台）

浏览器打开 **<http://127.0.0.1:9090/>**（若 `managementHost` 为 `0.0.0.0`，本机请用 `127.0.0.1`）。

### 1. 全局配置（「全局配置」标签页）

| 步骤 | 操作 |
|------|------|
| 知识库 API 地址 | 默认已填生产环境地址；私有部署时再改 `serverUrl` |
| 全局 AppKey | 填写玄关 Open API 密钥，点击 **「保存配置」** |
| 同步方向 / 间隔等 | 按需调整（默认双向、180 秒自动同步），保存后**立即热重载** |

> AppKey 保存后在页面上以脱敏形式显示；要更换密钥需重新输入完整值再保存。

### 2. 新增同步映射（「同步映射」标签页）

点击 **「新增映射」**，至少填写：

| 字段 | 说明 |
|------|------|
| 映射 ID | 可留空由系统自动生成，或自行指定唯一 ID |
| 本地根目录 | 本地目录**绝对路径**（Agent 工作区） |
| 远端目录路径 | 知识库内路径，如 `宋培众/0518` |
| AppKey | 若未配置全局 AppKey，**本条 mapping 必须填写**独立 AppKey |
| 启用 | 勾选后才会参与同步 |

保存 mapping 后配置会写入 `config.json` 并**自动热重载**，一般无需重启进程。

### 3. 试跑同步

- 在 mapping 卡片上点击 **「同步」**，或工具栏 **「全部同步」**
- 切换到 **「运行状态」** 查看 `lastSuccessAt`、错误信息、统计摘要

### 4. 可选：仍用手动编辑 `config.json`

Web 控制台与管理 API 的修改都会写回 `config.json`。高级用户可直接编辑文件后，在控制台点击 **「重载配置」** 或调用 `POST /reload`。  
模板参考：[config.example.json](../config.example.json)。

---

## 四、已有环境更新

更新代码时**不要覆盖**本地 `config.json` 和 SQLite 状态库（默认 `./openclaw-sync-state.db`），否则会丢失密钥与同步水位。

### 标准更新流程

```bash
# 1. 进入项目目录
cd openclaw-xgkb-sync

# 2. 若服务在运行，先停止（Ctrl+C 或结束对应进程）

# 3. 拉取最新代码
git pull origin main
# 若默认分支为 master，改为：git pull origin master

# 4. 安装可能新增的依赖
npm install

# 5. 重新编译
npm run build

# 6. 启动
npm start
```

### 更新后建议检查

| 检查项 | 命令 / 操作 |
|--------|-------------|
| 服务存活 | `curl http://127.0.0.1:9090/health` |
| 配置仍有效 | Web 控制台「同步映射」或 `GET /mappings` |
| 热重载配置（若只改了 config） | 控制台「重载配置」或 `POST /reload` |
| 试跑同步 | 控制台「全部同步」或 `POST /sync` |

> 升级后**首次同步**可能触发一次全量对账（略慢），属正常现象。大目录可在低峰期更新。

### 若 `git pull` 有本地修改冲突

```bash
# 查看状态
git status

# 仅保留本地 config（勿提交密钥）
# 可先备份再拉取
copy config.json config.json.bak          # Windows
cp config.json config.json.bak            # Linux/macOS

git stash push -m "local" -- config.json  # 可选：暂存 config
git pull
git stash pop                             # 若有 stash
```

`config.json` 已在 `.gitignore` 中，一般不会被 `git pull` 覆盖；冲突多出现在你改过仓库内其他文件时。

---

## 五、Windows 一键速查

```powershell
# 首次安装（无需事先编辑 config.json）
git clone https://github.com/xgjk/openclaw-xgkb-sync.git
cd openclaw-xgkb-sync
npm install
npm run build
npm start
# 浏览器打开 http://127.0.0.1:9090/ → 全局配置填 AppKey → 新增映射 → 同步

# 更新
cd openclaw-xgkb-sync
# 先停止正在运行的 npm run dev / npm start
git pull
npm install
npm run build
npm start
```

---

## 六、后台常驻（可选）

本仓库未内置 systemd/PM2 配置，可按环境自选：

**PM2 示例：**

```bash
npm run build
pm2 start dist/index.js --name openclaw-xgkb-sync -- --config config.json
pm2 save
```

更新时：

```bash
git pull && npm install && npm run build
pm2 restart openclaw-xgkb-sync
```

**日志落盘（默认已开启）：**

启动后自动写入项目下 `logs/openclaw-sync-YYYY-MM-DD.log`（与控制台同时输出，便于排查 KB 接口参数）。

```bash
# 自定义路径
node dist/index.js --config config.json --log-file ./logs/my-test.log

# 仅控制台、不写文件
node dist/index.js --no-log-file
```

环境变量：`OPENCLAW_SYNC_LOG_FILE=./logs/custom.log`（优先级高于默认路径，低于 `--log-file`）

---

## 七、常见问题

| 现象 | 处理 |
|------|------|
| `node -v` 低于 18 | 安装 Node 18+ LTS |
| 启动报 `no such column: local_ino` | 使用最新代码并重启；旧库会自动迁移列 |
| `mapping 数量: 0` | **首次安装正常**；在 Web 控制台「新增映射」 |
| 同步失败 / AppKey | 在「全局配置」或 mapping 中填写有效 AppKey 并保存 |
| `POST /mappings` 报 AppKey 必填 | 全局与各 mapping 均无 AppKey 时无法创建 mapping；至少填一处 |
| 更新后行为异常 | 查看 `logs/` 下 `[KbApi] request#` 日志；必要时点击「重载配置」 |
| 端口 9090 被占用 | 在「全局配置」改 `managementPort` 后**重启进程**（该字段需重启才生效） |
| 改了 `config.json` 未生效 | 控制台「重载配置」或 `POST /reload`（`managementPort` / `managementHost` 除外，需重启） |

更多排错见 [README.md § 常见问题](../README.md)。

---

## 八、相关文档

- [README.md](../README.md) — 功能说明与配置参考
- [MANAGEMENT_API.md](./MANAGEMENT_API.md) — HTTP API（脚本/自动化）
- [config.example.json](../config.example.json) — 配置字段说明（模板，安装时可不复制）
