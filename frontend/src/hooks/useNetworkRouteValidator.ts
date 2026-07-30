import { useMemo } from 'react';
import { validateRouteWallets } from '../utils/validation';
import { getCurrentNetwork, isTestnet } from '../config/networks';

export type BridgeDirection =
  | 'eth_to_xlm'
  | 'xlm_to_eth'
  | 'eth_to_sol'
  | 'sol_to_eth'
  | 'xlm_to_sol'
  | 'sol_to_xlm';

export interface RouteValidationResult {
  isValid: boolean;
  reason: string | null;
  unsupportedReasonsByRoute: Partial<Record<BridgeDirection, string>>;
}

const SUPPORTED_ROUTES: BridgeDirection[] = [
  'eth_to_xlm',
  'xlm_to_eth',
  'eth_to_sol',
  'sol_to_eth',
];

export function useNetworkRouteValidator({
  direction,
  ethAddress,
  stellarAddress,
  solanaAddress,
}: {
  direction: BridgeDirection;
  ethAddress: string;
  stellarAddress: string;
  solanaAddress?: string;
}): RouteValidationResult {
  const network = useMemo(() => getCurrentNetwork(), []);
  const testnetMode = useMemo(() => isTestnet(), []);

  const unsupportedReasonsByRoute = useMemo(() => {
    const out: Partial<Record<BridgeDirection, string>> = {};
    for (const route of SUPPORTED_ROUTES) {
      const r = validateRouteWallets(route, ethAddress, stellarAddress, solanaAddress ?? '');
      if (!r.isValid) out[route] = r.message;
    }
    return out;
  }, [ethAddress, stellarAddress, solanaAddress]);

  const currentReason = unsupportedReasonsByRoute[direction] ?? null;

  return {
    isValid: currentReason === null,
    reason: currentReason,
    unsupportedReasonsByRoute,
  };
}
