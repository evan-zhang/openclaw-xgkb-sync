import { Database } from 'node-sqlite3-wasm';
import { FileState, MappingState } from './types';
import { DEFAULT_DB_PATH } from './constants';

/** SQLite 状态库（使用 node-sqlite3-wasm，无需原生编译） */
export class SyncStateDb {
  private readonly db: Database;

  constructor(dbPath: string = DEFAULT_DB_PATH) {
    this.db = new Database(dbPath);
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS sync_mapping_state (
        mapping_id              TEXT    PRIMARY KEY,
        last_sync_since         INTEGER,
        last_server_time        INTEGER,
        last_success_at         INTEGER,
        last_full_scan_at       INTEGER,
        last_error              TEXT,
        last_stats_json         TEXT,
        resolved_root_file_id   TEXT,
        resolved_project_id     TEXT
      );

      CREATE TABLE IF NOT EXISTS sync_file_state (
        mapping_id            TEXT    NOT NULL,
        local_path            TEXT    NOT NULL,
        remote_file_id        TEXT,
        remote_folder_id      TEXT,
        local_mtime           INTEGER,
        remote_mtime          INTEGER,
        content_hash          TEXT,
        sync_status           TEXT    NOT NULL DEFAULT 'done',
        last_sync_at          INTEGER,
        last_error            TEXT,
        local_dev             INTEGER,
        local_ino             INTEGER,
        remote_relative_path  TEXT,
        PRIMARY KEY (mapping_id, local_path)
      );

      CREATE INDEX IF NOT EXISTS idx_sync_file_remote_id
        ON sync_file_state (mapping_id, remote_file_id);

      CREATE TABLE IF NOT EXISTS sync_op_log (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        idempotency_key   TEXT    UNIQUE,
        mapping_id        TEXT,
        op_type           TEXT,
        target            TEXT,
        request_payload   TEXT,
        result_payload    TEXT,
        created_at        INTEGER
      );
    `);

    // 迁移：为旧版本数据库添加新列（ADD COLUMN 在列已存在时会抛异常，用 try/catch 处理）
    const migrations = [
      'ALTER TABLE sync_mapping_state ADD COLUMN resolved_root_file_id TEXT',
      'ALTER TABLE sync_mapping_state ADD COLUMN resolved_project_id TEXT',
      'ALTER TABLE sync_mapping_state ADD COLUMN last_stats_json TEXT',
      'ALTER TABLE sync_mapping_state ADD COLUMN last_full_scan_at INTEGER',
      // Phase 0 迁移：inode 追踪与远端路径记录
      'ALTER TABLE sync_file_state ADD COLUMN local_dev INTEGER',
      'ALTER TABLE sync_file_state ADD COLUMN local_ino INTEGER',
      'ALTER TABLE sync_file_state ADD COLUMN remote_relative_path TEXT',
    ];
    for (const sql of migrations) {
      try {
        this.db.exec(sql);
      } catch {
        // 列已存在，忽略
      }
    }

    // 依赖新增列（local_dev/local_ino）的索引必须在迁移后创建，
    // 否则旧库（缺列）会在 initSchema 阶段直接报 "no such column"。
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_sync_file_local_key
        ON sync_file_state (mapping_id, local_dev, local_ino)
        WHERE local_dev IS NOT NULL AND local_ino IS NOT NULL AND local_ino != 0;
    `);
  }

  // ==================== mapping 状态 ====================

  getMappingState(mappingId: string): MappingState | undefined {
    const rows = this.db.all(
      'SELECT * FROM sync_mapping_state WHERE mapping_id = ?',
      [mappingId],
    ) as unknown as RawMappingState[];
    return rows.length > 0 ? rowToMappingState(rows[0]) : undefined;
  }

  upsertMappingState(
    state: Partial<Omit<MappingState, 'mappingId'>> & { mappingId: string },
  ): void {
    this.db.run(
      `INSERT INTO sync_mapping_state
         (mapping_id, last_sync_since, last_server_time, last_success_at, last_error,
          last_full_scan_at, last_stats_json, resolved_root_file_id, resolved_project_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(mapping_id) DO UPDATE SET
         last_sync_since       = COALESCE(excluded.last_sync_since,       last_sync_since),
         last_server_time      = COALESCE(excluded.last_server_time,      last_server_time),
         last_success_at       = COALESCE(excluded.last_success_at,       last_success_at),
         last_full_scan_at     = COALESCE(excluded.last_full_scan_at,     last_full_scan_at),
         last_error            = excluded.last_error,
         last_stats_json       = COALESCE(excluded.last_stats_json,       last_stats_json),
         resolved_root_file_id = COALESCE(excluded.resolved_root_file_id, resolved_root_file_id),
         resolved_project_id   = COALESCE(excluded.resolved_project_id,   resolved_project_id)`,
      [
        state.mappingId,
        state.lastSyncSince ?? null,
        state.lastServerTime ?? null,
        state.lastSuccessAt ?? null,
        state.lastError ?? null,
        state.lastFullScanAt ?? null,
        state.lastStats ? JSON.stringify(state.lastStats) : null,
        state.resolvedRootFileId ?? null,
        state.resolvedProjectId ?? null,
      ],
    );
  }

  /**
   * 主动清除 mapping 的远端 ID 缓存（resolved_root_file_id / resolved_project_id）。
   * 在修改 remoteRootFolderPath / projectId 配置后调用，强制下次启动重新解析。
   */
  clearResolvedCache(mappingId: string): void {
    this.db.run(
      `UPDATE sync_mapping_state
       SET resolved_root_file_id = NULL, resolved_project_id = NULL
       WHERE mapping_id = ?`,
      [mappingId],
    );
  }

  /**
   * 完全重置 mapping 的同步状态：
   * 1. 删除所有文件记录（sync_file_state）
   * 2. 重置同步水位（last_sync_since → NULL，下次强制全量对账）
   * 3. 清除远端 ID 缓存（resolved_root_file_id / resolved_project_id）
   *
   * 适用于修改了"身份字段"（localRoot / remoteRootFolderPath / projectId / appKey）之后，
   * 避免旧文件状态与新配置的同步目标产生错误决策。
   */
  resetMappingState(mappingId: string): void {
    this.db.exec('BEGIN');
    try {
      this.db.run('DELETE FROM sync_file_state WHERE mapping_id = ?', [mappingId]);
      this.db.run(
        `UPDATE sync_mapping_state
         SET last_sync_since       = NULL,
             last_server_time      = NULL,
             last_success_at       = NULL,
             last_full_scan_at     = NULL,
             last_error            = NULL,
             last_stats_json       = NULL,
             resolved_root_file_id = NULL,
             resolved_project_id   = NULL
         WHERE mapping_id = ?`,
        [mappingId],
      );
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  // ==================== 文件状态 ====================

  getFileState(mappingId: string, localPath: string): FileState | undefined {
    const rows = this.db.all(
      'SELECT * FROM sync_file_state WHERE mapping_id = ? AND local_path = ?',
      [mappingId, localPath],
    ) as unknown as RawFileState[];
    return rows.length > 0 ? rowToFileState(rows[0]) : undefined;
  }

  getFileStateByRemoteId(mappingId: string, remoteFileId: string): FileState | undefined {
    const rows = this.db.all(
      'SELECT * FROM sync_file_state WHERE mapping_id = ? AND remote_file_id = ?',
      [mappingId, remoteFileId],
    ) as unknown as RawFileState[];
    return rows.length > 0 ? rowToFileState(rows[0]) : undefined;
  }

  getAllFileStates(mappingId: string): FileState[] {
    const rows = this.db.all(
      'SELECT * FROM sync_file_state WHERE mapping_id = ?',
      [mappingId],
    ) as unknown as RawFileState[];
    return rows.map(rowToFileState);
  }

  upsertFileState(state: FileState): void {
    this.db.run(
      `INSERT OR REPLACE INTO sync_file_state
         (mapping_id, local_path, remote_file_id, remote_folder_id,
          local_mtime, remote_mtime, content_hash, sync_status, last_sync_at, last_error,
          local_dev, local_ino, remote_relative_path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        state.mappingId,
        state.localPath,
        state.remoteFileId ?? null,
        state.remoteFolderId ?? null,
        state.localMtime ?? null,
        state.remoteMtime ?? null,
        state.contentHash ?? null,
        state.syncStatus,
        state.lastSyncAt ?? null,
        state.lastError ?? null,
        state.localDev ?? null,
        state.localIno ?? null,
        state.remoteRelativePath ?? null,
      ],
    );
  }

  /**
   * 通过 inode 标识查找文件状态。
   * dev=0 或 ino=0 时直接返回 undefined（平台不支持，退化为路径查找）。
   */
  getFileStateByLocalKey(mappingId: string, dev: number, ino: number): FileState | undefined {
    if (dev === 0 || ino === 0) return undefined;
    const rows = this.db.all(
      'SELECT * FROM sync_file_state WHERE mapping_id = ? AND local_dev = ? AND local_ino = ?',
      [mappingId, dev, ino],
    ) as unknown as RawFileState[];
    return rows.length > 0 ? rowToFileState(rows[0]) : undefined;
  }

  /**
   * 批量更新因 moveFile(cover) 导致的远端 fileId 变更。
   * 适用于移动目录时子节点 fileId 随覆盖策略发生变更的场景。
   */
  applyRemoteIdMappings(
    mappingId: string,
    mappings: Array<{ sourceFileId: string; targetFileId: string }>,
  ): void {
    if (mappings.length === 0) return;
    this.db.exec('BEGIN');
    try {
      for (const { sourceFileId, targetFileId } of mappings) {
        this.db.run(
          'UPDATE sync_file_state SET remote_file_id = ? WHERE mapping_id = ? AND remote_file_id = ?',
          [targetFileId, mappingId, sourceFileId],
        );
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /**
   * 在单次事务中批量写入多条文件状态，比逐条写入快 10x 以上。
   * 用于同步完成后批量提交结果。
   */
  upsertFileStateBatch(states: FileState[]): void {
    if (states.length === 0) return;
    this.db.exec('BEGIN');
    try {
      for (const state of states) {
        this.upsertFileState(state);
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  deleteFileState(mappingId: string, localPath: string): void {
    this.db.run(
      'DELETE FROM sync_file_state WHERE mapping_id = ? AND local_path = ?',
      [mappingId, localPath],
    );
  }

  /** 清除某 mapping 所有文件状态（用于强制全量重建） */
  clearMappingFiles(mappingId: string): void {
    this.db.run('DELETE FROM sync_file_state WHERE mapping_id = ?', [mappingId]);
  }

  // ==================== 操作日志 ====================

  insertOpLog(entry: {
    idempotencyKey: string;
    mappingId: string;
    opType: string;
    target: string;
    requestPayload?: unknown;
    resultPayload?: unknown;
  }): void {
    try {
      this.db.run(
        `INSERT OR IGNORE INTO sync_op_log
           (idempotency_key, mapping_id, op_type, target, request_payload, result_payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          entry.idempotencyKey,
          entry.mappingId,
          entry.opType,
          entry.target,
          entry.requestPayload ? JSON.stringify(entry.requestPayload) : null,
          entry.resultPayload ? JSON.stringify(entry.resultPayload) : null,
          Date.now(),
        ],
      );
    } catch {
      // 日志写入失败不影响主流程
    }
  }

  close(): void {
    this.db.close();
  }
}

// ==================== 内部 Row 类型（与数据库列名对应） ====================

interface RawMappingState {
  mapping_id: string;
  last_sync_since: number | null;
  last_server_time: number | null;
  last_success_at: number | null;
  last_full_scan_at: number | null;
  last_error: string | null;
  last_stats_json: string | null;
  resolved_root_file_id: string | null;
  resolved_project_id: string | null;
}

interface RawFileState {
  mapping_id: string;
  local_path: string;
  remote_file_id: string | null;
  remote_folder_id: string | null;
  local_mtime: number | null;
  remote_mtime: number | null;
  content_hash: string | null;
  sync_status: string;
  last_sync_at: number | null;
  last_error: string | null;
  local_dev: number | null;
  local_ino: number | null;
  remote_relative_path: string | null;
}

function rowToMappingState(row: RawMappingState): MappingState {
  return {
    mappingId: row.mapping_id,
    lastSyncSince: row.last_sync_since,
    lastServerTime: row.last_server_time,
    lastSuccessAt: row.last_success_at,
    lastFullScanAt: row.last_full_scan_at,
    lastError: row.last_error,
    lastStats: parseStats(row.last_stats_json),
    resolvedRootFileId: row.resolved_root_file_id,
    resolvedProjectId: row.resolved_project_id,
  };
}

function parseStats(raw: string | null): MappingState['lastStats'] {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as MappingState['lastStats'];
  } catch {
    return null;
  }
}

function rowToFileState(row: RawFileState): FileState {
  return {
    mappingId: row.mapping_id,
    localPath: row.local_path,
    remoteFileId: row.remote_file_id,
    remoteFolderId: row.remote_folder_id,
    localMtime: row.local_mtime,
    remoteMtime: row.remote_mtime,
    contentHash: row.content_hash,
    syncStatus: row.sync_status as FileState['syncStatus'],
    lastSyncAt: row.last_sync_at,
    lastError: row.last_error,
    localDev: row.local_dev,
    localIno: row.local_ino,
    remoteRelativePath: row.remote_relative_path,
  };
}
