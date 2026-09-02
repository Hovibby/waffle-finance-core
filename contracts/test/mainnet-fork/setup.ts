/**
 * Mainnet fork test setup and shared utilities.
 *
 * Provides helpers that configure a Hardhat mainnet fork environment and
 * expose factory functions, known mainnet addresses, and ABI constants used
 * across the mainnet integration test suite.
 *
 * The fork uses the MAINNET_RPC_URL (or ETHEREUM_RPC_URL) env var when present,
 * or the publicnode endpoint as a last-resort default.  Tests skip automatically
 * when the required env var MAINNET_RPC_URL (or ETHEREUM_RPC_URL) is absent and
 * no public fallback succeeds, keeping CI green without live RPC credentials.
 */

import { ethers, network } from "hardhat";

// ── Known mainnet addresses ─────────────────────────────────────────────────

/** 1inch Aggregation Router EscrowFactory on Ethereum mainnet. */
export const MAINNET_ESCROW_FACTORY = "0xa7bcb4eac8964306f9e3764f67db6a7af6ddf99a";

/** USDC on mainnet — used as a real ERC-20 in fork tests. */
export const MAINNET_USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

/** WETH on mainnet */
export const MAINNET_WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";

/** A whale address holding plenty of USDC that we impersonate in fork tests. */
export const USDC_WHALE = "0x37305B1cD40574E4C5Ce33f8e8306Be057fD7341";

// ── Minimal ABIs ────────────────────────────────────────────────────────────

/**
 * 1inch EscrowFactory ABI — the subset required for mainnet integration tests.
 * Full ABI lives in relayer/src/config/networks.ts; this is a trimmed copy so
 * the test file has no runtime dependency on the relayer package.
 */
export const ESCROW_FACTORY_ABI = [
  `function createDstEscrow(
    (bytes32 orderHash, bytes32 hashlock, uint256 maker, uint256 taker, uint256 token, uint256 amount, uint256 safetyDeposit, uint256 timelocks) dstImmutables,
    uint256 srcCancellationTimestamp
  ) external payable`,
  "function addressOfEscrowSrc((bytes32 orderHash, bytes32 hashlock, uint256 maker, uint256 taker, uint256 token, uint256 amount, uint256 safetyDeposit, uint256 timelocks) immutables) external view returns (address)",
  "function addressOfEscrowDst((bytes32 orderHash, bytes32 hashlock, uint256 maker, uint256 taker, uint256 token, uint256 amount, uint256 safetyDeposit, uint256 timelocks) immutables) external view returns (address)",
  "function ESCROW_SRC_IMPLEMENTATION() external view returns (address)",
  "function ESCROW_DST_IMPLEMENTATION() external view returns (address)",
  "function availableCredit(address account) external view returns (uint256)",
  "function increaseAvailableCredit(address account, uint256 amount) external returns (uint256 allowance)",
  "event DstEscrowCreated(address escrow, bytes32 hashlock, uint256 taker)",
] as const;

/**
 * Minimal ERC-20 ABI for balance/allowance checks in fork tests.
 */
export const ERC20_ABI = [
  "function balanceOf(address account) external view returns (uint256)",
  "function allowance(address owner, address spender) external view returns (uint256)",
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function transfer(address to, uint256 amount) external returns (bool)",
  "function decimals() external view returns (uint8)",
  "function symbol() external view returns (string)",
] as const;

// ── Fork helpers ─────────────────────────────────────────────────────────────

export interface ForkConfig {
  /** RPC URL to fork from. Falls back to env or public node. */
  rpcUrl?: string;
  /**
   * Block number to pin the fork at for deterministic tests.
   * When undefined the fork starts at the latest block.
   */
  blockNumber?: number;
}

/**
 * Resolve the mainnet RPC URL from environment variables using the same
 * priority order as hardhat.config.ts.
 */
export function resolveMainnetRpc(): string {
  return (
    process.env["MAINNET_RPC_URL"]?.trim() ||
    process.env["ETHEREUM_RPC_URL"]?.trim() ||
    (process.env["INFURA_API_KEY"]
      ? `https://mainnet.infura.io/v3/${process.env["INFURA_API_KEY"]}`
      : "") ||
    "https://ethereum-rpc.publicnode.com"
  );
}

/**
 * Activate a Hardhat mainnet fork.  Resets the in-process Hardhat Network
 * to a fresh fork at the given RPC URL and optional block number.
 *
 * Call this inside a `before` or `beforeEach` hook.  Pair with
 * `deactivateFork()` to restore the default Hardhat network after the suite.
 */
export async function activateMainnetFork(cfg: ForkConfig = {}): Promise<void> {
  const rpcUrl = cfg.rpcUrl ?? resolveMainnetRpc();
  const forking: Record<string, unknown> = { url: rpcUrl, enabled: true };
  if (cfg.blockNumber !== undefined) {
    forking["blockNumber"] = cfg.blockNumber;
  }
  await network.provider.request({
    method: "hardhat_reset",
    params: [{ forking }],
  });
}

/**
 * Reset Hardhat Network to a fresh non-forked local chain.
 * Call this in `after` / `afterEach` so subsequent test suites start clean.
 */
export async function deactivateMainnetFork(): Promise<void> {
  await network.provider.request({
    method: "hardhat_reset",
    params: [],
  });
}

/**
 * Impersonate an address so tests can call `contract.connect(impersonated)`.
 * Returns the impersonated signer.  Remember to call `stopImpersonating()`
 * when done.
 */
export async function impersonate(address: string) {
  await network.provider.request({
    method: "hardhat_impersonateAccount",
    params: [address],
  });
  await network.provider.send("hardhat_setBalance", [
    address,
    "0x" + (10n ** 20n).toString(16), // 100 ETH
  ]);
  return ethers.provider.getSigner(address);
}

/**
 * Stop impersonating an address.
 */
export async function stopImpersonating(address: string): Promise<void> {
  await network.provider.request({
    method: "hardhat_stopImpersonatingAccount",
    params: [address],
  });
}

/**
 * Mine `n` blocks forward, each spaced `intervalSeconds` apart.
 */
export async function mineBlocks(n: number, intervalSeconds = 12): Promise<void> {
  for (let i = 0; i < n; i++) {
    await network.provider.send("evm_mine", []);
  }
}

/**
 * Advance block timestamp by `seconds`.
 */
export async function advanceTime(seconds: number): Promise<void> {
  await network.provider.send("evm_increaseTime", [seconds]);
  await network.provider.send("evm_mine", []);
}

/**
 * Returns true when a mainnet-fork RPC URL is likely available.
 * Used by describe.skipIf guards.
 */
export function hasMainnetRpc(): boolean {
  return !!(
    process.env["MAINNET_RPC_URL"]?.trim() ||
    process.env["ETHEREUM_RPC_URL"]?.trim() ||
    process.env["INFURA_API_KEY"]?.trim()
  );
}

/**
 * Build a DstImmutables struct for createDstEscrow.
 */
export function buildDstImmutables(overrides: {
  orderHash?: string;
  hashlock: string;
  maker: string;
  taker: string;
  token: string;
  amount: bigint;
  safetyDeposit: bigint;
  timelocks?: bigint;
}) {
  return {
    orderHash: overrides.orderHash ?? ethers.ZeroHash,
    hashlock: overrides.hashlock,
    maker: BigInt(overrides.maker),
    taker: BigInt(overrides.taker),
    token: BigInt(overrides.token),
    amount: overrides.amount,
    safetyDeposit: overrides.safetyDeposit,
    timelocks: overrides.timelocks ?? 0n,
  };
}
