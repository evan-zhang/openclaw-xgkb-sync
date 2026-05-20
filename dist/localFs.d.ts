import { LocalFileEntry } from './types';
/**
 * 本地文件系统适配器（Node.js 版）
 * 替代 Obsidian Vault API，面向标准 Node.js `fs/promises`。
 */
export declare class LocalFsAdapter {
    private readonly localRoot;
    private readonly filePatterns;
    private readonly excludePatterns;
    constructor(localRoot: string, filePatterns?: string[], excludePatterns?: string[]);
    getRoot(): string;
    /**
     * 递归列出 localRoot 下所有匹配 filePatterns 且不在 excludePatterns 中的文件。
     * 返回路径均为相对于 localRoot 的路径（使用 "/" 分隔）。
     */
    listFiles(): Promise<LocalFileEntry[]>;
    /**
     * 递归列出 localRoot 下所有纳入同步遍历范围的目录。
     * 返回路径均为相对于 localRoot 的路径（使用 "/" 分隔），不包含根目录自身。
     */
    listDirectories(): Promise<string[]>;
    private walk;
    private assertNoPathCollisions;
    private walkDirectories;
    /** 读取文件内容（UTF-8） */
    readFile(relativePath: string): Promise<string>;
    /**
     * 写入文件（自动创建父目录）。
     * 返回写入后的实际 mtime。
     */
    writeFile(relativePath: string, content: string): Promise<number>;
    /**
     * 删除文件。
     * 若路径不存在则静默跳过。
     */
    deleteFile(relativePath: string): Promise<void>;
    /** 获取文件的 mtime（毫秒），不存在返回 null */
    getMtime(relativePath: string): Promise<number | null>;
    /** 判断文件是否存在 */
    exists(relativePath: string): Promise<boolean>;
    /**
     * 将相对路径解析为绝对路径，并验证结果在 localRoot 内（防路径穿越）。
     * 若解析结果逃逸出 localRoot，抛出错误而非静默处理。
     */
    resolve(relativePath: string): string;
}
//# sourceMappingURL=localFs.d.ts.map