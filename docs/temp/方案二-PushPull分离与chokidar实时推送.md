# 方案二：Push/Pull 分离 + chokidar 实时推送

## 一、背景

当前同步服务依赖定时轮询，间隔难以平衡：
- 间隔长 → 同步不及时
- 间隔短 → 本地扫描压力大 + 知识库 API 压力大

仅推送（push）场景下，文件变更源在本地，可以用文件系统监听替代轮询，实现近实时同步。

## 二、行业案例

此方案为文件同步领域的行业标准做法：

| 产品 | 监听方式 | 兜底机制 |
|------|---------|---------|
| Dropbox | inotify / FSEvents / ReadDirectoryChangesW | 定期全量扫描 |
| Syncthing | 文件系统监听 | 定期全量扫描 |
| Nextcloud Client | inotify / FSEvents | 定期全量扫描 |
| VS Code Remote | chokidar | - |
| Obsidian Sync | 文okidar | 定期全量扫描 |

核心模式统一：**文件系统监听做实时推送 + 定期全量扫描做兜底**。

## 三、方案设计

### 3.1 架构总览

```
┌─ Push 循环（自动，用户无需配置）──────────────────┐
│                                                   │
│  chokidar 监听 → debounce 队列 → 批量上传         │
│  定时全量兜底（固定 30 分钟，不可配）                │
│                                                   │
└───────────────────────────────────────────────────┘
         │  共享互斥锁（per mappingId）
         ▼
┌─ Pull 循环（用户配置周期）────────────────────────┐
│                                                   │
│  定时拉取（autoSyncIntervalSec 控制）               │
│  写入文件时注册 ignoreSet 防止误触发 push           │
│                                                   │
└───────────────────────────────────────────────────┘
```

### 3.2 核心原则

- **Push 完全自动**：chokidar 监听 + 全量兜底，用户无需关心推送时机
- **Pull 用户可控**：通过 `autoSyncIntervalSec` 配置拉取频率
- **Push/Pull 互斥**：同一 mapping 同一时间只有一个方向在执行

### 3.3 配置变化

```typescript
export interface SyncConfig {
  // ... 现有字段

  /**
   * 拉取间隔（秒）。仅控制 pull 频率，push 由 chokidar 自动驱动。
   * 原来的 autoSyncIntervalSec 语义从"双向同步间隔"变为"拉取间隔"。
   */
  autoSyncIntervalSec: number;

  /**
   * push 防抖时间（毫秒），默认 1500。
   * 编辑器保存可能触发多次 write，防抖窗口内合并为一次批量上传。
   */
  pushDebounceMs?: number;

  /**
   * push 全量兜底间隔（秒），默认 1800（30 分钟），不可配置。
   * 用于发现 chokidar 可能遗漏的变更（如 Docker 挂载场景）。
   */
  // pushFullReconcileIntervalSec = 1800（内置常量，不暴露配置）
}
```

**配置语义变化**：

| 字段 | 原来 | 现在 |
|------|------|------|
| `autoSyncIntervalSec` | 双向同步间隔 | 仅控制 pull 频率 |
| `fullReconcileIntervalSec` | 双向全量对账间隔 | 仅控制 pull 全量对账 |
| `pushDebounceMs`（新增） | - | push 防抖，默认 1500ms |

## 四、碰撞处理

### 4.1 碰撞场景

| 场景 | 描述 | 风险 |
|------|------|------|
| 场景1 | push 和 pull 同时触发 | 数据竞争 |
| 场景2 | pull 写本地文件 → chokidar 误触发 push | 白跑一轮 API |
| 场景3 | push 和 pull 同时操作同一文件 | 文件内容不一致 |

### 4.2 解决方案：mapping 级互斥锁

现有代码已有 `MappingRunState.isSyncing` 串行机制。分离后改造为 push/pull 共享一把锁：

```typescript
interface MappingRunState {
  lockHolder: 'push' | 'pull' | null;
  pendingAction: 'push' | 'pull' | null;
  ignoreSet: Set<string>;   // pull 写入的文件路径，chokidar 过滤用
}
```

**互斥逻辑**：

```
push 入口 ──┐
             ├── 共享锁（per mappingId）── 执行
pull 入口 ──┘

谁先拿到谁先跑，另一个排队（pending）
跑完后检查 pending，自动触发挂起的那个
```

### 4.3 场景2 的关键处理：ignoreSet

pull 写入文件时，chokidar 会监听到 write 事件，误以为用户修改了文件，触发无意义的 push。

```
pull 执行前：
  1. 收集即将下载的文件路径列表（从远端变更列表可知）
  2. 注册到 ignoreSet

pull 执行中：
  写入文件 → chokidar 监听到 → 查 ignoreSet → 命中 → 丢弃

pull 完成后：
  清空 ignoreSet
```

这是最关键的细节，不加这层过滤会导致 push/pull 反复互相触发。

### 4.4 水位共享

bidirectional 模式下，push 和 pull 共享同一个 `mapping_state.lastSyncSince` 水位：

- push 推完后更新水位 → pull 拉取时跳过已处理的变更
- pull 拉完后更新水位 → push 全量兜底时跳过已同步的文件

避免重复处理。

## 五、Push 流程详解

### 5.1 chokidar 监听

```typescript
// watcher.ts 伪代码
const watcher = chokidar.watch(localRoot, {
  ignored: excludePatterns,
  ignoreInitial: true,        // 不触发已有文件
  awaitWriteFinish: {
    stabilityThreshold: 300,  // 文件 300ms 不变视为写入完成
    pollInterval: 100
  },
  usePolling: false           // 优先 OS 原生事件
});

const pendingPaths = new Set<string>();
let debounceTimer: NodeJS.Timeout | null = null;

watcher.on('all', (event, filePath) => {
  // 过滤：ignoreSet + filePatterns + 排除映射文件
  if (ignoreSet.has(relativePath)) return;
  if (!matchesSync(relativePath)) return;

  pendingPaths.add(relativePath);

  // debounce：1.5s 内的变更合并为一次批量上传
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    const batch = [...pendingPaths];
    pendingPaths.clear();
    doPushBatch(batch);  // 获取锁 → 批量上传
  }, pushDebounceMs);
});
```

### 5.2 批量上传

```
doPushBatch(filePaths)
  ↓
获取互斥锁（push）
  ↓ 已被 pull 占用？→ 排队等待
逐文件处理：
  1. 读本地内容
  2. 查 SQLite 有无 remoteFileId
     有 → uploadContent(updateFileId=xxx)
     无 → uploadContent(folderName=xxx)
  3. 更新 SQLite
释放锁 → 检查 pending pull
```

### 5.3 全量兜底

固定 30 分钟一次，复用现有 `runSync` 的全量对账逻辑。目的：
- 发现 chokidar 遗漏的变更（Docker 挂载、网络文件系统等场景）
- 校验 SQLite 和远端的一致性

## 六、Pull 流程详解

和现有 `runSync` 的 pull 逻辑基本一致，改动点：

1. 执行前注册 ignoreSet
2. 通过互斥锁与 push 互斥
3. 完成后清空 ignoreSet

## 七、边界情况处理

### 7.1 编辑器频繁写入

VS Code 保存一个文件可能触发 2~3 次 write 事件。通过 `awaitWriteFinish` + debounce 双重合并解决。

### 7.2 首次启动

chokidar 的 `ready` 事件前会爆出大量 `add` 事件。处理方式：
- `ignoreInitial: true` 跳过初始扫描
- 启动时做一次全量同步（复用现有逻辑）
- chokidar 只处理 ready 之后的新增变更

### 7.3 目录移动/重命名

chokidar 对目录 rename 的 raw 事件比较乱（可能表现为子文件逐个 delete + add）。处理方式：
- 目录级事件加短窗口聚合（100ms）
- 窗口内同一 inode 的 delete + add 配对识别为 rename
- 未配对的退化走全量兜底

### 7.4 Docker / 网络文件系统

inotify 无法穿透 NFS 或某些 Docker 存储驱动。处理方式：
- chokidar 的 `usePolling: true` 回退为轮询模式（性能降低但可用）
- 全量兜底 30 分钟一次保证最终一致性
- 配置中可加 `watcher.usePolling` 开关让用户选择

### 7.5 文件数量极大时

chokidar 监听大量文件时内存占用会增加（每个 watcher 约 800 字节）。10 万文件约 80MB，可接受。超过 50 万文件时建议关闭 chokidar，仅用定时全量。

## 八、依赖

```json
{
  "dependencies": {
    "chokidar": "^4.0.0"
  }
}
```

chokidar npm 周下载量 3500 万+，Node.js 文件监听的事实标准库。

## 九、改动评估

| 改动点 | 内容 | 代码量 |
|--------|------|--------|
| 新增 watcher.ts | chokidar 封装 + debounce + ignoreSet 过滤 | ~120行 |
| scheduler.ts | 拆为 push 调度 + pull 调度，共享互斥锁 | ~80行 |
| syncEngine.ts | push 和 pull 路径分离，ignoreSet 注册/清理 | ~60行 |
| types.ts | 配置字段新增 | ~15行 |
| package.json | 加 chokidar 依赖 | 1行 |

**总计约 275 行新增/修改**。

## 十、与方案一的兼容性

两个方案互不冲突，可以独立实施：
- 方案一（映射文件）解决的是数据查询问题
- 方案二（push/pull 分离）解决的是同步时效性问题

建议先实施方案二（时效性需求更迫切），再实施方案一。

## 十一、风险与待确认项

1. **Docker 环境 inotify 支持情况**：需确认实际部署环境的存储驱动是否支持
2. **chokidar 内存占用**：文件数超过 10 万时需关注
3. **push/pull 互斥导致延迟**：pull 执行期间 push 排队，最长等待 = pull 单次耗时。pull 耗时需控制
4. **autoSyncIntervalSec 语义变化**：升级时需注意文档说明，避免用户困惑
