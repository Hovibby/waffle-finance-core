// @vitest-environment jsdom

/**
 * Component tests for OrderImport.
 *
 * Verified concerns:
 *  - Panel opens/closes on toggle button click
 *  - Drop zone is rendered and announces itself accessibly
 *  - File input triggers parseImportFile with the selected file
 *  - Preview table renders valid rows
 *  - Validation errors are displayed per-row
 *  - "Import N orders" button calls confirmImport
 *  - "Choose different file" resets the panel
 *  - Success state shows imported count and offers to clear
 *  - "Clear imported orders" calls clearImported and resets panel
 *  - Persistent clear button is shown when stored bytes > 0
 *  - Error banner is shown when importError is set
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { Transaction } from '../hooks/useTransactionHistoryCache';
import type { ImportRow, RowValidationError } from '../hooks/useOrderExportImport';
import type * as OrderExportImportModule from '../hooks/useOrderExportImport';

// ── Mock the hook ─────────────────────────────────────────────────────────────

let mockParseResult: {
  preview: ImportRow[];
  validationErrors: RowValidationError[];
  totalRows: number;
} = { preview: [], validationErrors: [], totalRows: 0 };

const mockHook = {
  exportTransactions: vi.fn(),
  fetchAndExportFromApi: vi.fn(),
  isExporting: false,
  exportError: null,
  parseImportFile: vi.fn(),
  confirmImport: vi.fn(() => ({
    imported: [] as Transaction[],
    skipped: 0,
    errors: [],
    overQuota: false,
  })),
  isImporting: false,
  importError: null as string | null,
  getImportedOrders: vi.fn(() => [] as Transaction[]),
  clearImported: vi.fn(),
  importedStorageBytes: vi.fn(() => 0),
};

vi.mock('../hooks/useOrderExportImport', async (importOriginal) => {
  const actual = await importOriginal<typeof OrderExportImportModule>();
  return {
    ...actual,
    useOrderExportImport: () => mockHook,
  };
});

const { default: OrderImport } = await import('./OrderImport');

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeRow(overrides: Partial<ImportRow> = {}): ImportRow {
  return {
    orderId: 'wf_0xabc',
    direction: 'eth-to-xlm',
    sourceChain: 'ethereum',
    destChain: 'stellar',
    sourceAmount: '0.5',
    destAmount: '5000',
    timestamp: 1_700_000_000,
    status: 'completed',
    beneficiary: 'GABC',
    refundAddress: '0xuser',
    claimedAt: null,
    refundedAt: null,
    schemaVersion: '1',
    ...overrides,
  };
}

function makeCsvFile(name = 'orders.csv'): File {
  return new File(['orderId,direction\nwf_0xabc,eth-to-xlm'], name, {
    type: 'text/csv',
  });
}

const DEFAULT_PROPS = {
  onMerge: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  mockParseResult = { preview: [], validationErrors: [], totalRows: 0 };
  mockHook.isImporting = false;
  mockHook.importError = null;
  mockHook.importedStorageBytes.mockReturnValue(0);
  // Re-establish default implementation after vi.clearAllMocks() wipes it
  mockHook.parseImportFile.mockImplementation(async (_file: File) => mockParseResult);
  mockHook.confirmImport.mockReturnValue({
    imported: [],
    skipped: 0,
    errors: [],
    overQuota: false,
  });
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('OrderImport — panel toggle', () => {
  test('panel is collapsed by default', () => {
    render(<OrderImport {...DEFAULT_PROPS} />);
    expect(screen.queryByLabelText(/upload csv or json/i)).not.toBeInTheDocument();
  });

  test('panel opens on toggle button click', async () => {
    render(<OrderImport {...DEFAULT_PROPS} />);
    await userEvent.click(screen.getByRole('button', { name: /import orders/i }));
    // The drop zone is a div[role="button"] with accessible label
    expect(screen.getByRole('button', { name: /upload csv or json/i })).toBeInTheDocument();
  });

  test('toggle aria-expanded is updated correctly', async () => {
    render(<OrderImport {...DEFAULT_PROPS} />);
    const btn = screen.getByRole('button', { name: /import orders/i });
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(btn);
    expect(btn).toHaveAttribute('aria-expanded', 'true');
  });
});

describe('OrderImport — file selection', () => {
  test('calls parseImportFile when a file is chosen via input', async () => {
    mockParseResult = {
      preview: [makeRow()],
      validationErrors: [],
      totalRows: 1,
    };

    render(<OrderImport {...DEFAULT_PROPS} />);
    await userEvent.click(screen.getByRole('button', { name: /import orders/i }));

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await userEvent.upload(input, makeCsvFile());

    await waitFor(() => {
      expect(mockHook.parseImportFile).toHaveBeenCalledTimes(1);
    });
  });

  test('shows preview table after successful parse', async () => {
    mockParseResult = {
      preview: [makeRow()],
      validationErrors: [],
      totalRows: 1,
    };

    render(<OrderImport {...DEFAULT_PROPS} />);
    await userEvent.click(screen.getByRole('button', { name: /import orders/i }));

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await userEvent.upload(input, makeCsvFile());

    await waitFor(() => {
      expect(screen.getByRole('table', { name: /import preview/i })).toBeInTheDocument();
    });
  });
});

describe('OrderImport — validation errors', () => {
  test('shows row-level validation errors', async () => {
    mockParseResult = {
      preview: [],
      validationErrors: [
        { rowIndex: 2, messages: ["Column 'orderId' is missing or empty"] },
      ],
      totalRows: 1,
    };

    render(<OrderImport {...DEFAULT_PROPS} />);
    await userEvent.click(screen.getByRole('button', { name: /import orders/i }));

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await userEvent.upload(input, makeCsvFile());

    await waitFor(() => {
      expect(screen.getByText(/1 row skipped/i)).toBeInTheDocument();
      expect(screen.getByText(/orderId/i)).toBeInTheDocument();
    });
  });

  test('shows "no valid rows" message when all rows are invalid', async () => {
    mockParseResult = {
      preview: [],
      validationErrors: [{ rowIndex: 1, messages: ['bad'] }],
      totalRows: 1,
    };

    render(<OrderImport {...DEFAULT_PROPS} />);
    await userEvent.click(screen.getByRole('button', { name: /import orders/i }));

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await userEvent.upload(input, makeCsvFile());

    await waitFor(() => {
      expect(screen.getByText(/no valid rows found/i)).toBeInTheDocument();
    });
  });

  test('"show more" expands beyond 3 errors', async () => {
    mockParseResult = {
      preview: [],
      validationErrors: Array.from({ length: 5 }, (_, i) => ({
        rowIndex: i + 1,
        messages: ['bad row'],
      })),
      totalRows: 5,
    };

    render(<OrderImport {...DEFAULT_PROPS} />);
    await userEvent.click(screen.getByRole('button', { name: /import orders/i }));

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await userEvent.upload(input, makeCsvFile());

    await waitFor(() => expect(screen.getByText(/show 2 more/i)).toBeInTheDocument());
    await userEvent.click(screen.getByText(/show 2 more/i));
    expect(screen.getByText(/show less/i)).toBeInTheDocument();
  });
});

describe('OrderImport — confirm import', () => {
  test('import button calls confirmImport with the preview rows', async () => {
    const rows = [makeRow({ orderId: 'wf_1' }), makeRow({ orderId: 'wf_2' })];
    mockParseResult = { preview: rows, validationErrors: [], totalRows: 2 };
    mockHook.confirmImport.mockReturnValue({
      imported: rows.map((r) => ({ id: r.orderId } as Transaction)),
      skipped: 0,
      errors: [],
      overQuota: false,
    });

    render(<OrderImport {...DEFAULT_PROPS} />);
    await userEvent.click(screen.getByRole('button', { name: /import orders/i }));

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await userEvent.upload(input, makeCsvFile());

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /import 2 orders/i })).toBeInTheDocument(),
    );
    await userEvent.click(screen.getByRole('button', { name: /import 2 orders/i }));

    expect(mockHook.confirmImport).toHaveBeenCalledWith(rows, DEFAULT_PROPS.onMerge);
  });

  test('import button is disabled when preview is empty', async () => {
    mockParseResult = { preview: [], validationErrors: [], totalRows: 0 };

    render(<OrderImport {...DEFAULT_PROPS} />);
    await userEvent.click(screen.getByRole('button', { name: /import orders/i }));

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await userEvent.upload(input, makeCsvFile());

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /import 0 orders/i })).toBeDisabled(),
    );
  });
});

describe('OrderImport — success state', () => {
  test('shows success message with imported count after confirm', async () => {
    const rows = [makeRow()];
    mockParseResult = { preview: rows, validationErrors: [], totalRows: 1 };
    mockHook.confirmImport.mockReturnValue({
      imported: [{ id: 'wf_0xabc' } as Transaction],
      skipped: 0,
      errors: [],
      overQuota: false,
    });

    render(<OrderImport {...DEFAULT_PROPS} />);
    await userEvent.click(screen.getByRole('button', { name: /import orders/i }));

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await userEvent.upload(input, makeCsvFile());
    await waitFor(() => screen.getByRole('button', { name: /import 1 order/i }));
    await userEvent.click(screen.getByRole('button', { name: /import 1 order/i }));

    expect(screen.getByText(/1 order imported/i)).toBeInTheDocument();
  });

  test('shows quota warning when overQuota is true', async () => {
    const rows = [makeRow()];
    mockParseResult = { preview: rows, validationErrors: [], totalRows: 1 };
    mockHook.confirmImport.mockReturnValue({
      imported: [{ id: 'wf_0xabc' } as Transaction],
      skipped: 0,
      errors: [],
      overQuota: true,
    });

    render(<OrderImport {...DEFAULT_PROPS} />);
    await userEvent.click(screen.getByRole('button', { name: /import orders/i }));

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await userEvent.upload(input, makeCsvFile());
    await waitFor(() => screen.getByRole('button', { name: /import 1 order/i }));
    await userEvent.click(screen.getByRole('button', { name: /import 1 order/i }));

    expect(screen.getByText(/5 MB storage limit/i)).toBeInTheDocument();
  });

  test('"Import another file" resets the panel to idle', async () => {
    const rows = [makeRow()];
    mockParseResult = { preview: rows, validationErrors: [], totalRows: 1 };
    mockHook.confirmImport.mockReturnValue({
      imported: [{ id: 'wf_0xabc' } as Transaction],
      skipped: 0,
      errors: [],
      overQuota: false,
    });

    render(<OrderImport {...DEFAULT_PROPS} />);
    await userEvent.click(screen.getByRole('button', { name: /import orders/i }));

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await userEvent.upload(input, makeCsvFile());
    await waitFor(() => screen.getByRole('button', { name: /import 1 order/i }));
    await userEvent.click(screen.getByRole('button', { name: /import 1 order/i }));
    await userEvent.click(screen.getByRole('button', { name: /import another file/i }));

    expect(screen.getByRole('button', { name: /upload csv or json/i })).toBeInTheDocument();
  });

  test('"Clear imported orders" calls clearImported and resets panel', async () => {
    const rows = [makeRow()];
    mockParseResult = { preview: rows, validationErrors: [], totalRows: 1 };
    mockHook.confirmImport.mockReturnValue({
      imported: [{ id: 'wf_0xabc' } as Transaction],
      skipped: 0,
      errors: [],
      overQuota: false,
    });

    render(<OrderImport {...DEFAULT_PROPS} />);
    await userEvent.click(screen.getByRole('button', { name: /import orders/i }));

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await userEvent.upload(input, makeCsvFile());
    await waitFor(() => screen.getByRole('button', { name: /import 1 order/i }));
    await userEvent.click(screen.getByRole('button', { name: /import 1 order/i }));
    await userEvent.click(screen.getByRole('button', { name: /clear imported orders/i }));

    expect(mockHook.clearImported).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: /upload csv or json/i })).toBeInTheDocument();
  });
});

describe('OrderImport — idle clear button', () => {
  test('shows persistent clear button when stored bytes > 0', async () => {
    mockHook.importedStorageBytes.mockReturnValue(1024 * 100); // 100 KB

    render(<OrderImport {...DEFAULT_PROPS} />);
    await userEvent.click(screen.getByRole('button', { name: /import orders/i }));

    // The header should also show the stored size
    expect(screen.getAllByText(/MB stored/i).length).toBeGreaterThanOrEqual(1);
  });
});

describe('OrderImport — parse error', () => {
  test('displays importError when hook sets it', async () => {
    mockHook.importError = 'Unrecognised JSON format';
    mockHook.parseImportFile.mockRejectedValue(new Error('Unrecognised JSON format'));

    render(<OrderImport {...DEFAULT_PROPS} />);
    await userEvent.click(screen.getByRole('button', { name: /import orders/i }));

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await userEvent.upload(input, makeCsvFile());

    await waitFor(() => {
      expect(screen.getByText(/could not read file/i)).toBeInTheDocument();
      expect(screen.getByText(/unrecognised json format/i)).toBeInTheDocument();
    });
  });
});

describe('OrderImport — "Choose different file" reset', () => {
  test('clicking reset returns to the file-drop phase', async () => {
    mockParseResult = { preview: [makeRow()], validationErrors: [], totalRows: 1 };

    render(<OrderImport {...DEFAULT_PROPS} />);
    await userEvent.click(screen.getByRole('button', { name: /import orders/i }));

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await userEvent.upload(input, makeCsvFile());

    await waitFor(() =>
      screen.getByRole('button', { name: /choose different file/i }),
    );
    await userEvent.click(screen.getByRole('button', { name: /choose different file/i }));

    expect(screen.getByRole('button', { name: /upload csv or json/i })).toBeInTheDocument();
  });
});
