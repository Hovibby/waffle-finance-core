/**
 * useEthereumWallet diagnostics tests — issue #280
 *
 * Verifies network-mismatch and wallet-locked error codes.
 */
import { renderHook, act, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { useEthereumWallet } from './useEthereumWallet';

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeMetaMask(overrides: {
  accounts?: string[];
  chainId?: string;
  connectError?: Error;
}) {
  const { accounts = ['0xUserAddress'], chainId = '0xaa36a7', connectError } = overrides;
  const listeners: Record<string, ((...args: any[]) => void)[]> = {};

  return {
    isMetaMask: true,
    request: vi.fn(async ({ method }: { method: string }) => {
      if (connectError && method === 'eth_requestAccounts') throw connectError;
      if (method === 'eth_accounts') return accounts;
      if (method === 'eth_requestAccounts') return accounts;
      if (method === 'eth_chainId') return chainId;
      return null;
    }),
    on: (event: string, cb: (...args: any[]) => void) => {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(cb);
    },
    removeListener: (event: string, cb: (...args: any[]) => void) => {
      listeners[event] = (listeners[event] ?? []).filter((h) => h !== cb);
    },
    emit: (event: string, ...args: any[]) => {
      (listeners[event] ?? []).forEach((h) => h(...args));
    },
  };
}

// ─── tests ───────────────────────────────────────────────────────────────────

describe('useEthereumWallet — diagnostics (issue #280)', () => {
  beforeEach(() => {
    (window as any).ethereum = undefined;
    vi.stubEnv('VITE_NETWORK_MODE', 'testnet');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('sets errorCode=metamask_unavailable when MetaMask is not installed', async () => {
    const { result } = renderHook(() => useEthereumWallet());

    // On mount the hook immediately sets the error when no provider is found.
    await waitFor(() => expect(result.current.errorCode).toBe('metamask_unavailable'));
    expect(result.current.hint).toMatch(/install/i);
  });

  it('sets errorCode=network_mismatch when connected to mainnet in testnet mode', async () => {
    const provider = makeMetaMask({ chainId: '0x1' }); // mainnet
    (window as any).ethereum = provider;

    const { result } = renderHook(() => useEthereumWallet());
    // Let auto-check run first
    await waitFor(() => expect(result.current.phase).not.toBe('checking'));

    await act(async () => {
      await result.current.connect();
    });

    expect(result.current.errorCode).toBe('network_mismatch');
    expect(result.current.error).toMatch(/wrong network/i);
    expect(result.current.hint).toMatch(/sepolia/i);
  });

  it('sets errorCode=wallet_locked when MetaMask returns -32002', async () => {
    const lockedError = Object.assign(new Error('MetaMask is locked'), { code: -32002 });
    const provider = makeMetaMask({ connectError: lockedError });
    (window as any).ethereum = provider;

    const { result } = renderHook(() => useEthereumWallet());
    await waitFor(() => expect(result.current.phase).not.toBe('checking'));

    await act(async () => {
      await result.current.connect();
    });

    expect(result.current.errorCode).toBe('wallet_locked');
    expect(result.current.error).toMatch(/locked/i);
    expect(result.current.hint).toMatch(/unlock/i);
  });

  it('sets errorCode=metamask_connect_failed on generic connection rejection', async () => {
    const rejectError = Object.assign(new Error('User rejected'), { code: 4001 });
    const provider = makeMetaMask({ connectError: rejectError });
    (window as any).ethereum = provider;

    const { result } = renderHook(() => useEthereumWallet());
    await waitFor(() => expect(result.current.phase).not.toBe('checking'));

    await act(async () => {
      await result.current.connect();
    });

    expect(result.current.errorCode).toBe('metamask_connect_failed');
    expect(result.current.hint).toMatch(/rejected/i);
  });

  it('connects successfully on the correct network (Sepolia testnet)', async () => {
    const provider = makeMetaMask({ chainId: '0xaa36a7' }); // Sepolia
    (window as any).ethereum = provider;

    const { result } = renderHook(() => useEthereumWallet());
    await waitFor(() => expect(result.current.phase).not.toBe('checking'));

    await act(async () => {
      await result.current.connect();
    });

    expect(result.current.isConnected).toBe(true);
    expect(result.current.errorCode).toBeNull();
    expect(result.current.address).toBe('0xUserAddress');
  });
});
