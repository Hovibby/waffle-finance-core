/**
 * LedgerCursor — deterministic per-chain cursor and high-water-mark store.
 *
 * ## Responsibility
 *
 * The reconciler must know exactly where it left off on each chain so that
 * after a restart, an RPC hiccup, or a period of inactivity it can scan
 * precisely the missed window rather than re-scanning from a fixed lookback
 * constant or silently skipping events.
 *
 * This module owns three related concepts:
 *
 *  1. **High-water mark (HWM)** — the highest block / ledger / slot that has
 *     been fully processed and whose events are durably persisted in the DB.
 *     Advancing the HWM is an explicit, one-at-a-time operation so the cursor
 *     never jumps past un-processed ranges.
 *
 *  2. **Gap detection** — the distance between the stored HWM and the current
 *     chain tip.  Gaps are classified by severity:
 *     - `none`        — tip ≤ HWM + 1  (up to date)
 *     - `normal`      — gap ≤ lookback window  (replay covers it)
 *     - `large`       — gap > lookback window but ≤ LARGE_GAP_MULTIPLIER × window
 *     - `exceeded`    — gap > LARGE_GAP_MULTIPLIER × window (forced historical
 *                       re-sync required; operator must decide scan start)
 *
 *  3. **Lookback-exceeded decision** — when the gap exceeds the configured
 *     lookback window, the cursor cannot provide a deterministic start block
 *     from the HWM alone. `resolveFromBlock` returns the best available start
 *     point (either HWM when within window, or `tip - window` when exceeded)
 *     and records an `exceeded` event so the reconciler can emit a metric and
 *     log a warning.
 *
 * ## In-memory vs persistent
 *
 * The cursor is intentionally in-memory.  The source of truth for the HWM is
 * derived from the orders database: `getLastProcessedBlock` returns the highest
 * block number stored across all order lock records.  On startup the cursor
 * seeds itself from the DB; thereafter it advances as the reconciler writes
 * new lock records.
 *
 * This avoids the need for a separate cursor table while still being
 * deterministic: if the process restarts and the DB has records up to block N,
 * the cursor seeds at N and the reconciler will scan from N onward.
 */

export type GapSeverity = "none" | "normal" | "large" | "exceeded";

export interface GapAssessment {
  /** Number of blocks / ledgers / slots between the HWM and the current tip. */
  gap: number;
  /** Severity classification. */
  severity: GapSeverity;
  /** The block/ledger/slot from which replay should start. */
  fromBlock: number;
  /** The chain tip at assessment time. */
  tip: number;
  /** The HWM at assessment time. */
  hwm: number;
  /** The configured lookback window size (blocks/ledgers/slots). */
  lookbackWindow: number;
  /**
   * True when the gap exceeded the lookback window and the cursor fell back to
   * `tip - lookbackWindow` as the start point.  The reconciler MUST emit a
   * warning metric and log when this is true.
   */
  lookbackExceeded: boolean;
}

/** Multiplier applied to the lookback window to distinguish `large` from `exceeded`. */
const LARGE_GAP_MULTIPLIER = 2;

export class LedgerCursor {
  /** Current high-water mark: highest fully-processed block/ledger/slot. */
  private hwm: number;

  /** Number of times the lookback window has been exceeded since construction. */
  private lookbackExceededCount = 0;

  constructor(
    /** Chain identifier — used only for logging context. */
    private readonly chain: string,
    /** Configured replay lookback window (in blocks / ledgers / slots). */
    private readonly lookbackWindow: number,
    /** Initial HWM, seeded from DB on startup (0 = no prior state). */
    initialHwm = 0,
  ) {
    this.hwm = initialHwm;
  }

  // ─── Accessors ────────────────────────────────────────────────────────────

  /** Current high-water mark. */
  getHwm(): number {
    return this.hwm;
  }

  /** Lookback window size (blocks / ledgers / slots). */
  getLookbackWindow(): number {
    return this.lookbackWindow;
  }

  /** Number of lookback-exceeded events recorded since construction. */
  getLookbackExceededCount(): number {
    return this.lookbackExceededCount;
  }

  // ─── Mutation ─────────────────────────────────────────────────────────────

  /**
   * Advance the HWM to `newHwm`.  Only advances forward — calling with a value
   * ≤ the current HWM is a safe no-op (supports out-of-order acknowledgements
   * from batch replays).
   */
  advance(newHwm: number): void {
    if (newHwm > this.hwm) {
      this.hwm = newHwm;
    }
  }

  /**
   * Seed (or re-seed) the HWM from an externally derived value such as the
   * maximum block number stored in the orders DB.  Unlike `advance`, this
   * unconditionally sets the HWM to `seed` (useful for startup initialisation
   * where the DB value is the canonical source of truth).
   *
   * If `seed` is 0 (no DB records) the HWM stays at 0 and the reconciler will
   * use `tip - lookbackWindow` as the start block.
   */
  seed(seed: number): void {
    this.hwm = seed;
  }

  // ─── Gap analysis ─────────────────────────────────────────────────────────

  /**
   * Assess the gap between the current HWM and `tip`, and return a
   * `GapAssessment` describing the severity and the recommended start block
   * for the next replay scan.
   *
   * Decision table
   * ─────────────
   * | Condition                          | severity  | fromBlock          |
   * |------------------------------------|-----------|-------------------|
   * | tip ≤ hwm                          | none      | hwm               |
   * | gap ≤ lookbackWindow               | normal    | hwm               |
   * | gap ≤ 2 × lookbackWindow           | large     | hwm               |
   * | gap > 2 × lookbackWindow           | exceeded  | tip - lookbackWindow |
   *
   * When the gap is exactly 0 (hwm == tip) the severity is `none` and
   * `fromBlock` equals the tip (nothing to replay).
   */
  assess(tip: number): GapAssessment {
    const gap = Math.max(0, tip - this.hwm);

    let severity: GapSeverity;
    let fromBlock: number;
    let lookbackExceeded = false;

    if (gap === 0) {
      severity = "none";
      fromBlock = this.hwm;
    } else if (gap <= this.lookbackWindow) {
      severity = "normal";
      fromBlock = this.hwm;
    } else if (gap <= LARGE_GAP_MULTIPLIER * this.lookbackWindow) {
      severity = "large";
      fromBlock = this.hwm;
    } else {
      // Gap exceeds what the configured lookback window can cover.
      // Fall back to `tip - lookbackWindow` to avoid unbounded scans and
      // record the exceedance so the caller can alert.
      severity = "exceeded";
      fromBlock = Math.max(0, tip - this.lookbackWindow);
      lookbackExceeded = true;
      this.lookbackExceededCount++;
    }

    return { gap, severity, fromBlock, tip, hwm: this.hwm, lookbackWindow: this.lookbackWindow, lookbackExceeded };
  }

  /**
   * Convenience wrapper: given the current chain `tip`, return the block from
   * which the next replay scan should start.
   *
   * Equivalent to `assess(tip).fromBlock`.  Use this when you only need the
   * start block and don't need the full assessment.
   */
  resolveFromBlock(tip: number): number {
    return this.assess(tip).fromBlock;
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create a `LedgerCursor` pre-seeded from the orders DB.
 *
 * @param chain         Chain identifier (e.g. "ethereum", "soroban", "solana").
 * @param lookback      Lookback window in chain-native units.
 * @param dbHwm         HWM derived from `OrdersRepository.getLastProcessedBlock`.
 */
export function createLedgerCursor(
  chain: string,
  lookback: number,
  dbHwm: number,
): LedgerCursor {
  return new LedgerCursor(chain, lookback, dbHwm);
}
