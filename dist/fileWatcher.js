"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.FileWatcher = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const chokidar_1 = __importDefault(require("chokidar"));
const micromatch_1 = __importDefault(require("micromatch"));
const constants_1 = require("./constants");
const pathSanitize_1 = require("./pathSanitize");
/**
 * mapping 级 chokidar 封装：debounce 合并变更，sync 期间 pause，pull 写入 echo 过滤。
 * 硬排除 `.openclaw-sync-map.json`（方案一索引 consume 写入，避免误触发 push）。
 */
class FileWatcher {
    opts;
    ignoreSet = new Set();
    watcher = null;
    pendingPaths = new Set();
    debounceTimer = null;
    ignoreTailTimer = null;
    paused = false;
    started = false;
    constructor(opts) {
        this.opts = opts;
    }
    start() {
        if (this.started)
            return;
        const { localRoot, filePatterns, excludePatterns, usePolling, mappingId } = this.opts;
        const root = path.resolve(localRoot);
        if (!fs.existsSync(root)) {
            console.warn(`[FileWatcher][${mappingId}] localRoot 不存在，跳过监听: ${root}`);
            return;
        }
        this.started = true;
        this.watcher = chokidar_1.default.watch(root, {
            ignored: (absPath, stats) => this.shouldIgnoreWatchTarget(absPath, root, excludePatterns, stats),
            ignoreInitial: true,
            persistent: true,
            awaitWriteFinish: {
                stabilityThreshold: constants_1.WATCH_AWAIT_WRITE_STABILITY_MS,
                pollInterval: constants_1.WATCH_AWAIT_WRITE_POLL_MS,
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
            console.warn(`[FileWatcher][${mappingId}] error: ${err instanceof Error ? err.message : String(err)}; 依赖定时 sync 兜底`);
        });
    }
    async stop() {
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
    pause() {
        this.paused = true;
        this.clearDebounce();
    }
    /**
     * sync 结束后恢复；将 pull 写入路径加入 ignoreSet 一段时间，防止 resume 后 echo push。
     */
    resumeAfterSync(pullWrittenPaths) {
        this.paused = false;
        if (pullWrittenPaths) {
            this.addIgnore(pullWrittenPaths);
        }
        if (this.ignoreSet.size > 0) {
            if (this.ignoreTailTimer)
                clearTimeout(this.ignoreTailTimer);
            const tailMs = this.opts.debounceMs + constants_1.WATCH_AWAIT_WRITE_STABILITY_MS + constants_1.WATCH_PULL_IGNORE_TAIL_MS;
            this.ignoreTailTimer = setTimeout(() => {
                this.ignoreSet.clear();
                this.ignoreTailTimer = null;
            }, tailMs);
        }
    }
    addIgnore(paths) {
        for (const p of paths) {
            const key = (0, pathSanitize_1.canonicalizeRelativeSyncPath)((0, pathSanitize_1.normalizeSeparator)(p));
            if (key)
                this.ignoreSet.add(key);
        }
        // 方案一索引：始终忽略（consume 写入；点文件通常已被 chokidar ignored 规则排除）
        this.ignoreSet.add(constants_1.FILE_INDEX_NAME);
    }
    clearIgnore() {
        this.ignoreSet.clear();
        if (this.ignoreTailTimer) {
            clearTimeout(this.ignoreTailTimer);
            this.ignoreTailTimer = null;
        }
    }
    isActive() {
        return this.started && this.watcher !== null;
    }
    onFsEvent(event, absPath, root) {
        if (this.paused)
            return;
        if (event === 'ready')
            return;
        const rel = this.toRelativePath(absPath, root);
        if (!rel)
            return;
        if (this.ignoreSet.has(rel))
            return;
        const isDirEvent = event === 'addDir' || event === 'unlinkDir';
        if (!isDirEvent && !this.matchesSyncScope(rel))
            return;
        this.pendingPaths.add(rel);
        this.scheduleDebounce();
    }
    scheduleDebounce() {
        if (this.debounceTimer)
            clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => {
            this.debounceTimer = null;
            if (this.paused || this.pendingPaths.size === 0)
                return;
            const count = this.pendingPaths.size;
            this.pendingPaths.clear();
            this.opts.onBatchReady(count);
        }, this.opts.debounceMs);
    }
    clearDebounce() {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }
        this.pendingPaths.clear();
    }
    toRelativePath(absPath, root) {
        const rel = path.relative(root, absPath);
        if (!rel || rel.startsWith('..') || path.isAbsolute(rel))
            return null;
        return (0, pathSanitize_1.canonicalizeRelativeSyncPath)((0, pathSanitize_1.normalizeSeparator)(rel));
    }
    /** 与 SyncEngine.matchesSync 一致：仅纳入同步范围的文件路径 */
    matchesSyncScope(rel) {
        const { filePatterns, excludePatterns } = this.opts;
        if (micromatch_1.default.isMatch(rel, excludePatterns))
            return false;
        return micromatch_1.default.isMatch(rel, filePatterns);
    }
    /**
     * chokidar ignored：排除索引文件和 exclude 目录。
     * 点文件可能是待同步的工程配置（如 .gitignore），由 filePatterns/excludePatterns 判定。
     * 勿在此处按 filePatterns 排除，也勿 ignore 同步根（rel===''），否则 Windows 上可能收不到任何子路径事件。
     */
    shouldIgnoreWatchTarget(absPath, root, excludePatterns, stats) {
        const rel = path.relative(root, absPath);
        if (rel.startsWith('..'))
            return true;
        if (rel === '')
            return false;
        const relNorm = (0, pathSanitize_1.normalizeSeparator)(rel);
        if (relNorm === constants_1.FILE_INDEX_NAME)
            return true;
        let isDirectory = stats?.isDirectory();
        if (isDirectory === undefined) {
            try {
                isDirectory = fs.statSync(absPath).isDirectory();
            }
            catch {
                return false;
            }
        }
        if (isDirectory) {
            const relDir = relNorm.endsWith('/') ? relNorm : `${relNorm}/`;
            return micromatch_1.default.isMatch(relDir, excludePatterns);
        }
        return micromatch_1.default.isMatch(relNorm, excludePatterns);
    }
}
exports.FileWatcher = FileWatcher;
//# sourceMappingURL=fileWatcher.js.map