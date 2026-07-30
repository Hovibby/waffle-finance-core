import { describe, expect, test, vi, beforeEach } from 'vitest';
import { createBridgeLifecycleHarness, type BridgeLifecycleStep, type LifecycleRunResult } from '../test/bridgeLifecycleHarness';
import { createQuote, validateQuote, type BridgeQuote } from '../lib/quoteModel';

describe('bridgeLifecycleHarness', () => {
  let harness: ReturnType<typeof createBridgeLifecycleHarness>;

  beforeEach(() => {
    harness = createBridgeLifecycleHarness();
  });

  test('runs a happy-path quote -> submit -> status poll', () => {
    const steps: BridgeLifecycleStep[] = [
      { type: 'quote', amount: '1', direction: 'eth_to_xlm' },
      { type: 'submit', amount: '1', direction: 'eth_to_xlm' },
      { type: 'status_poll', index: 0 },
      { type: 'status_poll', index: 1 },
    ];

    const result = harness.run(steps);
    expect(result.errors).toHaveLength(0);
    expect(result.finalStatus).toBe('completed');
    expect(result.stepsRun).toBe(4);
  });

  test('surfaces quote failure immediately', () => {
    harness = createBridgeLifecycleHarness({
      quote: { success: false, error: 'RPC timeout' },
    });

    const steps: BridgeLifecycleStep[] = [
      { type: 'quote', amount: '1', direction: 'eth_to_xlm' },
      { type: 'submit', amount: '1', direction: 'eth_to_xlm' },
    ];

    const result = harness.run(steps);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/Quote failed/);
    expect(result.stepsRun).toBe(1);
  });

  test('surfaces submit failure and preserves order params', () => {
    harness = createBridgeLifecycleHarness({
      submit: { success: false, error: 'User rejected' },
    });

    const steps: BridgeLifecycleStep[] = [
      { type: 'quote', amount: '1', direction: 'eth_to_xlm' },
      { type: 'submit', amount: '1', direction: 'eth_to_xlm' },
      { type: 'recovery_retry', amount: '1', direction: 'eth_to_xlm' },
    ];

    const result = harness.run(steps);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/Submit failed/);
    expect(result.stepsRun).toBe(2);
  });

  test('recovers after a transient submit failure', () => {
    const harnessWithFailure = createBridgeLifecycleHarness({
      submit: { success: false, error: 'network_timeout' },
      submitAttempts: 1,
    });

    const steps: BridgeLifecycleStep[] = [
      { type: 'quote', amount: '1', direction: 'eth_to_xlm' },
      { type: 'submit', amount: '1', direction: 'eth_to_xlm' },
      { type: 'recovery_retry', amount: '1', direction: 'eth_to_xlm' },
    ];

    const result = harnessWithFailure.run(steps);
    expect(result.errors).toHaveLength(1);
    expect(result.finalStatus).toBe('pending');
  });

  test('handles chain switch before recovery', () => {
    const steps: BridgeLifecycleStep[] = [
      { type: 'quote', amount: '1', direction: 'eth_to_xlm' },
      { type: 'submit', amount: '1', direction: 'eth_to_xlm' },
      { type: 'chain_switch', newDirection: 'eth_to_sol' },
      { type: 'recovery_retry', amount: '1', direction: 'eth_to_sol' },
    ];

    const result = harness.run(steps);
    expect(result.errors).toHaveLength(0);
    expect(result.stepsRun).toBe(4);
  });
});

describe('quote model guards stale or mismatched quotes', () => {
  test('rejects expired quote', () => {
    const quote = {
      quotedAt: Date.now() - 120_000,
      expiresAt: Date.now() - 60_000,
      srcChain: 'ethereum' as const,
      dstChain: 'stellar' as const,
      fromAmount: '1',
    };
    const result = validateQuote(quote as unknown as BridgeQuote, 'ethereum', 'stellar', '1');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('expired');
  });

  test('rejects quote after chain switch', () => {
    const quote = {
      quotedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      srcChain: 'ethereum' as const,
      dstChain: 'stellar' as const,
      fromAmount: '1',
    };
    const result = validateQuote(quote as unknown as BridgeQuote, 'stellar', 'ethereum', '1');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('chain_mismatch');
  });

  test('rejects quote after amount change', () => {
    const quote = {
      quotedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      srcChain: 'ethereum' as const,
      dstChain: 'stellar' as const,
      fromAmount: '1',
    };
    const result = validateQuote(quote as unknown as BridgeQuote, 'ethereum', 'stellar', '2');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('amount_mismatch');
  });
});
