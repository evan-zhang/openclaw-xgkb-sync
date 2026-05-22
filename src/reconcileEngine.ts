import { FileState, LocalFileEntry, SyncPlan } from './types';

export interface DetectRenamesResult {
  plans: SyncPlan[];
  consumedFromPaths: Set<string>;
  consumedToPaths: Set<string>;
}

/**
 * 本地 inode 对账入口：
 * 1. 先检测目录级整体移动/重命名（一次 moveFile/updateFileName 处理整个目录树）
 * 2. 再检测剩余单文件 rename/move（未被目录计划消费的文件）
 */
export function detectLocalRenames(
  localFiles: LocalFileEntry[],
  dbRecords: FileState[],
  folderPathToRemoteId: Map<string, string>,
): DetectRenamesResult {
  // 构建 inode → 当前本地条目 的映射
  const inodeToEntry = new Map<string, LocalFileEntry>();
  for (const f of localFiles) {
    if (f.ino > 0) {
      inodeToEntry.set(`${f.dev}:${f.ino}`, f);
    }
  }

  // 第一轮：目录级检测（防止将目录内文件拆散为单文件计划）
  const dirResult = detectDirectoryMoves(dbRecords, inodeToEntry, folderPathToRemoteId);

  // 第二轮：单文件检测（跳过已被目录计划消费的路径）
  const fileResult = detectSingleFileMoves(
    localFiles,
    dbRecords,
    inodeToEntry,
    folderPathToRemoteId,
    dirResult.consumedFromPaths,
    dirResult.consumedToPaths,
  );

  return {
    plans: [...dirResult.plans, ...fileResult.plans],
    consumedFromPaths: new Set([...dirResult.consumedFromPaths, ...fileResult.consumedFromPaths]),
    consumedToPaths: new Set([...dirResult.consumedToPaths, ...fileResult.consumedToPaths]),
  };
}

/**
 * 检测目录级整体移动/重命名。
 *
 * 条件（全部满足才视为目录整体移动）：
 * - 该目录有至少一个直接子文件（有 inode 记录）
 * - 所有直接子文件均有 inode 匹配，且均移到同一新目录
 * - 文件名不变（纯目录移动；文件同时改名的情况留给单文件逻辑处理）
 * - 目标父目录可解析（folderPathToRemoteId 已知）
 *
 * 去重策略：只保留最外层目录（内层子目录若与外层都满足条件，外层覆盖内层）。
 */
function detectDirectoryMoves(
  dbRecords: FileState[],
  inodeToEntry: Map<string, LocalFileEntry>,
  folderPathToRemoteId: Map<string, string>,
): DetectRenamesResult {
  const plans: SyncPlan[] = [];
  const consumedFromPaths = new Set<string>();
  const consumedToPaths = new Set<string>();

  // 按直接父目录分组（只取有 inode 信息的记录）
  const dirToDirectChildren = new Map<string, FileState[]>();
  for (const rec of dbRecords) {
    if (!rec.remoteFileId || !rec.localDev || !rec.localIno || rec.localIno === 0) continue;
    const dir = dirOf(rec.localPath);
    if (!dir) continue; // 根目录直接子文件不做目录级合并
    const arr = dirToDirectChildren.get(dir) ?? [];
    arr.push(rec);
    dirToDirectChildren.set(dir, arr);
  }

  interface Candidate {
    oldDir: string;
    newDir: string;
    remoteFolderFileId: string;
  }

  const candidates: Candidate[] = [];

  for (const [oldDir, directChildren] of dirToDirectChildren) {
    let newDir: string | null = null;
    let valid = true;

    for (const rec of directChildren) {
      const key = `${rec.localDev}:${rec.localIno}`;
      const entry = inodeToEntry.get(key);

      // 文件消失或未移动 → 不是整个目录移动
      if (!entry || entry.path === rec.localPath) {
        valid = false;
        break;
      }
      // 文件被同时改名 → 暂不支持目录级合并，留给单文件逻辑处理
      if (baseName(entry.path) !== baseName(rec.localPath)) {
        valid = false;
        break;
      }

      const entryDir = dirOf(entry.path);
      if (newDir === null) {
        newDir = entryDir;
      } else if (newDir !== entryDir) {
        // 文件散落到不同目录 → 不是目录整体移动
        valid = false;
        break;
      }
    }

    if (!valid || newDir === null || newDir === oldDir || !newDir) continue;

    // 目标父目录须可解析
    if (!folderPathToRemoteId.has(dirOf(newDir))) continue;

    // 获取本目录的远端 folderId（从任意直接子文件的 remoteFolderId）
    const folderIdRec = directChildren.find((r) => r.remoteFolderId);
    if (!folderIdRec?.remoteFolderId) continue;

    candidates.push({ oldDir, newDir, remoteFolderFileId: folderIdRec.remoteFolderId });
  }

  // 去重：只保留最外层目录（若 dirA 和 dirA/sub 都是候选，移除 dirA/sub）
  const selected = candidates.filter(
    (c) => !candidates.some((other) => other !== c && isPathUnderDir(c.oldDir, other.oldDir)),
  );

  for (const { oldDir, newDir, remoteFolderFileId } of selected) {
    // affectedRecords：该目录下所有文件（含子目录下的文件）
    const affectedRecords = dbRecords.filter(
      (r) => r.remoteFileId && isPathUnderDir(r.localPath, oldDir),
    );

    const oldFolderName = baseName(oldDir);
    const newFolderName = baseName(newDir);
    const sameParent = dirOf(oldDir) === dirOf(newDir);

    if (sameParent) {
      // 同父目录下改名 → rename-remote (isDirectory=true)，调用 updateFileName
      plans.push({
        op: 'rename-remote',
        isDirectory: true,
        directoryOldPath: oldDir,
        directoryNewPath: newDir,
        path: newDir,
        fromPath: oldDir,
        newName: newFolderName,
        remoteFolderFileId,
        affectedRecords,
      });
    } else {
      // 跨目录移动（可能同时改名）→ move-remote (isDirectory=true)，调用 moveFile
      const targetParentId = folderPathToRemoteId.get(dirOf(newDir))!;
      const renameAfterMoveName = oldFolderName !== newFolderName ? newFolderName : undefined;
      plans.push({
        op: 'move-remote',
        isDirectory: true,
        directoryOldPath: oldDir,
        directoryNewPath: newDir,
        path: newDir,
        fromPath: oldDir,
        targetParentId,
        remoteFolderFileId,
        renameAfterMoveName,
        affectedRecords,
      });
    }

    for (const rec of affectedRecords) {
      consumedFromPaths.add(rec.localPath);
      const suffix = pathSuffixUnderDir(rec.localPath, oldDir);
      consumedToPaths.add(newDir ? `${newDir}/${suffix}` : suffix);
    }
  }

  return { plans, consumedFromPaths, consumedToPaths };
}

/**
 * 检测单文件级 rename/move（跳过已被目录计划消费的路径）。
 * 同目录改名 → rename-remote；跨目录移动 → move-remote（目标目录须在 folderPathToRemoteId 中）。
 */
function detectSingleFileMoves(
  localFiles: LocalFileEntry[],
  dbRecords: FileState[],
  inodeToEntry: Map<string, LocalFileEntry>,
  folderPathToRemoteId: Map<string, string>,
  excludeFromPaths: Set<string>,
  excludeToPaths: Set<string>,
): DetectRenamesResult {
  const plans: SyncPlan[] = [];
  const consumedFromPaths = new Set<string>();
  const consumedToPaths = new Set<string>();

  void localFiles; // 本函数只需 inodeToEntry（已从 localFiles 建好），保留参数签名以备扩展
  const dbPathSet = new Set<string>(dbRecords.map((r) => r.localPath));

  for (const record of dbRecords) {
    if (
      !record.localDev ||
      !record.localIno ||
      record.localIno === 0 ||
      !record.remoteFileId
    ) {
      continue;
    }
    if (excludeFromPaths.has(record.localPath)) continue;

    const localKey = `${record.localDev}:${record.localIno}`;
    const currentEntry = inodeToEntry.get(localKey);

    if (!currentEntry) continue;
    if (currentEntry.path === record.localPath) continue;
    if (dbPathSet.has(currentEntry.path)) continue;
    if (excludeToPaths.has(currentEntry.path) || consumedToPaths.has(currentEntry.path)) continue;
    if (consumedFromPaths.has(record.localPath)) continue;

    const oldDir = dirOf(record.localPath);
    const newDir = dirOf(currentEntry.path);
    const newName = baseName(currentEntry.path);

    if (oldDir === newDir) {
      plans.push({
        op: 'rename-remote',
        path: currentEntry.path,
        fromPath: record.localPath,
        newName,
        local: currentEntry,
        record,
      });
    } else {
      const targetParentId = folderPathToRemoteId.get(newDir);
      if (!targetParentId) continue;

      const oldBase = baseName(record.localPath);
      plans.push({
        op: 'move-remote',
        path: currentEntry.path,
        fromPath: record.localPath,
        targetParentId,
        renameAfterMoveName: newName !== oldBase ? newName : undefined,
        local: currentEntry,
        record,
      });
    }

    consumedFromPaths.add(record.localPath);
    consumedToPaths.add(currentEntry.path);
  }

  return { plans, consumedFromPaths, consumedToPaths };
}

function isPathUnderDir(filePath: string, dirPath: string): boolean {
  if (!dirPath) return filePath.includes('/');
  return filePath.startsWith(dirPath + '/');
}

function pathSuffixUnderDir(filePath: string, dirPath: string): string {
  if (!dirPath) return filePath;
  return filePath.slice(dirPath.length + 1);
}

function dirOf(p: string): string {
  const idx = p.lastIndexOf('/');
  return idx > 0 ? p.slice(0, idx) : '';
}

function baseName(p: string): string {
  const idx = p.lastIndexOf('/');
  return idx >= 0 ? p.slice(idx + 1) : p;
}
