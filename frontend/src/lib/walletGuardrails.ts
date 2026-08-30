import {
  validateEthereumAddress,
  validateStellarAddress,
  validateSolanaAddress,
  validateAssetPair,
  validateDestinationChain,
  validateRouteWallets,
  type ValidationResult,
} from '../utils/validation';
import { createQuote, validateQuote, type BridgeQuote, type QuoteValidationResult } from '../lib/quoteModel';

export type PreflightValidationError =
  | { kind: 'unsupported_route'; reason: string }
  | { kind: 'wallet_missing'; reason: string }
  | { kind: 'address_mismatch'; reason: string }
  | { kind: 'asset_pair_invalid'; reason: string }
  | { kind: 'quote_invalid'; reason: string };

export type PreflightValidationResult =
  | { valid: true }
  | { valid: false; error: PreflightValidationError };

export interface WalletGuardrailInput {
  direction: string;
  ethAddress?: string;
  stellarAddress?: string;
  solanaAddress?: string;
  fromToken?: string;
  toToken?: string;
  destinationAddress?: string;
  quote?: BridgeQuote | null;
  amount?: string;
}

export function validateWalletRouteGuardrails({
  direction,
  ethAddress = '',
  stellarAddress = '',
  solanaAddress = '',
  fromToken = '',
  toToken = '',
  destinationAddress = '',
  quote = null,
  amount = '',
}: WalletGuardrailInput): PreflightValidationResult {
  const routeResult = validateRouteWallets(direction, ethAddress, stellarAddress, solanaAddress);
  if (!routeResult.isValid) {
    return {
      valid: false,
      error: {
        kind: 'wallet_missing',
        reason: routeResult.message,
      },
    };
  }

  if (ethAddress && !validateEthereumAddress(ethAddress).isValid) {
    return {
      valid: false,
      error: {
        kind: 'address_mismatch',
        reason: 'Ethereum wallet address is invalid.',
      },
    };
  }

  if (stellarAddress && !validateStellarAddress(stellarAddress).isValid) {
    return {
      valid: false,
      error: {
        kind: 'address_mismatch',
        reason: 'Stellar wallet address is invalid.',
      },
    };
  }

  if (solanaAddress && !validateSolanaAddress(solanaAddress).isValid) {
    return {
      valid: false,
      error: {
        kind: 'address_mismatch',
        reason: 'Solana wallet address is invalid.',
      },
    };
  }

  if (fromToken && toToken) {
    const pairResult = validateAssetPair(fromToken, toToken);
    if (!pairResult.isValid) {
      return {
        valid: false,
        error: {
          kind: 'asset_pair_invalid',
          reason: pairResult.message,
        },
      };
    }
  }

  if (destinationAddress) {
    const destResult = validateDestinationChain(direction, destinationAddress);
    if (!destResult.isValid) {
      return {
        valid: false,
        error: {
          kind: 'address_mismatch',
          reason: destResult.message,
        },
      };
    }
  }

  if (quote && amount) {
    const srcChain = direction.endsWith('_eth') ? 'ethereum' : direction.endsWith('_xlm') ? 'stellar' : 'solana';
    const dstChain = direction.endsWith('_eth') ? 'ethereum' : direction.endsWith('_xlm') ? 'stellar' : 'solana';
    const quoteResult = validateQuote(quote, srcChain, dstChain, amount);
    if (!quoteResult.valid) {
      return {
        valid: false,
        error: {
          kind: 'quote_invalid',
          reason: quoteResult.message || 'Quote is invalid for this route.',
        },
      };
    }
  }

  return { valid: true };
}

export function getUnsupportedRouteReason(
  direction: string,
  eth: string,
  stellar: string,
  solana: string
): string | null {
  const result = validateRouteWallets(direction, eth, stellar, solana);
  return result.isValid ? null : result.message;
}
