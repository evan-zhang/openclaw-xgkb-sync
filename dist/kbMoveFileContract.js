"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeMoveFileResult = normalizeMoveFileResult;
exports.warnMoveFileResponseGaps = warnMoveFileResponseGaps;
/**
 * 将 KB moveFile 响应规范化为同步端最小契约（§4.2.1）。
 * 忽略 details / skippedItems / affectedCount 等扩展字段。
 * 过渡期：若无 mainSkipped 但 skippedItems 含主节点 id，则推断 mainSkipped=true。
 */
function normalizeMoveFileResult(raw, requestFileId) {
    const o = (raw && typeof raw === 'object' ? raw : {});
    const sourceFileId = o.sourceFileId != null ? String(o.sourceFileId) : requestFileId;
    const fileId = o.fileId != null ? String(o.fileId) : sourceFileId;
    const idChanged = o.idChanged === true;
    const mainSkipped = inferMainSkipped(o, requestFileId);
    let idMappings = parseIdMappings(o.idMappings);
    if (idChanged && idMappings.length === 0) {
        idMappings = [{ sourceFileId, targetFileId: fileId }];
    }
    const relativePath = typeof o.relativePath === 'string' ? o.relativePath : undefined;
    return {
        fileId,
        sourceFileId,
        idChanged,
        name: typeof o.name === 'string' ? o.name : '',
        parentId: o.parentId != null ? String(o.parentId) : '',
        updateTime: typeof o.updateTime === 'number' ? o.updateTime : Date.now(),
        relativePath,
        idMappings: idChanged ? idMappings : undefined,
        mainSkipped: mainSkipped || undefined,
    };
}
function inferMainSkipped(o, requestFileId) {
    if (o.mainSkipped === true)
        return true;
    const skipped = o.skippedItems;
    if (!Array.isArray(skipped))
        return false;
    return skipped.some((item) => {
        if (item == null || typeof item !== 'object')
            return false;
        const id = item.fileId;
        return id != null && String(id) === requestFileId;
    });
}
function parseIdMappings(raw) {
    if (!Array.isArray(raw))
        return [];
    const out = [];
    for (const item of raw) {
        if (item == null || typeof item !== 'object')
            continue;
        const m = item;
        const sourceFileId = m.sourceFileId;
        const targetFileId = m.targetFileId;
        if (sourceFileId == null || targetFileId == null)
            continue;
        out.push({
            sourceFileId: String(sourceFileId),
            targetFileId: String(targetFileId),
        });
    }
    return out;
}
/** 请求带 rootFileId 但响应缺 relativePath 时打诊断日志 */
function warnMoveFileResponseGaps(result, requestFileId, sentRootFileId, mappingId) {
    if (String(result.sourceFileId) !== String(requestFileId)) {
        console.warn(`[KbMoveContract][${mappingId}] moveFile sourceFileId(${result.sourceFileId}) ≠ 请求 fileId(${requestFileId})`);
    }
    if (sentRootFileId && !result.relativePath) {
        console.warn(`[KbMoveContract][${mappingId}] moveFile 请求含 rootFileId 但响应无 relativePath，使用本地路径兜底`);
    }
    if (result.idChanged && (!result.idMappings || result.idMappings.length === 0)) {
        console.warn(`[KbMoveContract][${mappingId}] moveFile idChanged=true 但无 idMappings，已用 sourceFileId→fileId 兜底`);
    }
}
//# sourceMappingURL=kbMoveFileContract.js.map