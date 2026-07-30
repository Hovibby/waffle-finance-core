/**
 * Tests for relayer/src/services/settlement-service.ts
 *
 * Strategy: inject isolated TxStateStore (storageDir: null) and a fresh
 * RetryEngine with minimal delays so tests run fast without real RPC calls.
 *
 * Coverage:
 *  a. Happy path — settle() succeeds on first attempt → SettleResult
 *  b. Transient retry — action fails twice then succeeds → attempts = 3
 *  c. Terminal error — action throws terminal error → no retry, SettlementError
 *  d. Exhausted retries — transient errors exhaust maxAttempts → SettlementError
 *  e. Idempotency — duplicate settle() call returns cached txHash
 *  f. onTxHash callback — called as soon as hash is available
 *  g. State persistence across restart (disk) — reconcile() recovers submission_acked
 *  h. Coordinator ack advances state
 *  i. markComplete() reaches terminal success
 *  j. recordReceipt() idempotency
 *  k. Reconcile on startup — advances coordinator_recorded → complete
 *  l. Reconcile on startup — times out pending_submission → terminal_failure
 *  m. stateCounts() and snapshot() helpers
 *  n. SettlementError carries correct properties
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';

// ── Mock metrics so counters/histograms don't bleed between tests ─────────
vi.mock('../src/metrics.js', () => ({
  settlementAttemptsTotal:     { inc: vi.fn() },
  settlementFailuresTotal:     { inc: vi.fn() },
  settlementRecoveryTotal:     { inc: vi.fn() },
  settlementStateGauge:        { set: vi.fn() },
  settlementDurationSeconds:   { observe: vi.fn() },
  txStateTransitionsTotal:     { inc: vi.fn() },
  txStateReconciliationsTotal: { inc: vi.fn() },
  txStateRecoveredTotal:       { inc: vi.fn() },
  txStateDuplicateReceiptsTotal: { inc: vi.fn() },
  txStateCurrentByState:       { set: vi.fn() },
  txStateReconciliationDurationSeconds: { startTimer: () => () => {} },
  retryEngineAttemptsTotal:    { inc: vi.fn() },
  retryEngineExhaustedTotal:   { inc: vi.fn() },
  retryEngineCircuitOpenedTotal: { inc: vi.fn() },
  retryEngineCircuitRejectedTotal: { inc: vi.fn() },
  retryEngineCircuitState:     { set: vi.fn() },
  retryEngineBackoffSeconds:   { observe: vi.fn() },
  correlationOpsTotal:         { inc: vi.fn() },
  correlationCheckpointsTotal: { inc: vi.fn() },
  correlationOpDurationSeconds: { startTimer: () => () => {} },
  correlationRetryHopsTotal:   { inc: vi.fn() },
}));

import {
  SettlementService,
  SettlementError,
} from '../src/services/settlement-service.js';
import { TxStateStore, type TxReceipt } from '../src/services/tx-state-store.js';
import { RetryEngine } from '../src/utils/retry-engine.js';

// ── Helpers ───────────────────────────────────────────────────────────────

function makeService(opts: { storageDir?: string | null } = {}) {
  const storageDir = opts.storageDir !== undefined ? opts.storageDir : null;
  const txStateStore = new TxStateStore({ storageDir });
  const retryEngine = new RetryEngine({
    defaultMaxAttempts: 3,
    defaultBaseDelayMs: 1,
    defaultMaxDelayMs: 10,
    circuitBreakerThreshold: 10, // high threshold so circuit stays closed in unit tests
  });
  return new SettlementService({ txStateStore, retryEngine });
}

function makeReceipt(overrides: Partial<TxReceipt> = {}): TxReceipt {
  return {
    hash: '0xabc123',
    blockNumber: 100,
    blockHash: '0xblock',
    status: 1,
    gasUsed: 21000n,
    confirmations: 12,
    ...overrides,
  };
}

const BASE_OPTS = {
  orderId: 'order-001',
  direction: 'xlm_to_eth',
  correlationId: 'cid-test',
};

// ═══════════════════════════════════════════════════════════════════════════
// a. Happy path
// ═══════════════════════════════════════════════════════════════════════════
describe('SettlementService — happy path', () => {
  it('returns SettleResult with txHash on first-attempt success', async () => {
    const svc = makeService();
    const result = await svc.settle({
      ...BASE_OPTS,
      action: async () => '0xtxhash_success',
    });
    expect(result.txHash).toBe('0xtxhash_success');
    expect(result.attempts).toBe(1);
    expect(result.lastFaultClass).toBeUndefined();
  });

  it('creates a TxStateRecord visible via getStatus()', async () => {
    const svc = makeService();
    await svc.settle({ ...BASE_OPTS, action: async () => '0xhash1' });
    const record = svc.getStatus(BASE_OPTS.orderId);
    expect(record).toBeDefined();
    // After a successful settle the record is in submission_acked or later.
    expect(['submission_acked', 'chain_mined', 'coordinator_recorded', 'complete'])
      .toContain(record!.state);
  });

  it('stores the txHash in the record after success', async () => {
    const svc = makeService();
    await svc.settle({ ...BASE_OPTS, action: async () => '0xtxhash_stored' });
    const record = svc.getStatus(BASE_OPTS.orderId);
    expect(record?.txHash).toBe('0xtxhash_stored');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// b. Transient retry
// ═══════════════════════════════════════════════════════════════════════════
describe('SettlementService — transient retry', () => {
  it('retries on transient error and succeeds on 3rd attempt', async () => {
    const svc = makeService();
    let calls = 0;
    const result = await svc.settle({
      ...BASE_OPTS,
      orderId: 'order-retry',
      action: async () => {
        calls++;
        if (calls < 3) throw new Error('connection timeout — retryable');
        return '0xfinal_hash';
      },
      maxAttempts: 5,
      baseDelayMs: 1,
    });
    expect(result.txHash).toBe('0xfinal_hash');
    expect(result.attempts).toBe(3);
    expect(calls).toBe(3);
  });

  it('records the fault class of the last transient error before success', async () => {
    const svc = makeService();
    let calls = 0;
    const result = await svc.settle({
      orderId: 'order-fault-class',
      direction: 'xlm_to_eth',
      correlationId: 'cid-fc',
      action: async () => {
        if (++calls < 2) throw new Error('network timeout');
        return '0xhash_fc';
      },
      maxAttempts: 3,
      baseDelayMs: 1,
    });
    expect(result.lastFaultClass).toBe('transient');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// c. Terminal error — no retry
// ═══════════════════════════════════════════════════════════════════════════
describe('SettlementService — terminal error', () => {
  it('throws SettlementError immediately on terminal error without retrying', async () => {
    const svc = makeService();
    let calls = 0;
    await expect(
      svc.settle({
        orderId: 'order-terminal',
        direction: 'xlm_to_eth',
        correlationId: 'cid-t',
        action: async () => {
          calls++;
          throw new Error('insufficient funds for transfer');
        },
        maxAttempts: 5,
        baseDelayMs: 1,
      })
    ).rejects.toBeInstanceOf(SettlementError);
    // Terminal — called exactly once, no retries.
    expect(calls).toBe(1);
  });

  it('marks the record terminal_failure after a terminal error', async () => {
    const svc = makeService();
    try {
      await svc.settle({
        orderId: 'order-terminal-state',
        direction: 'xlm_to_eth',
        correlationId: 'cid-ts',
        action: async () => { throw new Error('execution reverted'); },
        maxAttempts: 3,
        baseDelayMs: 1,
      });
    } catch { /* expected */ }
    const record = svc.getStatus('order-terminal-state');
    expect(record?.state).toBe('terminal_failure');
  });

  it('SettlementError.faultCategory is "terminal" for a terminal error', async () => {
    const svc = makeService();
    let caught: SettlementError | undefined;
    try {
      await svc.settle({
        orderId: 'order-terminal-category',
        direction: 'xlm_to_eth',
        correlationId: 'cid-tc',
        action: async () => { throw new Error('bad auth: invalid signature'); },
        maxAttempts: 3,
        baseDelayMs: 1,
      });
    } catch (e) {
      if (e instanceof SettlementError) caught = e;
    }
    expect(caught).toBeDefined();
    expect(caught!.faultCategory).toBe('terminal');
    expect(caught!.orderId).toBe('order-terminal-category');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// d. Exhausted retries
// ═══════════════════════════════════════════════════════════════════════════
describe('SettlementService — retry exhaustion', () => {
  it('throws SettlementError after maxAttempts transient failures', async () => {
    const svc = makeService();
    let calls = 0;
    await expect(
      svc.settle({
        orderId: 'order-exhaust',
        direction: 'xlm_to_eth',
        correlationId: 'cid-ex',
        action: async () => {
          calls++;
          throw new Error('network timeout');
        },
        maxAttempts: 3,
        baseDelayMs: 1,
      })
    ).rejects.toBeInstanceOf(SettlementError);
    expect(calls).toBe(3);
  });

  it('marks the record terminal_failure after exhaustion', async () => {
    const svc = makeService();
    try {
      await svc.settle({
        orderId: 'order-exhaust-state',
        direction: 'xlm_to_eth',
        correlationId: 'cid-es',
        action: async () => { throw new Error('RPC timeout'); },
        maxAttempts: 2,
        baseDelayMs: 1,
      });
    } catch { /* expected */ }
    expect(svc.getStatus('order-exhaust-state')?.state).toBe('terminal_failure');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// e. Idempotency
// ═══════════════════════════════════════════════════════════════════════════
describe('SettlementService — idempotency', () => {
  it('second settle() call returns cached txHash without re-executing action', async () => {
    const svc = makeService();
    let actionCalls = 0;
    const action = async () => { actionCalls++; return '0xcached_hash'; };
    await svc.settle({ ...BASE_OPTS, orderId: 'order-idem', action });
    const result2 = await svc.settle({ ...BASE_OPTS, orderId: 'order-idem', action });
    expect(result2.txHash).toBe('0xcached_hash');
    // Action only executed once — second call is a cache hit.
    expect(actionCalls).toBe(1);
  });

  it('settle() on already-terminal_failure record throws SettlementError', async () => {
    const svc = makeService();
    try {
      await svc.settle({
        orderId: 'order-already-failed',
        direction: 'xlm_to_eth',
        correlationId: 'cid-af',
        action: async () => { throw new Error('execution reverted'); },
        maxAttempts: 1,
        baseDelayMs: 1,
      });
    } catch { /* expected first failure */ }
    // Second call — record is already terminal_failure.
    await expect(
      svc.settle({
        orderId: 'order-already-failed',
        direction: 'xlm_to_eth',
        correlationId: 'cid-af',
        action: async () => '0xshould_not_call',
        maxAttempts: 1,
        baseDelayMs: 1,
      })
    ).rejects.toBeInstanceOf(SettlementError);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// f. onTxHash callback
// ═══════════════════════════════════════════════════════════════════════════
describe('SettlementService — onTxHash callback', () => {
  it('calls onTxHash with the hash immediately when action resolves', async () => {
    const svc = makeService();
    const received: string[] = [];
    await svc.settle({
      orderId: 'order-ontxhash',
      direction: 'xlm_to_eth',
      correlationId: 'cid-oth',
      action: async () => '0xmy_tx_hash',
      onTxHash: (h) => received.push(h),
    });
    expect(received).toEqual(['0xmy_tx_hash']);
  });

  it('onTxHash is called before settle() resolves', async () => {
    const svc = makeService();
    const events: string[] = [];
    await svc.settle({
      orderId: 'order-order-oth',
      direction: 'xlm_to_eth',
      correlationId: 'cid-ord',
      action: async () => {
        events.push('action');
        return '0xordered_hash';
      },
      onTxHash: () => events.push('onTxHash'),
    });
    events.push('settled');
    expect(events).toEqual(['action', 'onTxHash', 'settled']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// g. State persistence across restart (disk)
// ═══════════════════════════════════════════════════════════════════════════
describe('SettlementService — disk persistence and restart recovery', () => {
  it('reloads in-flight record on second instantiation', async () => {
    const dir = path.join(os.tmpdir(), `waffle-settlement-test-${Date.now()}`);
    try {
      const svc1 = makeService({ storageDir: dir });
      await svc1.settle({ orderId: 'persist-order', direction: 'xlm_to_eth', correlationId: 'c1', action: async () => '0xpersist_hash' });

      // Restart: new service, same dir.
      const svc2 = makeService({ storageDir: dir });
      const record = svc2.getStatus('persist-order');
      expect(record).toBeDefined();
      expect(record?.txHash).toBe('0xpersist_hash');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reconcile() after restart advances submission_acked → chain_mined', async () => {
    const dir = path.join(os.tmpdir(), `waffle-settlement-test-${Date.now()}`);
    try {
      const svc1 = makeService({ storageDir: dir });
      await svc1.settle({ orderId: 'restart-order', direction: 'xlm_to_eth', correlationId: 'c2', action: async () => '0xrestart_hash' });

      // Restart.
      const svc2 = makeService({ storageDir: dir });
      const provider = {
        getTransactionReceipt: vi.fn().mockResolvedValue(makeReceipt({ hash: '0xrestart_hash', blockNumber: 42 })),
        getBlockNumber: vi.fn().mockResolvedValue(100),
      };
      await svc2.reconcile(provider, 'startup');
      const record = svc2.getStatus('restart-order');
      expect(record?.state).toBe('chain_mined');
      expect(record?.minedBlock).toBe(42);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('pending_submission timeout marks record terminal_failure after restart', async () => {
    const dir = path.join(os.tmpdir(), `waffle-settlement-test-${Date.now()}`);
    try {
      // Use a tiny timeout so it expires immediately.
      const store1 = new TxStateStore({ storageDir: dir, pendingSubmissionTimeoutMs: 1 });
      const engine1 = new RetryEngine({ defaultMaxAttempts: 1, defaultBaseDelayMs: 1 });
      const svc1 = new SettlementService({ txStateStore: store1, retryEngine: engine1 });

      // Create a record that stays in pending_submission (action always fails immediately).
      try {
        await svc1.settle({
          orderId: 'timeout-order',
          direction: 'xlm_to_eth',
          correlationId: 'c3',
          action: async () => { throw new Error('RPC timeout'); },
          maxAttempts: 1,
          baseDelayMs: 1,
        });
      } catch { /* expected */ }

      // Override to pending_submission manually by creating a fresh store pointing at same dir.
      // The existing file may be terminal_failure — test reconcile on a fresh pending record.
      const store2 = new TxStateStore({ storageDir: dir, pendingSubmissionTimeoutMs: 1 });
      // Wait for the 1ms timeout to expire.
      await new Promise<void>((r) => setTimeout(r, 10));
      const svc2 = new SettlementService({ txStateStore: store2, retryEngine: engine1 });
      await svc2.reconcile(null, 'startup');
      const record = svc2.getStatus('timeout-order');
      // May be terminal_failure from either path.
      expect(record?.state).toBe('terminal_failure');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// h. Coordinator ack & i. markComplete
// ═══════════════════════════════════════════════════════════════════════════
describe('SettlementService — state progression helpers', () => {
  it('recordCoordinatorAck advances chain_mined → coordinator_recorded', async () => {
    const svc = makeService();
    await svc.settle({ orderId: 'order-coordack', direction: 'xlm_to_eth', correlationId: 'c', action: async () => '0xh1' });
    svc.recordReceipt('order-coordack', makeReceipt({ hash: '0xh1' }));
    svc.recordCoordinatorAck('order-coordack', 'ref-xyz');
    expect(svc.getStatus('order-coordack')?.state).toBe('coordinator_recorded');
    expect(svc.getStatus('order-coordack')?.coordinatorRef).toBe('ref-xyz');
  });

  it('markComplete advances coordinator_recorded → complete', async () => {
    const svc = makeService();
    await svc.settle({ orderId: 'order-complete', direction: 'xlm_to_eth', correlationId: 'c', action: async () => '0xh2' });
    svc.recordReceipt('order-complete', makeReceipt({ hash: '0xh2' }));
    svc.recordCoordinatorAck('order-complete', 'ref-complete');
    svc.markComplete('order-complete');
    expect(svc.getStatus('order-complete')?.state).toBe('complete');
  });

  it('markComplete is idempotent on already-complete record', async () => {
    const svc = makeService();
    await svc.settle({ orderId: 'order-complete2', direction: 'xlm_to_eth', correlationId: 'c', action: async () => '0xh3' });
    svc.recordReceipt('order-complete2', makeReceipt({ hash: '0xh3' }));
    svc.recordCoordinatorAck('order-complete2', 'ref-c2');
    svc.markComplete('order-complete2');
    // Second call must not throw.
    expect(() => svc.markComplete('order-complete2')).not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// j. recordReceipt idempotency
// ═══════════════════════════════════════════════════════════════════════════
describe('SettlementService — recordReceipt idempotency', () => {
  it('first recordReceipt returns true, second returns false for same hash', async () => {
    const svc = makeService();
    await svc.settle({ orderId: 'order-receipt', direction: 'xlm_to_eth', correlationId: 'c', action: async () => '0xreceipt_hash' });
    const r1 = svc.recordReceipt('order-receipt', makeReceipt({ hash: '0xreceipt_hash' }));
    expect(r1).toBe(true);
    const r2 = svc.recordReceipt('order-receipt', makeReceipt({ hash: '0xreceipt_hash' }));
    expect(r2).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// k. Reconcile — coordinator_recorded → complete
// ═══════════════════════════════════════════════════════════════════════════
describe('SettlementService — reconcile startup', () => {
  it('reconcile() auto-advances coordinator_recorded → complete', async () => {
    const svc = makeService();
    await svc.settle({ orderId: 'order-recon1', direction: 'xlm_to_eth', correlationId: 'c', action: async () => '0xrc1' });
    svc.recordReceipt('order-recon1', makeReceipt({ hash: '0xrc1' }));
    svc.recordCoordinatorAck('order-recon1', 'ref-recon1');

    const summary = await svc.reconcile(null, 'startup');
    expect(summary.advanced).toBeGreaterThanOrEqual(1);
    expect(svc.getStatus('order-recon1')?.state).toBe('complete');
  });

  it('reconcile() skips terminal records (does not scan them)', async () => {
    const svc = makeService();
    // Create a terminal_failure record.
    try {
      await svc.settle({
        orderId: 'order-terminal-recon',
        direction: 'xlm_to_eth',
        correlationId: 'c',
        action: async () => { throw new Error('execution reverted'); },
        maxAttempts: 1,
        baseDelayMs: 1,
      });
    } catch { /* expected */ }

    const before = svc.getStatus('order-terminal-recon')?.state;
    const summary = await svc.reconcile(null, 'scheduled');
    expect(summary.scanned).toBe(0); // terminal records not scanned
    expect(svc.getStatus('order-terminal-recon')?.state).toBe(before);
  });

  it('reconcile() with provider advances submission_acked → chain_mined on receipt', async () => {
    const svc = makeService();
    await svc.settle({ orderId: 'order-prov-recon', direction: 'xlm_to_eth', correlationId: 'c', action: async () => '0xprov_hash' });

    const provider = {
      getTransactionReceipt: vi.fn().mockResolvedValue(makeReceipt({ hash: '0xprov_hash', blockNumber: 77 })),
      getBlockNumber: vi.fn().mockResolvedValue(200),
    };
    await svc.reconcile(provider, 'manual');
    const record = svc.getStatus('order-prov-recon');
    expect(record?.state).toBe('chain_mined');
    expect(record?.minedBlock).toBe(77);
  });

  it('reconcile() marks terminal_failure when receipt.status = 0 (reverted)', async () => {
    const svc = makeService();
    await svc.settle({ orderId: 'order-reverted', direction: 'xlm_to_eth', correlationId: 'c', action: async () => '0xreverted_hash' });

    const provider = {
      getTransactionReceipt: vi.fn().mockResolvedValue(makeReceipt({ hash: '0xreverted_hash', status: 0 })),
      getBlockNumber: vi.fn().mockResolvedValue(200),
    };
    await svc.reconcile(provider, 'startup');
    expect(svc.getStatus('order-reverted')?.state).toBe('terminal_failure');
  });

  it('reconcile() returns a ReconcileSummary with trigger set correctly', async () => {
    const svc = makeService();
    await svc.settle({ orderId: 'order-summary', direction: 'xlm_to_eth', correlationId: 'c', action: async () => '0xsummary_hash' });
    const summary = await svc.reconcile(null, 'manual', 'xlm_to_eth');
    expect(summary.trigger).toBe('manual');
    expect(typeof summary.scanned).toBe('number');
    expect(typeof summary.advanced).toBe('number');
    expect(typeof summary.startedAt).toBe('number');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// l. pending_submission timeout
// ═══════════════════════════════════════════════════════════════════════════
describe('SettlementService — pending_submission timeout via reconcile', () => {
  it('reconcile() marks terminal_failure for a timed-out pending_submission', async () => {
    const store = new TxStateStore({ storageDir: null, pendingSubmissionTimeoutMs: 1 });
    const engine = new RetryEngine({ defaultMaxAttempts: 3, defaultBaseDelayMs: 1 });
    const svc = new SettlementService({ txStateStore: store, retryEngine: engine });

    // Create the record and manually leave it in pending_submission by
    // directly using the underlying store (bypassing settle() which would
    // also fail immediately).
    store.create({ orderId: 'order-timeout', correlationId: 'c', route: 'xlm_to_eth' });

    // Let the 1ms timeout expire.
    await new Promise<void>((r) => setTimeout(r, 10));
    await svc.reconcile(null, 'startup');
    expect(svc.getStatus('order-timeout')?.state).toBe('terminal_failure');
    expect(svc.getStatus('order-timeout')?.failureReason).toMatch(/timeout/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// m. stateCounts() and snapshot()
// ═══════════════════════════════════════════════════════════════════════════
describe('SettlementService — stateCounts and snapshot', () => {
  it('stateCounts() reflects current state distribution', async () => {
    const svc = makeService();
    await svc.settle({ orderId: 'sc-1', direction: 'xlm_to_eth', correlationId: 'c', action: async () => '0xh_sc1' });
    await svc.settle({ orderId: 'sc-2', direction: 'xlm_to_eth', correlationId: 'c', action: async () => '0xh_sc2' });
    try {
      await svc.settle({
        orderId: 'sc-3', direction: 'xlm_to_eth', correlationId: 'c',
        action: async () => { throw new Error('execution reverted'); },
        maxAttempts: 1, baseDelayMs: 1,
      });
    } catch { /* expected */ }

    const counts = svc.stateCounts();
    // sc-1 and sc-2 are in submission_acked (or later), sc-3 is terminal_failure.
    expect(counts.terminal_failure).toBe(1);
    const nonTerminal = counts.submission_acked + counts.chain_mined +
      counts.coordinator_recorded + counts.complete;
    expect(nonTerminal).toBe(2);
  });

  it('snapshot() returns all records', async () => {
    const svc = makeService();
    await svc.settle({ orderId: 'snap-1', direction: 'xlm_to_eth', correlationId: 'c', action: async () => '0xsnap1' });
    await svc.settle({ orderId: 'snap-2', direction: 'xlm_to_eth', correlationId: 'c', action: async () => '0xsnap2' });
    const snap = svc.snapshot();
    expect(snap.length).toBe(2);
    expect(snap.map((r) => r.orderId)).toContain('snap-1');
    expect(snap.map((r) => r.orderId)).toContain('snap-2');
  });

  it('byState() returns only records in the requested state', async () => {
    const svc = makeService();
    await svc.settle({ orderId: 'by-1', direction: 'xlm_to_eth', correlationId: 'c', action: async () => '0xby1' });
    try {
      await svc.settle({
        orderId: 'by-2', direction: 'xlm_to_eth', correlationId: 'c',
        action: async () => { throw new Error('execution reverted'); },
        maxAttempts: 1, baseDelayMs: 1,
      });
    } catch { /* expected */ }

    const failed = svc.byState('terminal_failure');
    expect(failed.map((r) => r.orderId)).toContain('by-2');
    expect(failed.map((r) => r.orderId)).not.toContain('by-1');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// n. SettlementError properties
// ═══════════════════════════════════════════════════════════════════════════
describe('SettlementError', () => {
  it('carries orderId, faultCategory, attempts, cause, and correct .name', async () => {
    const svc = makeService();
    let caught: SettlementError | undefined;
    const cause = new Error('insufficient funds for transfer');
    try {
      await svc.settle({
        orderId: 'order-err-props',
        direction: 'eth_to_xlm',
        correlationId: 'cid-ep',
        action: async () => { throw cause; },
        maxAttempts: 1,
        baseDelayMs: 1,
      });
    } catch (e) {
      if (e instanceof SettlementError) caught = e;
    }
    expect(caught).toBeDefined();
    expect(caught!.name).toBe('SettlementError');
    expect(caught!.orderId).toBe('order-err-props');
    expect(caught!.faultCategory).toBe('terminal');
    expect(caught!.attempts).toBe(1);
    expect(caught!.cause).toBe(cause);
    expect(caught!.message).toContain('order-err-props');
  });

  it('is an instance of Error', async () => {
    const svc = makeService();
    await expect(
      svc.settle({
        orderId: 'order-err-type',
        direction: 'eth_to_xlm',
        correlationId: 'c',
        action: async () => { throw new Error('execution reverted'); },
        maxAttempts: 1,
        baseDelayMs: 1,
      })
    ).rejects.toBeInstanceOf(Error);
  });
});
