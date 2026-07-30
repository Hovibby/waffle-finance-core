import { useCallback, useEffect, useState } from 'react';

export type ConnectionPhase = 'idle' | 'checking' | 'requesting_permission' | 'connected' | 'error';

export interface EthereumWalletState {
  isConnected: boolean;
  address: string | null;
  chainId: string | null;
  isLoading: boolean;
  error: string | null;
  errorCode: string | null;
  hint: string | null;
  phase: ConnectionPhase;
  lastTransitionAt: number | null;
  isInstalled: boolean;
}

const INITIAL_STATE: EthereumWalletState = {
  isConnected: false,
  address: null,
  chainId: null,
  isLoading: false,
  error: null,
  errorCode: null,
  hint: null,
  phase: 'idle',
  lastTransitionAt: null,
  isInstalled: false,
};

function transition(prev: EthereumWalletState, patch: Partial<EthereumWalletState>): EthereumWalletState {
  return {
    ...prev,
    ...patch,
    lastTransitionAt: Date.now(),
    phase: patch.phase ?? prev.phase,
  };
}

export function useEthereumWallet() {
  const [state, setState] = useState<EthereumWalletState>(INITIAL_STATE);

  const setError = useCallback((code: string, message: string, hint?: string) => {
    setState((prev) =>
      transition(prev, {
        error: message,
        errorCode: code,
        hint: hint ?? prev.hint,
        phase: 'error',
        isLoading: false,
      })
    );
  }, []);

  useEffect(() => {
    const provider = typeof window !== 'undefined' ? window.ethereum : undefined;
    const installed = !!provider;
    setState((prev) => transition(prev, { isInstalled: installed, phase: installed ? 'checking' : 'idle' }));

    if (!provider) {
      setError(
        'metamask_unavailable',
        'MetaMask not found.',
        'Install MetaMask from metamask.io and reload the page.'
      );
      return;
    }

    const check = async () => {
      try {
        const accounts = await provider.request({ method: 'eth_accounts' });
        const chainId = await provider.request({ method: 'eth_chainId' }).catch(() => null);
        if (accounts.length > 0) {
          setState((prev) =>
            transition(prev, {
              isConnected: true,
              address: accounts[0],
              chainId: chainId as string | null,
              error: null,
              errorCode: null,
              hint: null,
              phase: 'connected',
            })
          );
        } else {
          setState((prev) => transition(prev, { phase: 'idle' }));
        }
      } catch (err) {
        setError(
          'ethereum_check_failed',
          err instanceof Error ? err.message : 'Failed to check MetaMask state',
          'Refresh the page. If accounts are locked, unlock MetaMask and try again.'
        );
      }
    };

    check();

    const handleAccountsChanged = (accounts: string[]) => {
      setState((prev) => {
        if (accounts.length === 0) {
          return transition(prev, { isConnected: false, address: null, phase: 'idle' });
        }
        return transition(prev, {
          isConnected: true,
          address: accounts[0],
          error: null,
          errorCode: null,
          hint: null,
          phase: 'connected',
        });
      });
    };

    const handleChainChanged = (chainId: string) => {
      setState((prev) =>
        transition(prev, {
          chainId,
          error: null,
          errorCode: null,
          hint: null,
          phase: prev.isConnected ? 'connected' : prev.phase,
        })
      );
    };

    const handleDisconnect = () => {
      setState((prev) => transition(prev, { isConnected: false, address: null, phase: 'idle' }));
    };

    provider.on('accountsChanged', handleAccountsChanged as any);
    provider.on('chainChanged', handleChainChanged as any);
    provider.on('disconnect', handleDisconnect as any);

    return () => {
      provider.removeListener('accountsChanged', handleAccountsChanged as any);
      provider.removeListener('chainChanged', handleChainChanged as any);
      provider.removeListener('disconnect', handleDisconnect as any);
    };
  }, [setError]);

  /**
   * Expected Ethereum chain IDs for each network mode.
   * Sepolia = 0xaa36a7 (11155111), Mainnet = 0x1 (1).
   */
  const EXPECTED_CHAIN_IDS: Record<string, string[]> = {
    testnet: ['0xaa36a7'],
    mainnet: ['0x1'],
  };

  const connect = useCallback(async () => {
    const provider = typeof window !== 'undefined' ? window.ethereum : undefined;
    if (!provider) {
      setError('metamask_unavailable', 'MetaMask not found.', 'Install MetaMask and reload.');
      return;
    }

    setState((prev) => transition(prev, { isLoading: true, error: null, errorCode: null, hint: null, phase: 'requesting_permission' }));
    try {
      const accounts = await provider.request({ method: 'eth_requestAccounts' });
      const chainId = await provider.request({ method: 'eth_chainId' }).catch(() => null) as string | null;

      // ── Network mismatch diagnostic ─────────────────────────────────────
      // Determine expected chain IDs based on VITE_NETWORK_MODE env var.
      const networkMode = (import.meta as any).env?.VITE_NETWORK_MODE ?? 'testnet';
      const expectedChains = EXPECTED_CHAIN_IDS[networkMode] ?? EXPECTED_CHAIN_IDS['testnet'];
      if (chainId && !expectedChains.includes(chainId.toLowerCase())) {
        const expected = networkMode === 'mainnet' ? 'Ethereum Mainnet' : 'Sepolia testnet';
        setError(
          'network_mismatch',
          `MetaMask is connected to the wrong network (chain ID ${chainId}).`,
          `Switch MetaMask to ${expected} and try again.`,
        );
        return;
      }

      if (accounts.length > 0) {
        setState((prev) =>
          transition(prev, {
            isConnected: true,
            address: accounts[0],
            chainId: chainId,
            isLoading: false,
            error: null,
            errorCode: null,
            hint: null,
            phase: 'connected',
          })
        );
      }
    } catch (err: any) {
      // ── Wallet-locked diagnostic ────────────────────────────────────────
      // MetaMask returns error code -32002 when the extension is locked.
      const isLocked = err?.code === -32002;
      setError(
        isLocked ? 'wallet_locked' : 'metamask_connect_failed',
        isLocked
          ? 'MetaMask is locked. Please unlock it and try again.'
          : (err?.message ?? 'MetaMask connection failed'),
        isLocked
          ? 'Open MetaMask, enter your password to unlock, then retry.'
          : (err?.code === 4001
            ? 'You rejected the connection request in MetaMask.'
            : 'Check the MetaMask popup and try again.'),
      );
    }
  }, [setError]);

  const disconnect = useCallback(() => {
    setState((prev) => transition(prev, { isConnected: false, address: null, isLoading: false, error: null, errorCode: null, hint: null, phase: 'idle' }));
  }, []);

  return {
    ...state,
    connect,
    disconnect,
  };
}
