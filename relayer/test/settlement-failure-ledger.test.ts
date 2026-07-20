/**
 * Tests for SettlementFailureLedger and classifySettlementError.
 *
 * Coverage:
 *  classifySettlementError:
 *   - rate-limit signals → 'rate_limit'
 *   - nonce issues → 'nonce_conflict'
 *   - gas errors → 'gas_error'
 *   - network-level timeouts → 'transient_rpc'
 *   - 5xx server errors → 'transient_rpc'
 *   - HorizonTimeoutError shape → 'horizon_timeout'
 *   - insufficient funds → 'insufficient_funds'
 *   - terminal revert → 'terminal'
 *   - unknown errors → 'unknown'
 *
 *  SettlementFailureLedger:
 *   - register() creates a pending entry; second call is idempotent
 *   - recordAttemptStart() pushes an attempt and sets phase=retrying
 *   - recordSuccess() seals the entry and sets successTxHash
 *   - recordFailure() advances retry count, sets retryAfter, phase
 *   - recordFailure() with terminal category → phase=failed_terminal
 *   - recordFailure() with horizon_timeout → phase=failed_ambiguous
 *   - retryCount exhaustion → phase=failed_terminal even for retryable categories
 *   - resolveAmbiguous() promotes to succeeded
 *   - releaseAmbiguous() reopens for retry, or terminates on budget exhaustion
 *   - isDueForRetry() respects retryAfter timestamp
 *   - canRetry() reflects policy limits
 *   - dueForRetry() returns only eligible entries
 *   - needsManualIntervention() returns terminal and exhausted-ambiguous entries
 *   - stats() counts per phase correctly
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  SettlementFailureLedger,
  classifySettlementError,
  computeRetryDelay,
  type SettlementFailureCategory,
  type SettlementAction,
} from '../src/services/settlement-failure-ledger.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLedger(): SettlementFailureLedger {
  return new SettlementFailureLedger();
}

const ORDER_ID = 'order-abc-001';
const ACTION: SettlementAction = 'eth_send';

// ---------------------------------------------------------------------------
// classifySettlementError
// ---------------------------------------------------------------------------

describe('classifySettlementError', () => {
  it('classifies rate-limit by HTTP status 429', () => {
    const err = Object.assign(new Error('too many requests'), { response: { status: 429 } });
    expect(classifySettlementError(err)).toBe('rate_limit');
  });

  it('classifies rate-limit by error.code 429', () => {
    const err = Object.assign(new Error('limit'), { code: 429 });
    expect(classifySettlementError(err)).toBe('rate_limit');
  });

  it('classifies rate-limit from Alchemy "exceeded" message', () => {
    expect(classifySettlementError(new Error('Your app has exceeded its compute units'))).toBe('rate_limit');
  });

  it('classifies nonce too low', () => {
    expect(classifySettlementError(new Error('nonce too low'))).toBe('nonce_conflict');
  });

  it('classifies nonce too high', () => {
    expect(classifySettlementError(new Error('nonce too high'))).toBe('nonce_conflict');
  });

  it('classifies replacement transaction underpriced', () => {
    expect(classifySettlementError(new Error('replacement transaction underpriced'))).toBe('nonce_conflict');
  });

  it('classifies NONCE_EXPIRED code', () => {
    const err = Object.assign(new Error('nonce expired'), { code: 'NONCE_EXPIRED' });
    expect(classifySettlementError(err)).toBe('nonce_conflict');
  });

  it('classifies gas estimation failure', () => {
    expect(classifySettlementError(new Error('UNPREDICTABLE_GAS_LIMIT'))).toBe('gas_error');
    const err2 = Object.assign(new Error('gas estimation failed'), { code: 'UNPREDICTABLE_GAS_LIMIT' });
    expect(classifySettlementError(err2)).toBe('gas_error');
  });

  it('classifies fee cap errors as gas_error', () => {
    expect(classifySettlementError(new Error('max fee per gas less than basefee'))).toBe('gas_error');
  });

  it('classifies HorizonTimeoutError-shaped objects as horizon_timeout', () => {
    const err = Object.assign(new Error('Horizon 504'), { isTimeout: true });
    expect(classifySettlementError(err)).toBe('horizon_timeout');
  });

  it('classifies HTTP 504 as horizon_timeout', () => {
    const err = Object.assign(new Error('gateway timeout'), { response: { status: 504 } });
    expect(classifySettlementError(err)).toBe('horizon_timeout');
  });

  it('classifies HTTP 503 as transient_rpc', () => {
    const err = Object.assign(new Error('service unavailable'), { response: { status: 503 } });
    expect(classifySettlementError(err)).toBe('transient_rpc');
  });

  it('classifies ECONNRESET as transient_rpc', () => {
    const err = Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
    expect(classifySettlementError(err)).toBe('transient_rpc');
  });

  it('classifies ETIMEDOUT as transient_rpc', () => {
    const err = Object.assign(new Error('socket timeout'), { code: 'ETIMEDOUT' });
    expect(classifySettlementError(err)).toBe('transient_rpc');
  });

  it('classifies timeout message as transient_rpc', () => {
    expect(classifySettlementError(new Error('RPC getBalance timeout'))).toBe('transient_rpc');
  });

  it('classifies insufficient funds as insufficient_funds', () => {
    expect(classifySettlementError(new Error('insufficient funds for gas'))).toBe('insufficient_funds');
  });

  it('classifies insufficient relayer balance message', () => {
    expect(classifySettlementError(new Error('Insufficient relayer balance'))).toBe('insufficient_funds');
  });

  it('classifies execution reverted as terminal', () => {
    expect(classifySettlementError(new Error('execution reverted: ERC20: transfer amount exceeds balance'))).toBe('terminal');
  });

  it('classifies INVALID_ARGUMENT code as terminal', () => {
    const err = Object.assign(new Error('invalid address'), { code: 'INVALID_ARGUMENT' });
    expect(classifySettlementError(err)).toBe('terminal');
  });

  it('classifies unknown errors as unknown', () => {
    expect(classifySettlementError(new Error('something completely new happened'))).toBe('unknown');
  });

  it('handles non-Error objects gracefully', () => {
    expect(classifySettlementError('a plain string error')).toBe('unknown');
    expect(classifySettlementError(null)).toBe('unknown');
    expect(classifySettlementError(undefined)).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// computeRetryDelay
// ---------------------------------------------------------------------------

describe('computeRetryDelay', () => {
  it('returns 0 for non-retryable categories', () => {
    expect(computeRetryDelay('insufficient_funds', 0)).toBe(0);
    expect(computeRetryDelay('terminal', 2)).toBe(0);
  });

  it('increases with retry count (exponential backoff)', () => {
    const d0 = computeRetryDelay('transient_rpc', 0);
    const d1 = computeRetryDelay('transient_rpc', 1);
    const d2 = computeRetryDelay('transient_rpc', 2);
    // With jitter the exact values vary, but the median should increase
    // Approximately: d0 ~2s, d1 ~4s, d2 ~8s (before cap)
    expect(d0).toBeGreaterThan(0);
    expect(d1).toBeGreaterThanOrEqual(d0 * 0.7); // allow for jitter
    expect(d2).toBeGreaterThanOrEqual(d1 * 0.7);
  });

  it('caps at maxDelayMs for the category', () => {
    // transient_rpc caps at 60_000ms — retry 20 would otherwise be huge
    const d = computeRetryDelay('transient_rpc', 20);
    expect(d).toBeLessThanOrEqual(60_000 * 1.2); // +20% jitter cap
  });
});

// ---------------------------------------------------------------------------
// SettlementFailureLedger — registration
// ---------------------------------------------------------------------------

describe('SettlementFailureLedger — register', () => {
  it('creates a pending entry', () => {
    const ledger = makeLedger();
    const entry = ledger.register(ORDER_ID, ACTION);
    expect(entry.orderId).toBe(ORDER_ID);
    expect(entry.action).toBe(ACTION);
    expect(entry.phase).toBe('pending');
    expect(entry.attempts).toHaveLength(0);
    expect(entry.retryCount).toBe(0);
  });

  it('register() is idempotent — second call returns existing entry', () => {
    const ledger = makeLedger();
    const first = ledger.register(ORDER_ID, ACTION, { key: 'value' });
    const second = ledger.register(ORDER_ID, ACTION, { key: 'other' });
    expect(first).toBe(second); // same reference
  });

  it('entries for different orderId+action combinations are independent', () => {
    const ledger = makeLedger();
    ledger.register('order-1', 'eth_send');
    ledger.register('order-1', 'xlm_refund');
    ledger.register('order-2', 'eth_send');
    expect(ledger.stats().pending).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// SettlementFailureLedger — attempt lifecycle
// ---------------------------------------------------------------------------

describe('SettlementFailureLedger — recordAttemptStart', () => {
  it('pushes a new attempt and transitions to retrying', () => {
    const ledger = makeLedger();
    ledger.register(ORDER_ID, ACTION);
    ledger.recordAttemptStart(ORDER_ID, ACTION);

    const entry = ledger.getEntry(ORDER_ID, ACTION)!;
    expect(entry.attempts).toHaveLength(1);
    expect(entry.attempts[0].attemptNumber).toBe(1);
    expect(entry.attempts[0].succeeded).toBe(false);
    expect(entry.attempts[0].completedAt).toBeUndefined();
    expect(entry.phase).toBe('retrying');
  });

  it('auto-registers if register() was not called', () => {
    const ledger = makeLedger();
    ledger.recordAttemptStart(ORDER_ID, ACTION);
    expect(ledger.getEntry(ORDER_ID, ACTION)).toBeDefined();
  });

  it('increments attempt numbers', () => {
    const ledger = makeLedger();
    ledger.register(ORDER_ID, ACTION);
    ledger.recordAttemptStart(ORDER_ID, ACTION);
    ledger.recordFailure(ORDER_ID, ACTION, new Error('transient'));
    ledger.recordAttemptStart(ORDER_ID, ACTION);

    const entry = ledger.getEntry(ORDER_ID, ACTION)!;
    expect(entry.attempts[1].attemptNumber).toBe(2);
  });
});

describe('SettlementFailureLedger — recordSuccess', () => {
  it('seals entry with succeeded phase and txHash', () => {
    const ledger = makeLedger();
    ledger.register(ORDER_ID, ACTION);
    ledger.recordAttemptStart(ORDER_ID, ACTION);
    ledger.recordSuccess(ORDER_ID, ACTION, '0xdeadbeef');

    const entry = ledger.getEntry(ORDER_ID, ACTION)!;
    expect(entry.phase).toBe('succeeded');
    expect(entry.successTxHash).toBe('0xdeadbeef');
    expect(entry.succeededAt).toBeTypeOf('number');
    expect(entry.attempts[0].succeeded).toBe(true);
    expect(entry.attempts[0].txHash).toBe('0xdeadbeef');
    expect(entry.attempts[0].completedAt).toBeTypeOf('number');
  });

  it('recordSuccess without prior recordAttemptStart synthesizes an attempt', () => {
    const ledger = makeLedger();
    ledger.register(ORDER_ID, ACTION);
    ledger.recordSuccess(ORDER_ID, ACTION, '0xsynthetic');

    const entry = ledger.getEntry(ORDER_ID, ACTION)!;
    expect(entry.phase).toBe('succeeded');
    expect(entry.attempts).toHaveLength(1);
  });

  it('no-ops when called on a non-existent entry', () => {
    const ledger = makeLedger();
    // Should not throw
    expect(() => ledger.recordSuccess('ghost', ACTION, '0x')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// SettlementFailureLedger — failure recording and retry policies
// ---------------------------------------------------------------------------

describe('SettlementFailureLedger — recordFailure: transient', () => {
  it('increments retryCount and sets a retryAfter in the future', () => {
    const ledger = makeLedger();
    ledger.register(ORDER_ID, ACTION);
    const nowBefore = Math.floor(Date.now() / 1000);

    const updated = ledger.recordFailure(ORDER_ID, ACTION, new Error('ECONNRESET'), 'transient_rpc');

    expect(updated.retryCount).toBe(1);
    expect(updated.phase).toBe('retrying');
    expect(updated.retryAfter).toBeGreaterThan(nowBefore);
  });

  it('records failure details on the attempt', () => {
    const ledger = makeLedger();
    ledger.register(ORDER_ID, ACTION);
    ledger.recordAttemptStart(ORDER_ID, ACTION);
    const err = new Error('connection reset');
    ledger.recordFailure(ORDER_ID, ACTION, err, 'transient_rpc');

    const entry = ledger.getEntry(ORDER_ID, ACTION)!;
    const last = entry.attempts[entry.attempts.length - 1];
    expect(last.failureCategory).toBe('transient_rpc');
    expect(last.errorMessage).toContain('connection reset');
    expect(last.succeeded).toBe(false);
    expect(last.completedAt).toBeTypeOf('number');
  });
});

describe('SettlementFailureLedger — recordFailure: terminal categories', () => {
  it('insufficient_funds → phase=failed_terminal immediately', () => {
    const ledger = makeLedger();
    ledger.register(ORDER_ID, ACTION);
    const updated = ledger.recordFailure(ORDER_ID, ACTION, new Error('insufficient funds'), 'insufficient_funds');
    expect(updated.phase).toBe('failed_terminal');
  });

  it('terminal → phase=failed_terminal immediately', () => {
    const ledger = makeLedger();
    ledger.register(ORDER_ID, ACTION);
    const updated = ledger.recordFailure(ORDER_ID, ACTION, new Error('execution reverted'), 'terminal');
    expect(updated.phase).toBe('failed_terminal');
  });
});

describe('SettlementFailureLedger — recordFailure: horizon_timeout', () => {
  it('horizon_timeout → phase=failed_ambiguous', () => {
    const ledger = makeLedger();
    ledger.register(ORDER_ID, ACTION);
    const updated = ledger.recordFailure(ORDER_ID, ACTION, new Error('Horizon 504'), 'horizon_timeout');
    expect(updated.phase).toBe('failed_ambiguous');
  });
});

describe('SettlementFailureLedger — retry budget exhaustion', () => {
  it('transitions to failed_terminal when maxRetries exceeded', () => {
    const ledger = makeLedger();
    ledger.register(ORDER_ID, ACTION);

    // transient_rpc has maxRetries=5
    for (let i = 0; i < 6; i++) {
      ledger.recordFailure(ORDER_ID, ACTION, new Error('transient'), 'transient_rpc');
    }

    const entry = ledger.getEntry(ORDER_ID, ACTION)!;
    expect(entry.phase).toBe('failed_terminal');
  });
});

// ---------------------------------------------------------------------------
// SettlementFailureLedger — ambiguous resolution
// ---------------------------------------------------------------------------

describe('SettlementFailureLedger — resolveAmbiguous / releaseAmbiguous', () => {
  it('resolveAmbiguous promotes to succeeded', () => {
    const ledger = makeLedger();
    ledger.register(ORDER_ID, ACTION);
    ledger.recordFailure(ORDER_ID, ACTION, new Error('Horizon 504'), 'horizon_timeout');

    ledger.resolveAmbiguous(ORDER_ID, ACTION, '0xresolved');
    const entry = ledger.getEntry(ORDER_ID, ACTION)!;
    expect(entry.phase).toBe('succeeded');
    expect(entry.successTxHash).toBe('0xresolved');
  });

  it('resolveAmbiguous is a no-op when phase is not failed_ambiguous', () => {
    const ledger = makeLedger();
    ledger.register(ORDER_ID, ACTION);
    ledger.recordSuccess(ORDER_ID, ACTION, '0xoriginal');
    ledger.resolveAmbiguous(ORDER_ID, ACTION, '0xnew');
    // should remain succeeded with original hash
    expect(ledger.getEntry(ORDER_ID, ACTION)?.successTxHash).toBe('0xoriginal');
  });

  it('releaseAmbiguous reopens for retry within budget', () => {
    const ledger = makeLedger();
    ledger.register(ORDER_ID, ACTION);
    ledger.recordFailure(ORDER_ID, ACTION, new Error('Horizon 504'), 'horizon_timeout');

    ledger.releaseAmbiguous(ORDER_ID, ACTION);
    const entry = ledger.getEntry(ORDER_ID, ACTION)!;
    expect(entry.phase).toBe('retrying');
  });

  it('releaseAmbiguous terminates when budget exhausted', () => {
    const ledger = makeLedger();
    ledger.register(ORDER_ID, ACTION);
    // horizon_timeout maxRetries=3 — fail 3 times to exhaust budget
    for (let i = 0; i < 3; i++) {
      ledger.recordFailure(ORDER_ID, ACTION, new Error('Horizon 504'), 'horizon_timeout');
      // Manually reset to ambiguous each time to simulate repeated timeout
      // (in practice the phase stays ambiguous after the first timeout)
    }
    // Force ambiguous state for the final releaseAmbiguous test
    const entry = ledger.getEntry(ORDER_ID, ACTION)!;
    (entry as any).phase = 'failed_ambiguous';

    ledger.releaseAmbiguous(ORDER_ID, ACTION);
    expect(ledger.getEntry(ORDER_ID, ACTION)?.phase).toBe('failed_terminal');
  });
});

// ---------------------------------------------------------------------------
// SettlementFailureLedger — isDueForRetry / canRetry
// ---------------------------------------------------------------------------

describe('SettlementFailureLedger — isDueForRetry', () => {
  it('returns false for a pending entry', () => {
    const ledger = makeLedger();
    ledger.register(ORDER_ID, ACTION);
    expect(ledger.isDueForRetry(ORDER_ID, ACTION)).toBe(false);
  });

  it('returns false while back-off window is active', () => {
    const ledger = makeLedger();
    ledger.register(ORDER_ID, ACTION);
    ledger.recordFailure(ORDER_ID, ACTION, new Error('timeout'), 'transient_rpc');
    // retryAfter is set in the future — should not be due yet
    expect(ledger.isDueForRetry(ORDER_ID, ACTION)).toBe(false);
  });

  it('returns true when retryAfter is in the past', () => {
    const ledger = makeLedger();
    ledger.register(ORDER_ID, ACTION);
    ledger.recordFailure(ORDER_ID, ACTION, new Error('timeout'), 'transient_rpc');

    const entry = ledger.getEntry(ORDER_ID, ACTION)!;
    // Backdate retryAfter
    (entry as any).retryAfter = Math.floor(Date.now() / 1000) - 1;

    expect(ledger.isDueForRetry(ORDER_ID, ACTION)).toBe(true);
  });
});

describe('SettlementFailureLedger — canRetry', () => {
  it('returns true for a fresh pending entry', () => {
    const ledger = makeLedger();
    ledger.register(ORDER_ID, ACTION);
    expect(ledger.canRetry(ORDER_ID, ACTION)).toBe(true);
  });

  it('returns false for a succeeded entry', () => {
    const ledger = makeLedger();
    ledger.register(ORDER_ID, ACTION);
    ledger.recordSuccess(ORDER_ID, ACTION, '0x1');
    expect(ledger.canRetry(ORDER_ID, ACTION)).toBe(false);
  });

  it('returns false for a terminal entry', () => {
    const ledger = makeLedger();
    ledger.register(ORDER_ID, ACTION);
    ledger.recordFailure(ORDER_ID, ACTION, new Error('insufficient funds'), 'insufficient_funds');
    expect(ledger.canRetry(ORDER_ID, ACTION)).toBe(false);
  });

  it('returns false for an unknown entry', () => {
    const ledger = makeLedger();
    expect(ledger.canRetry('ghost-order', ACTION)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SettlementFailureLedger — queries
// ---------------------------------------------------------------------------

describe('SettlementFailureLedger — dueForRetry', () => {
  it('returns only entries with retrying phase and expired retryAfter', () => {
    const ledger = makeLedger();
    const past = Math.floor(Date.now() / 1000) - 10;

    // Entry A: retrying, due
    ledger.register('a', ACTION);
    ledger.recordFailure('a', ACTION, new Error('timeout'), 'transient_rpc');
    (ledger.getEntry('a', ACTION) as any).retryAfter = past;

    // Entry B: retrying, NOT yet due
    ledger.register('b', ACTION);
    ledger.recordFailure('b', ACTION, new Error('timeout'), 'transient_rpc');
    // retryAfter remains in the future

    // Entry C: succeeded
    ledger.register('c', ACTION);
    ledger.recordSuccess('c', ACTION, '0xtx');

    const due = ledger.dueForRetry();
    expect(due).toHaveLength(1);
    expect(due[0].orderId).toBe('a');
  });
});

describe('SettlementFailureLedger — needsManualIntervention', () => {
  it('returns terminal entries', () => {
    const ledger = makeLedger();
    ledger.register(ORDER_ID, ACTION);
    ledger.recordFailure(ORDER_ID, ACTION, new Error('insufficient funds'), 'insufficient_funds');

    const needs = ledger.needsManualIntervention();
    expect(needs).toHaveLength(1);
    expect(needs[0].orderId).toBe(ORDER_ID);
  });

  it('does not return retrying or succeeded entries', () => {
    const ledger = makeLedger();
    // retrying
    ledger.register('order-r', ACTION);
    ledger.recordFailure('order-r', ACTION, new Error('timeout'), 'transient_rpc');
    // succeeded
    ledger.register('order-s', ACTION);
    ledger.recordSuccess('order-s', ACTION, '0x1');

    expect(ledger.needsManualIntervention()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// SettlementFailureLedger — stats
// ---------------------------------------------------------------------------

describe('SettlementFailureLedger — stats', () => {
  it('counts phases correctly across multiple entries', () => {
    const ledger = makeLedger();

    ledger.register('o1', 'eth_send');                        // pending
    ledger.register('o2', 'eth_send');
    ledger.recordFailure('o2', 'eth_send', new Error('ECONNRESET'), 'transient_rpc');  // retrying
    ledger.register('o3', 'eth_send');
    ledger.recordSuccess('o3', 'eth_send', '0x1');            // succeeded
    ledger.register('o4', 'eth_send');
    ledger.recordFailure('o4', 'eth_send', new Error('insufficient funds'), 'insufficient_funds'); // failed_terminal
    ledger.register('o5', 'eth_send');
    ledger.recordFailure('o5', 'eth_send', new Error('Horizon 504'), 'horizon_timeout'); // failed_ambiguous

    const stats = ledger.stats();
    expect(stats.pending).toBe(1);
    expect(stats.retrying).toBe(1);
    expect(stats.succeeded).toBe(1);
    expect(stats.failed_terminal).toBe(1);
    expect(stats.failed_ambiguous).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// SettlementFailureLedger — auto-classification via recordFailure
// ---------------------------------------------------------------------------

describe('SettlementFailureLedger — auto-classification', () => {
  it('classifies and records a rate-limit error correctly', () => {
    const ledger = makeLedger();
    ledger.register(ORDER_ID, ACTION);
    const err = Object.assign(new Error('exceeded compute units'), { code: 429 });
    const entry = ledger.recordFailure(ORDER_ID, ACTION, err);
    const last = entry.attempts[entry.attempts.length - 1];
    expect(last.failureCategory).toBe('rate_limit');
    expect(entry.phase).toBe('retrying');
  });

  it('classifies and records a nonce conflict correctly', () => {
    const ledger = makeLedger();
    ledger.register(ORDER_ID, ACTION);
    const entry = ledger.recordFailure(ORDER_ID, ACTION, new Error('nonce too low'));
    const last = entry.attempts[entry.attempts.length - 1];
    expect(last.failureCategory).toBe('nonce_conflict');
    expect(entry.phase).toBe('retrying');
  });
});

// ---------------------------------------------------------------------------
// SettlementFailureLedger — snapshot
// ---------------------------------------------------------------------------

describe('SettlementFailureLedger — snapshot', () => {
  it('returns all entries in an array', () => {
    const ledger = makeLedger();
    ledger.register('o1', 'eth_send');
    ledger.register('o2', 'xlm_refund');

    const snap = ledger.snapshot();
    expect(snap).toHaveLength(2);
    const ids = snap.map((e) => e.orderId);
    expect(ids).toContain('o1');
    expect(ids).toContain('o2');
  });

  it('returns an empty array when no entries', () => {
    const ledger = makeLedger();
    expect(ledger.snapshot()).toHaveLength(0);
  });
});
