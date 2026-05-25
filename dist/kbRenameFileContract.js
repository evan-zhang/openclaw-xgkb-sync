"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeUpdateFileNameResult = normalizeUpdateFileNameResult;
/** updateFileName 成功响应最小契约（§4.1.1） */
function normalizeUpdateFileNameResult(raw, requestFileId) {
    const o = (raw && typeof raw === 'object' ? raw : {});
    const fileId = o.fileId != null ? String(o.fileId) : requestFileId;
    const name = typeof o.name === 'string' ? o.name : '';
    return {
        fileId,
        name,
        parentId: o.parentId != null ? String(o.parentId) : undefined,
        updateTime: typeof o.updateTime === 'number' ? o.updateTime : undefined,
        relativePath: typeof o.relativePath === 'string' ? o.relativePath : undefined,
        renamedDueToConflict: o.renamedDueToConflict === true,
    };
}
//# sourceMappingURL=kbRenameFileContract.js.map