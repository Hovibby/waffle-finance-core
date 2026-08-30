/**
 * Deterministic frontend integration harness for the full bridge lifecycle.
 *
 * This module exposes settable coordinator fixtures and a sequence runner that
 * exercises the main bridge flow: route selection -> quote formation ->
 * submission -> status updates -> recovery from transient failures.
 *
 * It is intentionally framework-agnostic so it can be used from Vitest or a
 * future Playwright suite without rewriting the scenario definitions.
 */

import type { BridgeQuote } from './quoteModel';

// ── Coordinator fixtures ──────────────────────────────────────────────────────

export interface CoordinatorQuoteResponse {
  success: boolean;
  data?: {
    estimatedAmount: string;
    exchangeRate: number;
    fee: string;
    timelockSeconds: number;
  };
  error?: string;
}

export interface CoordinatorSubmitResponse {
  success: boolean;
  data?: {
    orderId: string;
    txHash: string;
    status: 'pending' | 'completed' | 'failed';
  };
  error?: string;
}

export interface CoordinatorStatusResponse {
  success: boolean;
  data?: {
    status: 'pending' | 'completed' | 'failed' | 'refunded' | 'expired';
    txHash?: string;
    refundTxHash?: string;
  };
  error?: string;
}

export interface BridgeHarnessFixtures {
  quote: CoordinatorQuoteResponse;
  submit: CoordinatorSubmitResponse;
  statuses: CoordinatorStatusResponse[];
  submitAttempts: number;
  statusAttempts: number;
}

export function createBridgeHarnessFixtures(overrides: {
  quote?: Partial<CoordinatorQuoteResponse>;
  submit?: Partial<CoordinatorSubmitResponse>;
  statuses?: Partial<CoordinatorStatusResponse>[];
  submitAttempts?: number;
  statusAttempts?: number;
} = {}): BridgeHarnessFixtures {
  const quote: CoordinatorQuoteResponse = {
    success: true,
    data: {
      estimatedAmount: '100',
      exchangeRate: 100,
      fee: '0.01',
      timelockSeconds: 3600,
    },
    ...overrides.quote,
  };

  const submit: CoordinatorSubmitResponse = {
    success: true,
    data: {
      orderId: 'order-1',
      txHash: '0xabcdef1234567890',
      status: 'pending',
    },
    ...overrides.submit,
  };

  const statuses: CoordinatorStatusResponse[] = (overrides.statuses ?? [
    { success: true, data: { status: 'pending' } },
    { success: true, data: { status: 'completed' } },
  ]) as CoordinatorStatusResponse[];

  return {
    quote,
    submit,
    statuses,
    submitAttempts: overrides.submitAttempts ?? 0,
    statusAttempts: overrides.statusAttempts ?? 0,
  };
}

export type BridgeLifecycleStep =
  | { type: 'quote'; amount: string; direction: string }
  | { type: 'submit'; amount: string; direction: string }
  | { type: 'status_poll'; index: number }
  | { type: 'chain_switch'; newDirection: string }
  | { type: 'recovery_retry'; amount: string; direction: string };

export interface BridgeLifecycleHarness {
  fixtures: BridgeHarnessFixtures;
  reset: () => void;
  run: (steps: BridgeLifecycleStep[]) => LifecycleRunResult;
  getQuote: (direction: string, amount: string) => CoordinatorQuoteResponse;
  submitOrder: (direction: string, amount: string) => CoordinatorSubmitResponse;
  getStatus: (orderId: string, index: number) => CoordinatorStatusResponse;
}

export interface LifecycleRunResult {
  stepsRun: number;
  finalStatus?: string;
  errors: string[];
}

export function createBridgeLifecycleHarness(
  initialFixtures: BridgeHarnessFixtures = createBridgeHarnessFixtures()
): BridgeLifecycleHarness {
  let fixtures = initialFixtures;

  function reset() {
    fixtures = createBridgeHarnessFixtures();
  }

  function getQuote(_direction: string, _amount: string): CoordinatorQuoteResponse {
    return fixtures.quote;
  }

  function submitOrder(_direction: string, _amount: string): CoordinatorSubmitResponse {
    return fixtures.submit;
  }

  function getStatus(_orderId: string, index: number): CoordinatorStatusResponse {
    const idx = Math.min(index, fixtures.statuses.length - 1);
    return fixtures.statuses[idx];
  }

  function run(steps: BridgeLifecycleStep[]): LifecycleRunResult {
    const result: LifecycleRunResult = {
      stepsRun: 0,
      errors: [],
    };

    let currentDirection = 'eth_to_xlm';
    let currentStatus = 'pending';

    for (const step of steps) {
      result.stepsRun += 1;

      switch (step.type) {
        case 'quote': {
          const quote = getQuote(step.direction, step.amount);
          if (!quote.success) {
            result.errors.push(`Quote failed: ${quote.error}`);
            return result;
          }
          currentDirection = step.direction;
          break;
        }
        case 'submit': {
          const submit = submitOrder(step.direction, step.amount);
          if (!submit.success) {
            result.errors.push(`Submit failed: ${submit.error}`);
            return result;
          }
          currentStatus = submit.data?.status ?? 'pending';
          break;
        }
        case 'status_poll': {
          const status = getStatus('order-1', step.index);
          if (!status.success) {
            result.errors.push(`Status poll failed: ${status.error}`);
            return result;
          }
          if (status.data?.status) {
            currentStatus = status.data.status;
          }
          break;
        }
        case 'chain_switch': {
          currentDirection = step.newDirection;
          break;
        }
        case 'recovery_retry': {
          const retrySubmit = submitOrder(step.direction, step.amount);
          if (!retrySubmit.success) {
            result.errors.push(`Recovery retry failed: ${retrySubmit.error}`);
            return result;
          }
          currentStatus = retrySubmit.data?.status ?? currentStatus;
          break;
        }
      }
    }

    result.finalStatus = currentStatus;
    return result;
  }

  return {
    fixtures,
    reset,
    run,
    getQuote,
    submitOrder,
    getStatus,
  };
}
