/**
 * @fileoverview Settlement-specific retry policies for the WaffleFinance relayer.
 *
 * Each settlement code path (ETH send, Stellar submit, Horizon verify, RPC calls)
 * has different failure modes. This module provides:
 *
 *  1. FAULT CLASSIFIERS — maps raw errors from each code path to a
 *     `FaultClass` ('transient' | 'confirmation_delay' | 'terminal') for the
 *     RetryEngine, and to a `FailureCategory` for the SettlementFailureStore.
 *
 *  2. RETRY CONFIGS — per-operation RetryEngine `RunOptions` (maxAttempts,
 *     baseDelayMs, maxDelayMs) tuned for each failure mode's characteristics.
 *
 *  3. CATEGORY CLASSIFIER — converts a raw error to a `FailureCategory` so
 *     the SettlementFailureStore can record structured failure events.
 *
 * Design notes
 * ------------
 * - The classifiers never throw. Unknown errors default to `transient` fault
 *   class and `terminal_unknown` category after the retry budget is exhausted.
 * - Horizon timeout errors (504, ECONNABORTED) produce `transient` fault class
 *   but `horizon_timeout` category — callers MUST mark the outcome ambiguous
 *   rather than immediately retrying.
 * - `confirmation_delay` is used for "tx not yet mined" conditions — the
 *   RetryEngine applies a 3× longer back-off for these automatically.
 */

import type { FaultClass, FaultClassifier } from '../utils/retry-engine.js';
import type { FailureCategory } from './settlement-failure-store.js';
import type { RunOptions } from '../utils/retry-engine.js';
import {
  HorizonTimeoutError,
  HorizonTerminalError,
  HorizonTransientError,
} from './xlm-refund.js';

// ---------------------------------------------------------------------------
// ETH RPC fault classifier
// ---------------------------------------------------------------------------

/**
 * Classify errors from ethers.js provider calls and wallet operations.
 *
 * Terminal patterns (never retry):
 *   - insufficient funds, execution reverted, invalid signature, bad auth
 *   - nonce too high, gas limit exceeded (misconfigured — needs operator fix)
 *
 * Confirmation-delay patterns (retry with long back-off):
 *   - transaction not found, nonce too low (tx already landed or replaced)
 *   - already known (tx already in mempool — safe to wait for mining)
 *
 * Recoverable transient patterns (retry with short back-off):
 *   - 429 / rate limit / compute units exceeded
 *   - timeout, ECONNRESET, socket hang up
 *   - server error (5xx from RPC node)
 */
export const ethRpcClassifier: FaultClassifier = (err: unknown): FaultClass | null => {
  const msg = extractMessage(err);
  const code = extractCode(err);

  // ── Terminal ──────────────────────────────────────────────────────────────
  if (
    /insufficient funds/i.test(msg) ||
    /execution reverted/i.test(msg) ||
    /invalid signature/i.test(msg) ||
    /bad auth/i.test(msg) ||
    /not authorized/i.test(msg) ||
    /nonce too high/i.test(msg) ||
    /gas limit exceeded/i.test(msg) ||
    /replacement transaction underpriced/i.test(msg) ||
    /transaction underpriced/i.test(msg)
  ) {
    return 'terminal';
  }

  // ── Confirmation delay ────────────────────────────────────────────────────
  if (
    /nonce too low/i.test(msg) ||
    /already known/i.test(msg) ||
    /known transaction/i.test(msg) ||
    /transaction not found/i.test(msg) ||
    /pending/i.test(msg)
  ) {
    return 'confirmation_delay';
  }

  // ── Recoverable (rate limit / timeout) ────────────────────────────────────
  if (
    code === 429 ||
    (code === 'UNKNOWN_ERROR' && extractNestedCode(err) === 429) ||
    /rate limit/i.test(msg) ||
    /compute units/i.test(msg) ||
    /exceeded/i.test(msg) ||
    /timeout/i.test(msg) ||
    /ETIMEDOUT/i.test(msg) ||
    /ECONNRESET/i.test(msg) ||
    /socket hang up/i.test(msg) ||
    /server error/i.test(msg) ||
    /503/i.test(msg) ||
    /502/i.test(msg)
  ) {
    return 'transient';
  }

  return null; // fall through to default classifier
};

// ---------------------------------------------------------------------------
// Horizon / Stellar fault classifier
// ---------------------------------------------------------------------------

/**
 * Classify errors from Stellar SDK Horizon calls (load account, submit tx).
 *
 * Uses the typed error hierarchy from xlm-refund.ts when available,
 * otherwise falls back to HTTP status inspection.
 */
export const horizonClassifier: FaultClassifier = (err: unknown): FaultClass | null => {
  // Typed hierarchy from xlm-refund.ts
  if (err instanceof HorizonTimeoutError) return 'transient';   // ambiguous — callers handle
  if (err instanceof HorizonTerminalError) return 'terminal';
  if (err instanceof HorizonTransientError) return 'transient';

  const msg = extractMessage(err);
  const status = extractHttpStatus(err);

  if (status === 504 || status === 408) return 'transient';    // ambiguous outcome
  if (status === 400) {
    const codes = extractResultCodes(err);
    if (
      codes.includes('tx_bad_auth') ||
      codes.includes('op_no_destination') ||
      codes.includes('op_no_trust') ||
      codes.includes('tx_insufficient_balance')
    ) return 'terminal';
    // tx_bad_seq / tx_insufficient_fee — recoverable
    return 'transient';
  }
  if (status >= 500) return 'transient';

  if (/timeout|ETIMEDOUT|ECONNRESET/i.test(msg)) return 'transient';

  return null;
};

// ---------------------------------------------------------------------------
// Category classifier — maps raw errors to FailureCategory
// ---------------------------------------------------------------------------

/**
 * Convert a raw error to a structured `FailureCategory` for the
 * SettlementFailureStore. Called on every catch block in the settlement paths.
 *
 * @param err        The caught error.
 * @param chain      Which chain the failure came from.
 */
export function classifyFailureCategory(
  err: unknown,
  chain: 'ethereum' | 'stellar' | 'unknown' = 'unknown',
): FailureCategory {
  const msg = extractMessage(err);
  const code = extractCode(err);
  const status = extractHttpStatus(err);

  // ── Stellar typed errors ──────────────────────────────────────────────────
  if (err instanceof HorizonTimeoutError) return 'horizon_timeout';
  if (err instanceof HorizonTerminalError) {
    const rc = (err as HorizonTerminalError).resultCode;
    if (rc === 'tx_bad_seq')          return 'stellar_bad_seq';
    if (rc === 'tx_insufficient_fee') return 'stellar_fee_too_low';
    if (rc === 'tx_insufficient_balance' || rc === 'tx_no_source_account') return 'insufficient_balance';
    if (rc === 'tx_bad_auth')         return 'auth_failure';
    return 'terminal_unknown';
  }
  if (err instanceof HorizonTransientError) return 'horizon_transient';

  // ── Horizon HTTP status ───────────────────────────────────────────────────
  if (chain === 'stellar') {
    if (status === 504 || status === 408) return 'horizon_timeout';
    if (status >= 500)                    return 'horizon_transient';
    const codes = extractResultCodes(err);
    if (codes.includes('tx_bad_seq'))            return 'stellar_bad_seq';
    if (codes.includes('tx_insufficient_fee'))   return 'stellar_fee_too_low';
    if (codes.includes('tx_insufficient_balance')) return 'insufficient_balance';
    if (codes.includes('tx_bad_auth'))           return 'auth_failure';
  }

  // ── Ethereum errors ───────────────────────────────────────────────────────
  if (chain === 'ethereum') {
    if (
      code === 429 ||
      (code === 'UNKNOWN_ERROR' && extractNestedCode(err) === 429) ||
      /rate limit/i.test(msg) ||
      /compute units/i.test(msg)
    ) return 'rpc_rate_limit';

    if (/timeout|ETIMEDOUT|ECONNRESET|socket hang up/i.test(msg)) return 'rpc_timeout';
    if (/nonce too low/i.test(msg)) return 'eth_nonce_conflict';
    if (/gas/i.test(msg) && /low|limit/i.test(msg)) return 'eth_gas_too_low';
    if (/insufficient funds/i.test(msg)) return 'insufficient_balance';
    if (/execution reverted/i.test(msg) || /invalid signature/i.test(msg)) return 'auth_failure';
  }

  // ── Generic patterns ──────────────────────────────────────────────────────
  if (/rate limit/i.test(msg) || /429/i.test(msg)) return 'rpc_rate_limit';
  if (/timeout|ETIMEDOUT|ECONNRESET/i.test(msg))   return 'rpc_timeout';
  if (/insufficient.*(fund|balance)/i.test(msg))   return 'insufficient_balance';
  if (/auth|permission|not authorized/i.test(msg)) return 'auth_failure';

  return 'terminal_unknown';
}

// ---------------------------------------------------------------------------
// Per-operation retry configs
// ---------------------------------------------------------------------------

/**
 * RetryEngine `RunOptions` tuned for Ethereum RPC calls
 * (getBalance, sendTransaction, getTransactionReceipt).
 *
 * - 5 attempts total (4 retries after the first).
 * - 2 s base delay, caps at 30 s.
 * - Custom classifier installed so RPC-specific patterns are caught first.
 */
export const ETH_RPC_RETRY: RunOptions = {
  maxAttempts: 5,
  baseDelayMs: 2_000,
  maxDelayMs: 30_000,
  classifier: ethRpcClassifier,
  note: 'eth-rpc',
};

/**
 * Tighter config for the initial ETH balance check — fewer retries,
 * since a missing balance doesn't need aggressive recovery.
 */
export const ETH_BALANCE_RETRY: RunOptions = {
  maxAttempts: 4,
  baseDelayMs: 1_000,
  maxDelayMs: 16_000,
  classifier: ethRpcClassifier,
  note: 'eth-balance',
};

/**
 * Config for the ETH send transaction step.
 * Fewer attempts than general RPC — an in-flight tx is ambiguous; we don't
 * want to double-send. The TxStateStore handles idempotency above this layer.
 */
export const ETH_SEND_RETRY: RunOptions = {
  maxAttempts: 3,
  baseDelayMs: 2_000,
  maxDelayMs: 16_000,
  classifier: ethRpcClassifier,
  note: 'eth-send',
};

/**
 * Config for waiting for an ETH tx receipt (confirmation).
 * Uses confirmation_delay class naturally — tx may just not be mined yet.
 */
export const ETH_CONFIRM_RETRY: RunOptions = {
  maxAttempts: 5,
  baseDelayMs: 3_000,
  maxDelayMs: 30_000,
  classifier: ethRpcClassifier,
  note: 'eth-confirm',
};

/**
 * Config for Stellar Horizon verification calls.
 * Higher attempt count — Horizon can be temporarily unavailable.
 */
export const HORIZON_VERIFY_RETRY: RunOptions = {
  maxAttempts: 4,
  baseDelayMs: 2_000,
  maxDelayMs: 20_000,
  classifier: horizonClassifier,
  note: 'horizon-verify',
};

/**
 * Config for Stellar XLM payment submission.
 * Low attempt count — submitting a tx is not idempotent without a sequence
 * number check. The xlm-refund.ts layer handles tx_bad_seq internally.
 */
export const STELLAR_SUBMIT_RETRY: RunOptions = {
  maxAttempts: 3,
  baseDelayMs: 1_500,
  maxDelayMs: 15_000,
  classifier: horizonClassifier,
  note: 'stellar-submit',
};

// ---------------------------------------------------------------------------
// Error extraction helpers (internal)
// ---------------------------------------------------------------------------

function extractMessage(err: unknown): string {
  if (err instanceof Error) return err.message ?? '';
  if (typeof err === 'string') return err;
  return JSON.stringify(err);
}

function extractCode(err: unknown): number | string | undefined {
  return (err as any)?.code;
}

function extractNestedCode(err: unknown): number | undefined {
  return (err as any)?.error?.code;
}

function extractHttpStatus(err: unknown): number {
  return (err as any)?.response?.status ?? 0;
}

function extractResultCodes(err: unknown): string[] {
  const rc = (err as any)?.response?.data?.extras?.result_codes ?? {};
  const txCode = rc.transaction ? [rc.transaction] : [];
  const opCodes: string[] = Array.isArray(rc.operations) ? rc.operations : [];
  return [...txCode, ...opCodes];
}
