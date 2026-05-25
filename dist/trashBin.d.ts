/**
 * 将文件移动到回收站而非直接删除。
 *
 * 目标路径：~/.openclaw/trash/{mappingId}/YYYY-MM-DD/{relativePath}
 *
 * @param sourceAbsPath 要"删除"的文件的绝对路径
 * @param mappingId 当前 mapping 的 ID
 * @param relativePath 文件的相对路径（用于在回收站中保留目录结构）
 */
export declare function moveToTrash(sourceAbsPath: string, mappingId: string, relativePath: string): Promise<void>;
/**
 * 清理过期的回收站文件（超过 RETENTION_DAYS 天的日期目录）。
 * 建议在每轮同步完成后或定时调用。
 */
export declare function cleanupTrash(mappingId?: string): Promise<number>;
//# sourceMappingURL=trashBin.d.ts.map