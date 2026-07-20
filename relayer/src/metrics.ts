/**
 * Prometheus-compatible metrics for the WaffleFinance relayer.
 *
 * All metrics live in a dedicated registry (not the global default) so
 * tests can instantiate a clean registry per-run without cross-
 * contamination, and so the relayer can be embedded in other processes
 * without polluting their default metrics.
 *
 * Metric naming follows the Prometheus convention:
 *   <namespace>_<subsystem>_<name>_<unit>
 *
 * Security note: no metric label carries order-level data (addresses,
 * amounts, hashlocks). Labels are limited to reason codes and status
 * strings so the /metrics endpoint is safe to expose internally.
 */

import {
  Registry,
  Counter,
  Gauge,
  Histogram,
  collectDefaultMetrics,
} from 'prom-client';

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Shared registry for all relayer metrics. Export it so the /metrics
 * HTTP handler can call `registry.metrics()`.
 */
export const registry = new Registry();

// Attach Node.js process metrics (heap, GC, event loop lag, etc.) to our
// registry rather than the global default. Pass `register: registry` so
// they are scoped to this relayer instance.
collectDefaultMetrics({ register: registry });

// ---------------------------------------------------------------------------
// Refund Watchdog counters
// ---------------------------------------------------------------------------

/**
 * Total number of watchdog tick executions that completed without an
 * unhandled error ΓÇö i.e. the scan loop ran to completion regardless of
 * whether any individual order refund inside the tick succeeded or failed.
 */
export const watchdogRunsTotal = new Counter({
  name: 'relayer_refund_watchdog_runs_total',
  help: 'Total number of refund watchdog scan ticks executed',
  registers: [registry],
});

/**
 * Total number of individual order refunds that succeeded (Stellar tx
 * submitted and confirmed hash returned).
 */
export const watchdogRefundSuccessTotal = new Counter({
  name: 'relayer_refund_watchdog_success_total',
  help: 'Total number of XLM refunds successfully submitted by the watchdog',
  labelNames: ['network_mode'] as const,
  registers: [registry],
});

/**
 * Total number of individual order refunds that failed. The `reason`
 * label holds a short, sanitised error category (not the raw error
 * message) to keep the cardinality of label combinations bounded.
 *
 * Defined reason values:
 *   missing_address  ΓÇö order has no stellarAddress
 *   refund_error     ΓÇö refundXlmToUser threw
 */
export const watchdogRefundFailureTotal = new Counter({
  name: 'relayer_refund_watchdog_failure_total',
  help: 'Total number of XLM refund attempts that failed in the watchdog',
  labelNames: ['reason', 'network_mode'] as const,
  registers: [registry],
});

/**
 * Total number of stale orders detected (age >= staleAfterMs) during
 * any tick, regardless of whether refund was attempted or skipped
 * (e.g. due to back-off).
 */
export const watchdogStaleOrdersDetected = new Counter({
  name: 'relayer_refund_watchdog_stale_orders_detected_total',
  help: 'Total number of stale orders identified by the refund watchdog',
  registers: [registry],
});

/**
 * Total number of orders skipped during a tick because they were still
 * within the 10-minute back-off window after a previous failure.
 */
export const watchdogBackoffSkipsTotal = new Counter({
  name: 'relayer_refund_watchdog_backoff_skips_total',
  help: 'Total number of stale orders skipped due to post-failure back-off',
  registers: [registry],
});

// ---------------------------------------------------------------------------
// Refund Watchdog gauges
// ---------------------------------------------------------------------------

/**
 * Unix timestamp (seconds) of the last successful watchdog tick.
 * Stays at 0 until the first tick completes. An alert rule can fire
 * when `time() - relayer_refund_watchdog_last_run_timestamp_seconds > 2 * interval`.
 */
export const watchdogLastRunTimestamp = new Gauge({
  name: 'relayer_refund_watchdog_last_run_timestamp_seconds',
  help: 'Unix timestamp of the last completed refund watchdog scan tick',
  registers: [registry],
});

/**
 * Age in seconds of the oldest stale order found in the last tick.
 * Useful for alert rules: if this keeps climbing, refunds are not landing.
 * Resets to 0 when no stale orders are found.
 */
export const watchdogMaxStaleAgeSeconds = new Gauge({
  name: 'relayer_refund_watchdog_max_stale_age_seconds',
  help: 'Age in seconds of the oldest stale order seen in the last watchdog tick',
  registers: [registry],
});

/**
 * Current number of orders in the active map that are in a stale/pending
 * refund state. Sampled at each tick.
 */
export const watchdogPendingRefundsGauge = new Gauge({
  name: 'relayer_refund_watchdog_pending_refunds',
  help: 'Number of orders currently awaiting a watchdog refund attempt',
  registers: [registry],
});

// ---------------------------------------------------------------------------
// Refund Watchdog histogram
// ---------------------------------------------------------------------------

/**
 * Duration in seconds of each full watchdog tick (scanning all active
 * orders). Lets you spot ticks that are unusually slow.
 */
export const watchdogTickDurationSeconds = new Histogram({
  name: 'relayer_refund_watchdog_tick_duration_seconds',
  help: 'Duration of a full refund watchdog tick in seconds',
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10],
  registers: [registry],
});

// ---------------------------------------------------------------------------
// Solana configuration
// ---------------------------------------------------------------------------

/**
 * Set to 1 when SOLANA_HTLC_PROGRAM is a placeholder (Solana flows
 * disabled), or 0 when a real program address is configured.
 * Useful for alerting operators that Solana support is inactive.
 */
export const solanaPlaceholderMode = new Gauge({
  name: 'relayer_solana_placeholder_mode',
  help: '1 when SOLANA_HTLC_PROGRAM is a placeholder and Solana flows are disabled, 0 when configured',
  registers: [registry],
});

// ---------------------------------------------------------------------------
// XLM refund service counters
// ---------------------------------------------------------------------------

/**
 * Total refund submissions suppressed because the RefundLedger already
 * holds a committed or in-flight entry for that orderId. This is the
 * primary signal for exactly-once compliance.
 */
export const refundDuplicatesSuppressed = new Counter({
  name: 'relayer_xlm_refund_duplicates_suppressed_total',
  help: 'Total XLM refund attempts suppressed by the RefundLedger idempotency guard',
  labelNames: ['network_mode'] as const,
  registers: [registry],
});

/**
 * Total Horizon submit calls that returned a 504, 408, or network-level
 * timeout. These are *ambiguous* — the tx may have landed. Callers should
 * mark the order ambiguous in the RefundLedger and not retry immediately.
 */
export const refundHorizonTimeouts = new Counter({
  name: 'relayer_xlm_refund_horizon_timeouts_total',
  help: 'Total Horizon submit calls that returned a timeout or 504 (ambiguous outcome)',
  labelNames: ['network_mode'] as const,
  registers: [registry],
});

/**
 * Total intra-call retries performed for transient (non-terminal, non-timeout)
 * Horizon errors inside refundXlmToUser. One unit = one retry attempt, not
 * one overall refund invocation.
 */
export const refundHorizonRetries = new Counter({
  name: 'relayer_xlm_refund_horizon_retries_total',
  help: 'Total transient-error retries inside refundXlmToUser',
  labelNames: ['network_mode'] as const,
  registers: [registry],
});

// ---------------------------------------------------------------------------
// Settlement failure and recovery metrics
// ---------------------------------------------------------------------------

/**
 * Total number of settlement attempts that failed, labeled by:
 *   - `action`    : eth_send | xlm_refund | xlm_release | eth_escrow_claim
 *   - `category`  : transient_rpc | rate_limit | insufficient_funds |
 *                   nonce_conflict | gas_error | horizon_timeout | terminal | unknown
 */
export const settlementFailuresTotal = new Counter({
  name: 'relayer_settlement_failures_total',
  help: 'Total settlement attempts that failed, by action and failure category',
  labelNames: ['action', 'category'] as const,
  registers: [registry],
});

/**
 * Total number of settlement retries attempted after a recoverable failure.
 */
export const settlementRetriesTotal = new Counter({
  name: 'relayer_settlement_retries_total',
  help: 'Total settlement retry attempts triggered by the recovery service',
  labelNames: ['action', 'category'] as const,
  registers: [registry],
});

/**
 * Total number of settlement retries that succeeded after at least one failure.
 */
export const settlementRecoverySuccessTotal = new Counter({
  name: 'relayer_settlement_recovery_success_total',
  help: 'Total settlements recovered successfully after one or more failures',
  labelNames: ['action'] as const,
  registers: [registry],
});

/**
 * Total number of settlement failures that became terminal (no more retries).
 * These require manual operator intervention.
 */
export const settlementTerminalFailuresTotal = new Counter({
  name: 'relayer_settlement_terminal_failures_total',
  help: 'Total settlements that reached a terminal failed state requiring manual intervention',
  labelNames: ['action', 'category'] as const,
  registers: [registry],
});

/**
 * Total number of settlement outcomes that are ambiguous (Horizon/RPC
 * timeout — the tx may have landed). The watchdog will resolve these.
 */
export const settlementAmbiguousTotal = new Counter({
  name: 'relayer_settlement_ambiguous_total',
  help: 'Total settlement attempts with ambiguous outcomes (timeouts — tx may have landed)',
  labelNames: ['action'] as const,
  registers: [registry],
});

// ---------------------------------------------------------------------------
// Settlement failure ledger gauges (sampled by the recovery service)
// ---------------------------------------------------------------------------

/** Current number of settlement entries in each phase. */
export const settlementLedgerPhaseGauge = new Gauge({
  name: 'relayer_settlement_ledger_entries',
  help: 'Current number of settlement ledger entries by phase',
  labelNames: ['phase'] as const,
  registers: [registry],
});

/**
 * Current number of settlement entries awaiting a retry and due now
 * (back-off window expired).
 */
export const settlementDueForRetryGauge = new Gauge({
  name: 'relayer_settlement_due_for_retry',
  help: 'Number of failed settlements currently eligible for retry',
  registers: [registry],
});

/**
 * Current number of settlement entries that need manual intervention.
 */
export const settlementNeedsInterventionGauge = new Gauge({
  name: 'relayer_settlement_needs_intervention',
  help: 'Number of failed settlements requiring manual operator intervention',
  registers: [registry],
});

/**
 * Duration of settlement retry scan ticks (recovery service).
 */
export const settlementRetryTickDurationSeconds = new Histogram({
  name: 'relayer_settlement_retry_tick_duration_seconds',
  help: 'Duration of a full settlement retry scan tick in seconds',
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10],
  registers: [registry],
});

/**
 * Unix timestamp of the last recovery service tick.
 */
export const settlementRetryLastRunTimestamp = new Gauge({
  name: 'relayer_settlement_retry_last_run_timestamp_seconds',
  help: 'Unix timestamp of the last settlement retry scan tick',
  registers: [registry],
});

// ---------------------------------------------------------------------------
// Convenience re-export
// ---------------------------------------------------------------------------

/** All watchdog metrics in one object ΓÇö useful for test assertions. */
export const watchdogMetrics = {
  runsTotal: watchdogRunsTotal,
  successTotal: watchdogRefundSuccessTotal,
  failureTotal: watchdogRefundFailureTotal,
  staleDetected: watchdogStaleOrdersDetected,
  backoffSkips: watchdogBackoffSkipsTotal,
  lastRunTimestamp: watchdogLastRunTimestamp,
  maxStaleAge: watchdogMaxStaleAgeSeconds,
  pendingRefunds: watchdogPendingRefundsGauge,
  tickDuration: watchdogTickDurationSeconds,
} as const;

/** All XLM refund service metrics in one object — useful for test assertions. */
export const refundMetrics = {
  duplicatesSuppressed: refundDuplicatesSuppressed,
  horizonTimeouts: refundHorizonTimeouts,
  horizonRetries: refundHorizonRetries,
} as const;

/** All settlement failure / recovery metrics in one object — useful for test assertions. */
export const settlementMetrics = {
  failuresTotal: settlementFailuresTotal,
  retriesTotal: settlementRetriesTotal,
  recoverySuccessTotal: settlementRecoverySuccessTotal,
  terminalFailuresTotal: settlementTerminalFailuresTotal,
  ambiguousTotal: settlementAmbiguousTotal,
  ledgerPhaseGauge: settlementLedgerPhaseGauge,
  dueForRetryGauge: settlementDueForRetryGauge,
  needsInterventionGauge: settlementNeedsInterventionGauge,
  retryTickDuration: settlementRetryTickDurationSeconds,
  retryLastRunTimestamp: settlementRetryLastRunTimestamp,
} as const;
