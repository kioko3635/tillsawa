import { SYNC_CONTRACT_VERSION, type ResolveSyncTransactionInput } from '@pos/contracts';
import { api, ApiError } from '../api/client';
import type { OfflineReferenceSnapshot, SyncTransactionResult } from '../api/types';
import {
  applyServerOutcome,
  getDeviceIdentity,
  getOutboxSummary,
  getReferenceSnapshot,
  listOutboxTransactions,
  nextRetryAt,
  putOfflineTransaction,
  recoverInterruptedTransactions,
  saveReferenceSnapshot,
  setSyncMeta,
  updateOfflineTransaction,
  type DeviceIdentityRecord,
  type OfflineTransaction,
  type OutboxSummary
} from './db';

type Listener = () => void;
const listeners = new Set<Listener>();
let syncInFlight: Promise<OutboxSummary> | null = null;

export function subscribeOutbox(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notifyOutboxChanged(): void {
  for (const listener of listeners) listener();
}

function retryableError(error: unknown): { code: string; message: string; details?: unknown } {
  if (error instanceof ApiError) return { code: error.code, message: error.message, details: error.details };
  return { code: 'NETWORK_UNAVAILABLE', message: 'The server could not be reached. The sale remains queued on this device.' };
}

function failedStateFor(error: unknown): 'failed_retryable' | 'failed_permanent' | 'conflict' {
  if (!(error instanceof ApiError)) return 'failed_retryable';
  if (error.status === 401 || error.status === 408 || error.status === 429 || error.status >= 500) return 'failed_retryable';
  if (['DEVICE_NOT_REGISTERED', 'DEVICE_KEY_INVALID', 'BRANCH_ACCESS_DENIED', 'SYNC_CONTRACT_UNSUPPORTED'].includes(error.code)) return 'conflict';
  return 'failed_permanent';
}

export async function refreshReferenceSnapshot(identity: DeviceIdentityRecord): Promise<OfflineReferenceSnapshot> {
  const response = await api.syncBootstrap(identity.deviceId);
  await saveReferenceSnapshot(response.bootstrap.snapshot);
  return response.bootstrap.snapshot;
}

export async function currentReferenceSnapshot(organizationId: string, branchId: string, membershipId: string): Promise<OfflineReferenceSnapshot | undefined> {
  return getReferenceSnapshot(organizationId, branchId, membershipId);
}

export async function synchronizeOutbox(cashierMembershipId?: string): Promise<OutboxSummary> {
  syncInFlight ??= synchronizeOutboxInternal(cashierMembershipId).finally(() => {
    syncInFlight = null;
    notifyOutboxChanged();
  });
  return syncInFlight;
}

async function synchronizeOutboxInternal(cashierMembershipId?: string): Promise<OutboxSummary> {
  await recoverInterruptedTransactions();
  const identity = await getDeviceIdentity();
  if (!identity) return getOutboxSummary();

  const records = await listOutboxTransactions();
  const now = Date.now();
  const eligible = records
    .filter((record) =>
      ['pending_sync', 'failed_retryable'].includes(record.state)
      && record.payload.deviceId === identity.deviceId
      && (!cashierMembershipId || record.payload.cashierMembershipId === cashierMembershipId)
      && (!record.nextAttemptAt || Date.parse(record.nextAttemptAt) <= now)
    )
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));

  for (const record of eligible) {
    const syncing = await updateOfflineTransaction(record.clientTransactionId, (current) => ({
      ...current,
      state: 'syncing',
      attempts: current.attempts + 1,
      syncingStartedAt: new Date().toISOString(),
      lastError: undefined
    }));
    notifyOutboxChanged();
    if (!syncing) continue;
    try {
      const response = await api.syncTransactions({
        batchId: record.syncRequestId ?? record.clientTransactionId,
        deviceId: identity.deviceId,
        contractVersion: SYNC_CONTRACT_VERSION,
        transactions: [record.payload]
      });
      const outcome = response.results.find((item) => item.clientTransactionId === record.clientTransactionId) ?? response.results[0];
      if (!outcome) throw new ApiError(500, 'INVALID_SYNC_RESPONSE', 'The server returned no synchronization result');
      await updateOfflineTransaction(record.clientTransactionId, (current) => applyServerOutcome(current, outcome));
      await setSyncMeta('lastSuccessfulSyncAt', response.serverTime);
    } catch (error) {
      const state = failedStateFor(error);
      await updateOfflineTransaction(record.clientTransactionId, (current) => ({
        ...current,
        state,
        syncingStartedAt: undefined,
        nextAttemptAt: state === 'failed_retryable' ? nextRetryAt(current.attempts) : undefined,
        lastError: retryableError(error)
      }));
    }
    notifyOutboxChanged();
  }

  try {
    await refreshReferenceSnapshot(identity);
  } catch {
    // A failed reference pull must not erase accepted transaction results.
  }
  return getOutboxSummary({ deviceId: identity.deviceId });
}

export async function resolveOutboxConflict(
  record: OfflineTransaction,
  input: ResolveSyncTransactionInput
): Promise<SyncTransactionResult> {
  const identity = await getDeviceIdentity();
  if (!identity || !record.syncTransactionId) {
    throw new ApiError(400, 'SYNC_RECORD_UNAVAILABLE', 'The server synchronization record is unavailable');
  }
  const response = await api.resolveSyncTransaction(identity.deviceId, record.syncTransactionId, input);
  const outcome = response.transaction;
  await updateOfflineTransaction(record.clientTransactionId, (current) => {
    if (outcome.status === 'pending') {
      return {
        ...current,
        state: 'pending_sync',
        nextAttemptAt: new Date().toISOString(),
        lastError: undefined,
        resolutionAction: outcome.resolutionAction ?? undefined,
        syncRequestId: crypto.randomUUID()
      };
    }
    return applyServerOutcome(current, outcome);
  });
  notifyOutboxChanged();
  return outcome;
}

export async function markQueuedRecordSaved(record: OfflineTransaction): Promise<OfflineTransaction> {
  const saved = await putOfflineTransaction({ ...record, state: 'pending_sync' });
  notifyOutboxChanged();
  return saved;
}

export async function decrementSnapshotStock(
  snapshot: OfflineReferenceSnapshot,
  lines: Array<{ productId: string; quantity: number }>
): Promise<OfflineReferenceSnapshot> {
  const updated: OfflineReferenceSnapshot = {
    ...snapshot,
    products: snapshot.products.map((product) => {
      const line = lines.find((item) => item.productId === product.id);
      if (!line || product.itemType !== 'stocked') return product;
      return { ...product, onHandQty: String(Math.max(0, Number(product.onHandQty) - line.quantity)) };
    })
  };
  await saveReferenceSnapshot(updated);
  return updated;
}

export async function initializeOfflineStore(): Promise<void> {
  await recoverInterruptedTransactions();
  notifyOutboxChanged();
}
