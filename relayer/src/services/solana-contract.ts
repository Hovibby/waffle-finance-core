/**
 * Typed Solana integration contract layer for the relayer.
 *
 * This module establishes a stable contract for Solana settlement behavior,
 * making the placeholder-mode decision explicit and controlled. When Solana
 * is disabled (placeholder mode), all operations fail fast with clear errors.
 * When configured, the contract owns real settlement submission semantics.
 *
 * Design:
 *  - SolanaIntegration is the main interface, with two implementations:
 *    - PlaceholderSolanaIntegration (disabled/placeholder mode)
 *    - ConfiguredSolanaIntegration (real program ID configured)
 *  - Factory function `createSolanaIntegration` decides which impl to use
 *    based on the program ID and logs the choice explicitly at startup.
 *  - All relayer Solana interactions go through this contract rather than
 *    scattering placeholder checks across services.
 */

import type { Logger } from "pino";
import {
  isSolanaPlaceholder,
  checkSolanaConfig,
  type SolanaConfigStatus,
} from "@wafflefinance/config";

/**
 * Solana settlement capabilities exposed to the relayer.
 *
 * When placeholder mode is active, all operations throw
 * `SolanaDisabledError` immediately. When configured, operations
 * perform real Solana RPC calls and transaction submission.
 */
export interface SolanaIntegration {
  /**
   * Returns the current mode: "placeholder" when Solana is disabled,
   * "configured" when a real program ID is set.
   */
  readonly mode: SolanaConfigStatus;

  /**
   * The Solana HTLC program address, or undefined when in placeholder mode.
   */
  readonly programId: string | undefined;

  /**
   * Submit a lock transaction to the Solana HTLC program.
   *
   * @throws {SolanaDisabledError} when in placeholder mode
   * @throws {SolanaSubmissionError} on RPC or transaction failures
   */
  submitLock(params: SolanaLockParams): Promise<SolanaLockResult>;

  /**
   * Submit a claim transaction to the Solana HTLC program.
   *
   * @throws {SolanaDisabledError} when in placeholder mode
   * @throws {SolanaSubmissionError} on RPC or transaction failures
   */
  submitClaim(params: SolanaClaimParams): Promise<SolanaClaimResult>;

  /**
   * Check whether the integration can handle Solana settlement.
   * Returns false when in placeholder mode, true when configured.
   */
  isEnabled(): boolean;

  /**
   * Validate a Solana address format.
   * Safe to call in both placeholder and configured modes.
   */
  validateAddress(address: string): boolean;
}

/** Parameters for creating a Solana HTLC lock. */
export interface SolanaLockParams {
  /** Beneficiary address (who can claim with the preimage) */
  beneficiary: string;
  /** Refund address (who can reclaim after timelock) */
  refundAddress: string;
  /** Amount to lock (in lamports) */
  amount: bigint;
  /** SHA256 hashlock */
  hashlock: string;
  /** Timelock (unix seconds) */
  timelock: number;
  /** Token mint address, or undefined for native SOL */
  tokenMint?: string;
}

/** Result of a successful Solana lock submission. */
export interface SolanaLockResult {
  /** Transaction signature */
  signature: string;
  /** On-chain order ID (if applicable) */
  orderId?: string;
  /** Block number/slot where the tx was confirmed */
  blockNumber: number;
}

/** Parameters for claiming a Solana HTLC. */
export interface SolanaClaimParams {
  /** Order ID to claim */
  orderId: string;
  /** Preimage (secret) to unlock */
  preimage: string;
  /** Claimer's address */
  claimer: string;
}

/** Result of a successful Solana claim submission. */
export interface SolanaClaimResult {
  /** Transaction signature */
  signature: string;
  /** Block number/slot where the tx was confirmed */
  blockNumber: number;
}

/** Thrown when Solana operations are attempted in placeholder mode. */
export class SolanaDisabledError extends Error {
  constructor(operation: string) {
    super(
      `Solana operation "${operation}" is disabled: SOLANA_HTLC_PROGRAM is not configured. ` +
      `Set SOLANA_HTLC_PROGRAM_TESTNET or SOLANA_HTLC_PROGRAM_MAINNET to enable Solana support.`
    );
    this.name = "SolanaDisabledError";
  }
}

/** Thrown on Solana RPC or transaction submission failures. */
export class SolanaSubmissionError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "SolanaSubmissionError";
  }
}

/**
 * Placeholder implementation: all operations fail fast with clear errors.
 * Used when SOLANA_HTLC_PROGRAM is unset or a placeholder value.
 */
class PlaceholderSolanaIntegration implements SolanaIntegration {
  readonly mode: SolanaConfigStatus = "placeholder";
  readonly programId: string | undefined = undefined;

  constructor(private readonly log: Logger) {}

  isEnabled(): boolean {
    return false;
  }

  validateAddress(address: string): boolean {
    // Basic Solana base58 address validation (32-byte pubkey)
    // This is a permissive check suitable for placeholder mode.
    return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
  }

  async submitLock(_params: SolanaLockParams): Promise<SolanaLockResult> {
    this.log.warn("Attempted Solana lock submission in placeholder mode");
    throw new SolanaDisabledError("submitLock");
  }

  async submitClaim(_params: SolanaClaimParams): Promise<SolanaClaimResult> {
    this.log.warn("Attempted Solana claim submission in placeholder mode");
    throw new SolanaDisabledError("submitClaim");
  }
}

/**
 * Configured implementation: performs real Solana settlement operations.
 * Used when a real program ID is set in the environment.
 *
 * Note: This is a stub implementation. Real Solana RPC integration (Connection,
 * Transaction, sendAndConfirmTransaction) should be added here when the Solana
 * HTLC program is deployed and tested.
 */
class ConfiguredSolanaIntegration implements SolanaIntegration {
  readonly mode: SolanaConfigStatus = "configured";

  constructor(
    readonly programId: string,
    private readonly log: Logger,
    private readonly rpcUrl: string
  ) {}

  isEnabled(): boolean {
    return true;
  }

  validateAddress(address: string): boolean {
    // Real Solana address validation: base58 string, 32-44 chars
    // In production, use PublicKey.isOnCurve or similar from @solana/web3.js
    return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
  }

  async submitLock(params: SolanaLockParams): Promise<SolanaLockResult> {
    this.log.info(
      {
        programId: this.programId,
        beneficiary: params.beneficiary,
        amount: params.amount.toString(),
        hashlock: params.hashlock,
      },
      "Submitting Solana lock transaction"
    );

    // TODO: Implement real Solana transaction submission
    // 1. Construct instruction for the HTLC program
    // 2. Build and sign transaction
    // 3. Submit to RPC and wait for confirmation
    // 4. Return signature + block number

    throw new SolanaSubmissionError(
      "Solana lock submission is not yet implemented. " +
      "This is a typed contract stub awaiting HTLC program deployment."
    );
  }

  async submitClaim(params: SolanaClaimParams): Promise<SolanaClaimResult> {
    this.log.info(
      {
        programId: this.programId,
        orderId: params.orderId,
        claimer: params.claimer,
      },
      "Submitting Solana claim transaction"
    );

    // TODO: Implement real Solana claim submission
    // 1. Construct claim instruction with preimage
    // 2. Build and sign transaction
    // 3. Submit to RPC and wait for confirmation
    // 4. Return signature + block number

    throw new SolanaSubmissionError(
      "Solana claim submission is not yet implemented. " +
      "This is a typed contract stub awaiting HTLC program deployment."
    );
  }
}

/**
 * Factory function: create the appropriate Solana integration based on
 * the program ID. Logs the decision explicitly so operators see whether
 * Solana is enabled or disabled.
 *
 * @param programId - The Solana HTLC program address (from env)
 * @param log - Pino logger instance
 * @param rpcUrl - Solana RPC URL (only used when configured)
 * @returns SolanaIntegration instance (placeholder or configured)
 */
export function createSolanaIntegration(
  programId: string | undefined,
  log: Logger,
  rpcUrl: string
): SolanaIntegration {
  const status = checkSolanaConfig(programId);

  if (status === "placeholder") {
    log.warn(
      "Solana integration is in PLACEHOLDER mode: all Solana operations are disabled. " +
      "Set SOLANA_HTLC_PROGRAM_TESTNET or SOLANA_HTLC_PROGRAM_MAINNET to enable."
    );
    return new PlaceholderSolanaIntegration(log);
  }

  // status === "configured"
  log.info(
    { programId, rpcUrl },
    "Solana integration is CONFIGURED: Solana settlement is enabled."
  );
  return new ConfiguredSolanaIntegration(programId!, log, rpcUrl);
}

/**
 * Type guard: check if a Solana integration is in configured mode.
 * Useful for conditional logic that needs to branch on mode.
 */
export function isConfiguredSolana(
  integration: SolanaIntegration
): integration is ConfiguredSolanaIntegration {
  return integration.mode === "configured";
}
