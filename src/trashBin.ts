import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

/** 回收站根目录：~/.openclaw/trash/ */
const TRASH_ROOT = path.join(os.homedir(), '.openclaw', 'trash');

/** 回收站文件保留天数 */
const RETENTION_DAYS = 7;

/**
 * 将文件移动到回收站而非直接删除。
 *
 * 目标路径：~/.openclaw/trash/{mappingId}/YYYY-MM-DD/{relativePath}
 *
 * @param sourceAbsPath 要"删除"的文件的绝对路径
 * @param mappingId 当前 mapping 的 ID
 * @param relativePath 文件的相对路径（用于在回收站中保留目录结构）
 */
export async function moveToTrash(
  sourceAbsPath: string,
  mappingId: string,
  relativePath: string,
): Promise<void> {
  const dateStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const trashDir = path.join(TRASH_ROOT, mappingId, dateStr);
  const trashFilePath = path.join(trashDir, relativePath.replace(/\//g, path.sep));

  await fs.mkdir(path.dirname(trashFilePath), { recursive: true });

  try {
    await fs.rename(sourceAbsPath, trashFilePath);
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') return; // 源文件已不存在，视为成功
    // 跨盘 rename 失败时 fallback 为 copy + delete
    if (err.code === 'EXDEV') {
      await fs.copyFile(sourceAbsPath, trashFilePath);
      await fs.unlink(sourceAbsPath);
      return;
    }
    throw e;
  }
}

/**
 * 清理过期的回收站文件（超过 RETENTION_DAYS 天的日期目录）。
 * 建议在每轮同步完成后或定时调用。
 */
export async function cleanupTrash(mappingId?: string): Promise<number> {
  let cleaned = 0;
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;

  let mappingDirs: string[];
  try {
    if (mappingId) {
      mappingDirs = [path.join(TRASH_ROOT, mappingId)];
    } else {
      const entries = await fs.readdir(TRASH_ROOT, { withFileTypes: true });
      mappingDirs = entries
        .filter((e) => e.isDirectory())
        .map((e) => path.join(TRASH_ROOT, e.name));
    }
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw e;
  }

  for (const mDir of mappingDirs) {
    let dateDirs: string[];
    try {
      const entries = await fs.readdir(mDir, { withFileTypes: true });
      dateDirs = entries
        .filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name))
        .map((e) => e.name);
    } catch {
      continue;
    }

    for (const dateStr of dateDirs) {
      const dirDate = new Date(dateStr + 'T00:00:00Z').getTime();
      if (isNaN(dirDate) || dirDate >= cutoff) continue;

      const dirPath = path.join(mDir, dateStr);
      try {
        await fs.rm(dirPath, { recursive: true, force: true });
        cleaned++;
      } catch {
        // 清理失败不阻塞主流程
      }
    }
  }

  return cleaned;
}
