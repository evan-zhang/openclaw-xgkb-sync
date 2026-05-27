import { MTIME_TOLERANCE_MS } from './constants';
import { FileState, FolderState, LocalDirEntry, LocalFileEntry, SyncPlan } from './types';

export interface DetectRenamesResult {
  plans: SyncPlan[];
  consumedFromPaths: Set<string>;
  consumedToPaths: Set<string>;
}

/**
 * 本地 inode 对账入口：
 * 1. 先通过文件夹自身 inode 检测目录级 rename/move
 * 2. 再检测剩余单文件 rename/move（未被目录计划消费的文件）
 */
/**
 * rename/move 成功后路径会进入 consumedToPaths 以跳过 Phase2 路径对账。
 * 若同轮还改了文件内容，需从 consumedToPaths 移除，以便 Phase2 执行 upload-update。
 */
export function releaseContentChangedRenameTargets(
  localMap: Map<string, LocalFileEntry>,
  renamePlans: SyncPlan[],
  consumedToPaths: Set<string>,
): number {
  let released = 0;
  for (const plan of renamePlans) {
    if (plan.isDirectory && plan.affectedRecords?.length) {
      const oldDir = plan.directoryOldPath ?? '';
      const newDir = plan.directoryNewPath ?? '';
      for (const rec of plan.affectedRecords) {
        const suffix = pathSuffixUnderDir(rec.localPath, oldDir);
        const newPath = newDir ? `${newDir}/${suffix}` : suffix;
        const local = localMap.get(newPath);
        if (local && local.mtime > (rec.localMtime ?? 0) + MTIME_TOLERANCE_MS) {
          if (consumedToPaths.delete(newPath)) released++;
        }
      }
    } else if (plan.path && plan.record) {
      const local = plan.local ?? localMap.get(plan.path);
      if (local && local.mtime > (plan.record.localMtime ?? 0) + MTIME_TOLERANCE_MS) {
        if (consumedToPaths.delete(plan.path)) released++;
      }
    }
  }
  return released;
}

export function detectLocalRenames(
  localFiles: LocalFileEntry[],
  localDirs: LocalDirEntry[],
  dbRecords: FileState[],
  folderRecords: FolderState[],
  folderPathToRemoteId: Map<string, string>,
): DetectRenamesResult {
  // 构建 inode → 当前本地文件 的映射
  const inodeToEntry = new Map<string, LocalFileEntry>();
  for (const f of localFiles) {
    if (f.ino && f.ino !== '0') {
      inodeToEntry.set(`${f.dev}:${f.ino}`, f);
    }
  }

  // 第一轮：文件夹 inode 检测（直接比对文件夹自身的 dev:ino）
  const dirResult = detectFolderRenames(localDirs, folderRecords, dbRecords, folderPathToRemoteId);

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
 * 基于文件夹自身 inode 检测目录级 rename/move。
 *
 * 逻辑：
 * - 遍历 sync_folder_state 中有 inode 的记录
 * - 用 inode 在当前本地目录列表中查找
 * - 若找到且路径不同 → 该目录被 rename 或 move
 * - 只保留最外层目录（内层子目录若与外层都匹配，外层覆盖内层）
 */
function detectFolderRenames(
  localDirs: LocalDirEntry[],
  folderRecords: FolderState[],
  dbRecords: FileState[],
  folderPathToRemoteId: Map<string, string>,
): DetectRenamesResult {
  const plans: SyncPlan[] = [];
  const consumedFromPaths = new Set<string>();
  const consumedToPaths = new Set<string>();

  // 构建 inode → 当前本地目录 的映射
  const inodeToDirEntry = new Map<string, LocalDirEntry>();
  for (const d of localDirs) {
    if (d.ino && d.ino !== '0') {
      inodeToDirEntry.set(`${d.dev}:${d.ino}`, d);
    }
  }

  // 当前本地目录路径集合（用于排除已有路径不被其他记录误匹配）
  const localDirPathSet = new Set(localDirs.map((d) => d.path));

  interface Candidate {
    oldDir: string;
    newDir: string;
    remoteFolderId: string;
  }

  const candidates: Candidate[] = [];

  for (const fr of folderRecords) {
    if (!fr.localDev || !fr.localIno || fr.localIno === '0') continue;
    if (!fr.remoteFolderId) continue;

    const key = `${fr.localDev}:${fr.localIno}`;
    const currentDir = inodeToDirEntry.get(key);

    if (!currentDir) continue; // 目录已删除
    if (currentDir.path === fr.localPath) continue; // 路径未变

    // 新路径不能已存在于 folderRecords 中（避免与另一个已同步目录冲突）
    const conflicting = folderRecords.find(
      (other) => other !== fr && other.localPath === currentDir.path,
    );
    if (conflicting) continue;

    // 目标父目录须可解析
    const targetParent = dirOf(currentDir.path);
    if (!folderPathToRemoteId.has(targetParent)) {
      console.warn(
        `[reconcileEngine] 文件夹 rename/move 跳过: 无法解析目标父目录 folderId` +
          ` parent="${targetParent}" oldDir="${fr.localPath}" newDir="${currentDir.path}"`,
      );
      continue;
    }

    candidates.push({
      oldDir: fr.localPath,
      newDir: currentDir.path,
      remoteFolderId: fr.remoteFolderId,
    });
  }

  // 去重：只保留最外层目录
  const selected = candidates.filter(
    (c) => !candidates.some((other) => other !== c && isPathUnderDir(c.oldDir, other.oldDir)),
  );

  for (const { oldDir, newDir, remoteFolderId } of selected) {
    // affectedRecords：该目录下所有文件（含子目录下的文件）
    const affectedRecords = dbRecords.filter(
      (r) => r.remoteFileId && isPathUnderDir(r.localPath, oldDir),
    );

    const oldFolderName = baseName(oldDir);
    const newFolderName = baseName(newDir);
    const sameParent = dirOf(oldDir) === dirOf(newDir);

    if (sameParent) {
      plans.push({
        op: 'rename-remote',
        isDirectory: true,
        directoryOldPath: oldDir,
        directoryNewPath: newDir,
        path: newDir,
        fromPath: oldDir,
        newName: newFolderName,
        remoteFolderFileId: remoteFolderId,
        affectedRecords,
      });
    } else {
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
        remoteFolderFileId: remoteFolderId,
        renameAfterMoveName,
        affectedRecords,
      });
    }

    // 消费该目录下所有文件路径
    for (const rec of affectedRecords) {
      consumedFromPaths.add(rec.localPath);
      const suffix = pathSuffixUnderDir(rec.localPath, oldDir);
      consumedToPaths.add(`${newDir}/${suffix}`);
    }
    // 也消费目录路径本身（防止子目录被单独匹配）
    consumedFromPaths.add(oldDir);
    consumedToPaths.add(newDir);
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

  void localFiles;
  const dbPathSet = new Set<string>(dbRecords.map((r) => r.localPath));
  const pathToRecord = new Map<string, FileState>();
  for (const r of dbRecords) pathToRecord.set(r.localPath, r);

  for (const record of dbRecords) {
    if (
      !record.localDev ||
      !record.localIno ||
      record.localIno === '0' ||
      !record.remoteFileId
    ) {
      continue;
    }
    if (excludeFromPaths.has(record.localPath)) continue;

    const localKey = `${record.localDev}:${record.localIno}`;
    const currentEntry = inodeToEntry.get(localKey);

    if (!currentEntry) continue;
    if (currentEntry.path === record.localPath) continue;
    if (excludeToPaths.has(currentEntry.path) || consumedToPaths.has(currentEntry.path)) continue;
    if (consumedFromPaths.has(record.localPath)) continue;

    // 目标路径已有 DB 记录时，检查那条记录是否仍然有效
    if (dbPathSet.has(currentEntry.path)) {
      const targetRecord = pathToRecord.get(currentEntry.path);
      if (targetRecord && targetRecord.localIno && targetRecord.localIno !== '0') {
        const targetKey = `${targetRecord.localDev}:${targetRecord.localIno}`;
        const targetEntry = inodeToEntry.get(targetKey);
        // 旧记录的 inode 仍然指向同一路径 → 目标位置确实被另一个活跃文件占据，跳过
        if (targetEntry && targetEntry.path === currentEntry.path) continue;
      } else {
        // 旧记录无 inode 信息无法验证，保守跳过
        continue;
      }
    }

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
      const targetParentId = folderPathToRemoteId.get(newDir) ?? '';
      if (!targetParentId) {
        console.log(
          `[reconcileEngine] 单文件 move-remote: 目标目录待创建 newDir="${newDir}" from="${record.localPath}" to="${currentEntry.path}"`,
        );
      }

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
