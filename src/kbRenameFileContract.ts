import { UpdateFileNameResult } from './types';

/** updateFileName 成功响应最小契约（§4.1.1） */
export function normalizeUpdateFileNameResult(raw: unknown, requestFileId: string): UpdateFileNameResult {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
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
