import { useCallback, useMemo, useState } from 'react';
import {
  classifyProviderError,
  classifyReceiptTimeout,
  classifyRevertedTx,
  type OrderSubmissionCode,
  type OrderSubmissionFailure,
} from '../lib/orderSubmissionFallback';

export type BridgeErrorCategory =
  | 'quote_failure'
  | 'submission_failure'
  | 'network_disconnect'
  | 'reconciliation_failure'
  | 'unrecognized_response';

export interface BridgeError {
  category: BridgeErrorCategory;
  code: OrderSubmissionCode;
  message: string;
  retryable: boolean;
  recoverableActions: string[];
  httpStatus?: number;
  cause?: unknown;
}

function classifyQuoteError(err: unknown): BridgeError {
  const message = err instanceof Error ? err.message : 'Quote fetch failed';
  return {
    category: 'quote_failure',
    code: 'network_timeout',
    message: `Unable to fetch live quote: ${message}. Showing estimated rate from cache.`,
    retryable: true,
    recoverableActions: ['retry_submission', 'wait_and_retry'],
    cause: err,
  };
}

function classifyNetworkError(err: unknown): BridgeError {
  const message = err instanceof Error ? err.message : 'Network error';
  return {
    category: 'network_disconnect',
    code: 'network_timeout',
    message: `Network interrupted: ${message}. Please check your connection and retry.`,
    retryable: true,
    recoverableActions: ['retry_submission', 'wait_and_retry'],
    cause: err,
  };
}

function classifyReconciliationError(err: unknown): BridgeError {
  const message = err instanceof Error ? err.message : 'Reconciliation failed';
  return {
    category: 'reconciliation_failure',
    code: 'unknown_error',
    message: `Order state mismatch: ${message}. Check transaction history before retrying.`,
    retryable: false,
    recoverableActions: ['contact_support'],
    cause: err,
  };
}

export function classifyBridgeError(context: 'quote' | 'submission' | 'network' | 'reconciliation', err: unknown): BridgeError {
  if (context === 'quote') return classifyQuoteError(err);
  if (context === 'network') return classifyNetworkError(err);
  if (context === 'reconciliation') return classifyReconciliationError(err);
  if (context === 'submission') {
    const failure = classifyProviderError(err);
    return {
      category: 'submission_failure',
      code: failure.code,
      message: failure.message,
      retryable: failure.retryable,
      recoverableActions: failure.recoverableActions,
      httpStatus: failure.httpStatus,
      cause: failure.cause,
    };
  }
  return {
    category: 'unrecognized_response',
    code: 'unknown_error',
    message: 'An unexpected error occurred. Please try again or contact support.',
    retryable: false,
    recoverableActions: ['contact_support'],
    cause: err,
  };
}

export function useBridgeErrorHandler() {
  const [error, setError] = useState<BridgeError | null>(null);

  const handleError = useCallback((context: 'quote' | 'submission' | 'network' | 'reconciliation', err: unknown) => {
    const classified = classifyBridgeError(context, err);
    setError(classified);
    return classified;
  }, []);

  const clearError = useCallback(() => setError(null), []);

  return { error, handleError, clearError };
}
