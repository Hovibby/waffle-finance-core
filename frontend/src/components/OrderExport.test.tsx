// @vitest-environment jsdom

/**
 * Component tests for OrderExport.
 *
 * Verified concerns:
 *  - Panel opens/closes on toggle button click
 *  - Format, date-range, and status controls render and update state
 *  - Export button is disabled when previewCount is 0
 *  - Export button triggers exportTransactions (or API fetch) on click
 *  - Loading state is reflected while exporting
 *  - Error state is displayed when exportError is set
 *  - Accessibility: aria-expanded toggles correctly
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { Transaction } from '../hooks/useTransactionHistoryCache';
import type * as OrderExportImportModule from '../hooks/useOrderExportImport';

// ── Mock the hook so we control all side effects ──────────────────────────────

const mockHook = {
  exportTransactions: vi.fn(),
  fetchAndExportFromApi: vi.fn().mockRejectedValue(new Error('api down')),
  isExporting: false,
  exportError: null as string | null,
  parseImportFile: vi.fn(),
  confirmImport: vi.fn(),
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

const { default: OrderExport } = await import('./OrderExport');

// ── Fixture ───────────────────────────────────────────────────────────────────

function makeTx(id: string, status: Transaction['status'] = 'completed'): Transaction {
  return {
    id,
    txHash: `0x${id}`,
    fromNetwork: 'Ethereum',
    toNetwork: 'Stellar',
    fromToken: 'ETH',
    toToken: 'XLM',
    amount: '0.5',
    estimatedAmount: '5000',
    status,
    timestamp: Date.now() - 1000,
    direction: 'eth-to-xlm',
  };
}

const DEFAULT_PROPS = {
  transactions: [makeTx('1'), makeTx('2', 'failed')],
  apiBase: 'https://coordinator.example',
  ethAddress: '0xuser',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockHook.isExporting = false;
  mockHook.exportError = null;
  mockHook.fetchAndExportFromApi = vi.fn().mockRejectedValue(new Error('api down'));
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('OrderExport — panel toggle', () => {
  test('panel is collapsed by default', () => {
    render(<OrderExport {...DEFAULT_PROPS} />);
    expect(screen.queryByLabelText(/format/i)).not.toBeInTheDocument();
  });

  test('panel opens on toggle button click', async () => {
    render(<OrderExport {...DEFAULT_PROPS} />);
    await userEvent.click(screen.getByRole('button', { name: /export orders/i }));
    expect(screen.getByLabelText(/date range/i)).toBeInTheDocument();
  });

  test('toggle button has correct aria-expanded', async () => {
    render(<OrderExport {...DEFAULT_PROPS} />);
    const btn = screen.getByRole('button', { name: /export orders/i });
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(btn);
    expect(btn).toHaveAttribute('aria-expanded', 'true');
  });

  test('panel closes again on second click', async () => {
    render(<OrderExport {...DEFAULT_PROPS} />);
    const btn = screen.getByRole('button', { name: /export orders/i });
    await userEvent.click(btn);
    await userEvent.click(btn);
    expect(screen.queryByLabelText(/date range/i)).not.toBeInTheDocument();
  });
});

describe('OrderExport — format selector', () => {
  test('CSV and JSON buttons are rendered', async () => {
    render(<OrderExport {...DEFAULT_PROPS} />);
    await userEvent.click(screen.getByRole('button', { name: /export orders/i }));
    expect(screen.getByRole('button', { name: /^csv$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^json$/i })).toBeInTheDocument();
  });

  test('CSV is selected by default', async () => {
    render(<OrderExport {...DEFAULT_PROPS} />);
    await userEvent.click(screen.getByRole('button', { name: /export orders/i }));
    // The selected button should have the active color class (cyan border)
    const csvBtn = screen.getByRole('button', { name: /^csv$/i });
    expect(csvBtn.className).toMatch(/cyan/);
  });

  test('clicking JSON selects it', async () => {
    render(<OrderExport {...DEFAULT_PROPS} />);
    await userEvent.click(screen.getByRole('button', { name: /export orders/i }));
    await userEvent.click(screen.getByRole('button', { name: /^json$/i }));
    const jsonBtn = screen.getByRole('button', { name: /^json$/i });
    expect(jsonBtn.className).toMatch(/cyan/);
  });
});

describe('OrderExport — preview count', () => {
  test('shows total matching count above export button', async () => {
    render(<OrderExport {...DEFAULT_PROPS} />);
    await userEvent.click(screen.getByRole('button', { name: /export orders/i }));
    // All-time, all-status defaults → both transactions count
    expect(screen.getByText(/2 orders? will be exported/i)).toBeInTheDocument();
  });

  test('export button is disabled when 0 rows match the filter', async () => {
    render(<OrderExport {...DEFAULT_PROPS} />);
    await userEvent.click(screen.getByRole('button', { name: /export orders/i }));
    // Select a status that no transaction has
    const select = screen.getByLabelText(/status/i);
    fireEvent.change(select, { target: { value: 'refunded' } });
    const exportBtn = screen.getByRole('button', { name: /export csv/i });
    expect(exportBtn).toBeDisabled();
  });
});

describe('OrderExport — export action', () => {
  test('calls exportTransactions (fallback) when API fails', async () => {
    render(<OrderExport {...DEFAULT_PROPS} />);
    await userEvent.click(screen.getByRole('button', { name: /export orders/i }));
    await userEvent.click(screen.getByRole('button', { name: /export csv/i }));

    await waitFor(() => {
      expect(mockHook.exportTransactions).toHaveBeenCalledTimes(1);
    });
  });

  test('passes format=json when JSON is selected', async () => {
    render(<OrderExport {...DEFAULT_PROPS} />);
    await userEvent.click(screen.getByRole('button', { name: /export orders/i }));
    await userEvent.click(screen.getByRole('button', { name: /^json$/i }));
    await userEvent.click(screen.getByRole('button', { name: /export json/i }));

    await waitFor(() => {
      const [, opts] = mockHook.exportTransactions.mock.calls[0];
      expect(opts.format).toBe('json');
    });
  });
});

describe('OrderExport — loading and error states', () => {
  test('shows spinner and disables button while exporting', async () => {
    mockHook.isExporting = true;
    render(<OrderExport {...DEFAULT_PROPS} />);
    await userEvent.click(screen.getByRole('button', { name: /export orders/i }));
    expect(screen.getByRole('button', { name: /exporting/i })).toBeDisabled();
  });

  test('renders error message when exportError is set', async () => {
    mockHook.exportError = 'Server returned 503';
    render(<OrderExport {...DEFAULT_PROPS} />);
    await userEvent.click(screen.getByRole('button', { name: /export orders/i }));
    expect(screen.getByRole('alert')).toHaveTextContent('Server returned 503');
  });
});
