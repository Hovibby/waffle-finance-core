/**
 * @fileoverview Settlement Failure Ledger
 *
 * Tracks the state of every relayer settlement attempt so that:
 *  - Failed attempts are never silently lost
 *  - Recoverable failures are retried with correct back-off
 *  - Terminal failures are preserved for manual intervention
 *  - Operators can inspect outstanding failures via a status endpoint
 *
 * ## Failure categories
 *
 * | Category      | Retryable | Examples                                     |
 * |---------------|-----------|----------------------------------------------|
 * | transient_rpc | Yes       | RPC timeout, rate-limit (429), ECONNRESET     |
 * | insufficient_funds | No   | Relayer ETH balance too low                  |
 * | nonce_conflict | Yes (reset) | Nonce too low / too high                  |
 * | gas_error     | Yes       | Gas price spike, gas estimation failure      |
 * | horizon_timeout | Ambiguous | Stellar 504 — tx may have landed           |
 * | terminal      | No        | Invalid address, contract revert             |
 * | unknown       | Yes (bounded) | Unexpected errors                       |
 *
 * ## Persistence
 *
 * Entries are kept in-memory (matching the existing refund ledger pattern).
 * The interface mirrors RefundLedger so a durable backing store can be
 * swapped in without changing callers.
 *
 * ## Thread safety
 *
 * All mutations are synchronous — safe within Node.js single-threaded
 * event loop. The `attempt()` method is an atomic claim-or-update gate.
 */

import { getCurrentTimestamp } from './utils.js';

// ---------------------------------------------------------------------------
// Failure categories
// ---------------------------------------------------------------------------

export type SettlementFailureCategory =
  | 'transient_rpc'        // timeout, ECONNRESET, 503 — retry immediately
  | 'rate_limit'           // 429 / compute unit exhaustion — retry with back-off
  | 'insufficient_funds'   // relayer balance too low — no retry, needs top-up
  | 'nonce_conflict'       // nonce mismatch — retry after resync
  | 'gas_error'            // gas estimation failed or gas price spike
  | 'horizon_timeout'      // Stellar 504 — ambiguous, do not retry immediately
  | 'terminal'             // invalid params, contract revert, bad address
  | 'unknown';             // unclassified — retry up to limit

// ---------------------------------------------------------------------------
// Settlement directions / actions
// ---------------------------------------------------------------------------

export type SettlementAction =
  | 'eth_send'             // relayer sending ETH to user (XLM→ETH leg)
  | 'xlm_refund'           // relayer sending XLM back on failure
  | 'xlm_release'          // relayer releasing XLM to user (ETH→XLM leg)
  | 'eth_escrow_claim';    // relayer claiming ETH escrow on Ethereum

// ---------------------------------------------------------------------------
// Settlement entry state machine
// ---------------------------------------------------------------------------

export type SettlementEntryPhase =
  | 'pending'              // created, first attempt not yet made
  | 'retrying'             // failed at least once, scheduled for retry
  | 'succeeded'            // action completed successfully
  | 'failed_terminal'      // terminal failure — manual intervention needed
  | 'failed_ambiguous';    // outcome unknown (timeout) — watchdog resolving

export interface SettlementAttempt {
  /** Attempt number (1-indexed). */
  attemptNumber: number;
  /** Unix seconds when this attempt started. */
  startedAt: number;
  /** Unix seconds when this attempt completed (undefined if in-flight). */
  completedAt?: number;
  /** Whether this attempt succeeded. */
  succeeded: boolean;
  /** Failure category, if failed. */
  failureCategory?: SettlementFailureCategory;
  /** Raw error message (sanitized — no keys/secrets). */
  errorMessage?: string;
  /** Transaction hash if a tx was broadcast. */
  txHash?: string;
}

export interface SettlementFailureEntry {
  /** Order ID this settlement belongs to. */
  orderId: string;
  /** Which side of the settlement this tracks. */
  action: SettlementAction;
  /** Current lifecycle phase. */
  phase: SettlementEntryPhase;
  /** Ordered history of all attempts. */
  attempts: SettlementAttempt[];
  /** Unix seconds of the last attempt, for back-off calculations. */
  lastAttemptAt: number;
  /** Unix seconds after which the next retry is allowed. */
  retryAfter: number;
  /** Total retry count across all attempts. */
  retryCount: number;
  /** Winning transaction hash once succeeded. */
  successTxHash?: string;
  /** Unix seconds when settlement succeeded. */
  succeededAt?: number;
  /** Unix seconds when entry was first created. */
  createdAt: number;
  /** Free-form metadata (e.g. ETH amount, stellar address). */
  metadata: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Retry policy per failure category
// ---------------------------------------------------------------------------

export interface SettlementRetryPolicy {
  /** Should this category be retried at all? */
  retryable: boolean;
  /** Maximum retry attempts for this category. */
  maxRetries: number;
  /** Base delay in ms before first retry. */
  baseDelayMs: number;
  /** Maximum delay cap in ms. */
  maxDelayMs: number;
}

const RETRY_POLICIES: Record<SettlementFailureCategory, SettlementRetryPolicy> = {
  transient_rpc:      { retryable: true,  maxRetries: 5, baseDelayMs: 2_000,  maxDelayMs: 60_000  },
  rate_limit:         { retryable: true,  maxRetries: 5, baseDelayMs: 5_000,  maxDelayMs: 120_000 },
  nonce_conflict:     { retryable: true,  maxRetries: 3, baseDelayMs: 3_000,  maxDelayMs: 30_000  },
  gas_error:          { retryable: true,  maxRetries: 3, baseDelayMs: 5_000,  maxDelayMs: 60_000  },
  horizon_timeout:    { retryable: true,  maxRetries: 3, baseDelayMs: 30_000, maxDelayMs: 300_000 },
  unknown:            { retryable: true,  maxRetries: 3, baseDelayMs: 5_000,  maxDelayMs: 60_000  },
  insufficient_funds: { retryable: false, maxRetries: 0, baseDelayMs: 0,      maxDelayMs: 0       },
  terminal:           { retryable: false, maxRetries: 0, baseDelayMs: 0,      maxDelayMs: 0       },
};

// ---------------------------------------------------------------------------
// Error classifier
// ---------------------------------------------------------------------------

/**
 * Classify a raw error into a SettlementFailureCategory so the right
 * retry policy applies. Inspects error message, code, and HTTP status.
 */
export function classifySettlementError(err: unknown): SettlementFailureCategory {
  const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
  const code = (err as any)?.code;
  const httpStatus = (err as any)?.response?.status ?? (err as any)?.status;

  // Insufficient relayer balance
  if (message.includes('insufficient funds') || message.includes('insufficient relayer balance')) {
    return 'insufficient_funds';
  }

  // Rate limiting
  if (
    code === 429 ||
    httpStatus === 429 ||
    message.includes('exceeded') ||
    message.includes('compute units') ||
    message.includes('rate limit') ||
    message.includes('rate-limit') ||
    (err as any)?.error?.code === 429
  ) {
    return 'rate_limit';
  }

  // Nonce issues
  if (
    message.includes('nonce too low') ||
    message.includes('nonce too high') ||
    message.includes('replacement transaction underpriced') ||
    code === 'NONCE_EXPIRED'
  ) {
    return 'nonce_conflict';
  }

  // Gas issues
  if (
    message.includes('gas') ||
    message.includes('fee cap') ||
    message.includes('basefee') ||
    code === 'UNPREDICTABLE_GAS_LIMIT' ||
    code === 'INSUFFICIENT_FUNDS_FOR_GAS'
  ) {
    return 'gas_error';
  }

  // Horizon timeout / ambiguous
  if (
    (err as any)?.isTimeout ||
    (err as any)?.name === 'HorizonTimeoutError' ||
    httpStatus === 504 ||
    httpStatus === 408 ||
    message.includes('horizon timeout')
  ) {
    return 'horizon_timeout';
  }

  // Network-level transient errors
  if (
    message.includes('timeout') ||
    message.includes('etimedout') ||
    message.includes('econnreset') ||
    message.includes('socket hang up') ||
    message.includes('econnrefused') ||
    message.includes('network error') ||
    httpStatus === 503 ||
    httpStatus === 502 ||
    httpStatus === 500 ||
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNREFUSED' ||
    code === 'SERVER_ERROR'
  ) {
    return 'transient_rpc';
  }

  // Terminal errors — no point retrying
  if (
    message.includes('invalid address') ||
    message.includes('execution reverted') ||
    message.includes('invalid argument') ||
    message.includes('revert') ||
    code === 'INVALID_ARGUMENT' ||
    code === 'ACTION_REJECTED'
  ) {
    return 'terminal';
  }

  return 'unknown';
}

// ---------------------------------------------------------------------------
// Retry delay calculation
// ---------------------------------------------------------------------------

/**
 * Compute the next retry delay in ms with exponential back-off and
 * ±20% jitter to prevent thundering-herd.
 */
export function computeRetryDelay(
  category: SettlementFailureCategory,
  retryCount: number,
): number {
  const policy = RETRY_POLICIES[category];
  if (!policy.retryable) return 0;

  const exponential = Math.min(
    policy.maxDelayMs,
    policy.baseDelayMs * Math.pow(2, retryCount),
  );
  const jitter = 0.2 * exponential * (Math.random() - 0.5);
  return Math.max(0, Math.round(exponential + jitter));
}

// ---------------------------------------------------------------------------
// SettlementFailureLedger
// ---------------------------------------------------------------------------

export class SettlementFailureLedger {
  private readonly entries = new Map<string, SettlementFailureEntry>();

  // ── Entry key ────────────────────────────────────────────────────────────

  private key(orderId: string, action: SettlementAction): string {
    return `${orderId}::${action}`;
  }

  // ── Public API ───────────────────────────────────────────────────────────

  /**
   * Register a new settlement action for tracking.
   * Idempotent — if an entry already exists for this orderId+action, the
   * existing entry is returned unchanged (prevents double-registration on
   * retried requests).
   */
  register(
    orderId: string,
    action: SettlementAction,
    metadata: Record<string, unknown> = {},
  ): SettlementFailureEntry {
    const k = this.key(orderId, action);
    const existing = this.entries.get(k);
    if (existing) return existing;

    const entry: SettlementFailureEntry = {
      orderId,
      action,
      phase: 'pending',
      attempts: [],
      lastAttemptAt: 0,
      retryAfter: 0,
      retryCount: 0,
      createdAt: getCurrentTimestamp(),
      metadata,
    };
    this.entries.set(k, entry);
    return entry;
  }

  /**
   * Record a successful settlement attempt. Transitions phase to
   * `succeeded` and seals the entry.
   */
  recordSuccess(
    orderId: string,
    action: SettlementAction,
    txHash: string,
  ): void {
    const k = this.key(orderId, action);
    const entry = this.entries.get(k);
    if (!entry) return;

    const now = getCurrentTimestamp();
    const lastAttempt = entry.attempts[entry.attempts.length - 1];
    if (lastAttempt && !lastAttempt.completedAt) {
      lastAttempt.completedAt = now;
      lastAttempt.succeeded = true;
      lastAttempt.txHash = txHash;
    } else {
      // Called without a prior open attempt (e.g. success on first try without
      // a matching recordAttemptStart call). Record a synthetic attempt.
      entry.attempts.push({
        attemptNumber: entry.attempts.length + 1,
        startedAt: now,
        completedAt: now,
        succeeded: true,
        txHash,
      });
    }

    entry.phase = 'succeeded';
    entry.successTxHash = txHash;
    entry.succeededAt = now;
  }

  /**
   * Record the start of a settlement attempt. Should be called just before
   * the actual RPC call so we can track in-flight attempts.
   */
  recordAttemptStart(orderId: string, action: SettlementAction): void {
    const k = this.key(orderId, action);
    let entry = this.entries.get(k);
    if (!entry) {
      // Auto-register if caller skipped register()
      entry = this.register(orderId, action);
    }

    const now = getCurrentTimestamp();
    entry.attempts.push({
      attemptNumber: entry.attempts.length + 1,
      startedAt: now,
      succeeded: false,
    });
    entry.lastAttemptAt = now;
    entry.phase = 'retrying';
  }

  /**
   * Record a failed settlement attempt and compute when the next retry is
   * permitted based on the failure category.
   *
   * Returns the updated entry so callers can inspect `phase` and
   * `retryAfter` without a separate `getEntry` call.
   */
  recordFailure(
    orderId: string,
    action: SettlementAction,
    err: unknown,
    overrideCategory?: SettlementFailureCategory,
  ): SettlementFailureEntry {
    const k = this.key(orderId, action);
    let entry = this.entries.get(k);
    if (!entry) {
      entry = this.register(orderId, action);
    }

    const category = overrideCategory ?? classifySettlementError(err);
    const policy = RETRY_POLICIES[category];
    const now = getCurrentTimestamp();
    const errorMessage = err instanceof Error ? err.message : String(err);

    // Close the last open attempt
    const lastAttempt = entry.attempts[entry.attempts.length - 1];
    if (lastAttempt && !lastAttempt.completedAt) {
      lastAttempt.completedAt = now;
      lastAttempt.succeeded = false;
      lastAttempt.failureCategory = category;
      lastAttempt.errorMessage = errorMessage;
    } else {
      // recordAttemptStart was skipped — synthesize the attempt
      entry.attempts.push({
        attemptNumber: entry.attempts.length + 1,
        startedAt: now,
        completedAt: now,
        succeeded: false,
        failureCategory: category,
        errorMessage,
      });
    }

    entry.retryCount++;
    entry.lastAttemptAt = now;

    // Determine new phase
    if (category === 'horizon_timeout') {
      entry.phase = 'failed_ambiguous';
    } else if (!policy.retryable || entry.retryCount >= policy.maxRetries) {
      entry.phase = 'failed_terminal';
    } else {
      entry.phase = 'retrying';
      const delayMs = computeRetryDelay(category, entry.retryCount - 1);
      // retryAfter in seconds (getCurrentTimestamp returns unix seconds)
      entry.retryAfter = now + Math.ceil(delayMs / 1000);
    }

    return entry;
  }

  /**
   * Mark an ambiguous entry as confirmed succeeded (watchdog resolved it).
   */
  resolveAmbiguous(
    orderId: string,
    action: SettlementAction,
    txHash: string,
  ): void {
    const k = this.key(orderId, action);
    const entry = this.entries.get(k);
    if (!entry || entry.phase !== 'failed_ambiguous') return;
    this.recordSuccess(orderId, action, txHash);
  }

  /**
   * Re-open a `failed_ambiguous` entry for retry (watchdog confirmed the
   * tx did NOT land).
   */
  releaseAmbiguous(orderId: string, action: SettlementAction): void {
    const k = this.key(orderId, action);
    const entry = this.entries.get(k);
    if (!entry || entry.phase !== 'failed_ambiguous') return;

    const policy = RETRY_POLICIES['horizon_timeout'];
    if (entry.retryCount < policy.maxRetries) {
      const delayMs = computeRetryDelay('horizon_timeout', entry.retryCount);
      entry.retryAfter = getCurrentTimestamp() + Math.ceil(delayMs / 1000);
      entry.phase = 'retrying';
    } else {
      entry.phase = 'failed_terminal';
    }
  }

  /**
   * Check whether a given entry is due for retry (phase is `retrying` and
   * the back-off window has passed).
   */
  isDueForRetry(orderId: string, action: SettlementAction): boolean {
    const entry = this.entries.get(this.key(orderId, action));
    if (!entry) return false;
    if (entry.phase !== 'retrying') return false;
    return getCurrentTimestamp() >= entry.retryAfter;
  }

  /**
   * Check whether a retry is allowed based on the last failure category
   * and retry count (without advancing state).
   */
  canRetry(orderId: string, action: SettlementAction): boolean {
    const entry = this.entries.get(this.key(orderId, action));
    if (!entry) return false;
    if (entry.phase === 'succeeded' || entry.phase === 'failed_terminal') return false;
    const lastCategory = this.lastFailureCategory(entry);
    if (!lastCategory) return true; // never failed
    const policy = RETRY_POLICIES[lastCategory];
    return policy.retryable && entry.retryCount < policy.maxRetries;
  }

  // ── Queries ───────────────────────────────────────────────────────────────

  getEntry(orderId: string, action: SettlementAction): SettlementFailureEntry | undefined {
    return this.entries.get(this.key(orderId, action));
  }

  /**
   * All entries that are awaiting a retry and whose back-off has expired.
   */
  dueForRetry(): SettlementFailureEntry[] {
    const now = getCurrentTimestamp();
    return Array.from(this.entries.values()).filter(
      (e) => e.phase === 'retrying' && now >= e.retryAfter,
    );
  }

  /**
   * All entries that require manual intervention (terminal or ambiguous
   * beyond retry budget).
   */
  needsManualIntervention(): SettlementFailureEntry[] {
    return Array.from(this.entries.values()).filter(
      (e) =>
        e.phase === 'failed_terminal' ||
        (e.phase === 'failed_ambiguous' &&
          e.retryCount >= RETRY_POLICIES['horizon_timeout'].maxRetries),
    );
  }

  /** Full snapshot for health/debug endpoints. */
  snapshot(): SettlementFailureEntry[] {
    return Array.from(this.entries.values());
  }

  /** Aggregate counts by phase — for Prometheus gauges. */
  stats(): Record<SettlementEntryPhase, number> {
    const counts: Record<SettlementEntryPhase, number> = {
      pending: 0,
      retrying: 0,
      succeeded: 0,
      failed_terminal: 0,
      failed_ambiguous: 0,
    };
    for (const { phase } of this.entries.values()) {
      counts[phase]++;
    }
    return counts;
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private lastFailureCategory(
    entry: SettlementFailureEntry,
  ): SettlementFailureCategory | undefined {
    for (let i = entry.attempts.length - 1; i >= 0; i--) {
      if (entry.attempts[i].failureCategory) {
        return entry.attempts[i].failureCategory;
      }
    }
    return undefined;
  }
}

/**
 * Process-wide singleton. Import wherever settlement is initiated.
 * Tests should create a fresh instance per suite for isolation.
 */
export const globalSettlementLedger = new SettlementFailureLedger();
