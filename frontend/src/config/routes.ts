/**
 * Route-specific configuration layer.
 *
 * Route config describes which bridge directions are supported, their token
 * metadata, and validation rules. It is independent from the network layer
 * so that adding a new route does not require touching network resolution.
 */

export type SupportedChain = 'ethereum' | 'stellar' | 'solana';

export type BridgeDirection =
  | 'eth_to_xlm'
  | 'xlm_to_eth'
  | 'eth_to_sol'
  | 'sol_to_eth'
  | 'xlm_to_sol'
  | 'sol_to_xlm';

export interface RouteToken {
  symbol: string;
  name: string;
  chain: SupportedChain;
  decimals: number;
  logo: string;
}

export interface BridgeRoute {
  direction: BridgeDirection;
  fromToken: RouteToken;
  toToken: RouteToken;
  requiresWallet: (wallets: { eth?: string; stellar?: string; solana?: string }) => boolean;
}

export const ROUTE_TOKENS: Record<string, RouteToken> = {
  ETH: {
    symbol: 'ETH',
    name: 'Ether',
    chain: 'ethereum',
    decimals: 18,
    logo: '/images/eth.png',
  },
  XLM: {
    symbol: 'XLM',
    name: 'Lumens',
    chain: 'stellar',
    decimals: 7,
    logo: '/images/xlm.png',
  },
  SOL: {
    symbol: 'SOL',
    name: 'Solana',
    chain: 'solana',
    decimals: 9,
    logo: '/images/sol.svg',
  },
};

export const SUPPORTED_ROUTES: BridgeRoute[] = [
  {
    direction: 'eth_to_xlm',
    fromToken: ROUTE_TOKENS.ETH,
    toToken: ROUTE_TOKENS.XLM,
    requiresWallet: (w) => Boolean(w.eth && w.stellar),
  },
  {
    direction: 'xlm_to_eth',
    fromToken: ROUTE_TOKENS.XLM,
    toToken: ROUTE_TOKENS.ETH,
    requiresWallet: (w) => Boolean(w.eth && w.stellar),
  },
  {
    direction: 'eth_to_sol',
    fromToken: ROUTE_TOKENS.ETH,
    toToken: ROUTE_TOKENS.SOL,
    requiresWallet: (w) => Boolean(w.eth && w.solana),
  },
  {
    direction: 'sol_to_eth',
    fromToken: ROUTE_TOKENS.SOL,
    toToken: ROUTE_TOKENS.ETH,
    requiresWallet: (w) => Boolean(w.eth && w.solana),
  },
];

export function getRoute(direction: BridgeDirection): BridgeRoute | undefined {
  return SUPPORTED_ROUTES.find((r) => r.direction === direction);
}

export function isRouteSupported(direction: BridgeDirection): boolean {
  return SUPPORTED_ROUTES.some((r) => r.direction === direction);
}
