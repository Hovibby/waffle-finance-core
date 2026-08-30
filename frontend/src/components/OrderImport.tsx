/**
 * OrderImport
 *
 * Allows users to import their order history from a CSV or JSON file.
 *
 * Features:
 *  - File upload input (drag-and-drop or click)
 *  - Preview table showing the first N valid rows before confirmation
 *  - Validates file structure (required columns / fields)
 *  - Shows row-level error details for malformed data
 *  - Allows partial import: skips invalid rows, imports valid ones
 *  - Stores imported orders in localStorage
 *  - Displays a storage quota warning when > 5 MB
 *  - Lets the user clear all imported orders
 *
 * Sub-components (DropZone, PreviewTable, ParsedPhase, SuccessPhase, etc.)
 * live in OrderImportParts.tsx to keep each file under the 450-line limit.
 */

import { useCallback, useRef, useState } from 'react';
import { Upload, ChevronDown, ChevronUp, AlertCircle, Trash2 } from 'lucide-react';
import type { Transaction } from '../hooks/useTransactionHistoryCache';
import { useOrderExportImport, type ImportRow, type RowValidationError } from '../hooks/useOrderExportImport';
import { DropZone, ParsedPhase, SuccessPhase } from './OrderImportParts';

// ─── Types ────────────────────────────────────────────────────────────────────

interface OrderImportProps {
  /** Called with the updater function when the user confirms an import. */
  onMerge: (updater: (prev: Transaction[]) => Transaction[]) => void;
}

type ImportPhase = 'idle' | 'parsed' | 'success';

// ─── Component ────────────────────────────────────────────────────────────────

export default function OrderImport({ onMerge }: OrderImportProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [phase, setPhase] = useState<ImportPhase>('idle');
  const [isDragging, setIsDragging] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportRow[]>([]);
  const [validationErrors, setValidationErrors] = useState<RowValidationError[]>([]);
  const [totalRows, setTotalRows] = useState(0);
  const [importedCount, setImportedCount] = useState(0);
  const [overQuota, setOverQuota] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const {
    parseImportFile,
    confirmImport,
    isImporting,
    importError,
    importedStorageBytes,
    clearImported,
  } = useOrderExportImport();

  const storedMb = (importedStorageBytes() / (1024 * 1024)).toFixed(2);

  const resetState = useCallback(() => {
    setPhase('idle');
    setFileName(null);
    setPreview([]);
    setValidationErrors([]);
    setTotalRows(0);
    setImportedCount(0);
    setOverQuota(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, []);

  const handleFile = useCallback(async (file: File) => {
    setFileName(file.name);
    setPhase('idle');
    try {
      const result = await parseImportFile(file);
      setPreview(result.preview);
      setValidationErrors(result.validationErrors);
      setTotalRows(result.totalRows);
      setPhase('parsed');
    } catch {
      // importError from hook is already set; UI renders it from hook state
    }
  }, [parseImportFile]);

  const handleFileInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) void handleFile(file);
  }, [handleFile]);

  const handleDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void handleFile(file);
  }, [handleFile]);

  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleConfirm = useCallback(() => {
    const result = confirmImport(preview, onMerge);
    setImportedCount(result.imported.length);
    setOverQuota(result.overQuota);
    setPhase('success');
  }, [confirmImport, preview, onMerge]);

  const handleClearImported = useCallback(() => {
    clearImported();
    resetState();
  }, [clearImported, resetState]);

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03]">
      {/* Header / Toggle */}
      <button
        type="button"
        onClick={() => setIsOpen((prev) => !prev)}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
        aria-expanded={isOpen}
        aria-controls="order-import-panel"
      >
        <div className="flex items-center gap-2.5">
          <Upload className="h-4 w-4 text-indigo-400/80" />
          <span className="text-sm font-semibold text-white">Import Orders</span>
          {parseFloat(storedMb) > 0 && (
            <span className="rounded-full bg-white/10 px-2 py-0.5 text-[0.68rem] text-slate-400">
              {storedMb} MB stored
            </span>
          )}
        </div>
        {isOpen
          ? <ChevronUp className="h-4 w-4 text-slate-400" />
          : <ChevronDown className="h-4 w-4 text-slate-400" />}
      </button>

      {/* Panel */}
      {isOpen && (
        <div id="order-import-panel" className="border-t border-white/[0.06] px-4 pb-4 pt-3 space-y-4">

          {/* Drop zone — shown only in idle phase */}
          {phase === 'idle' && (
            <DropZone
              isImporting={isImporting}
              isDragging={isDragging}
              fileInputRef={fileInputRef}
              onDragOver={handleDragOver}
              onDragLeave={() => setIsDragging(false)}
              onDrop={handleDrop}
              onFileInput={handleFileInput}
            />
          )}

          {/* Parse error */}
          {importError && (
            <div role="alert"
              className="flex items-start gap-2 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <div>
                <p className="font-semibold">Could not read file</p>
                <p className="mt-0.5 text-red-300/80">{importError}</p>
              </div>
            </div>
          )}

          {/* Parsed phase */}
          {phase === 'parsed' && (
            <ParsedPhase
              fileName={fileName}
              preview={preview}
              validationErrors={validationErrors}
              totalRows={totalRows}
              onReset={resetState}
              onConfirm={handleConfirm}
            />
          )}

          {/* Success phase */}
          {phase === 'success' && (
            <SuccessPhase
              importedCount={importedCount}
              overQuota={overQuota}
              onImportAnother={resetState}
              onClear={handleClearImported}
            />
          )}

          {/* Persistent clear button when there are stored imports and idle */}
          {phase === 'idle' && parseFloat(storedMb) > 0 && (
            <div className="flex items-center justify-between rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2">
              <p className="text-xs text-slate-400">{storedMb} MB of imported orders in local storage</p>
              <button type="button" onClick={handleClearImported}
                className="flex items-center gap-1.5 rounded-full border border-red-400/25 bg-red-400/[0.08] px-3 py-1.5 text-xs font-semibold text-red-300 transition-colors hover:bg-red-400/[0.15]">
                <Trash2 className="h-3 w-3" />
                Clear
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
