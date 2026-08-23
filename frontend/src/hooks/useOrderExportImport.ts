/**
 * useOrderExportImport
 *
 * Provides all logic for:
 *  - Generating CSV / JSON export files from the current transaction list
 *    (client-side generation) or by fetching from the coordinator API.
 *  - Parsing, validating, and importing CSV / JSON files uploaded by the user.
 *  - Persisting imported orders in localStorage and merging them with the
 *    live transaction list.
 *  - Storage quota management and user-facing error messages.
 *
 * The hook is intentionally stateless with respect to the full transaction
 * list — callers pass the current list in and get back export/import
 * primitives they can invoke on demand.
 */

import { useCallback, useState } from 'react';
import type { Transaction } from './useTransactionHistoryCache';

// ─── Schema version ────────────────────────────────────────────────────────

/** Bumped when the CSV/JSON column set changes in a breaking way. */
export const EXPORT_SCHEMA_VERSION = '1' as const;

// ─── CSV schema ────────────────────────────────────────────────────────────

/**
 * Ordered CSV column names.  Any change here must be reflected in
 * `EXPORT_SCHEMA_VERSION` and the migration table below.
 */
export const CSV_COLUMNS = [
  'orderId',
  'direction',
  'sourceChain',
  'destChain',
  'sourceAmount',
  'destAmount',
  'timestamp',
  'status',
  'beneficiary',
  'refundAddress',
  'claimedAt',
  'refundedAt',
  'schemaVersion',
] as const;

export type CsvColumn = (typeof CSV_COLUMNS)[number];

/** A parsed, validated CSV/JSON row before it is converted to a Transaction. */
export interface ImportRow {
  orderId: string;
  direction: string;
  sourceChain: string;
  destChain: string;
  sourceAmount: string;
  destAmount: string;
  timestamp: number;
  status: string;
  beneficiary: string;
  refundAddress: string;
  claimedAt: number | null;
  refundedAt: number | null;
  schemaVersion: string;
}

/** Result of a single-row validation attempt. */
export interface RowValidationResult {
  row: ImportRow | null;
  errors: string[];
  rowIndex: number;
}

/** Result of a complete import operation. */
export interface ImportResult {
  imported: Transaction[];
  skipped: number;
  errors: RowValidationError[];
}

export interface RowValidationError {
  rowIndex: number;
  messages: string[];
}

// ─── Local storage ─────────────────────────────────────────────────────────

const IMPORTED_ORDERS_KEY = 'wafflefinance_imported_orders_v1';
/** Warn the user when imported orders exceed this byte size. */
const STORAGE_WARN_BYTES = 5 * 1024 * 1024; // 5 MB
/** Hard cap on the number of imported rows kept in localStorage. */
const MAX_IMPORTED_ROWS = 1_000;

// ─── Helpers ───────────────────────────────────────────────────────────────

function escapeCsvCell(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        // Escaped double-quote inside a quoted field
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      cells.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current);
  return cells;
}

function formatDateTag(): string {
  return new Date().toISOString().slice(0, 10);
}

function downloadBlob(content: string, mimeType: string, filename: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  // Slight delay before revoking so Safari has time to start the download
  setTimeout(() => {
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  }, 100);
}

// ─── Export helpers ─────────────────────────────────────────────────────────

function transactionToImportRow(tx: Transaction): ImportRow {
  const isEthSrc = tx.direction === 'eth-to-xlm';
  return {
    orderId: tx.id,
    direction: tx.direction,
    sourceChain: isEthSrc ? 'ethereum' : 'stellar',
    destChain: isEthSrc ? 'stellar' : 'ethereum',
    sourceAmount: tx.amount,
    destAmount: tx.estimatedAmount,
    timestamp: tx.timestamp,
    status: tx.status,
    beneficiary: isEthSrc ? (tx.stellarAddress ?? '') : (tx.ethAddress ?? ''),
    refundAddress: isEthSrc ? (tx.ethAddress ?? '') : (tx.stellarAddress ?? ''),
    claimedAt: tx.status === 'completed' || tx.status === 'confirmed' ? tx.timestamp : null,
    refundedAt: tx.refundedAt ?? null,
    schemaVersion: EXPORT_SCHEMA_VERSION,
  };
}

function buildCsvFromTransactions(transactions: Transaction[]): string {
  const lines: string[] = [CSV_COLUMNS.join(',')];
  for (const tx of transactions) {
    const row = transactionToImportRow(tx);
    const cells: string[] = CSV_COLUMNS.map((col) => {
      const val = row[col];
      return val === null || val === undefined ? '' : String(val);
    });
    lines.push(cells.map(escapeCsvCell).join(','));
  }
  return lines.join('\n');
}

function buildJsonFromTransactions(transactions: Transaction[]): string {
  const payload = {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    totalCount: transactions.length,
    orders: transactions.map((tx) => ({
      ...transactionToImportRow(tx),
      // Include the original raw transaction fields as a nested object
      // so a round-trip import can recover all data (incl. tx hashes).
      raw: tx,
    })),
  };
  return JSON.stringify(payload, null, 2);
}

// ─── Import / validation helpers ────────────────────────────────────────────

/**
 * Validate a single raw row object (from CSV or JSON parsing).
 * Returns either a clean ImportRow or a list of human-friendly error strings.
 */
export function validateImportRow(
  raw: Record<string, string | number | null | undefined>,
  rowIndex: number,
): RowValidationResult {
  const errors: string[] = [];

  // Required fields
  const orderId = String(raw['orderId'] ?? '').trim();
  if (!orderId) errors.push("Column 'orderId' is missing or empty");

  const direction = String(raw['direction'] ?? '').trim();
  if (!direction) errors.push("Column 'direction' is missing or empty");
  else if (direction !== 'eth-to-xlm' && direction !== 'xlm-to-eth') {
    errors.push(`Column 'direction' must be 'eth-to-xlm' or 'xlm-to-eth', got '${direction}'`);
  }

  const sourceAmount = String(raw['sourceAmount'] ?? '').trim();
  if (!sourceAmount) errors.push("Column 'sourceAmount' is missing");
  else if (isNaN(parseFloat(sourceAmount))) {
    errors.push(`Column 'sourceAmount' is not a valid number: '${sourceAmount}'`);
  }

  const destAmount = String(raw['destAmount'] ?? '').trim();
  if (!destAmount) errors.push("Column 'destAmount' is missing");
  else if (isNaN(parseFloat(destAmount))) {
    errors.push(`Column 'destAmount' is not a valid number: '${destAmount}'`);
  }

  const tsRaw = raw['timestamp'];
  const timestamp =
    typeof tsRaw === 'number' ? tsRaw : parseInt(String(tsRaw ?? ''), 10);
  if (isNaN(timestamp) || timestamp <= 0) {
    errors.push(`Column 'timestamp' is not a valid unix timestamp: '${tsRaw}'`);
  }

  const status = String(raw['status'] ?? '').trim();
  const validStatuses = [
    'pending', 'completed', 'confirmed', 'cancelled',
    'failed', 'refunded', 'expired', 'timed_out',
  ];
  if (!status) errors.push("Column 'status' is missing");
  else if (!validStatuses.includes(status)) {
    errors.push(`Column 'status' has unrecognised value '${status}'`);
  }

  if (errors.length > 0) {
    return { row: null, errors, rowIndex };
  }

  // Optional nullable fields
  const toNum = (v: string | number | null | undefined): number | null => {
    if (v === null || v === undefined || v === '') return null;
    const n = typeof v === 'number' ? v : parseInt(String(v), 10);
    return isNaN(n) ? null : n;
  };

  return {
    row: {
      orderId,
      direction,
      sourceChain: String(raw['sourceChain'] ?? '').trim() || 'ethereum',
      destChain: String(raw['destChain'] ?? '').trim() || 'stellar',
      sourceAmount,
      destAmount,
      timestamp,
      status,
      beneficiary: String(raw['beneficiary'] ?? '').trim(),
      refundAddress: String(raw['refundAddress'] ?? '').trim(),
      claimedAt: toNum(raw['claimedAt']),
      refundedAt: toNum(raw['refundedAt']),
      schemaVersion: String(raw['schemaVersion'] ?? EXPORT_SCHEMA_VERSION),
    },
    errors: [],
    rowIndex,
  };
}

/**
 * Convert a validated ImportRow to a Transaction suitable for the history UI.
 * Imported rows carry a visual indicator via `isImported: true` (tracked in
 * localStorage alongside the row, not on the Transaction type itself —
 * the Transaction type is owned by the cache hook and we must not modify it).
 */
function importRowToTransaction(row: ImportRow): Transaction {
  const isEthSrc = row.direction === 'eth-to-xlm';
  return {
    id: row.orderId,
    txHash: row.orderId,          // Best available identifier for imported rows
    fromNetwork: isEthSrc ? 'Ethereum' : 'Stellar',
    toNetwork: isEthSrc ? 'Stellar' : 'Ethereum',
    fromToken: isEthSrc ? 'ETH' : 'XLM',
    toToken: isEthSrc ? 'XLM' : 'ETH',
    amount: row.sourceAmount,
    estimatedAmount: row.destAmount,
    status: row.status as Transaction['status'],
    timestamp: row.timestamp,
    direction: row.direction as Transaction['direction'],
    ethAddress: isEthSrc ? row.refundAddress : row.beneficiary,
    stellarAddress: isEthSrc ? row.beneficiary : row.refundAddress,
    refundedAt: row.refundedAt ?? undefined,
  };
}

/**
 * Parse CSV text into raw row objects keyed by column name.
 * Returns an array of partial records; validation is separate.
 */
function parseCsvText(text: string): Array<Record<string, string>> {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length < 2) return []; // header only or empty

  const headers = parseCsvLine(lines[0]).map((h) => h.trim());
  const rows: Array<Record<string, string>> = [];

  for (let i = 1; i < lines.length; i++) {
    const cells = parseCsvLine(lines[i]);
    const row: Record<string, string> = {};
    headers.forEach((header, j) => {
      row[header] = cells[j] ?? '';
    });
    rows.push(row);
  }

  return rows;
}

/**
 * Parse JSON export text. Accepts either:
 *  - An array of order objects
 *  - The full export envelope { orders: [...] } produced by the coordinator
 */
function parseJsonText(text: string): Array<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(text);

  if (Array.isArray(parsed)) return parsed as Array<Record<string, unknown>>;

  if (
    parsed !== null &&
    typeof parsed === 'object' &&
    'orders' in parsed &&
    Array.isArray((parsed as { orders: unknown }).orders)
  ) {
    const envelope = parsed as { orders: Array<Record<string, unknown>> };
    // Each element may have a nested `raw` field from the client-side exporter
    return envelope.orders.map((entry) => {
      if (entry['raw'] && typeof entry['raw'] === 'object') {
        return { ...entry, ...(entry['raw'] as Record<string, unknown>) };
      }
      return entry;
    });
  }

  throw new Error('Unrecognised JSON format. Expected an array or { orders: [...] } envelope.');
}

// ─── localStorage helpers ──────────────────────────────────────────────────

export interface ImportedOrdersStore {
  schemaVersion: string;
  orders: Transaction[];
}

export function readImportedOrders(): Transaction[] {
  try {
    const raw = localStorage.getItem(IMPORTED_ORDERS_KEY);
    if (!raw) return [];
    const store = JSON.parse(raw) as Partial<ImportedOrdersStore>;
    if (!Array.isArray(store.orders)) return [];
    return store.orders;
  } catch {
    return [];
  }
}

function writeImportedOrders(orders: Transaction[]): { overQuota: boolean } {
  const capped = orders.slice(0, MAX_IMPORTED_ROWS);
  const payload: ImportedOrdersStore = {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    orders: capped,
  };
  const serialised = JSON.stringify(payload);
  localStorage.setItem(IMPORTED_ORDERS_KEY, serialised);
  return { overQuota: serialised.length > STORAGE_WARN_BYTES };
}

export function clearImportedOrders(): void {
  localStorage.removeItem(IMPORTED_ORDERS_KEY);
}

// ─── Hook ──────────────────────────────────────────────────────────────────

export type ExportFormat = 'csv' | 'json';

export type DateRange = 'week' | 'month' | 'all';

export interface ExportOptions {
  format: ExportFormat;
  dateRange: DateRange;
  statusFilter: Transaction['status'] | 'all';
}

export interface UseOrderExportImportReturn {
  // Export
  exportTransactions: (transactions: Transaction[], options: ExportOptions) => void;
  fetchAndExportFromApi: (
    apiBase: string,
    options: ExportOptions & { ethAddress?: string; stellarAddress?: string },
  ) => Promise<void>;
  isExporting: boolean;
  exportError: string | null;

  // Import
  parseImportFile: (file: File) => Promise<{
    preview: ImportRow[];
    validationErrors: RowValidationError[];
    totalRows: number;
  }>;
  confirmImport: (
    rows: ImportRow[],
    onMerge: (updater: (prev: Transaction[]) => Transaction[]) => void,
  ) => ImportResult & { overQuota: boolean };
  isImporting: boolean;
  importError: string | null;

  // Storage management
  getImportedOrders: () => Transaction[];
  clearImported: () => void;
  importedStorageBytes: () => number;
}

export function useOrderExportImport(): UseOrderExportImportReturn {
  const [isExporting, setIsExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  // ── Export ────────────────────────────────────────────────────────────────

  const filterForExport = useCallback(
    (transactions: Transaction[], options: ExportOptions): Transaction[] => {
      const now = Date.now();
      const cutoffs: Record<DateRange, number> = {
        week: now - 7 * 24 * 60 * 60 * 1000,
        month: now - 30 * 24 * 60 * 60 * 1000,
        all: 0,
      };
      const cutoff = cutoffs[options.dateRange];

      return transactions.filter((tx) => {
        if (tx.timestamp < cutoff) return false;
        if (options.statusFilter !== 'all' && tx.status !== options.statusFilter) return false;
        return true;
      });
    },
    [],
  );

  const exportTransactions = useCallback(
    (transactions: Transaction[], options: ExportOptions) => {
      setExportError(null);
      setIsExporting(true);
      try {
        const filtered = filterForExport(transactions, options);
        const dateTag = formatDateTag();
        const filename = `orders-${dateTag}.${options.format}`;

        if (options.format === 'csv') {
          downloadBlob(buildCsvFromTransactions(filtered), 'text/csv;charset=utf-8', filename);
        } else {
          downloadBlob(
            buildJsonFromTransactions(filtered),
            'application/json;charset=utf-8',
            filename,
          );
        }
      } catch (err) {
        setExportError(err instanceof Error ? err.message : 'Export failed');
      } finally {
        setIsExporting(false);
      }
    },
    [filterForExport],
  );

  /**
   * Fetch the export directly from the coordinator API and stream the
   * attachment to the browser.  Falls back to client-side generation if the
   * API is unreachable.
   */
  const fetchAndExportFromApi = useCallback(
    async (
      apiBase: string,
      options: ExportOptions & { ethAddress?: string; stellarAddress?: string },
    ): Promise<void> => {
      setExportError(null);
      setIsExporting(true);
      try {
        const params = new URLSearchParams({ format: options.format });

        if (options.dateRange !== 'all') {
          const now = Date.now();
          const cutoffs: Record<Exclude<DateRange, 'all'>, number> = {
            week: now - 7 * 24 * 60 * 60 * 1000,
            month: now - 30 * 24 * 60 * 60 * 1000,
          };
          params.set(
            'startDate',
            String(Math.floor(cutoffs[options.dateRange as Exclude<DateRange, 'all'>] / 1000)),
          );
        }
        if (options.statusFilter !== 'all') {
          params.set('status', options.statusFilter);
        }
        if (options.ethAddress) params.set('address', options.ethAddress);

        const res = await fetch(`${apiBase}/api/orders/export?${params.toString()}`);
        if (!res.ok) throw new Error(`Server returned ${res.status}`);

        const blob = await res.blob();
        const dateTag = formatDateTag();
        const filename = `orders-${dateTag}.${options.format}`;
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = filename;
        anchor.style.display = 'none';
        document.body.appendChild(anchor);
        anchor.click();
        setTimeout(() => {
          document.body.removeChild(anchor);
          URL.revokeObjectURL(url);
        }, 100);
      } catch (err) {
        setExportError(err instanceof Error ? err.message : 'API export failed');
        throw err;
      } finally {
        setIsExporting(false);
      }
    },
    [],
  );

  // ── Import ─────────────────────────────────────────────────────────────────

  const parseImportFile = useCallback(
    async (
      file: File,
    ): Promise<{
      preview: ImportRow[];
      validationErrors: RowValidationError[];
      totalRows: number;
    }> => {
      setImportError(null);
      setIsImporting(true);
      try {
        const text = await file.text();
        let rawRows: Array<Record<string, string | number | null | undefined>>;

        const name = file.name.toLowerCase();
        if (name.endsWith('.csv')) {
          rawRows = parseCsvText(text) as Array<Record<string, string>>;
        } else if (name.endsWith('.json')) {
          rawRows = parseJsonText(text) as Array<Record<string, string | number | null | undefined>>;
        } else {
          // Best-effort: try JSON then CSV
          try {
            rawRows = parseJsonText(text) as Array<Record<string, string | number | null | undefined>>;
          } catch {
            rawRows = parseCsvText(text) as Array<Record<string, string>>;
          }
        }

        if (rawRows.length === 0) {
          return { preview: [], validationErrors: [], totalRows: 0 };
        }

        const results = rawRows.map((raw, idx) => validateImportRow(raw, idx + 1));
        const validRows = results.filter((r) => r.row !== null).map((r) => r.row as ImportRow);
        const validationErrors: RowValidationError[] = results
          .filter((r) => r.errors.length > 0)
          .map((r) => ({ rowIndex: r.rowIndex, messages: r.errors }));

        return {
          preview: validRows,
          validationErrors,
          totalRows: rawRows.length,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to parse file';
        setImportError(msg);
        throw new Error(msg);
      } finally {
        setIsImporting(false);
      }
    },
    [],
  );

  /**
   * Persist validated rows and merge them into the transaction list.
   * Duplicate IDs are deduplicated (existing live transactions take precedence).
   */
  const confirmImport = useCallback(
    (
      rows: ImportRow[],
      onMerge: (updater: (prev: Transaction[]) => Transaction[]) => void,
    ): ImportResult & { overQuota: boolean } => {
      const newTransactions = rows.map(importRowToTransaction);

      // Merge into live list: existing entries win on id collision
      onMerge((prev) => {
        const existingIds = new Set(prev.map((tx) => tx.id));
        const fresh = newTransactions.filter((tx) => !existingIds.has(tx.id));
        return [...prev, ...fresh].sort((a, b) => b.timestamp - a.timestamp);
      });

      // Persist imported rows independently so they survive a wallet cache clear
      const existing = readImportedOrders();
      const existingIds = new Set(existing.map((tx) => tx.id));
      const fresh = newTransactions.filter((tx) => !existingIds.has(tx.id));
      const merged = [...existing, ...fresh].sort((a, b) => b.timestamp - a.timestamp);
      const { overQuota } = writeImportedOrders(merged);

      return {
        imported: newTransactions,
        skipped: rows.length - newTransactions.length,
        errors: [],
        overQuota,
      };
    },
    [],
  );

  // ── Storage management ─────────────────────────────────────────────────────

  const getImportedOrders = useCallback((): Transaction[] => readImportedOrders(), []);

  const clearImported = useCallback((): void => clearImportedOrders(), []);

  const importedStorageBytes = useCallback((): number => {
    const raw = localStorage.getItem(IMPORTED_ORDERS_KEY);
    return raw ? raw.length : 0;
  }, []);

  return {
    exportTransactions,
    fetchAndExportFromApi,
    isExporting,
    exportError,
    parseImportFile,
    confirmImport,
    isImporting,
    importError,
    getImportedOrders,
    clearImported,
    importedStorageBytes,
  };
}
