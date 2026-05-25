"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.FileUploader = void 0;
const crypto = __importStar(require("crypto"));
const constants_1 = require("./constants");
/** 分片大小：5MB（MinIO 最低要求，最后一片可小于此值） */
const CHUNK_SIZE = 5 * 1024 * 1024;
/**
 * 文件上传器 —— 负责将文件内容上传到知识库。
 *
 * 流程：分片上传(getSliceIdByMd5V2 → PUT MinIO → uploadFileSliceV2 → saveResource)
 *       → 获得 resourceId
 *       → 新建文件: saveFileByPath
 *       → 更新版本: updateFileVersion
 */
class FileUploader {
    api;
    constructor(api) {
        this.api = api;
    }
    /**
     * 新建文件上传。
     * 1. 分片上传得到 resourceId
     * 2. 调用 saveFileByPath 在知识库中建立文件节点
     */
    async create(params) {
        const buf = Buffer.from(params.content, 'utf-8');
        const suffix = params.fileSuffix || extractSuffix(params.fileName);
        const resourceResult = await this.uploadToResource(buf, params.fileName, suffix);
        if (!resourceResult.ok)
            return { ok: false, error: resourceResult.error };
        const saveResult = await this.api.saveFileByPath({
            projectId: params.projectId,
            path: params.folderName || undefined,
            name: params.fileName,
            fileType: 'file',
            suffix,
            size: buf.length,
            resourceId: resourceResult.value,
            nameConflictStrategy: 1,
        });
        if (!saveResult.ok)
            return { ok: false, error: `saveFileByPath failed: ${saveResult.error}` };
        const fileId = String(saveResult.value);
        // saveFileByPath 不返回 parentId，通过 batchGetMeta 获取
        const metaResult = await this.api.batchGetMeta([fileId], params.projectId);
        let folderId = '';
        if (metaResult.ok && metaResult.value.length > 0) {
            folderId = metaResult.value[0].parentId != null ? String(metaResult.value[0].parentId) : '';
        }
        return {
            ok: true,
            value: { remoteFileId: fileId, remoteFolderId: folderId },
        };
    }
    /**
     * 更新已有文件（追加新版本）。
     * 1. 分片上传得到 resourceId
     * 2. 调用 updateFileVersion 绑定新版本
     */
    async update(params) {
        const buf = Buffer.from(params.content, 'utf-8');
        const suffix = params.fileSuffix || extractSuffix(params.fileName);
        const resourceResult = await this.uploadToResource(buf, params.fileName, suffix);
        if (!resourceResult.ok)
            return { ok: false, error: resourceResult.error };
        if (!params.projectId) {
            return { ok: false, error: 'updateFileVersion requires projectId' };
        }
        const versionResult = await this.api.updateFileVersion({
            id: params.updateFileId,
            projectId: params.projectId,
            resourceId: resourceResult.value,
            name: params.fileName,
            suffix,
            size: buf.length,
            versionRemark: 'OpenClaw Sync Agent',
        });
        if (!versionResult.ok) {
            return { ok: false, error: `updateFileVersion failed: ${versionResult.error}` };
        }
        return { ok: true, value: { remoteFileId: String(versionResult.value) } };
    }
    /**
     * 核心：将 Buffer 通过分片上传流程上传到文件服务，返回 resourceId。
     *
     * 流程（每个分片）：
     * 1. getSliceIdByMd5V2 预检 → 命中秒传则直接拿到 sliceId
     * 2. 未命中：PUT 二进制流到 MinIO 预签名 URL
     * 3. uploadFileSliceV2 注册分片 → 拿到 sliceId
     * 4. 所有分片完成后 saveResource 合并 → 拿到 resourceId
     */
    async uploadToResource(buf, fileName, suffix) {
        const sliceIds = [];
        const totalSize = buf.length;
        const chunkCount = Math.max(1, Math.ceil(totalSize / CHUNK_SIZE));
        for (let i = 0; i < chunkCount; i++) {
            const start = i * CHUNK_SIZE;
            const end = Math.min(start + CHUNK_SIZE, totalSize);
            const chunk = buf.subarray(start, end);
            const chunkMd5 = crypto.createHash('md5').update(chunk).digest('hex');
            const chunkSize = chunk.length;
            // Step 1: 预检
            const checkResult = await this.api.getSliceIdByMd5V2(chunkMd5, chunkSize, suffix);
            if (!checkResult.ok) {
                return { ok: false, error: `getSliceIdByMd5V2 failed (chunk ${i + 1}/${chunkCount}): ${checkResult.error}` };
            }
            const sliceData = checkResult.value;
            if (sliceData.sliceId) {
                // 秒传命中
                sliceIds.push(sliceData.sliceId);
                continue;
            }
            // Step 2: 物理上传到 MinIO
            if (!sliceData.uploadUrl) {
                return { ok: false, error: `getSliceIdByMd5V2 returned no uploadUrl and no sliceId (chunk ${i + 1}/${chunkCount})` };
            }
            const putResult = await this.putToMinIO(sliceData.uploadUrl, chunk);
            if (!putResult.ok) {
                return { ok: false, error: `MinIO PUT failed (chunk ${i + 1}/${chunkCount}): ${putResult.error}` };
            }
            // Step 3: 注册分片
            const registerResult = await this.api.uploadFileSliceV2({
                filePath: sliceData.fullPath,
                md5: chunkMd5,
                size: chunkSize,
                storageType: sliceData.storageType || 'MINIO',
            });
            if (!registerResult.ok) {
                return { ok: false, error: `uploadFileSliceV2 failed (chunk ${i + 1}/${chunkCount}): ${registerResult.error}` };
            }
            sliceIds.push(registerResult.value);
        }
        // Step 4: 合并所有分片
        const mergeResult = await this.api.saveResource({
            name: fileName,
            sliceIds,
            suffix,
            size: totalSize,
        });
        if (!mergeResult.ok) {
            return { ok: false, error: `saveResource failed: ${mergeResult.error}` };
        }
        return { ok: true, value: mergeResult.value };
    }
    /** 直接 PUT 二进制到 MinIO 预签名 URL */
    async putToMinIO(url, data) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), constants_1.REQUEST_TIMEOUT_MS * 2);
            try {
                const resp = await fetch(url, {
                    method: 'PUT',
                    body: data,
                    signal: controller.signal,
                });
                if (!resp.ok) {
                    const text = await resp.text().catch(() => '');
                    return { ok: false, error: `HTTP ${resp.status}: ${text.slice(0, 200)}` };
                }
            }
            finally {
                clearTimeout(timeoutId);
            }
            return { ok: true, value: undefined };
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            return { ok: false, error: msg };
        }
    }
}
exports.FileUploader = FileUploader;
function extractSuffix(fileName) {
    const dot = fileName.lastIndexOf('.');
    if (dot <= 0 || dot === fileName.length - 1)
        return undefined;
    return fileName.slice(dot + 1).toLowerCase();
}
//# sourceMappingURL=fileUploader.js.map