import { Registry, Counter, Gauge, Histogram, collectDefaultMetrics } from "prom-client";

export const registry = new Registry();

collectDefaultMetrics({ register: registry, prefix: "coordinator_" });

// ── Rate-limit & abuse analytics ──────────────────────────────────────────────

/** Rate-limit decision (pass vs block) per route */
export const rateLimitDecisions = new Counter({
  name: "coordinator_rate_limit_decisions_total",
  help: "Rate-limit decisions by route and outcome (pass|block)",
  labelNames: ["route", "decision"] as const,
  registers: [registry]
});

/** How close a request got to the limit (0 = empty bucket, 1 = at limit) */
export const rateLimitWindowUsage = new Histogram({
  name: "coordinator_rate_limit_window_usage_ratio",
  help: "Bucket fullness ratio when each request arrives (0–1)",
  labelNames: ["route"] as const,
  buckets: [0.25, 0.5, 0.75, 0.9, 0.95, 0.99, 1],
  registers: [registry]
});

/** Blocked IPs *actively* rate-limited in the last window (tracked by abuse detector) */
export const rateLimitActiveBlocks = new Gauge({
  name: "coordinator_rate_limit_active_blocks",
  help: "Number of unique IPs currently rate-limited by route",
  labelNames: ["route"] as const,
  registers: [registry]
});

/** IPs that hit rate limits on ≥2 distinct routes within the abuse window */
export const rateLimitMultiRouteAbusers = new Gauge({
  name: "coordinator_rate_limit_multi_route_abusers",
  help: "IPs hitting rate limits on multiple routes (enumeration signal)",
  registers: [registry]
});

/** Total orders by status and direction labels */
export const ordersTotal = new Counter({
  name: "coordinator_orders_total",
  help: "Total number of orders by status and direction",
  labelNames: ["status", "direction"] as const,
  registers: [registry]
});

/** Database query duration histogram */
export const dbQueryDuration = new Histogram({
  name: "coordinator_db_query_duration_seconds",
  help: "Duration of database queries in seconds",
  labelNames: ["operation"] as const,
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5],
  registers: [registry]
});

/** Last block number seen by each listener */
export const listenerLastBlock = new Gauge({
  name: "coordinator_listener_last_block",
  help: "Most recent block processed by each chain listener",
  labelNames: ["chain"] as const,
  registers: [registry]
});

/** Latest chain head observed by each listener */
export const listenerHeadBlock = new Gauge({
  name: "coordinator_listener_head_block",
  help: "Most recent chain head observed by each listener",
  labelNames: ["chain"] as const,
  registers: [registry]
});

/** Difference between the observed chain head and processed listener block */
export const listenerLagBlocks = new Gauge({
  name: "coordinator_listener_lag_blocks",
  help: "Current listener lag in blocks, ledgers, or slots by chain",
  labelNames: ["chain"] as const,
  registers: [registry]
});

/** Event processing duration per chain and event type */
export const listenerEventProcessingDuration = new Histogram({
  name: "coordinator_listener_event_processing_duration_seconds",
  help: "Duration spent processing listener event batches",
  labelNames: ["chain", "event"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
  registers: [registry]
});

export function recordListenerProgress(
  chain: string,
  processedBlock: number,
  headBlock = processedBlock
): void {
  listenerLastBlock.set({ chain }, processedBlock);
  listenerHeadBlock.set({ chain }, headBlock);
  listenerLagBlocks.set({ chain }, Math.max(headBlock - processedBlock, 0));
}

export function observeListenerEventProcessing(
  chain: string,
  event: string,
  startedAtMs: number
): void {
  listenerEventProcessingDuration.observe(
    { chain, event },
    Math.max(Date.now() - startedAtMs, 0) / 1000
  );
}

/** HTTP request duration histogram */
export const httpRequestDuration = new Histogram({
  name: "coordinator_http_request_duration_seconds",
  help: "Duration of HTTP requests in seconds",
  labelNames: ["method", "route", "status_code"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
  registers: [registry]
});

/** End-to-end swap completion latency in seconds */
export const swapDuration = new Histogram({
  name: "coordinator_swap_duration_seconds",
  help: "Time from order announcement to terminal state (completed or refunded)",
  labelNames: ["direction", "outcome"] as const,
  buckets: [30, 60, 120, 180, 300, 600, 900, 1800, 3600],
  registers: [registry]
});

/** Active orders currently in flight */
export const activeOrders = new Gauge({
  name: "coordinator_active_orders",
  help: "Number of orders not yet in a terminal state",
  labelNames: ["direction"] as const,
  registers: [registry]
});

/** Reconciliation runs by result */
export const reconciliationRuns = new Counter({
  name: "coordinator_reconciliation_runs_total",
  help: "Total reconciliation runs by result (success|failure)",
  labelNames: ["result"] as const,
  registers: [registry]
});

/** Reconciliation errors */
export const reconciliationErrors = new Counter({
  name: "coordinator_reconciliation_errors_total",
  help: "Total reconciliation run failures",
  registers: [registry]
});

/** Unix timestamp of last completed reconciliation run */
export const reconciliationLastRun = new Gauge({
  name: "coordinator_reconciliation_last_run_timestamp_seconds",
  help: "Unix timestamp of the most recent reconciliation run",
  registers: [registry]
});

/** Total events replayed by reconciler */
export const reconciliationEventsReplayed = new Counter({
  name: "coordinator_reconciliation_events_replayed_total",
  help: "Total on-chain events replayed by the reconciler",
  registers: [registry]
});

/** Stale cleanup runs (success | failure) */
export const staleCleanupRuns = new Counter({
  name: "coordinator_stale_cleanup_runs_total",
  help: "Total stale order cleanup runs by result",
  labelNames: ["result"] as const,
  registers: [registry]
});

/** Orders archived (soft-deleted) by the stale cleanup service */
export const staleOrdersArchived = new Counter({
  name: "coordinator_stale_orders_archived_total",
  help: "Total stale announced orders archived by the cleanup service",
  registers: [registry]
});

/** Unix timestamp of the last completed stale cleanup run */
export const staleCleanupLastRun = new Gauge({
  name: "coordinator_stale_cleanup_last_run_timestamp_seconds",
  help: "Unix timestamp of the most recent stale order cleanup run",
  registers: [registry]
});

/** Resolver participation per operation */
export const resolverLockActionsTotal = new Counter({
  name: "coordinator_resolver_lock_actions_total",
  help: "Total resolver lock actions by resolver address and action type",
  labelNames: ["resolver_address", "action"] as const,
  registers: [registry],
});

/**
 * Soroban event decode failures.
 *
 * Incremented whenever a Soroban contract event cannot be decoded —
 * either because `scValToNative` throws on malformed XDR, or because
 * the first topic is an unknown symbol not matching our HTLC events.
 * A non-zero rate here indicates a contract ABI drift or a bad RPC node.
 */
export const sorobanDecodeErrors = new Counter({
  name: "coordinator_soroban_decode_errors_total",
  help: "Total Soroban contract events that could not be decoded, by reason",
  labelNames: ["reason"] as const,
  registers: [registry],
});

/**
 * Set to 1 when SOLANA_HTLC_PROGRAM is a placeholder and the Solana
 * listener is disabled; 0 when a real program address is configured.
 *
 * Mirrors the `relayer_solana_placeholder_mode` gauge in the relayer so
 * both services expose the same observable signal.  An alert on this
 * gauge lets operators know Solana flows are inactive before they start
 * wondering why SOL→ETH swaps never complete.
 */
export const solanaPlaceholderMode = new Gauge({
  name: "coordinator_solana_placeholder_mode",
  help: "1 when SOLANA_HTLC_PROGRAM is a placeholder and Solana flows are disabled, 0 when configured",
  registers: [registry],
});

// ── Reconciliation replay / recovery metrics ─────────────────────────────────
// These metrics expose the internals of the formal replay pipeline so operators
// can detect silent event loss, cursor staleness, and forced re-syncs without
// reconstructing event streams manually.

/**
 * Current replay window size (in blocks / ledgers / slots) per chain.
 * Set on every reconciler run.  A value of 0 means the chain is up to date.
 * A persistently large value indicates the HWM is not advancing (RPC outage
 * or events are not being found in the window).
 */
export const reconciliationWindowSize = new Gauge({
  name: "coordinator_reconciliation_window_size",
  help: "Current replay scan window size in chain-native units (blocks/ledgers/slots) per chain",
  labelNames: ["chain"] as const,
  registers: [registry],
});

/**
 * Cursor lag per chain: the distance between the cursor HWM and the current
 * chain tip in chain-native units.  Identical to `reconciliationWindowSize`
 * today but kept as a separate metric so dashboards can alert on lag vs window
 * independently once they diverge (e.g. when partial-page replays are added).
 */
export const reconciliationCursorLag = new Gauge({
  name: "coordinator_reconciliation_cursor_lag",
  help: "Distance between the reconciler cursor HWM and the current chain tip",
  labelNames: ["chain"] as const,
  registers: [registry],
});

/**
 * Cumulative count of times the configured lookback window was exceeded,
 * forcing the reconciler to fall back to `tip - lookback` as the start block.
 * A non-zero rate means events before the fallback point may have been missed.
 * Operators should investigate whether a manual historical re-scan is required.
 */
export const reconciliationGapExceedances = new Counter({
  name: "coordinator_reconciliation_gap_exceedances_total",
  help: "Total times the reconciler cursor gap exceeded the configured lookback window",
  labelNames: ["chain"] as const,
  registers: [registry],
});

/**
 * Conflicts classified during event replay, by type.
 *
 * conflict_type label values:
 *   - already_applied      — event targets a status the order already has (benign)
 *   - status_ahead         — order is past the event's target status (benign)
 *   - state_contradiction  — event contradicts persisted state (investigate)
 *   - unknown_order        — event references an order not in the DB (gap signal)
 */
export const reconciliationConflicts = new Counter({
  name: "coordinator_reconciliation_conflicts_total",
  help: "Total event-vs-state conflicts classified during reconciler replay, by type",
  labelNames: ["conflict_type"] as const,
  registers: [registry],
});

/**
 * Cumulative count of forced historical re-sync decisions: gaps that exceeded
 * 3× the lookback window, requiring operator action to ensure no events were
 * permanently missed.
 */
export const reconciliationForcedResyncs = new Counter({
  name: "coordinator_reconciliation_forced_resyncs_total",
  help: "Total forced historical re-sync decisions (gap > 3× lookback window)",
  labelNames: ["chain"] as const,
  registers: [registry],
});

/**
 * Per-chain errors during a reconciler run.  Incremented when a single
 * chain's RPC call fails and that chain is skipped for the run.  A non-zero
 * rate for a chain means its cursor is not advancing and the window is growing.
 */
export const reconciliationChainErrors = new Counter({
  name: "coordinator_reconciliation_chain_errors_total",
  help: "Total per-chain errors that caused a chain to be skipped in a reconciler run",
  labelNames: ["chain"] as const,
  registers: [registry],
});

/**
 * Total events skipped by the per-run deduplication set.  A non-zero count is
 * expected (overlapping windows are intentional); a very high count relative to
 * `eventsReplayed` may indicate the cursor is not advancing.
 */
export const reconciliationDuplicatesSkipped = new Counter({
  name: "coordinator_reconciliation_duplicates_skipped_total",
  help: "Total on-chain events skipped by the per-run deduplication filter",
  registers: [registry],
});
