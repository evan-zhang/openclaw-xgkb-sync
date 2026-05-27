import * as fs from 'fs';
import * as path from 'path';
import chokidar, { FSWatcher } from 'chokidar';
import micromatch from 'micromatch';
import {
  FILE_INDEX_NAME,
  WATCH_AWAIT_WRITE_POLL_MS,
  WATCH_AWAIT_WRITE_STABILITY_MS,
  WATCH_PULL_IGNORE_TAIL_MS,
} from './constants';
import { canonicalizeRelativeSyncPath, normalizeSeparator } from './pathSanitize';

export interface FileWatcherOptions {
  mappingId: string;
  localRoot: string;
  filePatterns: string[];
  excludePatterns: string[];
  debounceMs: number;
  usePolling: boolean;
  onBatchReady: (pathCount: number) => void;
}

/**
 * mapping 级 chokidar 封装：debounce 合并变更，sync 期间 pause，pull 写入 echo 过滤。
 * 硬排除 `.openclaw-sync-map.json`（方案一索引 consume 写入，避免误触发 push）。
 */
export class FileWatcher {
  private readonly opts: FileWatcherOptions;
  private readonly ignoreSet = new Set<string>();
  private watcher: FSWatcher | null = null;
  private pendingPaths = new Set<string>();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private ignoreTailTimer: ReturnType<typeof setTimeout> | null = null;
  private paused = false;
  private started = false;

  constructor(opts: FileWatcherOptions) {
    this.opts = opts;
  }

  start(): void {
    if (this.started) return;

    const { localRoot, filePatterns, excludePatterns, usePolling, mappingId } = this.opts;
    const root = path.resolve(localRoot);

    if (!fs.existsSync(root)) {
      console.warn(`[FileWatcher][${mappingId}] localRoot 不存在，跳过监听: ${root}`);
      return;
    }

    this.started = true;

    this.watcher = chokidar.watch(root, {
      ignored: (absPath, stats) =>
        this.shouldIgnoreWatchTarget(absPath, root, excludePatterns, stats),
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: {
        stabilityThreshold: WATCH_AWAIT_WRITE_STABILITY_MS,
        pollInterval: WATCH_AWAIT_WRITE_POLL_MS,
      },
      usePolling,
      depth: undefined,
    });

    this.watcher.on('all', (event, absPath) => {
      this.onFsEvent(event, absPath, root);
    });

    this.watcher.on('ready', () => {
      console.log(`[FileWatcher][${mappingId}] ready root=${root} polling=${usePolling}`);
    });

    this.watcher.on('error', (err) => {
      console.warn(
        `[FileWatcher][${mappingId}] error: ${err instanceof Error ? err.message : String(err)}; 依赖定时 sync 兜底`,
      );
    });
  }

  async stop(): Promise<void> {
    this.started = false;
    this.clearDebounce();
    if (this.ignoreTailTimer) {
      clearTimeout(this.ignoreTailTimer);
      this.ignoreTailTimer = null;
    }
    this.ignoreSet.clear();
    this.pendingPaths.clear();
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }

  /** sync 开始前暂停，丢弃期间所有 FS 事件 */
  pause(): void {
    this.paused = true;
    this.clearDebounce();
  }

  /**
   * sync 结束后恢复；将 pull 写入路径加入 ignoreSet 一段时间，防止 resume 后 echo push。
   */
  resumeAfterSync(pullWrittenPaths?: Iterable<string>): void {
    this.paused = false;
    if (pullWrittenPaths) {
      this.addIgnore(pullWrittenPaths);
    }
    if (this.ignoreSet.size > 0) {
      if (this.ignoreTailTimer) clearTimeout(this.ignoreTailTimer);
      const tailMs = this.opts.debounceMs + WATCH_AWAIT_WRITE_STABILITY_MS + WATCH_PULL_IGNORE_TAIL_MS;
      this.ignoreTailTimer = setTimeout(() => {
        this.ignoreSet.clear();
        this.ignoreTailTimer = null;
      }, tailMs);
    }
  }

  addIgnore(paths: Iterable<string>): void {
    for (const p of paths) {
      const key = canonicalizeRelativeSyncPath(normalizeSeparator(p));
      if (key) this.ignoreSet.add(key);
    }
    // 方案一索引：始终忽略（consume 写入；点文件通常已被 chokidar ignored 规则排除）
    this.ignoreSet.add(FILE_INDEX_NAME);
  }

  clearIgnore(): void {
    this.ignoreSet.clear();
    if (this.ignoreTailTimer) {
      clearTimeout(this.ignoreTailTimer);
      this.ignoreTailTimer = null;
    }
  }

  isActive(): boolean {
    return this.started && this.watcher !== null;
  }

  private onFsEvent(event: string, absPath: string, root: string): void {
    if (this.paused) return;
    if (event === 'ready') return;

    const rel = this.toRelativePath(absPath, root);
    if (!rel) return;
    if (this.ignoreSet.has(rel)) return;

    const isDirEvent = event === 'addDir' || event === 'unlinkDir';
    if (!isDirEvent && !this.matchesSyncScope(rel)) return;

    this.pendingPaths.add(rel);
    this.scheduleDebounce();
  }

  private scheduleDebounce(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      if (this.paused || this.pendingPaths.size === 0) return;
      const count = this.pendingPaths.size;
      this.pendingPaths.clear();
      this.opts.onBatchReady(count);
    }, this.opts.debounceMs);
  }

  private clearDebounce(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.pendingPaths.clear();
  }

  private toRelativePath(absPath: string, root: string): string | null {
    const rel = path.relative(root, absPath);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return canonicalizeRelativeSyncPath(normalizeSeparator(rel));
  }

  /** 与 SyncEngine.matchesSync 一致：仅纳入同步范围的文件路径 */
  private matchesSyncScope(rel: string): boolean {
    const { filePatterns, excludePatterns } = this.opts;
    if (micromatch.isMatch(rel, excludePatterns)) return false;
    return micromatch.isMatch(rel, filePatterns);
  }

  /**
   * chokidar ignored：仅排除 dot 文件、索引文件、exclude 目录。
   * 勿在此处按 filePatterns 排除，也勿 ignore 同步根（rel===''），否则 Windows 上可能收不到任何子路径事件。
   */
  private shouldIgnoreWatchTarget(
    absPath: string,
    root: string,
    excludePatterns: string[],
    stats?: fs.Stats,
  ): boolean {
    const rel = path.relative(root, absPath);
    if (rel.startsWith('..')) return true;
    if (rel === '') return false;

    const relNorm = normalizeSeparator(rel);
    const base = path.basename(absPath);

    if (base.startsWith('.')) return true;
    if (relNorm === FILE_INDEX_NAME) return true;

    let isDirectory = stats?.isDirectory();
    if (isDirectory === undefined) {
      try {
        isDirectory = fs.statSync(absPath).isDirectory();
      } catch {
        return false;
      }
    }

    if (isDirectory) {
      const relDir = relNorm.endsWith('/') ? relNorm : `${relNorm}/`;
      return micromatch.isMatch(relDir, excludePatterns);
    }

    return micromatch.isMatch(relNorm, excludePatterns);
  }
}
