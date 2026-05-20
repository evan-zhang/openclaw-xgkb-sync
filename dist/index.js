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
Object.defineProperty(exports, "__esModule", { value: true });
const path = __importStar(require("path"));
const consoleTee_1 = require("./consoleTee");
const constants_1 = require("./constants");
const config_1 = require("./config");
const scheduler_1 = require("./scheduler");
const managementApi_1 = require("./managementApi");
function parseArgs() {
    const args = process.argv.slice(2);
    let configPath = './config.json';
    let logFile;
    for (let i = 0; i < args.length; i++) {
        if ((args[i] === '--config' || args[i] === '-c') && args[i + 1]) {
            configPath = args[++i];
        }
        else if (args[i] === '--log-file' && args[i + 1]) {
            logFile = args[++i];
        }
    }
    return { configPath, logFile };
}
async function main() {
    const { configPath, logFile: logFileArg } = parseArgs();
    const logFilePath = logFileArg ?? (process.env.OPENCLAW_SYNC_LOG_FILE?.trim() || undefined);
    if (logFilePath) {
        (0, consoleTee_1.installConsoleTee)(path.resolve(logFilePath));
    }
    const absConfigPath = path.resolve(configPath);
    console.log(`[OpenClaw Sync] 启动中...`);
    console.log(`[OpenClaw Sync] 配置文件: ${absConfigPath}`);
    let config;
    let configBootstrapped = false;
    try {
        const loaded = (0, config_1.loadConfigWithMeta)(absConfigPath);
        config = loaded.config;
        configBootstrapped = loaded.bootstrapped;
    }
    catch (e) {
        console.error('[OpenClaw Sync] 配置加载失败:', e instanceof Error ? e.message : String(e));
        process.exit(1);
    }
    if (configBootstrapped) {
        const port = config.managementPort ?? 9090;
        const host = config.managementHost ?? constants_1.DEFAULT_MANAGEMENT_HOST;
        const uiHost = host === '0.0.0.0' ? '127.0.0.1' : host;
        console.log(`[OpenClaw Sync] 请在 Web 控制台补充 AppKey 与同步映射: http://${uiHost}:${port}/`);
    }
    console.log(`[OpenClaw Sync] serverUrl: ${config.serverUrl}`);
    console.log(`[OpenClaw Sync] 同步方向: ${config.syncDirection}`);
    console.log(`[OpenClaw Sync] mapping 数量: ${config.mappings.length}（已启用: ${config.mappings.filter((m) => m.enabled).length}）`);
    // 用可变引用包装 scheduler，reload 时替换其中的实例
    const schedulerRef = { current: new scheduler_1.SyncScheduler(config) };
    // 热重载：停掉旧 scheduler，用新配置重建并启动
    function doReload() {
        let newConfig;
        try {
            newConfig = (0, config_1.loadConfigWithMeta)(absConfigPath).config;
        }
        catch (e) {
            return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
        schedulerRef.current.stop();
        schedulerRef.current = new scheduler_1.SyncScheduler(newConfig);
        schedulerRef.current.start();
        return { ok: true, config: newConfig };
    }
    // 管理 API（HTTP 服务，port=0 时自动禁用）
    const managementApi = new managementApi_1.ManagementApi({
        port: config.managementPort ?? 9090,
        host: config.managementHost ?? constants_1.DEFAULT_MANAGEMENT_HOST,
        configPath: absConfigPath,
        logFilePath: logFilePath ? path.resolve(logFilePath) : undefined,
        getScheduler: () => schedulerRef.current,
        onReload: doReload,
    });
    managementApi.start();
    // 优雅退出
    function shutdown(signal) {
        console.log(`\n[OpenClaw Sync] 收到 ${signal}，正在停止...`);
        managementApi.stop();
        schedulerRef.current.stop();
        process.exit(0);
    }
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    // 未捕获异常记录但不崩溃（调度器会在下轮重试）
    process.on('uncaughtException', (e) => {
        console.error('[OpenClaw Sync] 未捕获异常:', e);
    });
    process.on('unhandledRejection', (reason) => {
        console.error('[OpenClaw Sync] 未处理的 Promise 拒绝:', reason);
    });
    schedulerRef.current.start();
    console.log('[OpenClaw Sync] 服务已启动，按 Ctrl+C 停止');
}
main().catch((e) => {
    console.error('[OpenClaw Sync] 启动失败:', e);
    process.exit(1);
});
//# sourceMappingURL=index.js.map