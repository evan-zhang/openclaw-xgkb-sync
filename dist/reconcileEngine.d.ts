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
export declare function detectLocalRenames(localFiles: LocalFileEntry[], localDirs: LocalDirEntry[], dbRecords: FileState[], folderRecords: FolderState[], folderPathToRemoteId: Map<string, string>): DetectRenamesResult;
//# sourceMappingURL=reconcileEngine.d.ts.map