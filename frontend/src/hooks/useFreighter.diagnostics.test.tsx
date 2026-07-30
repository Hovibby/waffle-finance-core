/**
 * useFreighter diagnostics tests — issue #280
 *
 * Verifies wallet-locked and network-mismatch error codes.
 */
import { renderHook, act, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { useFreighter } from './useFreighter';

// ─── mock @stellar/freighter-api ─────────────────────────────────────────────

vi.mock('@stellar/freighter-api', () => {
  const api = {
    isConnected: vi.fn(async () => false),
    getAddress: vi.fn(async () => ({ address: 'GSTELLARADDRESS' })),
    getNetwork: vi.fn(async () => ({ network: 'TESTNET', networkPassphrase: 'Test SDF Network ; September 2015' })),
    setAllowed: vi.fn(async () => {}),
    signTransaction: vi.fn(),
  };
  return { default: api };
});

async function getFreighterMock() {
  const mod = await import('@stellar/freighter-api');
  return mod.default as any;
}

// ─── tests ───────────────────────────────────────────────────────────────────

describe('useFreighter — diagnostics (issue #280)', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_NETWORK_MODE', 'testnet');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it('sets errorCode=freighter_unavailable when the API is unavailable', async () => {
    const api = await getFreighterMock();
    // Simulate missing API: make isConnected not a function
    const orig = api.isConnected;
    api.isConnected = undefined as any;

    const { result } = renderHook(() => useFreighter());
    await waitFor(() => expect(result.current.errorCode).toBeTruthy());

    expect(result.current.errorCode).toBe('freighter_unavailable');
    expect(result.current.hint).toMatch(/install/i);

    api.isConnected = orig;
  });

  it('sets errorCode=wallet_locked when getAddress returns empty string', async () => {
    const api = await getFreighterMock();
    api.isConnected.mockResolvedValue(true);
    api.setAllowed.mockResolvedValue(undefined);
    api.getAddress.mockResolvedValue({ address: '' }); // locked → empty address

    const { result } = renderHook(() => useFreighter());
    // Initial check sees isConnected=true but address='' — does not set connected
    await waitFor(() => expect(result.current.phase).not.toBe('checking'));

    await act(async () => {
      try { await result.current.connect(); } catch { /* ignore rethrow */ }
    });

    expect(result.current.errorCode).toBe('wallet_locked');
    expect(result.current.error).toMatch(/locked/i);
    expect(result.current.hint).toMatch(/unlock/i);
  });

  it('sets errorCode=network_mismatch when Freighter is on PUBLIC in testnet mode', async () => {
    const api = await getFreighterMock();
    api.isConnected.mockResolvedValue(true);
    api.setAllowed.mockResolvedValue(undefined);
    api.getAddress.mockResolvedValue({ address: 'GSTELLARADDRESS' });
    api.getNetwork.mockResolvedValue({ network: 'PUBLIC', networkPassphrase: 'Public Global Stellar Network ; September 2015' });

    const { result } = renderHook(() => useFreighter());
    await waitFor(() => expect(result.current.phase).not.toBe('checking'));

    await act(async () => {
      try { await result.current.connect(); } catch { /* ignore rethrow */ }
    });

    expect(result.current.errorCode).toBe('network_mismatch');
    expect(result.current.error).toMatch(/PUBLIC/i);
    expect(result.current.hint).toMatch(/TESTNET/i);
  });

  it('sets errorCode=network_mismatch when Freighter is on TESTNET in mainnet mode', async () => {
    vi.stubEnv('VITE_NETWORK_MODE', 'mainnet');

    const api = await getFreighterMock();
    api.isConnected.mockResolvedValue(true);
    api.setAllowed.mockResolvedValue(undefined);
    api.getAddress.mockResolvedValue({ address: 'GSTELLARADDRESS' });
    api.getNetwork.mockResolvedValue({ network: 'TESTNET', networkPassphrase: 'Test SDF Network ; September 2015' });

    const { result } = renderHook(() => useFreighter());
    await waitFor(() => expect(result.current.phase).not.toBe('checking'));

    await act(async () => {
      try { await result.current.connect(); } catch { /* ignore rethrow */ }
    });

    expect(result.current.errorCode).toBe('network_mismatch');
    expect(result.current.hint).toMatch(/PUBLIC/i);
  });

  it('connects successfully when Freighter is on TESTNET in testnet mode', async () => {
    const api = await getFreighterMock();
    api.isConnected.mockResolvedValue(true);
    api.setAllowed.mockResolvedValue(undefined);
    api.getAddress.mockResolvedValue({ address: 'GSTELLARADDRESS' });
    api.getNetwork.mockResolvedValue({ network: 'TESTNET', networkPassphrase: 'Test SDF Network ; September 2015' });

    const { result } = renderHook(() => useFreighter());
    await waitFor(() => expect(result.current.phase).not.toBe('checking'));

    await act(async () => {
      await result.current.connect();
    });

    expect(result.current.isConnected).toBe(true);
    expect(result.current.errorCode).toBeNull();
    expect(result.current.address).toBe('GSTELLARADDRESS');
  });

  it('sets errorCode=wallet_locked when connect throws a locked message', async () => {
    const api = await getFreighterMock();
    api.isConnected.mockResolvedValue(true);
    api.setAllowed.mockRejectedValue(new Error('Wallet is locked'));

    const { result } = renderHook(() => useFreighter());
    await waitFor(() => expect(result.current.phase).not.toBe('checking'));

    await act(async () => {
      try { await result.current.connect(); } catch { /* ignore rethrow */ }
    });

    expect(result.current.errorCode).toBe('wallet_locked');
    expect(result.current.hint).toMatch(/unlock/i);
  });
});
