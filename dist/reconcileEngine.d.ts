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
export declare function releaseContentChangedRenameTargets(localMap: Map<string, LocalFileEntry>, renamePlans: SyncPlan[], consumedToPaths: Set<string>): number;
export declare function detectLocalRenames(localFiles: LocalFileEntry[], localDirs: LocalDirEntry[], dbRecords: FileState[], folderRecords: FolderState[], folderPathToRemoteId: Map<string, string>): DetectRenamesResult;
//# sourceMappingURL=reconcileEngine.d.ts.map