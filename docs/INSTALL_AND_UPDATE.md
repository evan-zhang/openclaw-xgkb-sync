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

## 二、首次安装（约 5 分钟）

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

### 3. 创建配置文件

**Linux / macOS：**

```bash
cp config.example.json config.json
```

**Windows（PowerShell）：**

```powershell
Copy-Item config.example.json config.json
```

**Windows（CMD）：**

```cmd
copy config.example.json config.json
```

> 若跳过此步，首次启动也会自动生成默认 `config.json`，但仍需自行填写 AppKey 与 mapping。

### 4. 编辑 `config.json`（至少完成以下项）

| 字段 | 说明 |
|------|------|
| `appKey` | 玄关 Open API 密钥（全局）；或在每条 `mappings[].appKey` 单独配置 |
| `mappings[].mappingId` | 映射唯一 ID |
| `mappings[].localRoot` | 本地目录**绝对路径** |
| `mappings[].remoteRootFolderPath` | 知识库内远端路径，如 `宋培众/0518` |
| `mappings[].enabled` | 设为 `true` 才会参与同步 |

`serverUrl` 可省略，默认使用生产环境地址。

### 5. 编译并启动

**生产运行（推荐）：**

```bash
npm run build
npm start
```

**开发调试（改 TS 源码后需重启，无需先 build）：**

```bash
npm run dev
```

指定配置文件路径：

```bash
node dist/index.js --config D:\path\to\config.json
```

### 6. 验证安装成功

控制台应出现类似：

- `[OpenClaw Sync] 服务已启动`
- `[ManagementApi] 已启动，监听 http://0.0.0.0:9090`

**健康检查：**

```bash
curl http://127.0.0.1:9090/health
```

Windows 若 `curl` 异常，使用：

```powershell
curl.exe http://127.0.0.1:9090/health
```

期望返回 JSON 且 `"ok": true`。

**Web 控制台：** 浏览器打开 <http://127.0.0.1:9090/>，在「同步映射」中确认 mapping 已配置，点击「全部同步」测试。

---

## 三、已有环境更新

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
| 热重载配置（若只改了 config） | `POST http://127.0.0.1:9090/reload` 或控制台「重载配置」 |
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

## 四、Windows 一键速查

```powershell
# 首次安装
git clone https://github.com/xgjk/openclaw-xgkb-sync.git
cd openclaw-xgkb-sync
npm install
Copy-Item config.example.json config.json
# 用编辑器修改 config.json
npm run build
npm start

# 更新
cd openclaw-xgkb-sync
# 先停止正在运行的 npm run dev / npm start
git pull
npm install
npm run build
npm start
```

---

## 五、后台常驻（可选）

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

## 六、常见问题

| 现象 | 处理 |
|------|------|
| `node -v` 低于 18 | 安装 Node 18+ LTS |
| 启动报 `no such column: local_ino` | 使用最新代码并重启；旧库会自动迁移列 |
| `mappingCount: 0` | 在 `config.json` 或 Web 控制台添加至少一条 mapping |
| 同步失败 / AppKey | 确认全局或 mapping 级 `appKey` 非空 |
| 更新后行为异常 | 查看控制台 `[KbApi] request#` 日志；必要时 `POST /reload` |
| 端口 9090 被占用 | 修改 `config.json` 中 `managementPort` 后重启 |

更多排错见 [README.md § 常见问题](../README.md)。

---

## 七、相关文档

- [README.md](../README.md) — 功能说明与配置参考
- [MANAGEMENT_API.md](./MANAGEMENT_API.md) — HTTP API（脚本/自动化）
- [config.example.json](../config.example.json) — 配置模板
