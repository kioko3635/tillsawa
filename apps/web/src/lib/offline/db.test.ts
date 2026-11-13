import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyServerOutcome,
  getOfflineTransaction,
  getOutboxSummary,
  nextRetryAt,
  putOfflineTransaction,
  queueOfflineTransaction,
  recoverInterruptedTransactions,
  type OfflineTransaction
} from './db';

function resetDatabase(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase('kenya-pos-offline');
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error('Unable to reset the offline test database'));
    request.onblocked = () => resolve();
  });
}

function record(): OfflineTransaction {
  return {
    schemaVersion: 2,
    clientTransactionId: '7d0fd9d5-0efc-4b23-8f21-1ecbc4cf01ef',
    entityType: 'pos.sale',
    payload: {
      clientTransactionId: '7d0fd9d5-0efc-4b23-8f21-1ecbc4cf01ef',
      entityType: 'pos.sale',
      occurredAt: '2026-10-18T12:00:00.000Z',
      branchId: 'f88a1e24-7b0f-43b2-92fc-cf623d36280d',
      deviceId: '3e119c89-37c9-4a75-b8b7-54742eb2f954',
      registerSessionId: '2f01ce6b-8e1d-4c0c-9174-0f5f8e9ec0c0',
      cashierMembershipId: 'c6b95f93-2c61-478a-85e0-997d4fc6d744',
      payload: {}
    },
    state: 'syncing',
    createdAt: '2026-10-18T12:00:00.000Z',
    updatedAt: '2026-10-18T12:00:00.000Z',
    attempts: 1,
    syncingStartedAt: '2026-10-18T12:01:00.000Z'
  };
}

describe('offline outbox lifecycle', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('persists a queued transaction in IndexedDB with a stable retry request ID', async () => {
    const queued = await queueOfflineTransaction({ ...record(), state: 'draft_local', attempts: 0 });
    expect(queued.state).toBe('pending_sync');
    expect(queued.syncRequestId).toBe(queued.clientTransactionId);

    const persisted = await getOfflineTransaction(queued.clientTransactionId);
    expect(persisted?.state).toBe('pending_sync');
    expect(persisted?.payload.clientTransactionId).toBe(queued.clientTransactionId);

    const summary = await getOutboxSummary({ deviceId: queued.payload.deviceId });
    expect(summary).toMatchObject({ pending: 1, unresolved: 1 });
  });

  it('recovers an interrupted syncing row as retryable instead of losing it', async () => {
    const interrupted = record();
    await putOfflineTransaction(interrupted);

    expect(await recoverInterruptedTransactions(new Date('2026-10-18T12:03:00.000Z'))).toBe(1);

    const recovered = await getOfflineTransaction(interrupted.clientTransactionId);
    expect(recovered?.state).toBe('failed_retryable');
    expect(recovered?.lastError?.code).toBe('SYNC_INTERRUPTED');
    expect(recovered?.syncingStartedAt).toBeUndefined();
    expect(recovered?.nextAttemptAt).toBe('2026-10-18T12:03:00.000Z');

    const summary = await getOutboxSummary({ deviceId: interrupted.payload.deviceId });
    expect(summary).toMatchObject({ retryable: 1, unresolved: 1 });
  });

  it('retains locally resolved records without counting them as unresolved', async () => {
    const resolved = { ...record(), state: 'resolved_local' as const };
    await putOfflineTransaction(resolved);

    const summary = await getOutboxSummary({ deviceId: resolved.payload.deviceId });
    expect(summary).toMatchObject({ resolvedLocal: 1, unresolved: 0 });
  });

  it('maps accepted and replayed server outcomes to durable synchronized state', () => {
    const accepted = applyServerOutcome(record(), {
      syncTransactionId: 'ea5f6e02-fd98-4a3e-a1cc-fef37cb4822d',
      clientTransactionId: record().clientTransactionId,
      entityType: 'pos.sale',
      deviceId: record().payload.deviceId,
      branchId: record().payload.branchId,
      status: 'accepted',
      outcome: 'accepted',
      saleId: '69351e25-7017-49bd-8f11-a54ed18a2ca5',
      receiptNumber: 'REG-1-000001',
      error: null,
      attempts: 1,
      clientOccurredAt: record().payload.occurredAt,
      processedAt: '2026-10-18T12:02:00.000Z',
      createdAt: '2026-10-18T12:02:00.000Z',
      updatedAt: '2026-10-18T12:02:00.000Z'
    });
    expect(accepted.state).toBe('synced');
    expect(accepted.serverReceiptNumber).toBe('REG-1-000001');
    expect(accepted.syncingStartedAt).toBeUndefined();
  });

  it('retains retryable, permanent and conflict states without discarding the local transaction', () => {
    const base = {
      syncTransactionId: 'ea5f6e02-fd98-4a3e-a1cc-fef37cb4822d',
      clientTransactionId: record().clientTransactionId,
      entityType: 'pos.sale',
      deviceId: record().payload.deviceId,
      branchId: record().payload.branchId,
      attempts: 2,
      clientOccurredAt: record().payload.occurredAt,
      createdAt: '2026-10-18T12:02:00.000Z',
      updatedAt: '2026-10-18T12:02:00.000Z'
    };
    const retryable = applyServerOutcome(record(), {
      ...base,
      status: 'retryable',
      outcome: 'retryable',
      error: { code: 'SYNC_INTERNAL_ERROR', message: 'Try again later' }
    });
    expect(retryable.state).toBe('failed_retryable');
    expect(retryable.nextAttemptAt).toBeTruthy();

    const rejected = applyServerOutcome(record(), {
      ...base,
      status: 'rejected',
      outcome: 'rejected',
      error: { code: 'VALIDATION_ERROR', message: 'Invalid sale' }
    });
    expect(rejected.state).toBe('failed_permanent');
    expect(rejected.lastError?.code).toBe('VALIDATION_ERROR');

    const conflict = applyServerOutcome(record(), {
      ...base,
      status: 'conflict',
      outcome: 'conflict',
      error: { code: 'NEGATIVE_STOCK_DENIED', message: 'Stock is no longer available' }
    });
    expect(conflict.state).toBe('conflict');
    expect(conflict.nextAttemptAt).toBeUndefined();
  });

  it('uses bounded backoff for interrupted synchronization attempts', () => {
    const early = Date.parse(nextRetryAt(1, 1_000));
    const late = Date.parse(nextRetryAt(99, 1_000));
    expect(early).toBeGreaterThanOrEqual(2_000);
    expect(early).toBeLessThanOrEqual(3_250);
    expect(late).toBeGreaterThanOrEqual(61_000);
    expect(late).toBeLessThanOrEqual(62_250);
  });
});
