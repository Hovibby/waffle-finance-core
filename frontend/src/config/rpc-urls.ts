/**
 * Browser-side EVM RPC URL resolvers.
 *
 * Priority order (first truthy value wins):
 *   1. Explicit RPC URL  — VITE_SEPOLIA_RPC_URL / VITE_MAINNET_RPC_URL
 *   2. Infura key        — VITE_INFURA_API_KEY constructs the Infura endpoint
 *   3. Public fallback   — unauthenticated publicnode.com endpoint
 *
 * Infura API keys are intentionally visible in the browser bundle; restrict
 * them by HTTP referrer in the Infura dashboard rather than keeping them
 * server-side.
 *
 * Each function reads import.meta.env at call time (not at module load) so
 * that vi.stubEnv() overrides in tests are reflected correctly.
 */

const INFURA_SEPOLIA = 'https://sepolia.infura.io/v3';
const INFURA_MAINNET = 'https://mainnet.infura.io/v3';
const PUBLIC_SEPOLIA = 'https://ethereum-sepolia-rpc.publicnode.com';
const PUBLIC_MAINNET = 'https://ethereum-rpc.publicnode.com';

export function resolveViteSepoliaRpcUrl(): string {
  const env = (import.meta as any).env as Record<string, string | undefined> | undefined ?? {};
  return (
    env['VITE_SEPOLIA_RPC_URL'] ||
    (env['VITE_INFURA_API_KEY'] ? `${INFURA_SEPOLIA}/${env['VITE_INFURA_API_KEY']}` : '') ||
    PUBLIC_SEPOLIA
  );
}

export function resolveViteMainnetRpcUrl(): string {
  const env = (import.meta as any).env as Record<string, string | undefined> | undefined ?? {};
  return (
    env['VITE_MAINNET_RPC_URL'] ||
    (env['VITE_INFURA_API_KEY'] ? `${INFURA_MAINNET}/${env['VITE_INFURA_API_KEY']}` : '') ||
    PUBLIC_MAINNET
  );
}
