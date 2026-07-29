/**
 * Soroban transaction orchestration layer.
 *
 * Implements the full pipeline: build → simulate → assemble → sign → submit →
 * poll, with retry logic, sequence-number refresh, and fee-bump escalation.
 *
 * Callers supply a `buildTx` factory so the orchestrator can fetch a fresh
 * account sequence on every attempt without knowing the operation details.
 */

import {
  TransactionBuilder,
  rpc,
  xdr,
  type Transaction,
  type FeeBumpTransaction,
} from "@stellar/stellar-sdk";
import { HTLCError, type HTLCErrorCode, type HTLCSubmissionMeta } from "../htlc-client.js";
import type { SorobanSigner } from "./index.js";

// ── Public config ─────────────────────────────────────────────────────────────

export interface OrchestrationConfig {
  /** Maximum number of end-to-end submission attempts. Default: 3 */
  maxRetries?: number;
  /** Delay in ms between retry attempts. Default: 1000 */
  retryDelayMs?: number;
  /** Status poll interval in ms. Default: 2000 */
  pollingIntervalMs?: number;
  /** Total polling budget in ms before a timeout error. Default: 30000 */
  pollingTimeoutMs?: number;
  /**
   * Maximum base fee per operation in stroops for fee-bump transactions.
   * The actual total fee charged = baseFee × (inner ops + 1).
   * Default: 1_000_000 stroops (≈ 0.1 XLM).
   */
  feeBumpCap?: number;
  /** Multiplier applied to the current base fee on each bump attempt. Default: 2 */
  feeBumpMultiplier?: number;
}

export interface OrchestratedResult {
  hash: string;
  ledger: number;
  /** Base64-encoded XDR of the on-chain TransactionResult. */
  resultXdr: string;
  meta: HTLCSubmissionMeta;
}

// ── Internals ─────────────────────────────────────────────────────────────────

const DEFAULTS = {
  maxRetries: 3,
  retryDelayMs: 1_000,
  pollingIntervalMs: 2_000,
  pollingTimeoutMs: 30_000,
  feeBumpCap: 1_000_000,
  feeBumpMultiplier: 2,
} satisfies Required<OrchestrationConfig>;

type StellarRejectionCode =
  | "tx_bad_seq"
  | "tx_insufficient_fee"
  | "tx_failed"
  | "unknown";

function parseRejectionCode(
  errorResult: xdr.TransactionResult | undefined,
): StellarRejectionCode {
  if (!errorResult) return "unknown";
  try {
    const name = (errorResult.result().switch() as { name: string }).name;
    if (name === "txBadSeq") return "tx_bad_seq";
    if (name === "txInsufficientFee") return "tx_insufficient_fee";
    if (name === "txFailed") return "tx_failed";
    return "unknown";
  } catch {
    return "unknown";
  }
}

function makeError(
  code: HTLCErrorCode,
  message: string,
  retryable: boolean,
  meta: HTLCSubmissionMeta,
  cause?: unknown,
): HTLCError {
  return new HTLCError({ code, message, retryable, cause, submissionMeta: meta });
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Main entry point ──────────────────────────────────────────────────────────

export interface OrchestrateOptions {
  server: rpc.Server;
  networkPassphrase: string;
  signer: SorobanSigner;
  sourceAccountId: string;
  /**
   * Factory called at the start of each attempt to produce a Transaction
   * with a current account sequence number. Receives the RPC server so it
   * can call server.getAccount() for a fresh sequence.
   */
  buildTx: (server: rpc.Server) => Promise<Transaction>;
  config?: OrchestrationConfig;
  /**
   * @internal Override for `rpc.assembleTransaction` — used in unit tests to
   * avoid the need to produce valid Soroban simulation responses.
   */
  _assembleTransaction?: (
    tx: Transaction,
    sim: rpc.Api.SimulateTransactionResponse,
  ) => { build(): Transaction };
  /**
   * @internal Override for `TransactionBuilder.fromXDR` — used in unit tests.
   */
  _fromXDR?: (xdr: string, passphrase: string) => Transaction | FeeBumpTransaction;
  /**
   * @internal Override for `TransactionBuilder.buildFeeBumpTransaction` — used
   * in unit tests.
   */
  _buildFeeBumpTransaction?: (
    source: string,
    baseFee: string,
    inner: Transaction,
    passphrase: string,
  ) => FeeBumpTransaction;
}

export async function orchestrateTransaction({
  server,
  networkPassphrase,
  signer,
  sourceAccountId,
  buildTx,
  config: configIn,
  _assembleTransaction = rpc.assembleTransaction,
  _fromXDR = TransactionBuilder.fromXDR.bind(TransactionBuilder),
  _buildFeeBumpTransaction = TransactionBuilder.buildFeeBumpTransaction.bind(TransactionBuilder),
}: OrchestrateOptions): Promise<OrchestratedResult> {
  const cfg = { ...DEFAULTS, ...configIn };
  const feeBumpHistory: number[] = [];
  let lastHash: string | undefined;

  const snap = (attempts: number): HTLCSubmissionMeta => ({
    attempts,
    feeBumpHistory: [...feeBumpHistory],
    lastHash,
  });

  outerLoop: for (let attempt = 1; attempt <= cfg.maxRetries; attempt++) {
    // ── Step 1: Build (fetches a fresh account sequence each attempt) ─────────

    let tx: Transaction;
    try {
      tx = await buildTx(server);
    } catch (err) {
      if (attempt < cfg.maxRetries) {
        await pause(cfg.retryDelayMs);
        continue outerLoop;
      }
      throw makeError(
        "chain_error",
        `Failed to build transaction after ${attempt} attempts: ${err}`,
        false,
        snap(attempt),
        err,
      );
    }

    // ── Step 2: Simulate ──────────────────────────────────────────────────────

    let simResult: rpc.Api.SimulateTransactionResponse;
    try {
      simResult = await server.simulateTransaction(tx);
    } catch (err) {
      if (attempt < cfg.maxRetries) {
        await pause(cfg.retryDelayMs);
        continue outerLoop;
      }
      throw makeError(
        "chain_error",
        `Simulation RPC failed after ${attempt} attempts: ${err}`,
        false,
        snap(attempt),
        err,
      );
    }

    if (rpc.Api.isSimulationError(simResult)) {
      // Simulation failures are logic errors — retrying won't help.
      throw makeError(
        "simulation_failed",
        `Soroban simulation rejected the transaction: ${simResult.error}`,
        false,
        snap(attempt),
        new Error(simResult.error),
      );
    }

    // ── Step 3: Assemble ──────────────────────────────────────────────────────
    // Injects auth entries, resource fees, and footprint from the simulation.

    tx = _assembleTransaction(tx, simResult).build();

    // ── Step 4: Sign ──────────────────────────────────────────────────────────

    let signedXdr: string;
    try {
      signedXdr = await signer({
        xdr: tx.toXDR(),
        networkPassphrase,
        publicKey: sourceAccountId,
      });
    } catch (err) {
      throw makeError(
        "wallet_unavailable",
        `Signer rejected the transaction: ${err}`,
        false,
        snap(attempt),
        err,
      );
    }

    const signedTx = _fromXDR(signedXdr, networkPassphrase) as Transaction;
    let currentBaseFee = parseInt(signedTx.fee, 10);
    let txToSubmit: Transaction | FeeBumpTransaction = signedTx;

    // ── Step 5: Submit (with inline fee-bump escalation) ──────────────────────

    feeBumpLoop: while (true) {
      let submitted: rpc.Api.SendTransactionResponse;
      try {
        submitted = await server.sendTransaction(txToSubmit);
      } catch (err) {
        if (attempt < cfg.maxRetries) {
          await pause(cfg.retryDelayMs);
          continue outerLoop;
        }
        throw makeError(
          "chain_error",
          `Network error submitting transaction: ${err}`,
          false,
          snap(attempt),
          err,
        );
      }

      lastHash = submitted.hash;

      if (submitted.status === "PENDING" || submitted.status === "DUPLICATE") {
        // ── Step 6: Poll for on-chain inclusion ───────────────────────────────
        return await pollStatus(server, submitted.hash, cfg, snap(attempt));
      }

      if (submitted.status === "TRY_AGAIN_LATER") {
        if (attempt < cfg.maxRetries) {
          await pause(cfg.retryDelayMs);
          continue outerLoop;
        }
        throw makeError(
          "chain_error",
          `RPC overloaded (TRY_AGAIN_LATER) after ${attempt} attempts`,
          false,
          snap(attempt),
        );
      }

      if (submitted.status === "ERROR") {
        const code = parseRejectionCode(submitted.errorResult);

        if (code === "tx_bad_seq") {
          // Sequence mismatch — re-fetch the account to get the current sequence.
          if (attempt < cfg.maxRetries) {
            await pause(cfg.retryDelayMs);
            continue outerLoop;
          }
          throw makeError(
            "tx_rejected",
            `Sequence number conflict (tx_bad_seq) after ${attempt} attempts`,
            false,
            snap(attempt),
          );
        }

        if (code === "tx_insufficient_fee") {
          const newBaseFee = currentBaseFee * cfg.feeBumpMultiplier;
          if (newBaseFee > cfg.feeBumpCap) {
            throw makeError(
              "tx_rejected",
              `Fee cap of ${cfg.feeBumpCap} stroops exceeded` +
                ` (would need ${newBaseFee}, cap is ${cfg.feeBumpCap})`,
              false,
              snap(attempt),
            );
          }

          feeBumpHistory.push(newBaseFee);
          currentBaseFee = newBaseFee;

          const feeBump = _buildFeeBumpTransaction(
            sourceAccountId,
            newBaseFee.toString(),
            signedTx,
            networkPassphrase,
          );
          let bumpXdr: string;
          try {
            bumpXdr = await signer({
              xdr: feeBump.toXDR(),
              networkPassphrase,
              publicKey: sourceAccountId,
            });
          } catch (err) {
            throw makeError(
              "wallet_unavailable",
              `Signer rejected fee-bump transaction: ${err}`,
              false,
              snap(attempt),
              err,
            );
          }
          txToSubmit = _fromXDR(bumpXdr, networkPassphrase) as FeeBumpTransaction;
          continue feeBumpLoop;
        }

        // Terminal rejection (tx_failed, unknown, etc.)
        const errorXdr = submitted.errorResult?.toXDR("base64") ?? "unknown";
        throw makeError(
          "tx_rejected",
          `Network rejected transaction (${code}): ${errorXdr}`,
          false,
          snap(attempt),
          submitted.errorResult,
        );
      }
    }
  }

  throw makeError(
    "chain_error",
    `Max retries (${cfg.maxRetries}) exhausted without a terminal response`,
    false,
    snap(cfg.maxRetries),
  );
}

// ── Status polling ────────────────────────────────────────────────────────────

async function pollStatus(
  server: rpc.Server,
  hash: string,
  cfg: Required<OrchestrationConfig>,
  meta: HTLCSubmissionMeta,
): Promise<OrchestratedResult> {
  const deadline = Date.now() + cfg.pollingTimeoutMs;

  while (Date.now() < deadline) {
    await pause(cfg.pollingIntervalMs);

    let response: rpc.Api.GetTransactionResponse;
    try {
      response = await server.getTransaction(hash);
    } catch {
      continue; // transient poll failure; keep trying
    }

    if (response.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      const ok = response as rpc.Api.GetSuccessfulTransactionResponse;
      return {
        hash,
        ledger: ok.ledger,
        resultXdr: ok.resultXdr.toXDR("base64"),
        meta,
      };
    }

    if (response.status === rpc.Api.GetTransactionStatus.FAILED) {
      const failed = response as rpc.Api.GetFailedTransactionResponse;
      throw new HTLCError({
        code: "tx_rejected",
        message: `Transaction failed on-chain: ${failed.resultXdr.toXDR("base64")}`,
        retryable: false,
        cause: failed.resultXdr,
        submissionMeta: meta,
      });
    }

    // NOT_FOUND → keep polling until deadline
  }

  throw new HTLCError({
    code: "chain_error",
    message: `Polling timed out after ${cfg.pollingTimeoutMs}ms for tx ${hash}`,
    retryable: true,
    submissionMeta: meta,
  });
}
