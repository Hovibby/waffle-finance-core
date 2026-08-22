/**
 * OrderExport
 *
 * Allows users to export their order history as CSV or JSON.
 *
 * Features:
 *  - Format selector (CSV / JSON)
 *  - Date range filter (last week / last month / all time)
 *  - Status filter (all / pending / completed / failed / refunded)
 *  - Triggers a browser download with a timestamped filename
 *  - Tries the coordinator API first; falls back to client-side generation
 *    if the API is unreachable
 */

import { useState } from 'react';
import { Download, ChevronDown, ChevronUp, AlertCircle, Loader2 } from 'lucide-react';
import type { Transaction } from '../hooks/useTransactionHistoryCache';
import {
  useOrderExportImport,
  type ExportFormat,
  type DateRange,
} from '../hooks/useOrderExportImport';

interface OrderExportProps {
  transactions: Transaction[];
  apiBase: string;
  ethAddress?: string;
  stellarAddress?: string;
}

const FORMAT_OPTIONS: { value: ExportFormat; label: string; description: string }[] = [
  { value: 'csv', label: 'CSV', description: 'Spreadsheet-compatible, flat format' },
  { value: 'json', label: 'JSON', description: 'Structured format with full detail' },
];

const DATE_RANGE_OPTIONS: { value: DateRange; label: string }[] = [
  { value: 'week', label: 'Last 7 days' },
  { value: 'month', label: 'Last 30 days' },
  { value: 'all', label: 'All time' },
];

const STATUS_OPTIONS: { value: Transaction['status'] | 'all'; label: string }[] = [
  { value: 'all', label: 'All statuses' },
  { value: 'pending', label: 'Pending' },
  { value: 'completed', label: 'Completed' },
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'failed', label: 'Failed' },
  { value: 'refunded', label: 'Refunded' },
  { value: 'expired', label: 'Expired' },
  { value: 'timed_out', label: 'Timed out' },
];

export default function OrderExport({
  transactions,
  apiBase,
  ethAddress,
  stellarAddress,
}: OrderExportProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [format, setFormat] = useState<ExportFormat>('csv');
  const [dateRange, setDateRange] = useState<DateRange>('all');
  const [statusFilter, setStatusFilter] = useState<Transaction['status'] | 'all'>('all');

  const { exportTransactions, fetchAndExportFromApi, isExporting, exportError } =
    useOrderExportImport();

  const handleExport = async () => {
    const options = { format, dateRange, statusFilter };

    // Try the coordinator API first for a server-authoritative export.
    // Fall back to client-side generation from the in-memory list.
    try {
      await fetchAndExportFromApi(apiBase, { ...options, ethAddress, stellarAddress });
    } catch {
      // API unavailable — generate from local transactions instead
      exportTransactions(transactions, options);
    }
  };

  // Count how many transactions match the current filters for user feedback
  const previewCount = (() => {
    const now = Date.now();
    const cutoffs: Record<DateRange, number> = {
      week: now - 7 * 24 * 60 * 60 * 1000,
      month: now - 30 * 24 * 60 * 60 * 1000,
      all: 0,
    };
    return transactions.filter((tx) => {
      if (tx.timestamp < cutoffs[dateRange]) return false;
      if (statusFilter !== 'all' && tx.status !== statusFilter) return false;
      return true;
    }).length;
  })();

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03]">
      {/* Header / Toggle */}
      <button
        type="button"
        onClick={() => setIsOpen((prev) => !prev)}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
        aria-expanded={isOpen}
        aria-controls="order-export-panel"
      >
        <div className="flex items-center gap-2.5">
          <Download className="h-4 w-4 text-cyan-400/80" />
          <span className="text-sm font-semibold text-white">Export Orders</span>
          <span className="rounded-full bg-white/10 px-2 py-0.5 text-[0.68rem] text-slate-400">
            {transactions.length} total
          </span>
        </div>
        {isOpen ? (
          <ChevronUp className="h-4 w-4 text-slate-400" />
        ) : (
          <ChevronDown className="h-4 w-4 text-slate-400" />
        )}
      </button>

      {/* Panel */}
      {isOpen && (
        <div
          id="order-export-panel"
          className="border-t border-white/[0.06] px-4 pb-4 pt-3"
        >
          <div className="grid gap-4 sm:grid-cols-3">
            {/* Format */}
            <div>
              <label className="mb-1.5 block text-[0.7rem] font-semibold uppercase tracking-[0.18em] text-slate-400">
                Format
              </label>
              <div className="flex gap-2">
                {FORMAT_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setFormat(opt.value)}
                    title={opt.description}
                    className={`flex-1 rounded-xl border py-2 text-sm font-semibold transition-colors ${
                      format === opt.value
                        ? 'border-cyan-400/40 bg-cyan-400/[0.14] text-cyan-200'
                        : 'border-white/10 bg-white/[0.04] text-slate-400 hover:border-white/20 hover:text-white'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Date range */}
            <div>
              <label
                htmlFor="export-date-range"
                className="mb-1.5 block text-[0.7rem] font-semibold uppercase tracking-[0.18em] text-slate-400"
              >
                Date range
              </label>
              <select
                id="export-date-range"
                value={dateRange}
                onChange={(e) => setDateRange(e.target.value as DateRange)}
                className="w-full rounded-xl border border-white/10 bg-[#07091c] px-3 py-2 text-sm text-white focus:border-cyan-400/40 focus:outline-none"
              >
                {DATE_RANGE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Status filter */}
            <div>
              <label
                htmlFor="export-status"
                className="mb-1.5 block text-[0.7rem] font-semibold uppercase tracking-[0.18em] text-slate-400"
              >
                Status
              </label>
              <select
                id="export-status"
                value={statusFilter}
                onChange={(e) =>
                  setStatusFilter(e.target.value as Transaction['status'] | 'all')
                }
                className="w-full rounded-xl border border-white/10 bg-[#07091c] px-3 py-2 text-sm text-white focus:border-cyan-400/40 focus:outline-none"
              >
                {STATUS_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Error */}
          {exportError && (
            <div
              role="alert"
              className="mt-3 flex items-start gap-2 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300"
            >
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{exportError}</span>
            </div>
          )}

          {/* Action row */}
          <div className="mt-4 flex items-center justify-between gap-3">
            <p className="text-xs text-slate-500">
              {previewCount} order{previewCount !== 1 ? 's' : ''} will be exported
            </p>
            <button
              type="button"
              onClick={() => void handleExport()}
              disabled={isExporting || previewCount === 0}
              className="flex items-center gap-2 rounded-full border border-cyan-400/35 bg-cyan-400/[0.14] px-4 py-2 text-sm font-semibold text-cyan-200 transition-colors hover:bg-cyan-400/[0.22] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isExporting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Download className="h-4 w-4" />
              )}
              {isExporting ? 'Exporting…' : `Export ${format.toUpperCase()}`}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
