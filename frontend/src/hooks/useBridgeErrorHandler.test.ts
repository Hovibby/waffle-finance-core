import { renderHook, act } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useBridgeErrorHandler, classifyBridgeError } from './useBridgeErrorHandler';

describe('useBridgeErrorHandler', () => {
  it('classifies quote errors', () => {
    const { result } = renderHook(() => useBridgeErrorHandler());
    const error = result.current.handleError('quote', new Error('fetch failed'));
    expect(error.category).toBe('quote_failure');
    expect(error.code).toBe('network_timeout');
    expect(error.retryable).toBe(true);
  });

  it('classifies submission errors', () => {
    const { result } = renderHook(() => useBridgeErrorHandler());
    const error = result.current.handleError('submission', new Error('user rejected'));
    expect(error.category).toBe('submission_failure');
    expect(error.code).toBe('user_rejected');
    expect(error.retryable).toBe(false);
  });

  it('classifies network errors', () => {
    const { result } = renderHook(() => useBridgeErrorHandler());
    const error = result.current.handleError('network', new Error('connection lost'));
    expect(error.category).toBe('network_disconnect');
    expect(error.retryable).toBe(true);
  });

  it('classifies reconciliation errors', () => {
    const { result } = renderHook(() => useBridgeErrorHandler());
    const error = result.current.handleError('reconciliation', new Error('state mismatch'));
    expect(error.category).toBe('reconciliation_failure');
    expect(error.retryable).toBe(false);
    expect(error.recoverableActions).toEqual(['contact_support']);
  });

  it('clears error state', () => {
    const { result } = renderHook(() => useBridgeErrorHandler());
    act(() => result.current.handleError('quote', new Error('fail')));
    expect(result.current.error).not.toBeNull();
    act(() => result.current.clearError());
    expect(result.current.error).toBeNull();
  });
});
