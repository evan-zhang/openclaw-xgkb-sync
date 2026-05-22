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
export declare function detectLocalRenames(localFiles: LocalFileEntry[], dbRecords: FileState[], folderPathToRemoteId: Map<string, string>): DetectRenamesResult;
//# sourceMappingURL=reconcileEngine.d.ts.map