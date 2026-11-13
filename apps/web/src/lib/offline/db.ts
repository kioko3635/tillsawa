import type { OfflineSaleTransactionPayload, SyncTransactionItem } from '@pos/contracts';
import type { OfflineReferenceSnapshot, SyncTransactionResult } from '../api/types';

const DB_NAME = 'kenya-pos-offline';
const DB_VERSION = 2;
const OUTBOX_SCHEMA_VERSION = 2;

export type OfflineTransactionState =
  | 'draft_local'
  | 'pending_sync'
  | 'syncing'
  | 'synced'
  | 'conflict'
  | 'failed_retryable'
  | 'failed_permanent'
  | 'resolved_local';

export interface DeviceIdentityRecord {
  key: string;
  deviceId: string;
  organizationId: string;
  branchId: string;
  deviceKey?: string;
  deviceName?: string;
  registeredAt: string;
}

export interface OfflineSaleLocalDisplay {
  localReference: string;
  branchName: string;
  registerCode: string;
  registerName: string;
  cashierName: string;
  currencyCode: string;
  subtotal: string;
  discountTotal: string;
  taxTotal: string;
  total: string;
  amountTendered: string;
  change: string;
  lines: OfflineSaleTransactionPayload['snapshot']['lines'];
}

export interface OfflineTransaction {
  schemaVersion: number;
  clientTransactionId: string;
  syncRequestId?: string | undefined;
  entityType: string;
  payload: SyncTransactionItem;
  state: OfflineTransactionState;
  localDisplay?: OfflineSaleLocalDisplay | undefined;
  createdAt: string;
  updatedAt: string;
  queuedAt?: string | undefined;
  attempts: number;
  nextAttemptAt?: string | undefined;
  syncingStartedAt?: string | undefined;
  lastError?: { code: string; message: string; details?: unknown } | undefined;
  syncTransactionId?: string | undefined;
  serverSaleId?: string | undefined;
  serverReceiptNumber?: string | undefined;
  syncedAt?: string | undefined;
  resolvedAt?: string | undefined;
  resolutionAction?: string | undefined;
}

export interface SyncCursorRecord {
  entityType: string;
  cursor: number;
  updatedAt: string;
}

interface SyncMetaRecord {
  key: string;
  value: string;
  updatedAt: string;
}

interface ReferenceSnapshotRecord {
  key: string;
  schemaVersion: 1;
  organizationId: string;
  branchId: string;
  cashierMembershipId: string;
  snapshot: OfflineReferenceSnapshot;
  updatedAt: string;
}

interface CorruptedRecord {
  key: string;
  storeName: string;
  record: unknown;
  reason: string;
  createdAt: string;
}

function legacyState(state: unknown): OfflineTransactionState {
  switch (state) {
    case 'draft': return 'draft_local';
    case 'queued': return 'pending_sync';
    case 'sending': return 'pending_sync';
    case 'acknowledged': return 'synced';
    case 'rejected': return 'failed_permanent';
    case 'conflict': return 'conflict';
    default: return 'failed_permanent';
  }
}

function migrateLegacyRecord(record: unknown): OfflineTransaction {
  const legacy = typeof record === 'object' && record !== null ? record as Partial<OfflineTransaction> & { payload?: unknown } : {};
  const clientTransactionId = typeof legacy.clientTransactionId === 'string' ? legacy.clientTransactionId : crypto.randomUUID();
  const now = new Date().toISOString();
  return {
    schemaVersion: OUTBOX_SCHEMA_VERSION,
    clientTransactionId,
    entityType: typeof legacy.entityType === 'string' ? legacy.entityType : 'pos.sale',
    payload: (legacy.payload ?? {}) as SyncTransactionItem,
    state: legacyState(legacy.state),
    localDisplay: legacy.localDisplay,
    createdAt: legacy.createdAt ?? now,
    updatedAt: now,
    attempts: legacy.attempts ?? 0,
    lastError: legacy.lastError ?? { code: 'LOCAL_SCHEMA_MIGRATED', message: 'A version 1 outbox record was recovered during the schema upgrade.' }
  };
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      const upgrade = request.transaction!;
      if (!db.objectStoreNames.contains('device_identity')) db.createObjectStore('device_identity', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('sync_state')) db.createObjectStore('sync_state', { keyPath: 'entityType' });
      if (!db.objectStoreNames.contains('sync_meta')) db.createObjectStore('sync_meta', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('transaction_outbox')) db.createObjectStore('transaction_outbox', { keyPath: 'clientTransactionId' });
      if (!db.objectStoreNames.contains('rejected_transactions')) db.createObjectStore('rejected_transactions', { keyPath: 'clientTransactionId' });
      if (!db.objectStoreNames.contains('idempotency_index')) db.createObjectStore('idempotency_index', { keyPath: 'clientTransactionId' });
      if (!db.objectStoreNames.contains('reference_snapshots')) db.createObjectStore('reference_snapshots', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('corrupted_records')) db.createObjectStore('corrupted_records', { keyPath: 'key' });

      const outbox = upgrade.objectStore('transaction_outbox');
      if (!outbox.indexNames.contains('state')) outbox.createIndex('state', 'state');
      if (!outbox.indexNames.contains('createdAt')) outbox.createIndex('createdAt', 'createdAt');
      if (!outbox.indexNames.contains('deviceBranch')) outbox.createIndex('deviceBranch', ['payload.deviceId', 'payload.branchId']);
      const cursorRequest = outbox.openCursor();
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) return;
        const value = cursor.value as { schemaVersion?: number };
        if (value.schemaVersion !== OUTBOX_SCHEMA_VERSION) cursor.update(migrateLegacyRecord(value));
        cursor.continue();
      };
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Unable to open the offline database'));
    request.onblocked = () => reject(new Error('Offline database upgrade is blocked by another open tab'));
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction was aborted'));
  });
}

interface StoreContext {
  get<T>(store: string, key: IDBValidKey | IDBKeyRange): Promise<T | undefined>;
  getAll<T>(store: string): Promise<T[]>;
  put(store: string, value: unknown): Promise<IDBValidKey>;
  delete(store: string, key: IDBValidKey): Promise<void>;
}

async function withStores<T>(storeNames: string[], mode: IDBTransactionMode, work: (stores: StoreContext) => Promise<T>): Promise<T> {
  const db = await openDatabase();
  const tx = db.transaction(storeNames, mode);
  const stores: StoreContext = {
    get: async <V>(store: string, key: IDBValidKey | IDBKeyRange) => requestResult<V | undefined>(tx.objectStore(store).get(key)),
    getAll: async <V>(store: string) => requestResult<V[]>(tx.objectStore(store).getAll()),
    put: (store, value) => requestResult(tx.objectStore(store).put(value)),
    delete: (store, key) => requestResult(tx.objectStore(store).delete(key)).then(() => undefined)
  };
  try {
    const result = await work(stores);
    await transactionDone(tx);
    return result;
  } catch (error) {
    try {
      tx.abort();
    } catch {
      // The transaction may already have completed or aborted.
    }
    throw error;
  } finally {
    db.close();
  }
}

function validOutboxRecord(record: unknown): record is OfflineTransaction {
  if (typeof record !== 'object' || record === null) return false;
  const value = record as Partial<OfflineTransaction>;
  return value.schemaVersion === OUTBOX_SCHEMA_VERSION
    && typeof value.clientTransactionId === 'string'
    && typeof value.entityType === 'string'
    && typeof value.state === 'string'
    && typeof value.createdAt === 'string'
    && typeof value.payload === 'object';
}

export async function saveDeviceIdentity(identity: Omit<DeviceIdentityRecord, 'registeredAt'> & { registeredAt?: string }): Promise<void> {
  await withStores(['device_identity'], 'readwrite', async (stores) => {
    await stores.put('device_identity', { ...identity, registeredAt: identity.registeredAt ?? new Date().toISOString() });
  });
}

export async function getDeviceIdentity(key = 'current'): Promise<DeviceIdentityRecord | undefined> {
  return withStores(['device_identity'], 'readonly', async (stores) => stores.get<DeviceIdentityRecord>('device_identity', key));
}

export async function queueOfflineTransaction(record: OfflineTransaction): Promise<OfflineTransaction> {
  return withStores(['transaction_outbox'], 'readwrite', async (stores) => {
    const existing = await stores.get<OfflineTransaction>('transaction_outbox', record.clientTransactionId);
    if (existing) {
      if (JSON.stringify(existing.payload) === JSON.stringify(record.payload)) return existing;
      throw new Error('A different transaction already uses this local transaction ID');
    }
    const stored: OfflineTransaction = {
      ...record,
      schemaVersion: OUTBOX_SCHEMA_VERSION,
      syncRequestId: record.syncRequestId ?? record.clientTransactionId,
      state: record.state === 'draft_local' ? 'pending_sync' : record.state,
      updatedAt: new Date().toISOString()
    };
    await stores.put('transaction_outbox', stored);
    return stored;
  });
}

export async function putOfflineTransaction(record: OfflineTransaction): Promise<OfflineTransaction> {
  const stored = { ...record, schemaVersion: OUTBOX_SCHEMA_VERSION, updatedAt: new Date().toISOString() };
  await withStores(['transaction_outbox'], 'readwrite', async (stores) => {
    await stores.put('transaction_outbox', stored);
  });
  return stored;
}

export async function getOfflineTransaction(clientTransactionId: string): Promise<OfflineTransaction | undefined> {
  return withStores(['transaction_outbox', 'corrupted_records'], 'readwrite', async (stores) => {
    const record = await stores.get<OfflineTransaction>('transaction_outbox', clientTransactionId);
    if (!record) return undefined;
    if (validOutboxRecord(record)) return record;
    await stores.put('corrupted_records', {
      key: `outbox:${clientTransactionId}`,
      storeName: 'transaction_outbox',
      record,
      reason: 'Invalid outbox schema',
      createdAt: new Date().toISOString()
    } satisfies CorruptedRecord);
    return undefined;
  });
}

export async function updateOfflineTransaction(
  clientTransactionId: string,
  update: (record: OfflineTransaction) => OfflineTransaction
): Promise<OfflineTransaction | undefined> {
  return withStores(['transaction_outbox'], 'readwrite', async (stores) => {
    const record = await stores.get<OfflineTransaction>('transaction_outbox', clientTransactionId);
    if (!record || !validOutboxRecord(record)) return undefined;
    const updated = { ...update(record), schemaVersion: OUTBOX_SCHEMA_VERSION, updatedAt: new Date().toISOString() };
    await stores.put('transaction_outbox', updated);
    return updated;
  });
}

export async function listOutboxTransactions(filter: { deviceId?: string; branchId?: string; cashierMembershipId?: string } = {}): Promise<OfflineTransaction[]> {
  return withStores(['transaction_outbox', 'corrupted_records'], 'readwrite', async (stores) => {
    const records = await stores.getAll<OfflineTransaction>('transaction_outbox');
    const valid: OfflineTransaction[] = [];
    for (const record of records) {
      if (validOutboxRecord(record)) {
        valid.push(record);
      } else {
        const id = typeof (record as { clientTransactionId?: unknown }).clientTransactionId === 'string'
          ? (record as { clientTransactionId: string }).clientTransactionId
          : crypto.randomUUID();
        await stores.put('corrupted_records', {
          key: `outbox:${id}`,
          storeName: 'transaction_outbox',
          record,
          reason: 'Invalid outbox schema',
          createdAt: new Date().toISOString()
        } satisfies CorruptedRecord);
        await stores.delete('transaction_outbox', id);
      }
    }
    return valid
      .filter((record) =>
        (!filter.deviceId || record.payload.deviceId === filter.deviceId)
        && (!filter.branchId || record.payload.branchId === filter.branchId)
        && (!filter.cashierMembershipId || record.payload.cashierMembershipId === filter.cashierMembershipId)
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  });
}

export async function recoverInterruptedTransactions(now = new Date()): Promise<number> {
  return withStores(['transaction_outbox'], 'readwrite', async (stores) => {
    const records = await stores.getAll<OfflineTransaction>('transaction_outbox');
    let recovered = 0;
    for (const record of records) {
      if (!validOutboxRecord(record) || record.state !== 'syncing') continue;
      await stores.put('transaction_outbox', {
        ...record,
        state: 'failed_retryable',
        syncingStartedAt: undefined,
        nextAttemptAt: now.toISOString(),
        lastError: { code: 'SYNC_INTERRUPTED', message: 'Synchronization was interrupted; the transaction was recovered for retry.' },
        updatedAt: now.toISOString()
      });
      recovered += 1;
    }
    return recovered;
  });
}

export async function saveReferenceSnapshot(snapshot: OfflineReferenceSnapshot): Promise<void> {
  const key = `${snapshot.organization.id}:${snapshot.branch.id}:${snapshot.cashierMembershipId}`;
  await withStores(['reference_snapshots'], 'readwrite', async (stores) => {
    await stores.put('reference_snapshots', {
      key,
      schemaVersion: 1,
      organizationId: snapshot.organization.id,
      branchId: snapshot.branch.id,
      cashierMembershipId: snapshot.cashierMembershipId,
      snapshot,
      updatedAt: new Date().toISOString()
    } satisfies ReferenceSnapshotRecord);
  });
}

export async function getReferenceSnapshot(organizationId: string, branchId: string, cashierMembershipId: string): Promise<OfflineReferenceSnapshot | undefined> {
  const record = await withStores(['reference_snapshots'], 'readonly', async (stores) =>
    stores.get<ReferenceSnapshotRecord>('reference_snapshots', `${organizationId}:${branchId}:${cashierMembershipId}`)
  );
  return record?.schemaVersion === 1 ? record.snapshot : undefined;
}

export async function saveSyncCursor(record: SyncCursorRecord): Promise<void> {
  await withStores(['sync_state'], 'readwrite', async (stores) => {
    await stores.put('sync_state', record);
  });
}

export async function getSyncCursor(entityType: string): Promise<SyncCursorRecord | undefined> {
  return withStores(['sync_state'], 'readonly', async (stores) => stores.get<SyncCursorRecord>('sync_state', entityType));
}

export async function setSyncMeta(key: string, value: string): Promise<void> {
  await withStores(['sync_meta'], 'readwrite', async (stores) => {
    await stores.put('sync_meta', { key, value, updatedAt: new Date().toISOString() } satisfies SyncMetaRecord);
  });
}

export async function getSyncMeta(key: string): Promise<string | undefined> {
  const record = await withStores(['sync_meta'], 'readonly', async (stores) => stores.get<SyncMetaRecord>('sync_meta', key));
  return record?.value;
}

export interface OutboxSummary {
  pending: number;
  syncing: number;
  conflicts: number;
  retryable: number;
  permanent: number;
  resolvedLocal: number;
  synced: number;
  unresolved: number;
  lastSuccessfulSyncAt?: string | undefined;
}

export async function getOutboxSummary(filter: { deviceId?: string; branchId?: string; cashierMembershipId?: string } = {}): Promise<OutboxSummary> {
  const [records, lastSuccessfulSyncAt] = await Promise.all([listOutboxTransactions(filter), getSyncMeta('lastSuccessfulSyncAt')]);
  const summary: OutboxSummary = {
    pending: 0,
    syncing: 0,
    conflicts: 0,
    retryable: 0,
    permanent: 0,
    resolvedLocal: 0,
    synced: 0,
    unresolved: 0,
    lastSuccessfulSyncAt
  };
  for (const record of records) {
    if (record.state === 'pending_sync') summary.pending += 1;
    else if (record.state === 'syncing') summary.syncing += 1;
    else if (record.state === 'conflict') summary.conflicts += 1;
    else if (record.state === 'failed_retryable') summary.retryable += 1;
    else if (record.state === 'failed_permanent') summary.permanent += 1;
    else if (record.state === 'resolved_local') summary.resolvedLocal += 1;
    else if (record.state === 'synced') summary.synced += 1;
  }
  summary.unresolved = summary.pending + summary.syncing + summary.conflicts + summary.retryable + summary.permanent;
  return summary;
}

export function applyServerOutcome(record: OfflineTransaction, outcome: SyncTransactionResult): OfflineTransaction {
  const common = {
    ...record,
    syncTransactionId: outcome.syncTransactionId,
    updatedAt: new Date().toISOString()
  };
  if (outcome.status === 'accepted' || outcome.status === 'duplicate') {
    return {
      ...common,
      state: 'synced',
      syncingStartedAt: undefined,
      nextAttemptAt: undefined,
      serverSaleId: outcome.saleId ?? outcome.serverEntityId ?? undefined,
      serverReceiptNumber: outcome.receiptNumber ?? undefined,
      syncedAt: outcome.processedAt ?? new Date().toISOString(),
      lastError: undefined
    };
  }
  if (outcome.status === 'conflict') {
    return {
      ...common,
      state: 'conflict',
      syncingStartedAt: undefined,
      nextAttemptAt: undefined,
      lastError: outcome.error ?? undefined
    };
  }
  if (outcome.status === 'resolved') {
    return {
      ...common,
      state: 'resolved_local',
      syncingStartedAt: undefined,
      resolvedAt: outcome.resolvedAt ?? new Date().toISOString(),
      resolutionAction: outcome.resolutionAction ?? undefined
    };
  }
  if (outcome.status === 'retryable') {
    return {
      ...common,
      state: 'failed_retryable',
      syncingStartedAt: undefined,
      nextAttemptAt: nextRetryAt(record.attempts + 1),
      lastError: outcome.error ?? { code: 'SYNC_RETRYABLE', message: 'Synchronization can be retried.' }
    };
  }
  return {
    ...common,
    state: 'failed_permanent',
    syncingStartedAt: undefined,
    nextAttemptAt: undefined,
    lastError: outcome.error ?? { code: 'SYNC_REJECTED', message: 'The server permanently rejected this transaction.' }
  };
}

export function nextRetryAt(attempts: number, now = Date.now()): string {
  const delay = Math.min(60_000, 1_000 * 2 ** Math.min(attempts, 6));
  const jitter = Math.floor(Math.random() * 250);
  return new Date(now + delay + jitter).toISOString();
}
