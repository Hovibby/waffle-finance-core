// @vitest-environment jsdom

import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useNetworkRouteValidator, type BridgeDirection } from './useNetworkRouteValidator';

const ETH = '0x1111111111111111111111111111111111111111';
const XLM = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB422';
const SOL = '11111111111111111111111111111111';

vi.mock('../config/networks', () => ({
  getCurrentNetwork: () => ({
    ethereum: { explorerUrl: 'https://sepolia.etherscan.io' },
    stellar: { horizonUrl: 'https://horizon-testnet.stellar.org', networkPassphrase: 'Test SDF Network ; September 2015', explorerUrl: 'https://stellar.expert' },
  }),
  isTestnet: () => true,
}));

describe('useNetworkRouteValidator', () => {
  it('marks eth_to_xlm valid when ETH + Stellar are connected', () => {
    const { result } = renderHook(() =>
      useNetworkRouteValidator({ direction: 'eth_to_xlm', ethAddress: ETH, stellarAddress: XLM, solanaAddress: '' }),
    );
    expect(result.current.isValid).toBe(true);
    expect(result.current.reason).toBeNull();
  });

  it('marks eth_to_xlm invalid when Stellar is missing', () => {
    const { result } = renderHook(() =>
      useNetworkRouteValidator({ direction: 'eth_to_xlm', ethAddress: ETH, stellarAddress: '', solanaAddress: '' }),
    );
    expect(result.current.isValid).toBe(false);
    expect(result.current.reason).toMatch(/Stellar wallet/i);
  });

  it('marks eth_to_sol invalid when Solana is missing', () => {
    const { result } = renderHook(() =>
      useNetworkRouteValidator({ direction: 'eth_to_sol', ethAddress: ETH, stellarAddress: XLM, solanaAddress: '' }),
    );
    expect(result.current.isValid).toBe(false);
    expect(result.current.reason).toMatch(/Solana wallet/i);
  });

  it('computes unsupported reasons for all routes', () => {
    const { result } = renderHook(() =>
      useNetworkRouteValidator({ direction: 'eth_to_xlm', ethAddress: ETH, stellarAddress: '', solanaAddress: '' }),
    );
    expect(result.current.unsupportedReasonsByRoute['eth_to_xlm']).toBeTruthy();
    expect(result.current.unsupportedReasonsByRoute['xlm_to_eth']).toBeTruthy();
    expect(result.current.unsupportedReasonsByRoute['eth_to_sol']).toBeFalsy();
  });
});
