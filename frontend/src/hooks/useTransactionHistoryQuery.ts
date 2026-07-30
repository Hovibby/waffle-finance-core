import { useMemo, useState } from 'react';
import type { Transaction } from '../hooks/useTransactionHistoryCache';

export type HistoryFilterField = 'status' | 'chain' | 'asset' | 'address' | 'timeWindow';

export type HistorySortField = 'timestamp' | 'amount' | 'status' | 'network';

export interface HistoryQuery {
  status?: Transaction['status'] | 'all';
  chain?: string;
  asset?: string;
  address?: string;
  timeWindow?: { start: number; end: number };
}

export interface HistoryQueryOptions {
  query: HistoryQuery;
  sort: HistorySortField;
  sortDirection: 'asc' | 'desc';
  page: number;
  pageSize: number;
}

export interface HistoryQueryResult {
  items: Transaction[];
  total: number;
  page: number;
  pageSize: number;
}

const DEFAULT_PAGE_SIZE = 20;

function matchesStatus(tx: Transaction, status?: Transaction['status'] | 'all'): boolean {
  if (!status || status === 'all') return true;
  return tx.status === status;
}

function matchesChain(tx: Transaction, chain?: string): boolean {
  if (!chain) return true;
  const normalized = chain.toLowerCase();
  return (
    tx.fromNetwork.toLowerCase().includes(normalized) ||
    tx.toNetwork.toLowerCase().includes(normalized)
  );
}

function matchesAsset(tx: Transaction, asset?: string): boolean {
  if (!asset) return true;
  const normalized = asset.toLowerCase();
  return (
    tx.fromToken.toLowerCase() === normalized ||
    tx.toToken.toLowerCase() === normalized
  );
}

function matchesAddress(tx: Transaction, address?: string): boolean {
  if (!address) return true;
  const normalized = address.trim().toLowerCase();
  if (!normalized) return true;
  return (
    (tx.ethAddress?.toLowerCase() || '').includes(normalized) ||
    (tx.stellarAddress?.toLowerCase() || '').includes(normalized) ||
    tx.txHash.toLowerCase().includes(normalized) ||
    tx.id.toLowerCase().includes(normalized)
  );
}

function matchesTimeWindow(tx: Transaction, timeWindow?: { start: number; end: number }): boolean {
  if (!timeWindow) return true;
  return tx.timestamp >= timeWindow.start && tx.timestamp <= timeWindow.end;
}

function matchesQuery(tx: Transaction, query: HistoryQuery): boolean {
  return (
    matchesStatus(tx, query.status) &&
    matchesChain(tx, query.chain) &&
    matchesAsset(tx, query.asset) &&
    matchesAddress(tx, query.address) &&
    matchesTimeWindow(tx, query.timeWindow)
  );
}

function sortTransactions(transactions: Transaction[], sort: HistorySortField, direction: 'asc' | 'desc'): Transaction[] {
  const sorted = [...transactions].sort((a, b) => {
    let cmp = 0;
    if (sort === 'timestamp') cmp = a.timestamp - b.timestamp;
    else if (sort === 'amount') cmp = parseFloat(a.amount) - parseFloat(b.amount);
    else if (sort === 'status') cmp = a.status.localeCompare(b.status);
    else if (sort === 'network') cmp = a.fromNetwork.localeCompare(b.fromNetwork);
    return direction === 'asc' ? cmp : -cmp;
  });
  return sorted;
}

export function useTransactionHistoryQuery(transactions: Transaction[]) {
  const [options, setOptions] = useState<HistoryQueryOptions>({
    query: {},
    sort: 'timestamp',
    sortDirection: 'desc',
    page: 1,
    pageSize: DEFAULT_PAGE_SIZE,
  });

  const filtered = useMemo(() => {
    return transactions.filter((tx) => matchesQuery(tx, options.query));
  }, [transactions, options.query]);

  const sorted = useMemo(() => {
    return sortTransactions(filtered, options.sort, options.sortDirection);
  }, [filtered, options.sort, options.sortDirection]);

  const paginated = useMemo(() => {
    const start = (options.page - 1) * options.pageSize;
    const end = start + options.pageSize;
    return sorted.slice(start, end);
  }, [sorted, options.page, options.pageSize]);

  const result: HistoryQueryResult = {
    items: paginated,
    total: sorted.length,
    page: options.page,
    pageSize: options.pageSize,
  };

  const setQuery = (patch: Partial<HistoryQuery>) => {
    setOptions((prev) => ({
      ...prev,
      query: { ...prev.query, ...patch },
      page: 1,
    }));
  };

  const setSort = (sort: HistorySortField) => {
    setOptions((prev) => ({
      ...prev,
      sort,
      sortDirection: prev.sort === sort && prev.sortDirection === 'desc' ? 'asc' : 'desc',
      page: 1,
    }));
  };

  const setPage = (page: number) => {
    setOptions((prev) => ({ ...prev, page }));
  };

  const setPageSize = (pageSize: number) => {
    setOptions((prev) => ({ ...prev, pageSize, page: 1 }));
  };

  return {
    result,
    options,
    setQuery,
    setSort,
    setPage,
    setPageSize,
  };
}
