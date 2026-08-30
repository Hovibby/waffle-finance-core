/**
 * Tests for the config selector layer.
 *
 * Verifies that selectors expose the correct subsets and preserve existing
 * behavior after the config refactor.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  selectApiBaseUrl,
  selectIsMockDataEnabled,
  selectIsMainnetEnabled,
  selectIsTestnet,
  selectCurrentEthereumNetwork,
  selectCurrentStellarNetwork,
  selectFaucets,
  selectRoute,
  selectIsRouteSupported,
} from '../config/selectors';

describe('selectApiBaseUrl', () => {
  it('returns a non-empty string', () => {
    expect(selectApiBaseUrl()).toBe('http://localhost:3001');
  });
});

describe('selectIsMockDataEnabled', () => {
  it('returns false by default', () => {
    expect(selectIsMockDataEnabled()).toBe(false);
  });
});

describe('selectIsMainnetEnabled', () => {
  it('returns false in the default test environment', () => {
    expect(selectIsMainnetEnabled()).toBe(false);
  });
});

describe('selectIsTestnet', () => {
  it('returns true in the default test environment', () => {
    expect(selectIsTestnet()).toBe(true);
  });
});

describe('selectCurrentEthereumNetwork', () => {
  it('returns Sepolia config when mainnet is disabled', () => {
    const eth = selectCurrentEthereumNetwork();
    expect(eth.id).toBe(11155111);
    expect(eth.testnet).toBe(true);
  });
});

describe('selectCurrentStellarNetwork', () => {
  it('returns testnet Stellar config by default', () => {
    const stellar = selectCurrentStellarNetwork();
    expect(stellar.testnet).toBe(true);
    expect(stellar.horizonUrl).toContain('testnet');
  });
});

describe('selectFaucets', () => {
  it('returns faucet entries in testnet mode', () => {
    const faucets = selectFaucets();
    expect(faucets.ethereum.sepolia.length).toBeGreaterThan(0);
    expect(faucets.stellar.testnet.length).toBeGreaterThan(0);
  });
});

describe('selectRoute', () => {
  it('returns a route for eth_to_xlm', () => {
    const route = selectRoute('eth_to_xlm');
    expect(route?.direction).toBe('eth_to_xlm');
    expect(route?.fromToken.symbol).toBe('ETH');
    expect(route?.toToken.symbol).toBe('XLM');
  });

  it('returns undefined for unsupported route', () => {
    expect(selectRoute('xlm_to_sol')).toBeUndefined();
  });
});

describe('selectIsRouteSupported', () => {
  it('returns true for supported routes', () => {
    expect(selectIsRouteSupported('eth_to_xlm')).toBe(true);
    expect(selectIsRouteSupported('sol_to_eth')).toBe(true);
  });

  it('returns false for unsupported routes', () => {
    expect(selectIsRouteSupported('xlm_to_sol')).toBe(false);
  });
});
