import { LocalFsAdapter } from './localFs';
import { RemoteFsAdapter } from './remoteFs';
import { SyncStateDb } from './syncStateDb';
import { SyncMapping } from './types';
/**
 * 映射索引独立通道：根目录 `.openclaw-sync-map.json`（全量 local_path → remoteFileId）。
 * 不参与 SyncEngine 路径对账。
 */
export declare class FileIndexService {
    private readonly db;
    private readonly remoteFs;
    private readonly localFs;
    private readonly mapping;
    constructor(db: SyncStateDb, remoteFs: RemoteFsAdapter, localFs: LocalFsAdapter, mapping: SyncMapping);
    private log;
    private warn;
    private delay;
    /** Pull / bidirectional：同步开始前从 KB 拉取索引到本地 */
    consumeIndex(): Promise<void>;
    /** Push / bidirectional：主 sync 成功后 publish 索引到 KB */
    publishIndex(): Promise<void>;
    private syncIndexHashFromRemote;
    private buildFilesMap;
    private buildIndexJson;
    private locateRemoteIndexFileId;
}
//# sourceMappingURL=fileIndexService.d.ts.map