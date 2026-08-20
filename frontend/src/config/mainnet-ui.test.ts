/**
 * Tests for mainnet UI flows (TD-071).
 *
 * Covers the behaviour that is supposed to activate when
 * VITE_MAINNET_ENABLED=true: network resolution, config helpers, and the
 * feature-flag surface that gates mainnet-only UI paths.
 *
 * The test environment does NOT set VITE_MAINNET_ENABLED, so tests that
 * exercise the mainnet-enabled code path use `vi.stubEnv` to inject the flag
 * and `vi.resetModules()` to force a fresh module evaluation (the config
 * helpers read import.meta.env at call time, but the feature-flag set is
 * evaluated once at module load, so re-importing after the stub is the only
 * reliable approach).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Re-import the networks module with a custom env context.
 * Necessary because `resolveNetworkMode` and `isMainnetEnabled` read
 * `import.meta.env` at call time, but some dependents (e.g. featureFlags)
 * cache the result at module-load time.
 */
async function importNetworksWithMainnet(enabled: 'true' | 'false' | undefined) {
  vi.resetModules();
  if (enabled !== undefined) {
    vi.stubEnv('VITE_MAINNET_ENABLED', enabled);
  }
  return import('./networks');
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

// ── isMainnetEnabled ──────────────────────────────────────────────────────────

describe('isMainnetEnabled — mainnet-enabled path', () => {
  it('returns true when VITE_MAINNET_ENABLED is "true"', async () => {
    const { isMainnetEnabled } = await importNetworksWithMainnet('true');
    expect(isMainnetEnabled()).toBe(true);
  });

  it('returns false when VITE_MAINNET_ENABLED is "false"', async () => {
    const { isMainnetEnabled } = await importNetworksWithMainnet('false');
    expect(isMainnetEnabled()).toBe(false);
  });

  it('returns false when VITE_MAINNET_ENABLED is absent', async () => {
    const { isMainnetEnabled } = await importNetworksWithMainnet(undefined);
    expect(isMainnetEnabled()).toBe(false);
  });
});

// ── resolveNetworkMode — mainnet-enabled ───────────────────────────────────

describe('resolveNetworkMode — when mainnet is enabled', () => {
  it('passes "mainnet" through unchanged when VITE_MAINNET_ENABLED=true', async () => {
    const { resolveNetworkMode } = await importNetworksWithMainnet('true');
    expect(resolveNetworkMode('mainnet')).toBe('mainnet');
  });

  it('still passes "testnet" through unchanged when mainnet is enabled', async () => {
    const { resolveNetworkMode } = await importNetworksWithMainnet('true');
    expect(resolveNetworkMode('testnet')).toBe('testnet');
  });

  it('clamps "mainnet" to "testnet" when flag is off even if requested', async () => {
    const { resolveNetworkMode } = await importNetworksWithMainnet('false');
    expect(resolveNetworkMode('mainnet')).toBe('testnet');
  });
});

// ── isTestnet — mainnet-enabled ───────────────────────────────────────────────

describe('isTestnet — when mainnet is enabled and VITE_NETWORK_MODE=mainnet', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_MAINNET_ENABLED', 'true');
    vi.stubEnv('VITE_NETWORK_MODE', 'mainnet');
  });

  it('returns false when the resolved mode is mainnet', async () => {
    vi.resetModules();
    const { isTestnet } = await import('./networks');
    expect(isTestnet()).toBe(false);
  });
});

// ── getCurrentNetwork — mainnet config ────────────────────────────────────────

describe('getCurrentNetwork — mainnet config when enabled', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_MAINNET_ENABLED', 'true');
    vi.stubEnv('VITE_NETWORK_MODE', 'mainnet');
  });

  it('ethereum chainId is 1 (Ethereum Mainnet), not Sepolia', async () => {
    vi.resetModules();
    const { getCurrentNetwork } = await import('./networks');
    const { ethereum } = getCurrentNetwork();
    expect(ethereum.id).toBe(1);
  });

  it('ethereum.testnet is false in mainnet mode', async () => {
    vi.resetModules();
    const { getCurrentNetwork } = await import('./networks');
    const { ethereum } = getCurrentNetwork();
    expect(ethereum.testnet).toBe(false);
  });

  it('stellar.testnet is false in mainnet mode', async () => {
    vi.resetModules();
    const { getCurrentNetwork } = await import('./networks');
    const { stellar } = getCurrentNetwork();
    expect(stellar.testnet).toBe(false);
  });

  it('stellar horizonUrl does not contain "testnet"', async () => {
    vi.resetModules();
    const { getCurrentNetwork } = await import('./networks');
    const { stellar } = getCurrentNetwork();
    expect(stellar.horizonUrl).not.toContain('testnet');
  });

  it('stellar networkPassphrase is the Public Network passphrase', async () => {
    vi.resetModules();
    const { getCurrentNetwork } = await import('./networks');
    const { stellar } = getCurrentNetwork();
    expect(stellar.networkPassphrase).toContain('Public Global Stellar Network');
  });
});

// ── getContractAddresses — mainnet addresses ───────────────────────────────────

describe('getContractAddresses — mainnet addresses when enabled', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_MAINNET_ENABLED', 'true');
    vi.stubEnv('VITE_NETWORK_MODE', 'mainnet');
  });

  it('returns non-empty ethereum contract addresses in mainnet mode', async () => {
    vi.resetModules();
    const { getContractAddresses } = await import('./networks');
    const { ethereum } = getContractAddresses();
    expect(typeof ethereum.htlcBridge).toBe('string');
    expect(ethereum.htlcBridge.length).toBeGreaterThan(0);
  });

  it('mainnet ethereum escrow address differs from Sepolia address', async () => {
    vi.resetModules();
    // First get testnet addresses
    vi.stubEnv('VITE_MAINNET_ENABLED', 'false');
    vi.stubEnv('VITE_NETWORK_MODE', 'testnet');
    const { getContractAddresses: getTestnet } = await import('./networks');
    const testnetAddresses = getTestnet();

    // Then get mainnet addresses
    vi.resetModules();
    vi.stubEnv('VITE_MAINNET_ENABLED', 'true');
    vi.stubEnv('VITE_NETWORK_MODE', 'mainnet');
    const { getContractAddresses: getMainnet } = await import('./networks');
    const mainnetAddresses = getMainnet();

    // Mainnet and testnet contract addresses must differ.
    expect(mainnetAddresses.ethereum.htlcBridge.toLowerCase()).not.toBe(
      testnetAddresses.ethereum.htlcBridge.toLowerCase()
    );
  });
});

// ── resolveNetworkMode idempotency ────────────────────────────────────────────

describe('resolveNetworkMode — idempotency and round-trips', () => {
  it('resolving "testnet" twice is stable', async () => {
    const { resolveNetworkMode } = await importNetworksWithMainnet('false');
    expect(resolveNetworkMode(resolveNetworkMode('testnet'))).toBe('testnet');
  });

  it('resolving "mainnet" twice is stable when enabled', async () => {
    const { resolveNetworkMode } = await importNetworksWithMainnet('true');
    expect(resolveNetworkMode(resolveNetworkMode('mainnet'))).toBe('mainnet');
  });

  it('resolving "mainnet" twice while disabled still returns "testnet"', async () => {
    const { resolveNetworkMode } = await importNetworksWithMainnet('false');
    const once = resolveNetworkMode('mainnet');
    expect(resolveNetworkMode(once)).toBe('testnet');
  });
});
