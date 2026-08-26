import { describe, it, expect, vi, beforeEach } from "vitest";
import pino from "pino";

const mockReadContract = vi.fn();
const mockWriteContract = vi.fn();
const mockWaitForTransactionReceipt = vi.fn();

vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem")>();
  return {
    ...actual,
    createPublicClient: vi.fn(() => ({
      readContract: mockReadContract,
      waitForTransactionReceipt: mockWaitForTransactionReceipt,
    })),
    createWalletClient: vi.fn(() => ({
      writeContract: mockWriteContract,
    })),
  };
});

vi.mock("viem/accounts", () => ({
  privateKeyToAccount: vi.fn(() => ({ address: "0xResolverAddress" })),
}));

const cfg = {
  network: "testnet" as const,
  pollIntervalMs: 15000,
  coordinatorUrl: "",
  logLevel: "silent" as const,
  ethereum: {
    chainId: 11155111,
    rpcUrl: "http://localhost:8545",
    htlcEscrow: "0xEscrow" as const,
    resolverRegistry: "0xRegistry" as `0x${string}`,
    resolverPrivateKey: "0xabc123" as `0x${string}`,
  },
  soroban: {
    rpcUrl: "",
    networkPassphrase: "",
    horizonUrl: "",
    htlc: null,
    resolverRegistry: null,
    resolverSecret: null,
  },
};

vi.mock("../src/config.js", () => ({
  loadConfig: vi.fn(() => cfg),
}));

vi.mock("../src/logger.js", () => ({
  getLogger: vi.fn(() => pino({ level: "silent" })),
}));

import { registerCommand, statusCommand, unregisterCommand } from "../src/commands/register.js";
import { registry, registrationInfo, registrationChangesTotal, operationFailuresTotal } from "../src/metrics.js";

beforeEach(() => {
  vi.clearAllMocks();
  registry.resetMetrics();
});

describe("registerCommand", () => {
  it("registers and records registration metrics on success", async () => {
    mockReadContract
      .mockResolvedValueOnce("0xStakeAsset") // stakeAsset
      .mockResolvedValueOnce(6) // decimals
      .mockResolvedValueOnce("USDC") // symbol
      .mockResolvedValueOnce(1000n); // minStake
    mockWriteContract.mockResolvedValueOnce("0xApproveTx").mockResolvedValueOnce("0xRegisterTx");
    mockWaitForTransactionReceipt.mockResolvedValue({ gasUsed: 21000n });

    await registerCommand();

    const metrics = await registry.metrics();
    expect(metrics).toContain("resolver_registration_info 1");
    expect(metrics).toContain(
      'resolver_registration_changes_total{action="register"} 1'
    );
  });

  it("retries transient RPC read failures before succeeding", async () => {
    mockReadContract
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockResolvedValueOnce("0xStakeAsset")
      .mockResolvedValueOnce(6)
      .mockResolvedValueOnce("USDC")
      .mockResolvedValueOnce(1000n);
    mockWriteContract.mockResolvedValueOnce("0xApproveTx").mockResolvedValueOnce("0xRegisterTx");
    mockWaitForTransactionReceipt.mockResolvedValue({ gasUsed: 21000n });

    await registerCommand();

    expect(mockReadContract).toHaveBeenCalledTimes(5);
    const metrics = await registry.metrics();
    expect(metrics).toContain("resolver_registration_info 1");
  }, 10000);

  it("does not retry the write path and reports a classified failure on rejection", async () => {
    mockReadContract
      .mockResolvedValueOnce("0xStakeAsset")
      .mockResolvedValueOnce(6)
      .mockResolvedValueOnce("USDC")
      .mockResolvedValueOnce(1000n);
    mockWriteContract.mockRejectedValueOnce(new Error("insufficient funds"));

    await expect(registerCommand()).rejects.toThrow("insufficient funds");

    expect(mockWriteContract).toHaveBeenCalledTimes(1);
    const metrics = await registry.metrics();
    expect(metrics).toContain(
      'resolver_operation_failures_total{chain="ethereum",operation="register",failure_reason="unknown_error"} 1'
    );
  });

  it("rejects a stake below the minimum without submitting any transaction", async () => {
    mockReadContract
      .mockResolvedValueOnce("0xStakeAsset")
      .mockResolvedValueOnce(6)
      .mockResolvedValueOnce("USDC")
      .mockResolvedValueOnce(1000n);

    await expect(registerCommand("0.0001")).rejects.toThrow(/below minimum/);
    expect(mockWriteContract).not.toHaveBeenCalled();
  });

  // ── Strict stake parsing (Fix 1) ────────────────────────────────────────

  it("rejects a stake string with an alphabetic suffix before any RPC call", async () => {
    await expect(registerCommand("10abc")).rejects.toThrow(/stake argument.*not a valid decimal/);
    expect(mockReadContract).not.toHaveBeenCalled();
    expect(mockWriteContract).not.toHaveBeenCalled();
  });

  it("rejects scientific-notation stake input before any RPC call", async () => {
    await expect(registerCommand("1e2")).rejects.toThrow(/stake argument.*not a valid decimal/);
    expect(mockReadContract).not.toHaveBeenCalled();
    expect(mockWriteContract).not.toHaveBeenCalled();
  });

  it("rejects a stake string with leading/trailing spaces before any RPC call", async () => {
    await expect(registerCommand(" 10 ")).rejects.toThrow(/stake argument.*not a valid decimal/);
    expect(mockReadContract).not.toHaveBeenCalled();
    expect(mockWriteContract).not.toHaveBeenCalled();
  });

  it("accepts a valid integer stake string and proceeds to RPC calls", async () => {
    mockReadContract
      .mockResolvedValueOnce("0xStakeAsset")
      .mockResolvedValueOnce(6)
      .mockResolvedValueOnce("USDC")
      .mockResolvedValueOnce(1000n);
    mockWriteContract.mockResolvedValueOnce("0xApproveTx").mockResolvedValueOnce("0xRegisterTx");
    mockWaitForTransactionReceipt.mockResolvedValue({ gasUsed: 21000n });

    await registerCommand("1000000"); // 1 USDC with 6 decimals = 1_000_000 units

    expect(mockReadContract).toHaveBeenCalledTimes(4);
    expect(mockWriteContract).toHaveBeenCalledTimes(2);
  });

  it("accepts a valid decimal stake string and proceeds to RPC calls", async () => {
    mockReadContract
      .mockResolvedValueOnce("0xStakeAsset")
      .mockResolvedValueOnce(6)
      .mockResolvedValueOnce("USDC")
      .mockResolvedValueOnce(1000n);
    mockWriteContract.mockResolvedValueOnce("0xApproveTx").mockResolvedValueOnce("0xRegisterTx");
    mockWaitForTransactionReceipt.mockResolvedValue({ gasUsed: 21000n });

    await registerCommand("1.5");

    expect(mockReadContract).toHaveBeenCalledTimes(4);
    expect(mockWriteContract).toHaveBeenCalledTimes(2);
  });

  // ── Negative stake guard (Fix 3) ────────────────────────────────────────

  it("rejects a negative stake before any token or registry call", async () => {
    await expect(registerCommand("-1")).rejects.toThrow(
      /stake argument must be a non-negative amount/
    );
    expect(mockReadContract).not.toHaveBeenCalled();
    expect(mockWriteContract).not.toHaveBeenCalled();
  });

  it("rejects a negative decimal stake before any token or registry call", async () => {
    await expect(registerCommand("-0.5")).rejects.toThrow(
      /stake argument must be a non-negative amount/
    );
    expect(mockReadContract).not.toHaveBeenCalled();
    expect(mockWriteContract).not.toHaveBeenCalled();
  });

  // ── Retry classification (Fix 4) ────────────────────────────────────────
  //
  // Read-path calls (stakeAsset, decimals, symbol, minStake) are wrapped with
  // retryRpcCall and may be attempted multiple times on transient failure.
  // Write-path calls (approve, register) must occur at most once per command
  // invocation — retrying a submitted transaction risks double-submission.

  it("retries only the read path: reads may be retried, writes are called exactly once per invocation", async () => {
    // First stakeAsset call fails transiently, then all reads succeed.
    mockReadContract
      .mockRejectedValueOnce(new Error("network timeout")) // stakeAsset attempt 1
      .mockRejectedValueOnce(new Error("network timeout")) // stakeAsset attempt 2
      .mockResolvedValueOnce("0xStakeAsset")               // stakeAsset attempt 3
      .mockResolvedValueOnce(6)                            // decimals
      .mockResolvedValueOnce("USDC")                       // symbol
      .mockResolvedValueOnce(1000n);                       // minStake

    mockWriteContract
      .mockResolvedValueOnce("0xApproveTx")
      .mockResolvedValueOnce("0xRegisterTx");
    mockWaitForTransactionReceipt.mockResolvedValue({ gasUsed: 21000n });

    await registerCommand();

    // Reads were retried: 2 failures + 1 success on stakeAsset + 3 more reads = 6 total
    expect(mockReadContract).toHaveBeenCalledTimes(6);
    // Writes were NOT retried: exactly one approve and one register
    expect(mockWriteContract).toHaveBeenCalledTimes(2);
  }, 30000);

  it("does not retry a failed write even when reads all succeed", async () => {
    mockReadContract
      .mockResolvedValueOnce("0xStakeAsset")
      .mockResolvedValueOnce(6)
      .mockResolvedValueOnce("USDC")
      .mockResolvedValueOnce(1000n);

    // Write fails immediately
    mockWriteContract.mockRejectedValueOnce(new Error("out of gas"));

    await expect(registerCommand()).rejects.toThrow("out of gas");

    // Write was attempted exactly once — no retry
    expect(mockWriteContract).toHaveBeenCalledTimes(1);
    // Reads were done (no retry needed since all succeeded)
    expect(mockReadContract).toHaveBeenCalledTimes(4);
  });
});

describe("statusCommand", () => {
  it("reflects an active resolver in the registration_info gauge", async () => {
    mockReadContract
      .mockResolvedValueOnce({ resolver: "0xResolverAddress", stake: 1000n })
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(1000n);

    await statusCommand();

    const metrics = await registry.metrics();
    expect(metrics).toContain("resolver_registration_info 1");
  });

  it("reflects an inactive resolver in the registration_info gauge", async () => {
    mockReadContract
      .mockResolvedValueOnce({ resolver: "0xResolverAddress", stake: 0n })
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(1000n);

    await statusCommand();

    const metrics = await registry.metrics();
    expect(metrics).toContain("resolver_registration_info 0");
  });
});

describe("unregisterCommand", () => {
  it("unregisters and records registration metrics on success", async () => {
    mockWriteContract.mockResolvedValueOnce("0xUnregisterTx");
    mockWaitForTransactionReceipt.mockResolvedValue({ gasUsed: 21000n });

    await unregisterCommand();

    const metrics = await registry.metrics();
    expect(metrics).toContain("resolver_registration_info 0");
    expect(metrics).toContain(
      'resolver_registration_changes_total{action="unregister"} 1'
    );
  });

  it("propagates a write failure with a classified failure metric", async () => {
    mockWriteContract.mockRejectedValueOnce(new Error("nonce too low"));

    await expect(unregisterCommand()).rejects.toThrow("nonce too low");

    const metrics = await registry.metrics();
    expect(metrics).toContain(
      'resolver_operation_failures_total{chain="ethereum",operation="unregister",failure_reason="unknown_error"} 1'
    );
  });
});
