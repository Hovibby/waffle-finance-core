import { describe, expect, test, vi } from 'vitest';
import {
  validateWalletRouteGuardrails,
  getUnsupportedRouteReason,
} from '../walletGuardrails';
import { createQuote } from '../quoteModel';

const ETH = '0x1111111111111111111111111111111111111111';
const XLM = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB422';
const SOL = '11111111111111111111111111111111';

describe('validateWalletRouteGuardrails', () => {
  test('passes for valid eth_to_xlm with all wallets', () => {
    const result = validateWalletRouteGuardrails({
      direction: 'eth_to_xlm',
      ethAddress: ETH,
      stellarAddress: XLM,
    });
    expect(result.valid).toBe(true);
  });

  test('fails when Ethereum wallet is missing', () => {
    const result = validateWalletRouteGuardrails({
      direction: 'xlm_to_eth',
      stellarAddress: XLM,
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error.kind).toBe('wallet_missing');
    }
  });

  test('fails when Stellar wallet is missing for eth_to_xlm', () => {
    const result = validateWalletRouteGuardrails({
      direction: 'eth_to_xlm',
      ethAddress: ETH,
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error.kind).toBe('wallet_missing');
    }
  });

  test('fails when destination address format is wrong', () => {
    const result = validateWalletRouteGuardrails({
      direction: 'eth_to_xlm',
      ethAddress: ETH,
      stellarAddress: XLM,
      destinationAddress: 'invalid',
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error.kind).toBe('address_mismatch');
    }
  });

  test('fails when quote is expired', () => {
    const quote = createQuote({
      srcChain: 'ethereum',
      dstChain: 'stellar',
      fromAsset: { chain: 'ethereum', symbol: 'ETH', decimals: 18 },
      toAsset: { chain: 'stellar', symbol: 'XLM', decimals: 7 },
      fromAmount: '1',
      estimatedToAmount: '100',
      exchangeRate: 100,
      priceStateness: 'fresh',
    });
    const staleQuote = { ...quote, expiresAt: Date.now() - 1000 };

    const result = validateWalletRouteGuardrails({
      direction: 'eth_to_xlm',
      ethAddress: ETH,
      stellarAddress: XLM,
      quote: staleQuote,
      amount: '1',
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error.kind).toBe('quote_invalid');
    }
  });

  test('fails when chain does not match quote', () => {
    const quote = createQuote({
      srcChain: 'ethereum',
      dstChain: 'stellar',
      fromAsset: { chain: 'ethereum', symbol: 'ETH', decimals: 18 },
      toAsset: { chain: 'stellar', symbol: 'XLM', decimals: 7 },
      fromAmount: '1',
      estimatedToAmount: '100',
      exchangeRate: 100,
      priceStateness: 'fresh',
    });

    const result = validateWalletRouteGuardrails({
      direction: 'eth_to_sol',
      ethAddress: ETH,
      solanaAddress: SOL,
      quote,
      amount: '1',
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error.kind).toBe('quote_invalid');
    }
  });
});

describe('getUnsupportedRouteReason', () => {
  test('returns null for valid route', () => {
    expect(getUnsupportedRouteReason('eth_to_xlm', ETH, XLM, '')).toBeNull();
  });

  test('returns reason for missing wallet', () => {
    const reason = getUnsupportedRouteReason('eth_to_xlm', ETH, '', '');
    expect(reason).toMatch(/Stellar wallet/i);
  });

  test('returns reason for missing Solana wallet', () => {
    const reason = getUnsupportedRouteReason('eth_to_sol', ETH, '', '');
    expect(reason).toMatch(/Solana wallet/i);
  });
});
