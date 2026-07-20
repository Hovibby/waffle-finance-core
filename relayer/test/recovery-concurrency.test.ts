/**
 * Tests for RecoveryService concurrency — ensures that two concurrent
 * recovery attempts for the same orderId+action do not execute in parallel.
 *
 * The Deduplicator used internally returns null for the second caller
 * while the first is in-flight, preventing double-settlement.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RecoveryService } from '../src/services/recovery-service.js';
import { SettlementFailureLedger } from '../src/services/settlement-failure-ledger.js';

describe('RecoveryService Concurrency', () => {
  let ledger: SettlementFailureLedger;
  let service: RecoveryService;

  beforeEach(() => {
    ledger = new SettlementFailureLedger();
    service = new RecoveryService({
      ledger,
      scanIntervalMs: 60_000,   // don't fire background scan during test
      timelockIntervalMs: 60_000,
    });
  });

  it('prevents concurrent executions of recovery for the same order+action', async () => {
    let executionCount = 0;
    let concurrent = false;
    let wasEverConcurrent = false;

    // Slow executor to make concurrency detectable
    const executor = vi.fn().mockImplementation(async () => {
      if (executionCount > 0) wasEverConcurrent = true;
      concurrent = true;
      executionCount++;
      await new Promise((resolve) => setTimeout(resolve, 50));
      concurrent = false;
      return '0xtxhash';
    });

    service = new RecoveryService({
      ledger,
      executors: { eth_send: executor },
      scanIntervalMs: 60_000,
      timelockIntervalMs: 60_000,
    });

    // Register the order in the ledger so it exists
    ledger.register('order-concurrent', 'eth_send');
    // Record a failure so the entry can be retried
    ledger.recordFailure('order-concurrent', 'eth_send', new Error('ECONNRESET'), 'transient_rpc');
    // Backdate so it's immediately eligible for retry
    const entry = ledger.getEntry('order-concurrent', 'eth_send')!;
    (entry as any).retryAfter = Math.floor(Date.now() / 1000) - 1;

    // Two concurrent manual recoveries for the same order
    const [result1, result2] = await Promise.allSettled([
      service.manualRecover('order-concurrent', 'eth_send'),
      service.manualRecover('order-concurrent', 'eth_send'),
    ]);

    // Both complete without crashing
    expect([result1.status, result2.status]).toEqual(
      expect.arrayContaining(['fulfilled', expect.any(String)]),
    );

    // The executor must have run — at least one attempt succeeded
    expect(executor.mock.calls.length).toBeGreaterThanOrEqual(1);

    // The executions must have been serialized (no concurrent overlap)
    expect(wasEverConcurrent).toBe(false);
  });

  it('two concurrent scan calls for the same entry only execute the executor once', async () => {
    let callCount = 0;

    const slowExecutor = vi.fn().mockImplementation(async () => {
      callCount++;
      await new Promise((resolve) => setTimeout(resolve, 30));
      return '0xslow';
    });

    service = new RecoveryService({
      ledger,
      executors: { eth_send: slowExecutor },
      scanIntervalMs: 60_000,
      timelockIntervalMs: 60_000,
    });

    // One eligible entry
    ledger.register('order-scan-dedup', 'eth_send');
    ledger.recordFailure('order-scan-dedup', 'eth_send', new Error('ECONNRESET'), 'transient_rpc');
    const entry = ledger.getEntry('order-scan-dedup', 'eth_send')!;
    (entry as any).retryAfter = Math.floor(Date.now() / 1000) - 1;

    // Fire two overlapping scans
    await Promise.all([
      service.runRetryScan(),
      service.runRetryScan(),
    ]);

    // Give async executor time to finish
    await new Promise((r) => setTimeout(r, 80));

    // Deduplicator prevents the second scan from dispatching a second retry
    // while the first is still running
    expect(callCount).toBeLessThanOrEqual(1);
  });

  it('sequential calls do execute the executor each time (not permanently deduplicated)', async () => {
    let callCount = 0;

    const executor = vi.fn().mockImplementation(async () => {
      callCount++;
      return '0xseq';
    });

    service = new RecoveryService({
      ledger,
      executors: { eth_send: executor },
      scanIntervalMs: 60_000,
      timelockIntervalMs: 60_000,
    });

    // First manual recovery
    ledger.register('order-seq', 'eth_send');
    await service.manualRecover('order-seq', 'eth_send');

    // Second manual recovery on the same order (already succeeded — triggers again)
    await service.manualRecover('order-seq', 'eth_send');

    expect(callCount).toBe(2);
  });
});
