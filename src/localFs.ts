import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import micromatch from 'micromatch';
import { LocalDirEntry, LocalFileEntry } from './types';
import { DEFAULT_EXCLUDE_PATTERNS, DEFAULT_FILE_PATTERNS, mergeDefaultExcludePatterns } from './constants';
import { canonicalizeRelativeSyncPath, normalizeSeparator, sanitizePathSegment } from './pathSanitize';

/**
 * 本地文件系统适配器（Node.js 版）
 * 替代 Obsidian Vault API，面向标准 Node.js `fs/promises`。
 */
export class LocalFsAdapter {
  private readonly localRoot: string;
  private readonly filePatterns: string[];
  private readonly excludePatterns: string[];

  constructor(
    localRoot: string,
    filePatterns = DEFAULT_FILE_PATTERNS,
    excludePatterns = DEFAULT_EXCLUDE_PATTERNS,
  ) {
    this.localRoot = path.resolve(localRoot);
    this.filePatterns = filePatterns;
    this.excludePatterns = mergeDefaultExcludePatterns(excludePatterns);
  }

  getRoot(): string {
    return this.localRoot;
  }

  /**
   * 递归列出 localRoot 下所有匹配 filePatterns 且不在 excludePatterns 中的文件。
   * 返回路径均为相对于 localRoot 的路径（使用 "/" 分隔）。
   */
  async listFiles(): Promise<LocalFileEntry[]> {
    const entries: LocalFileEntry[] = [];
    await this.walk(this.localRoot, '', entries);
    this.assertNoPathCollisions(entries);
    return entries;
  }

  /**
   * 递归列出 localRoot 下所有纳入同步遍历范围的目录（含 dev/ino）。
   * 返回路径均为相对于 localRoot 的路径（使用 "/" 分隔），不包含根目录自身。
   */
  async listDirectories(): Promise<LocalDirEntry[]> {
    const dirs: LocalDirEntry[] = [];
    await this.walkDirectories(this.localRoot, '', dirs);
    return dirs;
  }

  private async walk(
    absDir: string,
    relPrefix: string,
    entries: LocalFileEntry[],
  ): Promise<void> {
    let dirEntries: fsSync.Dirent[];
    try {
      dirEntries = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }

    const subDirTasks: Promise<void>[] = [];

    for (const dirent of dirEntries) {
      const relPath = relPrefix ? `${relPrefix}/${dirent.name}` : dirent.name;
      const absPath = path.join(absDir, dirent.name);

      if (dirent.isDirectory()) {
        const relDirPath = relPath + '/';
        if (micromatch.isMatch(relDirPath, this.excludePatterns)) continue;
        // 并行递归所有子目录，大目录扫描速度显著提升
        subDirTasks.push(this.walk(absPath, relPath, entries));
      } else if (dirent.isFile()) {
        const safePath = normalizeSeparator(relPath)
          .split('/')
          .map((seg) => sanitizePathSegment(seg))
          .join('/');

        if (micromatch.isMatch(safePath, this.excludePatterns)) continue;
        if (!micromatch.isMatch(safePath, this.filePatterns)) continue;

        try {
          const stat = await fs.stat(absPath, { bigint: true });
          entries.push({
            path: safePath,
            name: dirent.name,
            mtime: Number(stat.mtimeMs),
            size: Number(stat.size),
            dev: stat.dev.toString(),
            ino: stat.ino.toString(),
          });
        } catch {
          // stat 失败跳过
        }
      }
    }

    if (subDirTasks.length > 0) {
      await Promise.all(subDirTasks);
    }
  }

  private assertNoPathCollisions(entries: LocalFileEntry[]): void {
    const seen = new Set<string>();
    const duplicates = new Set<string>();
    for (const entry of entries) {
      if (seen.has(entry.path)) duplicates.add(entry.path);
      seen.add(entry.path);
    }
    if (duplicates.size > 0) {
      const sample = [...duplicates].slice(0, 10).join(', ');
      throw new Error(
        `本地路径规范化后发生冲突，已停止同步以避免覆盖文件: ${sample}`,
      );
    }
  }

  private async walkDirectories(
    absDir: string,
    relPrefix: string,
    dirs: LocalDirEntry[],
  ): Promise<void> {
    let dirEntries: fsSync.Dirent[];
    try {
      dirEntries = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }

    const subDirTasks: Promise<void>[] = [];
    for (const dirent of dirEntries) {
      if (!dirent.isDirectory()) continue;

      const relPath = relPrefix ? `${relPrefix}/${dirent.name}` : dirent.name;
      const relDirPath = relPath + '/';
      if (micromatch.isMatch(relDirPath, this.excludePatterns)) continue;

      const safePath = normalizeSeparator(relPath)
        .split('/')
        .map((seg) => sanitizePathSegment(seg))
        .join('/');
      const absPath = path.join(absDir, dirent.name);
      try {
        const stat = await fs.stat(absPath, { bigint: true });
        dirs.push({ path: safePath, dev: stat.dev.toString(), ino: stat.ino.toString() });
      } catch {
        dirs.push({ path: safePath, dev: '0', ino: '0' });
      }
      subDirTasks.push(this.walkDirectories(absPath, relPath, dirs));
    }

    if (subDirTasks.length > 0) {
      await Promise.all(subDirTasks);
    }
  }

  /** 读取文件内容（UTF-8） */
  async readFile(relativePath: string): Promise<string> {
    const absPath = this.resolve(relativePath);
    return fs.readFile(absPath, 'utf-8');
  }

  /**
   * 写入文件（自动创建父目录）。
   * 返回写入后的实际 mtime。
   */
  async writeFile(relativePath: string, content: string): Promise<number> {
    const absPath = this.resolve(relativePath);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, content, 'utf-8');
    const stat = await fs.stat(absPath);
    return stat.mtimeMs;
  }

  /**
   * 删除文件。
   * 若路径不存在则静默跳过。
   */
  async deleteFile(relativePath: string): Promise<void> {
    const absPath = this.resolve(relativePath);
    try {
      await fs.unlink(absPath);
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }

  /** 获取文件的 mtime（毫秒），不存在返回 null */
  async getMtime(relativePath: string): Promise<number | null> {
    const absPath = this.resolve(relativePath);
    try {
      const stat = await fs.stat(absPath);
      return stat.mtimeMs;
    } catch {
      return null;
    }
  }

  /**
   * 重命名文件或目录（原子移动操作，源和目标必须在同一文件系统）。
   * 若目标已存在则会被覆盖（平台行为）。
   * 自动创建目标路径的父目录。
   */
  async rename(fromRelPath: string, toRelPath: string): Promise<void> {
    const fromAbs = this.resolve(fromRelPath);
    const toAbs = this.resolve(toRelPath);
    await fs.mkdir(path.dirname(toAbs), { recursive: true });
    await fs.rename(fromAbs, toAbs);
  }

  /** 判断文件是否存在 */
  async exists(relativePath: string): Promise<boolean> {
    const absPath = this.resolve(relativePath);
    try {
      await fs.access(absPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 将相对路径解析为绝对路径，并验证结果在 localRoot 内（防路径穿越）。
   * 若解析结果逃逸出 localRoot，抛出错误而非静默处理。
   */
  resolve(relativePath: string): string {
    const safe = canonicalizeRelativeSyncPath(normalizeSeparator(relativePath));
    const resolved = path.resolve(this.localRoot, safe);
    // 确保解析结果在 localRoot 内（localRoot 已在构造函数中 path.resolve 过）
    const rootWithSep = this.localRoot.endsWith(path.sep)
      ? this.localRoot
      : this.localRoot + path.sep;
    if (resolved !== this.localRoot && !resolved.startsWith(rootWithSep)) {
      throw new Error(`路径越界: "${relativePath}" 解析后超出 localRoot 范围`);
    }
    return resolved;
  }
}
