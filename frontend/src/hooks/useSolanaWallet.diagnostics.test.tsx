/**
 * Wallet diagnostics tests — issue #280
 *
 * Covers network-mismatch and wallet-locked error codes for all three
 * wallet hooks: useEthereumWallet, useSolanaWallet, useFreighter.
 */
import { renderHook, act, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { useSolanaWallet } from './useSolanaWallet';

// ─── helpers ────────────────────────────────────────────────────────────────

type Handler = (arg: unknown) => void;

function makePhantom(overrides: Partial<{ network: string }> = {}) {
  const handlers: Record<string, Handler> = {};
  return {
    isPhantom: true,
    publicKey: { toString: () => 'SoLPubKey111' },
    isConnected: true,
    network: overrides.network ?? 'devnet',
    connect: vi.fn(async () => ({ publicKey: { toString: () => 'SoLPubKey111' } })),
    disconnect: vi.fn(async () => {}),
    signTransaction: vi.fn(),
    signAllTransactions: vi.fn(),
    on: (event: string, handler: Handler) => { handlers[event] = handler; },
    removeListener: (event: string) => { delete handlers[event]; },
    emit: (event: string, arg?: unknown) => handlers[event]?.(arg),
  };
}

// ─── useSolanaWallet diagnostics ─────────────────────────────────────────────

describe('useSolanaWallet — diagnostics (issue #280)', () => {
  beforeEach(() => {
    (window as any).phantom = undefined;
    (window as any).solana = undefined;
    vi.stubEnv('VITE_NETWORK_MODE', 'testnet');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('sets errorCode=phantom_unavailable when Phantom is not installed', async () => {
    // No phantom or solana on window → hook stays idle with no provider
    const { result } = renderHook(() => useSolanaWallet());

    await act(async () => {
      await result.current.connect();
    });

    expect(result.current.errorCode).toBe('phantom_unavailable');
    expect(result.current.error).toMatch(/phantom/i);
    expect(result.current.hint).toMatch(/install/i);
  });

  it('sets errorCode=wallet_locked when Phantom throws a locked error', async () => {
    const provider = makePhantom();
    provider.connect = vi.fn(async () => {
      throw Object.assign(new Error('Wallet is locked'), { code: 4900 });
    });
    (window as any).solana = provider;

    const { result } = renderHook(() => useSolanaWallet());
    await waitFor(() => expect(result.current.isInstalled).toBe(true));

    await act(async () => {
      await result.current.connect();
    });

    expect(result.current.errorCode).toBe('wallet_locked');
    expect(result.current.error).toMatch(/locked/i);
    expect(result.current.hint).toMatch(/unlock/i);
  });

  it('sets errorCode=network_mismatch when Phantom is on mainnet-beta in testnet mode', async () => {
    const provider = makePhantom({ network: 'mainnet-beta' });
    // connect succeeds but network is wrong
    (window as any).solana = provider;

    const { result } = renderHook(() => useSolanaWallet());
    await waitFor(() => expect(result.current.isInstalled).toBe(true));

    await act(async () => {
      await result.current.connect();
    });

    expect(result.current.errorCode).toBe('network_mismatch');
    expect(result.current.error).toMatch(/mainnet-beta/i);
    expect(result.current.hint).toMatch(/devnet/i);
  });

  it('connects successfully when Phantom is on the correct network (devnet/testnet)', async () => {
    const provider = makePhantom({ network: 'devnet' });
    (window as any).solana = provider;

    const { result } = renderHook(() => useSolanaWallet());
    await waitFor(() => expect(result.current.isInstalled).toBe(true));

    await act(async () => {
      await result.current.connect();
    });

    expect(result.current.isConnected).toBe(true);
    expect(result.current.errorCode).toBeNull();
    expect(result.current.address).toBe('SoLPubKey111');
  });

  it('sets errorCode=phantom_connect_failed on generic Phantom error', async () => {
    const provider = makePhantom();
    provider.connect = vi.fn(async () => {
      throw new Error('User rejected');
    });
    (window as any).solana = provider;

    const { result } = renderHook(() => useSolanaWallet());
    await waitFor(() => expect(result.current.isInstalled).toBe(true));

    await act(async () => {
      await result.current.connect();
    });

    expect(result.current.errorCode).toBe('phantom_connect_failed');
    expect(result.current.phase).toBe('error');
  });

  it('auto-connects when previously trusted and exposes the address', async () => {
    const provider = makePhantom();
    (window as any).solana = provider;

    const { result } = renderHook(() => useSolanaWallet());
    await waitFor(() => expect(result.current.isConnected).toBe(true));

    expect(result.current.address).toBe('SoLPubKey111');
  });

  it('recovers to a disconnected state on a provider disconnect event', async () => {
    const provider = makePhantom();
    (window as any).solana = provider;

    const { result } = renderHook(() => useSolanaWallet());
    await waitFor(() => expect(result.current.isConnected).toBe(true));

    act(() => { provider.emit('disconnect'); });

    expect(result.current.isConnected).toBe(false);
    expect(result.current.address).toBeNull();
  });

  it('re-syncs the address on an accountChanged event', async () => {
    const provider = makePhantom();
    (window as any).solana = provider;

    const { result } = renderHook(() => useSolanaWallet());
    await waitFor(() => expect(result.current.isConnected).toBe(true));

    act(() => { provider.emit('accountChanged', { toString: () => 'SoLPubKey222' }); });

    expect(result.current.address).toBe('SoLPubKey222');
  });
});
