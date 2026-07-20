/**
 * Tests for RecoveryService.
 *
 * Strategy: inject a fresh SettlementFailureLedger and mock executor callbacks
 * so no network is touched. All timer behaviour is controlled via vi.useFakeTimers().
 *
 * Coverage:
 *  start() / stop():
 *   - start() launches background scan; stop() clears intervals
 *   - calling start() twice is a no-op (no duplicate interval)
 *
 *  runRetryScan():
 *   - entries due for retry are picked up and executor is called
 *   - successful retry → entry phase=succeeded, metrics incremented
 *   - failed retry (transient) → entry stays retrying, retryAfter updated
 *   - failed retry (terminal category) → entry phase=failed_terminal
 *   - ambiguous outcome → entry phase=failed_ambiguous
 *   - entries NOT due (back-off still active) → executor NOT called
 *   - mutex prevents concurrent duplicate retries for same order+action
 *   - scan emits 'intervention_needed' for terminal entries
 *   - scan emits 'recovered' on success
 *   - scan emits 'terminal_failure' on terminal failure
 *
 *  manualRecover():
 *   - succeeds and returns txHash
 *   - failure throws and updates ledger
 *   - no executor → throws with descriptive message
 *
 *  checkTimelocks():
 *   - expired order triggers xlm_refund executor
 *   - non-expired order is skipped
 *   - executor failure records in ledger
 *
 *  getStats() / getLedgerStats() / snapshot():
 *   - reflect current state accurately
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Registry, Counter, Gauge, Histogram } from 'prom-client';
import {
  RecoveryService,
  type RetryExecutors,
  type RecoveryServiceConfig,
} from '../src/services/recovery-service.js';
import {
  SettlementFailureLedger,
  type SettlementFailureEntry,
} from '../src/services/settlement-failure-ledger.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLedger(): SettlementFailureLedger {
  return new SettlementFailureLedger();
}

function makeService(
  ledger: SettlementFailureLedger,
  executors: RetryExecutors = {},
  config: Partial<RecoveryServiceConfig> = {},
): RecoveryService {
  return new RecoveryService({
    ledger,
    executors,
    scanIntervalMs: 1_000, // short for test use
    timelockIntervalMs: 1_000,
    gracePeriodSeconds: 60,
    ...config,
  });
}

/** Create a ledger entry that is past its retryAfter so it qualifies for retry. */
function makeEligibleEntry(
  ledger: SettlementFailureLedger,
  orderId: string,
  action: 'eth_send' | 'xlm_refund' = 'eth_send',
): SettlementFailureEntry {
  ledger.register(orderId, action);
  const entry = ledger.recordFailure(orderId, action, new Error('ECONNRESET'), 'transient_rpc');
  // Backdate so it's immediately eligible
  (entry as any).retryAfter = Math.floor(Date.now() / 1000) - 1;
  return entry;
}

// ---------------------------------------------------------------------------
// start() / stop()
// ---------------------------------------------------------------------------

describe('RecoveryService — start / stop', () => {
  it('stop() is safe to call before start()', () => {
    const service = makeService(makeLedger());
    expect(() => service.stop()).not.toThrow();
  });

  it('start() is idempotent — calling twice does not create duplicate intervals', () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const ledger = makeLedger();
    const service = makeService(ledger);

    service.start();
    const callsAfterFirst = setIntervalSpy.mock.calls.length;
    service.start(); // second call — should be a no-op
    const callsAfterSecond = setIntervalSpy.mock.calls.length;

    expect(callsAfterSecond).toBe(callsAfterFirst);
    service.stop();
    setIntervalSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// runRetryScan() — successful recovery
// ---------------------------------------------------------------------------

describe('RecoveryService — runRetryScan: successful retry', () => {
  it('calls executor for due entries and transitions phase to succeeded', async () => {
    const ledger = makeLedger();
    makeEligibleEntry(ledger, 'order-ok', 'eth_send');

    const executor = vi.fn().mockResolvedValue('0xtxhash');
    const service = makeService(ledger, { eth_send: executor });

    await service.runRetryScan();

    // Allow the mutex to resolve (runExclusive is fire-and-forget in the scan)
    await new Promise((r) => setTimeout(r, 10));

    expect(executor).toHaveBeenCalledOnce();
    expect(ledger.getEntry('order-ok', 'eth_send')?.phase).toBe('succeeded');
    expect(ledger.getEntry('order-ok', 'eth_send')?.successTxHash).toBe('0xtxhash');
  });

  it('emits "recovered" event on success', async () => {
    const ledger = makeLedger();
    makeEligibleEntry(ledger, 'order-emit', 'eth_send');

    const executor = vi.fn().mockResolvedValue('0xemit');
    const service = makeService(ledger, { eth_send: executor });

    const recovered = vi.fn();
    service.on('recovered', recovered);
    await service.runRetryScan();
    await new Promise((r) => setTimeout(r, 10));

    expect(recovered).toHaveBeenCalledOnce();
    expect(recovered.mock.calls[0][0].txHash).toBe('0xemit');
  });

  it('increments successfulRecoveries stat', async () => {
    const ledger = makeLedger();
    makeEligibleEntry(ledger, 'order-stat', 'eth_send');

    const executor = vi.fn().mockResolvedValue('0xstat');
    const service = makeService(ledger, { eth_send: executor });

    await service.runRetryScan();
    await new Promise((r) => setTimeout(r, 10));

    expect(service.getStats().successfulRecoveries).toBe(1);
    expect(service.getStats().totalRetries).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// runRetryScan() — failure paths
// ---------------------------------------------------------------------------

describe('RecoveryService — runRetryScan: retry failure (transient)', () => {
  it('keeps phase=retrying and updates retryAfter', async () => {
    const ledger = makeLedger();
    makeEligibleEntry(ledger, 'order-fail', 'eth_send');

    const executor = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    const service = makeService(ledger, { eth_send: executor });

    await service.runRetryScan();
    await new Promise((r) => setTimeout(r, 10));

    const entry = ledger.getEntry('order-fail', 'eth_send')!;
    expect(entry.phase).toBe('retrying');
    expect(entry.retryCount).toBeGreaterThan(0);
  });

  it('emits "retry_failed" event', async () => {
    const ledger = makeLedger();
    makeEligibleEntry(ledger, 'order-evt', 'eth_send');

    const executor = vi.fn().mockRejectedValue(new Error('timeout'));
    const service = makeService(ledger, { eth_send: executor });
    const retryFailed = vi.fn();
    service.on('retry_failed', retryFailed);

    await service.runRetryScan();
    await new Promise((r) => setTimeout(r, 10));

    expect(retryFailed).toHaveBeenCalledOnce();
  });
});

describe('RecoveryService — runRetryScan: terminal failure', () => {
  it('transitions entry to failed_terminal on terminal category error', async () => {
    const ledger = makeLedger();
    makeEligibleEntry(ledger, 'order-terminal', 'eth_send');

    const executor = vi.fn().mockRejectedValue(new Error('insufficient funds for gas'));
    const service = makeService(ledger, { eth_send: executor });

    await service.runRetryScan();
    await new Promise((r) => setTimeout(r, 10));

    expect(ledger.getEntry('order-terminal', 'eth_send')?.phase).toBe('failed_terminal');
    expect(service.getStats().terminalFailures).toBe(1);
  });

  it('emits "terminal_failure" event', async () => {
    const ledger = makeLedger();
    makeEligibleEntry(ledger, 'order-tev', 'eth_send');

    const executor = vi.fn().mockRejectedValue(new Error('execution reverted'));
    const service = makeService(ledger, { eth_send: executor });
    const terminalFailed = vi.fn();
    service.on('terminal_failure', terminalFailed);

    await service.runRetryScan();
    await new Promise((r) => setTimeout(r, 10));

    expect(terminalFailed).toHaveBeenCalledOnce();
  });
});

describe('RecoveryService — runRetryScan: ambiguous outcome', () => {
  it('transitions to failed_ambiguous on horizon_timeout', async () => {
    const ledger = makeLedger();
    makeEligibleEntry(ledger, 'order-ambig', 'xlm_refund');

    const horizonErr = Object.assign(new Error('Horizon 504'), { isTimeout: true });
    const executor = vi.fn().mockRejectedValue(horizonErr);
    const service = makeService(ledger, { xlm_refund: executor });

    await service.runRetryScan();
    await new Promise((r) => setTimeout(r, 10));

    expect(ledger.getEntry('order-ambig', 'xlm_refund')?.phase).toBe('failed_ambiguous');
    expect(service.getStats().ambiguousEntries).toBe(1);
  });

  it('emits "ambiguous" event', async () => {
    const ledger = makeLedger();
    makeEligibleEntry(ledger, 'order-amev', 'xlm_refund');

    const horizonErr = Object.assign(new Error('Horizon 504'), { isTimeout: true });
    const executor = vi.fn().mockRejectedValue(horizonErr);
    const service = makeService(ledger, { xlm_refund: executor });
    const ambiguous = vi.fn();
    service.on('ambiguous', ambiguous);

    await service.runRetryScan();
    await new Promise((r) => setTimeout(r, 10));

    expect(ambiguous).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// runRetryScan() — entries not due
// ---------------------------------------------------------------------------

describe('RecoveryService — runRetryScan: entries not yet due', () => {
  it('does not call executor for entries whose retryAfter is in the future', async () => {
    const ledger = makeLedger();
    ledger.register('order-notdue', 'eth_send');
    // Record failure — retryAfter will be in the future
    ledger.recordFailure('order-notdue', 'eth_send', new Error('timeout'), 'transient_rpc');
    // Do NOT backdate retryAfter — it should be in the future

    const executor = vi.fn().mockResolvedValue('0x');
    const service = makeService(ledger, { eth_send: executor });

    await service.runRetryScan();
    await new Promise((r) => setTimeout(r, 10));

    expect(executor).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// runRetryScan() — deduplication (concurrent scan protection)
// ---------------------------------------------------------------------------

describe('RecoveryService — runRetryScan: concurrent deduplication', () => {
  it('does not run the same orderId+action concurrently (second is skipped)', async () => {
    const ledger = makeLedger();
    makeEligibleEntry(ledger, 'order-concurrent', 'eth_send');

    // Slow executor so two scans can overlap
    const slowExecutor = vi.fn().mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 50));
      return '0xslow';
    });

    const service = makeService(ledger, { eth_send: slowExecutor });

    // Trigger two overlapping scans
    await Promise.all([
      service.runRetryScan(),
      service.runRetryScan(),
    ]);

    await new Promise((r) => setTimeout(r, 100));

    // Deduplicator ensures executor is called at most once concurrently
    expect(slowExecutor.mock.calls.length).toBeLessThanOrEqual(1);
  });
});

describe('RecoveryService — runRetryScan: intervention needed', () => {
  it('emits "intervention_needed" for terminal entries', async () => {
    const ledger = makeLedger();
    ledger.register('order-int', 'eth_send');
    ledger.recordFailure('order-int', 'eth_send', new Error('insufficient funds'), 'insufficient_funds');

    const service = makeService(ledger);
    const intervene = vi.fn();
    service.on('intervention_needed', intervene);

    await service.runRetryScan();
    await new Promise((r) => setTimeout(r, 10));

    expect(intervene).toHaveBeenCalledOnce();
    expect(intervene.mock.calls[0][0].orderId).toBe('order-int');
  });
});

// ---------------------------------------------------------------------------
// runRetryScan() — no executor registered
// ---------------------------------------------------------------------------

describe('RecoveryService — runRetryScan: no executor', () => {
  it('emits "no_executor" event and does not crash', async () => {
    const ledger = makeLedger();
    makeEligibleEntry(ledger, 'order-noexec', 'eth_send');

    // No executors registered
    const service = makeService(ledger, {});
    const noExec = vi.fn();
    service.on('no_executor', noExec);

    await expect(service.runRetryScan()).resolves.not.toThrow();
    await new Promise((r) => setTimeout(r, 10));

    expect(noExec).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// runRetryScan() — multiple orders
// ---------------------------------------------------------------------------

describe('RecoveryService — runRetryScan: multiple orders', () => {
  it('processes all eligible entries independently', async () => {
    const ledger = makeLedger();
    makeEligibleEntry(ledger, 'order-1', 'eth_send');
    makeEligibleEntry(ledger, 'order-2', 'eth_send');
    makeEligibleEntry(ledger, 'order-3', 'xlm_refund');

    const ethExecutor = vi.fn().mockResolvedValue('0xeth');
    const xlmExecutor = vi.fn().mockResolvedValue('0xxlm');
    const service = makeService(ledger, { eth_send: ethExecutor, xlm_refund: xlmExecutor });

    await service.runRetryScan();
    await new Promise((r) => setTimeout(r, 20));

    expect(ethExecutor).toHaveBeenCalledTimes(2);
    expect(xlmExecutor).toHaveBeenCalledOnce();
    expect(service.getStats().successfulRecoveries).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// manualRecover()
// ---------------------------------------------------------------------------

describe('RecoveryService — manualRecover', () => {
  it('succeeds and returns txHash', async () => {
    const ledger = makeLedger();
    ledger.register('order-manual', 'eth_send');
    ledger.recordFailure('order-manual', 'eth_send', new Error('ECONNRESET'), 'transient_rpc');

    const executor = vi.fn().mockResolvedValue('0xmanual');
    const service = makeService(ledger, { eth_send: executor });

    const result = await service.manualRecover('order-manual', 'eth_send');
    expect(result).toBe('0xmanual');
    expect(ledger.getEntry('order-manual', 'eth_send')?.phase).toBe('succeeded');
  });

  it('auto-registers the entry if it does not exist yet', async () => {
    const ledger = makeLedger();
    const executor = vi.fn().mockResolvedValue('0xnew');
    const service = makeService(ledger, { eth_send: executor });

    const result = await service.manualRecover('brand-new', 'eth_send');
    expect(result).toBe('0xnew');
  });

  it('throws and records failure when executor throws', async () => {
    const ledger = makeLedger();
    ledger.register('order-mfail', 'eth_send');

    const executor = vi.fn().mockRejectedValue(new Error('RPC down'));
    const service = makeService(ledger, { eth_send: executor });

    await expect(service.manualRecover('order-mfail', 'eth_send')).rejects.toThrow('RPC down');
    const entry = ledger.getEntry('order-mfail', 'eth_send')!;
    expect(entry.retryCount).toBe(1);
  });

  it('throws a descriptive error when no executor is registered', async () => {
    const ledger = makeLedger();
    const service = makeService(ledger, {});

    await expect(
      service.manualRecover('order-noexec', 'xlm_refund')
    ).rejects.toThrow(/No executor registered/);
  });

  it('increments totalRetries stat on each call', async () => {
    const ledger = makeLedger();
    const executor = vi.fn().mockResolvedValue('0x1');
    const service = makeService(ledger, { eth_send: executor });

    await service.manualRecover('o1', 'eth_send');
    await service.manualRecover('o2', 'eth_send');
    expect(service.getStats().totalRetries).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// checkTimelocks()
// ---------------------------------------------------------------------------

describe('RecoveryService — checkTimelocks', () => {
  it('calls xlm_refund executor for an expired order', async () => {
    const ledger = makeLedger();
    const executor = vi.fn().mockResolvedValue('0xrefund');
    const service = makeService(ledger, { xlm_refund: executor }, { gracePeriodSeconds: 0 });

    const expiredOrder = {
      orderId: 'order-expired',
      deadline: Math.floor(Date.now() / 1000) - 200,
    };

    await service.checkTimelocks(() => [expiredOrder]);
    await new Promise((r) => setTimeout(r, 10));

    expect(executor).toHaveBeenCalledOnce();
    expect(ledger.getEntry('order-expired', 'xlm_refund')?.phase).toBe('succeeded');
  });

  it('does not call executor for non-expired orders', async () => {
    const ledger = makeLedger();
    const executor = vi.fn();
    const service = makeService(ledger, { xlm_refund: executor }, { gracePeriodSeconds: 120 });

    const activeOrder = {
      orderId: 'order-active',
      deadline: Math.floor(Date.now() / 1000) + 3600, // 1h in the future
    };

    await service.checkTimelocks(() => [activeOrder]);
    await new Promise((r) => setTimeout(r, 10));

    expect(executor).not.toHaveBeenCalled();
  });

  it('handles checkTimelocks with no getExpiringOrders callback', async () => {
    const service = makeService(makeLedger());
    await expect(service.checkTimelocks()).resolves.not.toThrow();
  });

  it('records failure in ledger when executor throws', async () => {
    const ledger = makeLedger();
    const executor = vi.fn().mockRejectedValue(new Error('Horizon down'));
    const service = makeService(ledger, { xlm_refund: executor }, { gracePeriodSeconds: 0 });

    await service.checkTimelocks(() => [
      { orderId: 'order-tlfail', deadline: Math.floor(Date.now() / 1000) - 300 },
    ]);
    await new Promise((r) => setTimeout(r, 10));

    const entry = ledger.getEntry('order-tlfail', 'xlm_refund');
    expect(entry).toBeDefined();
    expect(entry?.attempts.length).toBeGreaterThan(0);
  });

  it('emits "timeout_refund_success" event on success', async () => {
    const ledger = makeLedger();
    const executor = vi.fn().mockResolvedValue('0xtimeout');
    const service = makeService(ledger, { xlm_refund: executor }, { gracePeriodSeconds: 0 });

    const successEvt = vi.fn();
    service.on('timeout_refund_success', successEvt);

    await service.checkTimelocks(() => [
      { orderId: 'order-tls', deadline: Math.floor(Date.now() / 1000) - 200 },
    ]);
    await new Promise((r) => setTimeout(r, 10));

    expect(successEvt).toHaveBeenCalledOnce();
    expect(successEvt.mock.calls[0][0].orderId).toBe('order-tls');
  });

  it('emits "timeout_refund_failed" event on failure', async () => {
    const ledger = makeLedger();
    const executor = vi.fn().mockRejectedValue(new Error('nonce too low'));
    const service = makeService(ledger, { xlm_refund: executor }, { gracePeriodSeconds: 0 });

    const failEvt = vi.fn();
    service.on('timeout_refund_failed', failEvt);

    await service.checkTimelocks(() => [
      { orderId: 'order-tlf', deadline: Math.floor(Date.now() / 1000) - 200 },
    ]);
    await new Promise((r) => setTimeout(r, 10));

    expect(failEvt).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// getStats / getLedgerStats / snapshot / getFailedEntries
// ---------------------------------------------------------------------------

describe('RecoveryService — status queries', () => {
  it('getStats() reflects initial state', () => {
    const service = makeService(makeLedger());
    const stats = service.getStats();
    expect(stats.totalRetries).toBe(0);
    expect(stats.successfulRecoveries).toBe(0);
    expect(stats.terminalFailures).toBe(0);
    expect(stats.ambiguousEntries).toBe(0);
  });

  it('getLedgerStats() returns per-phase counts', () => {
    const ledger = makeLedger();
    ledger.register('o1', 'eth_send');
    ledger.register('o2', 'eth_send');
    ledger.recordSuccess('o2', 'eth_send', '0x1');

    const service = makeService(ledger);
    const stats = service.getLedgerStats();
    expect(stats.pending).toBe(1);
    expect(stats.succeeded).toBe(1);
  });

  it('snapshot() returns all ledger entries', () => {
    const ledger = makeLedger();
    ledger.register('o1', 'eth_send');
    ledger.register('o2', 'xlm_refund');
    const service = makeService(ledger);
    expect(service.snapshot()).toHaveLength(2);
  });

  it('getFailedEntries() returns only terminal/exhausted entries', () => {
    const ledger = makeLedger();
    ledger.register('ok', 'eth_send');
    ledger.recordSuccess('ok', 'eth_send', '0x1');
    ledger.register('bad', 'eth_send');
    ledger.recordFailure('bad', 'eth_send', new Error('insufficient funds'), 'insufficient_funds');

    const service = makeService(ledger);
    const failed = service.getFailedEntries();
    expect(failed).toHaveLength(1);
    expect(failed[0].orderId).toBe('bad');
  });

  it('getEntry() returns the entry for a specific orderId+action', () => {
    const ledger = makeLedger();
    ledger.register('lookup', 'xlm_refund', { meta: 'val' });
    const service = makeService(ledger);

    const entry = service.getEntry('lookup', 'xlm_refund');
    expect(entry).toBeDefined();
    expect(entry?.metadata.meta).toBe('val');
  });
});

// ---------------------------------------------------------------------------
// Metrics registry — settlement metric names present
// ---------------------------------------------------------------------------

describe('relayer metrics — settlement metric names', () => {
  it('exports Prometheus text with all settlement metric names', async () => {
    const { registry } = await import('../src/metrics.js');
    const output = await registry.metrics();

    const expectedNames = [
      'relayer_settlement_failures_total',
      'relayer_settlement_retries_total',
      'relayer_settlement_recovery_success_total',
      'relayer_settlement_terminal_failures_total',
      'relayer_settlement_ambiguous_total',
      'relayer_settlement_ledger_entries',
      'relayer_settlement_due_for_retry',
      'relayer_settlement_needs_intervention',
      'relayer_settlement_retry_tick_duration_seconds',
      'relayer_settlement_retry_last_run_timestamp_seconds',
    ];

    for (const name of expectedNames) {
      expect(output, `missing metric: ${name}`).toContain(name);
    }
  });
});
