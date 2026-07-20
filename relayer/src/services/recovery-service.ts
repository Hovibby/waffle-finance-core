/**
 * @fileoverview Recovery Service for Ethereum–Stellar Bridge
 *
 * Handles settlement failure recovery through:
 *
 *  1. **Retry scanning** — a background loop that runs every `scanIntervalMs`
 *     and picks up all settlement entries in the `retrying` phase whose
 *     back-off window has expired, then re-executes them via the caller-
 *     supplied retry callback.
 *
 *  2. **Manual recovery** — operator-triggered recovery for a specific order
 *     (used through the admin REST API).
 *
 *  3. **Timelock monitoring** — watches orders approaching their deadline and
 *     initiates timeout refunds.
 *
 *  4. **Metrics** — every outcome is recorded in Prometheus so operators can
 *     alert on stalled recovery and build dashboards.
 *
 * ## Key design decisions
 *
 *  - The service owns the retry loop but delegates the actual on-chain calls
 *    to injected callbacks (`RetryExecutors`). This keeps the service
 *    testable without network mocks at the service level.
 *
 *  - All state is kept in a `SettlementFailureLedger` that can be swapped for
 *    a durable store. The recovery service does not maintain its own state.
 *
 *  - Failures never crash the scan loop — per-order errors are caught and
 *    recorded; subsequent orders continue processing.
 *
 *  - The `KeyedMutex` ensures at most one recovery attempt runs per order at
 *    a time, even if the scan loop fires while a prior retry is still pending.
 */

import { EventEmitter } from 'events';
import { KeyedMutex, Deduplicator } from '../utils/concurrency.js';
import { getCurrentTimestamp } from './utils.js';
import {
  SettlementFailureLedger,
  SettlementFailureEntry,
  SettlementAction,
  SettlementFailureCategory,
  classifySettlementError,
  globalSettlementLedger,
} from './settlement-failure-ledger.js';
import { sanitizeForLog } from '../utils/sanitize-for-log.js';
import {
  settlementRetriesTotal,
  settlementRecoverySuccessTotal,
  settlementTerminalFailuresTotal,
  settlementAmbiguousTotal,
  settlementLedgerPhaseGauge,
  settlementDueForRetryGauge,
  settlementNeedsInterventionGauge,
  settlementRetryTickDurationSeconds,
  settlementRetryLastRunTimestamp,
} from '../metrics.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Callback the recovery service invokes when it retries a settlement action.
 * Must return the winning transaction hash on success, or throw on failure.
 *
 * The callback is responsible for the actual on-chain call. The recovery
 * service handles state tracking, retries, and metrics around it.
 */
export type RetryExecutor = (entry: SettlementFailureEntry) => Promise<string>;

/**
 * Map of executors by settlement action. The recovery service will use
 * the matching executor for each entry.
 */
export type RetryExecutors = Partial<Record<SettlementAction, RetryExecutor>>;

export interface RecoveryServiceConfig {
  /**
   * How often to scan for entries due for retry, in ms.
   * Default: 30_000 (30 seconds).
   */
  scanIntervalMs?: number;
  /**
   * How often to check timelocks, in ms.
   * Default: 60_000 (1 minute).
   */
  timelockIntervalMs?: number;
  /**
   * Seconds after timelock expiry before initiating a timeout refund.
   * Default: 120 (2 minutes grace period).
   */
  gracePeriodSeconds?: number;
  /**
   * Settlement failure ledger to read entries from.
   * Default: the process-wide singleton.
   */
  ledger?: SettlementFailureLedger;
  /**
   * Callback map for retrying different settlement actions.
   * If not provided for an action, the recovery service will log a
   * warning but will not throw.
   */
  executors?: RetryExecutors;
}

export interface RecoveryStats {
  totalRetries: number;
  successfulRecoveries: number;
  terminalFailures: number;
  ambiguousEntries: number;
  lastScanAt: number;
}

// ---------------------------------------------------------------------------
// RecoveryService
// ---------------------------------------------------------------------------

export class RecoveryService extends EventEmitter {
  private readonly ledger: SettlementFailureLedger;
  private readonly executors: RetryExecutors;
  private readonly config: Required<Omit<RecoveryServiceConfig, 'ledger' | 'executors'>>;

  private scanInterval: NodeJS.Timeout | null = null;
  private timelockInterval: NodeJS.Timeout | null = null;
  private readonly mutex = new KeyedMutex();
  private readonly deduplicator = new Deduplicator();

  private stats: RecoveryStats = {
    totalRetries: 0,
    successfulRecoveries: 0,
    terminalFailures: 0,
    ambiguousEntries: 0,
    lastScanAt: 0,
  };

  constructor(config: RecoveryServiceConfig = {}) {
    super();
    this.ledger = config.ledger ?? globalSettlementLedger;
    this.executors = config.executors ?? {};
    this.config = {
      scanIntervalMs: config.scanIntervalMs ?? 30_000,
      timelockIntervalMs: config.timelockIntervalMs ?? 60_000,
      gracePeriodSeconds: config.gracePeriodSeconds ?? 120,
    };
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Start the background scan loop and timelock monitor.
   * Idempotent — calling start() when already running is a no-op.
   */
  start(): void {
    if (this.scanInterval) return; // already running

    console.log(
      `[recovery-service] starting ` +
      `· retry scan every ${this.config.scanIntervalMs / 1000}s ` +
      `· timelock check every ${this.config.timelockIntervalMs / 1000}s`
    );

    // Warm-up: first scan after 5s so the relayer is fully booted
    const warmup = setTimeout(() => void this.runRetryScan(), 5_000);
    // Prevent the warmup timer from blocking process exit
    if (warmup.unref) warmup.unref();

    this.scanInterval = setInterval(
      () => void this.runRetryScan(),
      this.config.scanIntervalMs,
    );

    this.timelockInterval = setInterval(
      () => void this.checkTimelocks(),
      this.config.timelockIntervalMs,
    );
  }

  /** Stop background loops and release resources. */
  stop(): void {
    if (this.scanInterval) {
      clearInterval(this.scanInterval);
      this.scanInterval = null;
    }
    if (this.timelockInterval) {
      clearInterval(this.timelockInterval);
      this.timelockInterval = null;
    }
    this.removeAllListeners();
    console.log('[recovery-service] stopped');
  }

  // ── Retry scan ────────────────────────────────────────────────────────────

  /**
   * Scan for entries due for retry and attempt recovery.
   * Exported for direct invocation in tests.
   */
  async runRetryScan(): Promise<void> {
    const tickEnd = settlementRetryTickDurationSeconds.startTimer();
    const now = getCurrentTimestamp();

    try {
      const due = this.ledger.dueForRetry();
      const needs = this.ledger.needsManualIntervention();

      // Update gauges before processing so they reflect current state
      this.refreshGauges();

      settlementDueForRetryGauge.set(due.length);
      settlementNeedsInterventionGauge.set(needs.length);

      for (const entry of due) {
        // Deduplicator: if a prior retry is still running for this
        // order+action, skip — don't stack up concurrent attempts.
        const mutexKey = `${entry.orderId}::${entry.action}`;
        void this.deduplicator.run(mutexKey, () => this.retryEntry(entry));
      }

      // Emit terminal failures as events so callers can alert
      for (const entry of needs) {
        this.emit('intervention_needed', entry);
      }

      this.stats.lastScanAt = now;
    } catch (err: unknown) {
      const safe = sanitizeForLog(err);
      console.error(
        '[recovery-service] scan error:',
        safe instanceof Error ? safe.message : safe
      );
    } finally {
      tickEnd();
      settlementRetryLastRunTimestamp.set(Math.floor(Date.now() / 1000));
    }
  }

  // ── Individual entry retry ────────────────────────────────────────────────

  private async retryEntry(entry: SettlementFailureEntry): Promise<void> {
    const { orderId, action } = entry;
    const executor = this.executors[action];

    if (!executor) {
      console.warn(
        `[recovery-service] orderId=${orderId} action=${action} ` +
        `no executor registered — cannot retry automatically`
      );
      this.emit('no_executor', entry);
      return;
    }

    settlementRetriesTotal.inc({ action, category: this.lastCategory(entry) });
    this.stats.totalRetries++;

    this.ledger.recordAttemptStart(orderId, action);
    console.log(
      `[recovery-service] 🔄 orderId=${orderId} action=${action} ` +
      `retry #${entry.retryCount + 1}`
    );

    try {
      const txHash = await executor(entry);

      this.ledger.recordSuccess(orderId, action, txHash);
      settlementRecoverySuccessTotal.inc({ action });
      this.stats.successfulRecoveries++;

      console.log(
        `[recovery-service] ✅ orderId=${orderId} action=${action} ` +
        `recovered (tx=${txHash})`
      );
      this.emit('recovered', { entry, txHash });
    } catch (err: unknown) {
      const category = classifySettlementError(err);
      const updated = this.ledger.recordFailure(orderId, action, err, category);
      const safe = sanitizeForLog(err);

      if (updated.phase === 'failed_terminal') {
        settlementTerminalFailuresTotal.inc({ action, category });
        this.stats.terminalFailures++;
        console.error(
          `[recovery-service] ❌ orderId=${orderId} action=${action} ` +
          `terminal failure (category=${category}): ` +
          (safe instanceof Error ? safe.message : String(safe))
        );
        this.emit('terminal_failure', { entry: updated, category, error: safe });
      } else if (updated.phase === 'failed_ambiguous') {
        settlementAmbiguousTotal.inc({ action });
        this.stats.ambiguousEntries++;
        console.warn(
          `[recovery-service] ⚠️  orderId=${orderId} action=${action} ` +
          `ambiguous outcome — will re-check next scan`
        );
        this.emit('ambiguous', { entry: updated, category, error: safe });
      } else {
        // Still retrying — will be picked up on next scan
        console.warn(
          `[recovery-service] ⚠️  orderId=${orderId} action=${action} ` +
          `retry #${updated.retryCount} failed (category=${category}), ` +
          `next retry after ${new Date(updated.retryAfter * 1000).toISOString()}: ` +
          (safe instanceof Error ? safe.message : String(safe))
        );
        this.emit('retry_failed', { entry: updated, category, error: safe });
      }
    }
  }

  // ── Timelock monitoring ───────────────────────────────────────────────────

  /**
   * Scan for orders whose timelock has expired and initiate timeout refunds.
   * Orders are supplied via the `getExpiringOrders` callback (injected at
   * call sites so the service does not depend on the in-memory order map
   * directly — keeping it testable).
   */
  async checkTimelocks(
    getExpiringOrders?: () => Array<{ orderId: string; deadline: number; metadata?: Record<string, unknown> }>,
  ): Promise<void> {
    if (!getExpiringOrders) return;

    const now = getCurrentTimestamp();
    const grace = this.config.gracePeriodSeconds;

    let expiredCount = 0;
    for (const order of getExpiringOrders()) {
      if (now <= order.deadline + grace) continue;

      expiredCount++;
      const mutexKey = `${order.orderId}::timelock`;

      void this.deduplicator.run(mutexKey, async () => {
        const executor = this.executors['xlm_refund'];
        if (!executor) {
          console.warn(
            `[recovery-service] orderId=${order.orderId} ` +
            `timelock expired but no xlm_refund executor registered`
          );
          return;
        }

        const entry = this.ledger.register(
          order.orderId,
          'xlm_refund',
          { reason: 'timelock_expired', deadline: order.deadline, ...order.metadata },
        );

        console.log(
          `[recovery-service] ⏰ orderId=${order.orderId} ` +
          `timelock expired at ${order.deadline} (grace=${grace}s) — initiating refund`
        );

        this.ledger.recordAttemptStart(order.orderId, 'xlm_refund');
        try {
          const txHash = await executor(entry);
          this.ledger.recordSuccess(order.orderId, 'xlm_refund', txHash);
          settlementRecoverySuccessTotal.inc({ action: 'xlm_refund' });
          console.log(`[recovery-service] ✅ orderId=${order.orderId} timeout refund (tx=${txHash})`);
          this.emit('timeout_refund_success', { orderId: order.orderId, txHash });
        } catch (err: unknown) {
          const updated = this.ledger.recordFailure(order.orderId, 'xlm_refund', err);
          const safe = sanitizeForLog(err);
          console.error(
            `[recovery-service] ❌ orderId=${order.orderId} timeout refund failed:`,
            safe instanceof Error ? safe.message : safe
          );
          this.emit('timeout_refund_failed', { orderId: order.orderId, entry: updated, error: safe });
        }
      });
    }

    if (expiredCount > 0) {
      console.log(`[recovery-service] ⏰ ${expiredCount} expired orders processed`);
    }
  }

  // ── Manual recovery ───────────────────────────────────────────────────────

  /**
   * Trigger an immediate recovery for a specific order + action.
   * Useful for operator-driven retries via the admin API.
   *
   * Returns the winning txHash on success, or throws on failure.
   */
  async manualRecover(
    orderId: string,
    action: SettlementAction,
    metadata: Record<string, unknown> = {},
  ): Promise<string> {
    const mutexKey = `${orderId}::${action}`;

    return this.mutex.runExclusive(mutexKey, async () => {
      const executor = this.executors[action];
      if (!executor) {
        throw new Error(
          `[recovery-service] No executor registered for action=${action}. ` +
          `Register one via RecoveryServiceConfig.executors.`
        );
      }

      let entry = this.ledger.getEntry(orderId, action);
      if (!entry) {
        entry = this.ledger.register(orderId, action, { ...metadata, manualRecovery: true });
      }

      settlementRetriesTotal.inc({ action, category: this.lastCategory(entry) });
      this.stats.totalRetries++;
      this.ledger.recordAttemptStart(orderId, action);

      console.log(
        `[recovery-service] 🔧 manual recovery orderId=${orderId} action=${action}`
      );

      try {
        const txHash = await executor(entry);
        this.ledger.recordSuccess(orderId, action, txHash);
        settlementRecoverySuccessTotal.inc({ action });
        this.stats.successfulRecoveries++;

        console.log(
          `[recovery-service] ✅ manual recovery succeeded orderId=${orderId} action=${action} tx=${txHash}`
        );
        this.emit('recovered', { entry, txHash });
        return txHash;
      } catch (err: unknown) {
        const category = classifySettlementError(err);
        const updated = this.ledger.recordFailure(orderId, action, err, category);
        const safe = sanitizeForLog(err);

        console.error(
          `[recovery-service] ❌ manual recovery failed orderId=${orderId} action=${action}:`,
          safe instanceof Error ? safe.message : safe
        );
        this.emit('retry_failed', { entry: updated, category, error: safe });
        throw err;
      }
    });
  }

  // ── Status queries ────────────────────────────────────────────────────────

  getStats(): RecoveryStats {
    return { ...this.stats };
  }

  getLedgerStats() {
    return this.ledger.stats();
  }

  getFailedEntries(): SettlementFailureEntry[] {
    return this.ledger.needsManualIntervention();
  }

  getDueForRetry(): SettlementFailureEntry[] {
    return this.ledger.dueForRetry();
  }

  getEntry(orderId: string, action: SettlementAction): SettlementFailureEntry | undefined {
    return this.ledger.getEntry(orderId, action);
  }

  /**
   * Full snapshot of all settlement ledger entries. Used by the
   * /api/recovery/status admin endpoint.
   */
  snapshot(): SettlementFailureEntry[] {
    return this.ledger.snapshot();
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private refreshGauges(): void {
    const counts = this.ledger.stats();
    for (const [phase, count] of Object.entries(counts)) {
      settlementLedgerPhaseGauge.labels(phase).set(count);
    }
  }

  private lastCategory(entry: SettlementFailureEntry): SettlementFailureCategory | string {
    for (let i = entry.attempts.length - 1; i >= 0; i--) {
      const c = entry.attempts[i].failureCategory;
      if (c) return c;
    }
    return 'unknown';
  }
}

// ---------------------------------------------------------------------------
// Process-wide singleton
// ---------------------------------------------------------------------------

/**
 * Default singleton. Callers that need a custom ledger or executor set
 * should construct a new RecoveryService instead.
 */
export const globalRecoveryService = new RecoveryService();

export default RecoveryService;
