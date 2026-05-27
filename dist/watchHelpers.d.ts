import { SyncConfig, SyncMapping, SyncTriggerReason } from './types';
export declare function needsPush(mapping: SyncMapping, globalDirection: SyncConfig['syncDirection']): boolean;
export declare function needsPull(mapping: SyncMapping, globalDirection: SyncConfig['syncDirection']): boolean;
export declare function resolveWatchEnabled(mapping: SyncMapping, config: SyncConfig): boolean;
export declare function resolvePushDebounceMs(mapping: SyncMapping, config: SyncConfig): number;
export declare function resolveWatchUsePolling(mapping: SyncMapping, config: SyncConfig): boolean;
export declare function formatSyncTriggerReason(reason: SyncTriggerReason): string;
//# sourceMappingURL=watchHelpers.d.ts.map