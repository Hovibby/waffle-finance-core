import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTransactionHistoryQuery } from '../useTransactionHistoryQuery';
import type { Transaction } from '../useTransactionHistoryCache';

function makeTx(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: '1',
    txHash: '0xabc',
    fromNetwork: 'Ethereum',
    toNetwork: 'Stellar',
    fromToken: 'ETH',
    toToken: 'XLM',
    amount: '1',
    estimatedAmount: '100',
    status: 'completed',
    timestamp: Date.now(),
    direction: 'eth-to-xlm',
    ...overrides,
  };
}

describe('useTransactionHistoryQuery', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test('filters by status', () => {
    const txs = [
      makeTx({ id: '1', status: 'pending' }),
      makeTx({ id: '2', status: 'completed' }),
      makeTx({ id: '3', status: 'pending' }),
    ];
    const { result } = renderHook(() => useTransactionHistoryQuery(txs));

    expect(result.current.result.total).toBe(3);

    act(() => { result.current.setQuery({ status: 'pending' }); });
    expect(result.current.result.total).toBe(2);
    expect(result.current.result.items.every(tx => tx.status === 'pending')).toBe(true);

    act(() => { result.current.setQuery({ status: 'completed' }); });
    expect(result.current.result.total).toBe(1);
  });

  test('filters by chain', () => {
    const txs = [
      makeTx({ id: '1', fromNetwork: 'Ethereum', toNetwork: 'Stellar' }),
      makeTx({ id: '2', fromNetwork: 'Solana', toNetwork: 'Ethereum' }),
    ];
    const { result } = renderHook(() => useTransactionHistoryQuery(txs));

    act(() => { result.current.setQuery({ chain: 'ethereum' }); });
    expect(result.current.result.total).toBe(2);

    act(() => { result.current.setQuery({ chain: 'solana' }); });
    expect(result.current.result.total).toBe(1);
  });

  test('sorts by timestamp desc by default', () => {
    const txs = [
      makeTx({ id: '1', timestamp: 100 }),
      makeTx({ id: '2', timestamp: 300 }),
      makeTx({ id: '3', timestamp: 200 }),
    ];
    const { result } = renderHook(() => useTransactionHistoryQuery(txs));

    expect(result.current.result.items[0].id).toBe('2');
    expect(result.current.result.items[1].id).toBe('3');
    expect(result.current.result.items[2].id).toBe('1');
  });

  test('paginates results', () => {
    const txs = Array.from({ length: 25 }, (_, i) => makeTx({ id: String(i + 1) }));
    const { result } = renderHook(() => useTransactionHistoryQuery(txs));

    expect(result.current.result.total).toBe(25);
    expect(result.current.result.items.length).toBe(20);
    expect(result.current.result.page).toBe(1);

    act(() => { result.current.setPage(2); });
    expect(result.current.result.items.length).toBe(5);
    expect(result.current.result.page).toBe(2);
  });
});
