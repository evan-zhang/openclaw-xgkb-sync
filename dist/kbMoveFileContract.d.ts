import { MoveFileResult } from './types';
/**
 * 将 KB moveFile 响应规范化为同步端最小契约（§4.2.1）。
 * 忽略 details / skippedItems / affectedCount 等扩展字段。
 * 过渡期：若无 mainSkipped 但 skippedItems 含主节点 id，则推断 mainSkipped=true。
 */
export declare function normalizeMoveFileResult(raw: unknown, requestFileId: string): MoveFileResult;
/** 请求带 rootFileId 但响应缺 relativePath 时打诊断日志 */
export declare function warnMoveFileResponseGaps(result: MoveFileResult, requestFileId: string, sentRootFileId: boolean, mappingId: string): void;
//# sourceMappingURL=kbMoveFileContract.d.ts.map