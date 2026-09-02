/**
 * OrderImportParts
 *
 * Internal sub-components used by OrderImport.tsx.
 * Kept in a separate file to keep OrderImport under the 450-line limit.
 */

import { useState } from 'react';
import { Upload, AlertCircle, CheckCircle, Trash2, Loader2, FileText } from 'lucide-react';
import type { ImportRow, RowValidationError } from '../hooks/useOrderExportImport';

// ─── DropZone ─────────────────────────────────────────────────────────────────

const ACCEPTED_TYPES = '.csv,.json,text/csv,application/json';

export interface DropZoneProps {
  isImporting: boolean;
  isDragging: boolean;
  fileInputRef: React.RefObject<HTMLInputElement>;
  onDragOver: (e: React.DragEvent<HTMLDivElement>) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent<HTMLDivElement>) => void;
  onFileInput: (e: React.ChangeEvent<HTMLInputElement>) => void;
}

export function DropZone({
  isImporting,
  isDragging,
  fileInputRef,
  onDragOver,
  onDragLeave,
  onDrop,
  onFileInput,
}: DropZoneProps) {
  return (
    <div
      role="button"
      tabIndex={0}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onClick={() => fileInputRef.current?.click()}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') fileInputRef.current?.click();
      }}
      aria-label="Upload CSV or JSON order history file"
      className={`flex cursor-pointer flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed px-6 py-8 text-center transition-colors ${
        isDragging
          ? 'border-indigo-400/60 bg-indigo-400/[0.08]'
          : 'border-white/15 bg-white/[0.02] hover:border-indigo-400/35 hover:bg-indigo-400/[0.05]'
      }`}
    >
      {isImporting ? (
        <Loader2 className="h-8 w-8 animate-spin text-indigo-400" />
      ) : (
        <FileText className="h-8 w-8 text-slate-400" />
      )}
      <div>
        <p className="text-sm font-semibold text-white">
          {isImporting ? 'Parsing file…' : 'Drop a file or click to browse'}
        </p>
        <p className="mt-0.5 text-xs text-slate-500">CSV or JSON — exported from WaffleFinance</p>
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept={ACCEPTED_TYPES}
        onChange={onFileInput}
        className="sr-only"
        aria-hidden="true"
      />
    </div>
  );
}

// ─── ValidationErrorList ──────────────────────────────────────────────────────

export function ValidationErrorList({ errors }: { errors: RowValidationError[] }) {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? errors : errors.slice(0, 3);
  return (
    <div className="rounded-xl border border-amber-400/25 bg-amber-400/[0.06] px-3 py-2">
      <p className="mb-1.5 text-xs font-semibold text-amber-300">
        {errors.length} row{errors.length !== 1 ? 's' : ''} skipped
      </p>
      <ul className="space-y-1">
        {visible.map((e) => (
          <li key={e.rowIndex} className="text-[0.68rem] text-amber-200/80">
            <span className="font-semibold">Row {e.rowIndex}:</span>{' '}
            {e.messages.join('; ')}
          </li>
        ))}
      </ul>
      {errors.length > 3 && (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="mt-1.5 text-[0.68rem] text-amber-400 underline hover:no-underline"
        >
          {showAll ? 'Show less' : `Show ${errors.length - 3} more`}
        </button>
      )}
    </div>
  );
}

// ─── PreviewTable / PreviewRow ────────────────────────────────────────────────

const PREVIEW_ROWS = 5;

function statusColorClass(status: string): string {
  if (status === 'completed') return 'bg-emerald-500/15 text-emerald-300';
  if (status === 'failed' || status === 'expired') return 'bg-red-500/15 text-red-300';
  if (status === 'refunded') return 'bg-indigo-500/15 text-indigo-300';
  return 'bg-white/10 text-slate-300';
}

function PreviewRow({ row }: { row: ImportRow }) {
  const shortId =
    row.orderId.length > 14
      ? `${row.orderId.slice(0, 6)}…${row.orderId.slice(-6)}`
      : row.orderId;
  return (
    <tr className="hover:bg-white/[0.025]">
      <td className="px-3 py-2 font-mono text-slate-300">{shortId}</td>
      <td className="px-3 py-2 text-slate-300">{row.direction}</td>
      <td className="px-3 py-2 text-slate-300">{row.sourceAmount} ({row.sourceChain})</td>
      <td className="px-3 py-2 text-slate-300">{row.destAmount} ({row.destChain})</td>
      <td className="px-3 py-2">
        <span className={`rounded-full px-2 py-0.5 font-semibold ${statusColorClass(row.status)}`}>
          {row.status}
        </span>
      </td>
      <td className="px-3 py-2 text-slate-400">
        {new Date(row.timestamp).toLocaleDateString()}
      </td>
    </tr>
  );
}

export function PreviewTable({ rows }: { rows: ImportRow[] }) {
  return (
    <div>
      <p className="mb-2 text-[0.7rem] font-semibold uppercase tracking-[0.18em] text-slate-400">
        Preview (first {Math.min(PREVIEW_ROWS, rows.length)} rows)
      </p>
      <div className="overflow-x-auto rounded-xl border border-white/10">
        <table className="min-w-full text-xs" aria-label="Import preview">
          <thead>
            <tr className="border-b border-white/[0.06] bg-white/[0.03]">
              {['Order ID', 'Direction', 'From', 'To', 'Status', 'Date'].map((h) => (
                <th key={h} scope="col"
                  className="whitespace-nowrap px-3 py-2 text-left text-[0.65rem] font-semibold uppercase tracking-wide text-slate-500">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-white/[0.04]">
            {rows.slice(0, PREVIEW_ROWS).map((row, i) => <PreviewRow key={i} row={row} />)}
          </tbody>
        </table>
      </div>
      {rows.length > PREVIEW_ROWS && (
        <p className="mt-1.5 text-[0.68rem] text-slate-500">
          +{rows.length - PREVIEW_ROWS} more rows not shown
        </p>
      )}
    </div>
  );
}

// ─── ParsedPhase ──────────────────────────────────────────────────────────────

export interface ParsedPhaseProps {
  fileName: string | null;
  preview: ImportRow[];
  validationErrors: RowValidationError[];
  totalRows: number;
  onReset: () => void;
  onConfirm: () => void;
}

export function ParsedPhase({
  fileName,
  preview,
  validationErrors,
  totalRows,
  onReset,
  onConfirm,
}: ParsedPhaseProps) {
  return (
    <>
      <div className="flex items-center justify-between gap-2 rounded-xl border border-white/[0.07] bg-white/[0.03] px-3 py-2">
        <div className="flex items-center gap-2 text-xs">
          <FileText className="h-3.5 w-3.5 text-slate-400" />
          <span className="font-mono text-slate-300 truncate max-w-[12rem]">{fileName}</span>
        </div>
        <div className="flex items-center gap-2 text-xs text-slate-400">
          <span className="text-white">{preview.length}</span> valid
          {validationErrors.length > 0 && (
            <span className="text-amber-300">, {validationErrors.length} skipped</span>
          )}
          <span>/ {totalRows} total rows</span>
        </div>
      </div>

      {validationErrors.length > 0 && <ValidationErrorList errors={validationErrors} />}
      {preview.length > 0 && <PreviewTable rows={preview} />}

      {preview.length === 0 && totalRows > 0 && (
        <div role="alert"
          className="flex items-start gap-2 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>No valid rows found. Check that the file uses the WaffleFinance export format.</span>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <button type="button" onClick={onReset}
          className="rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-sm font-semibold text-slate-400 transition-colors hover:border-white/20 hover:text-white">
          Choose different file
        </button>
        <button type="button" onClick={onConfirm} disabled={preview.length === 0}
          className="flex items-center gap-2 rounded-full border border-indigo-400/35 bg-indigo-400/[0.14] px-4 py-2 text-sm font-semibold text-indigo-200 transition-colors hover:bg-indigo-400/[0.22] disabled:cursor-not-allowed disabled:opacity-50">
          <Upload className="h-4 w-4" />
          Import {preview.length} order{preview.length !== 1 ? 's' : ''}
        </button>
      </div>
    </>
  );
}

// ─── SuccessPhase ─────────────────────────────────────────────────────────────

export interface SuccessPhaseProps {
  importedCount: number;
  overQuota: boolean;
  onImportAnother: () => void;
  onClear: () => void;
}

export function SuccessPhase({ importedCount, overQuota, onImportAnother, onClear }: SuccessPhaseProps) {
  return (
    <div className="space-y-3">
      <div className="flex items-start gap-3 rounded-xl border border-emerald-400/30 bg-emerald-500/[0.08] px-4 py-3">
        <CheckCircle className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
        <div>
          <p className="text-sm font-semibold text-emerald-300">
            {importedCount} order{importedCount !== 1 ? 's' : ''} imported
          </p>
          <p className="mt-0.5 text-xs text-emerald-300/70">
            Imported orders are stored locally and marked as &quot;imported&quot; in your history.
          </p>
          {overQuota && (
            <p className="mt-1 text-xs text-amber-300">
              Warning: imported orders are approaching the 5 MB storage limit.
              Consider clearing old imports to free space.
            </p>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <button type="button" onClick={onImportAnother}
          className="rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-sm font-semibold text-slate-400 transition-colors hover:border-white/20 hover:text-white">
          Import another file
        </button>
        <button type="button" onClick={onClear}
          className="flex items-center gap-2 rounded-full border border-red-400/25 bg-red-400/[0.08] px-4 py-2 text-sm font-semibold text-red-300 transition-colors hover:bg-red-400/[0.15]">
          <Trash2 className="h-3.5 w-3.5" />
          Clear imported orders
        </button>
      </div>
    </div>
  );
}
