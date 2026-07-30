import { rpc } from "@stellar/stellar-sdk";
import type { xdr } from "@stellar/stellar-sdk";
import type { Logger } from "pino";
import type { CoordinatorConfig } from "../config.js";
import type { OrderService } from "../services/order-service.js";
import {
  observeListenerEventProcessing,
  recordListenerProgress,
  sorobanDecodeErrors,
  workflowDispatchDecisions,
} from "../metrics.js";
import {
  decodeHtlcEvent,
  isMalformedEvent,
  type DecodedHtlcEvent,
} from "../soroban-events.js";
import { decideDispatch } from "../services/workflow-priority-policy.js";

/** Maximum ledger gap before we treat it as a node inconsistency and re-scan. */
const MAX_LEDGER_GAP = 100;

/**
 * Maximum number of processed event keys retained in the in-process
 * deduplication cache (same sizing rationale as the Ethereum listener).
 */
const DEDUP_CACHE_MAX = 10_000;

// ─── Typed RPC event shape ────────────────────────────────────────────────────

/**
 * Minimal typed wrapper for the raw Soroban RPC event returned by
 * `rpc.Server.getEvents()`.  The full type is not exported by the SDK at
 * the version we use, so we extract the relevant slice.
 */
interface SorobanRpcEvent {
  ledger: number;
  txHash: string;
  /** Array of xdr.ScVal — the published topics. */
  topic: xdr.ScVal[];
  /** Single xdr.ScVal — the published data (a Soroban Vec/tuple). */
  value: xdr.ScVal;
}

// ─── SorobanListener ─────────────────────────────────────────────────────────

/**
 * Polls the Soroban RPC for HTLC contract events and feeds them into
 * the OrderService.
 *
 * Stellar consensus is BFT-finalized so true chain reorgs cannot occur,
 * but we guard against three classes of node-level inconsistency:
 *
 *  1. Out-of-order delivery  — ledger sequence goes backwards.
 *     Detected per-event: skip and warn.
 *
 *  2. Ledger gap             — cursor jumps forward by more than MAX_LEDGER_GAP.
 *     Detected per-event: reset cursor so the next iteration re-scans
 *     from lastProcessedLedger.
 *
 *  3. Stale / expired cursor — the RPC node no longer recognises our cursor
 *     (e.g. node restarted, history window pruned).
 *     Detected on RPC error: reset cursor and continue.
 *
 * Event decoding
 * ──────────────
 * All decoding is delegated to {@link decodeHtlcEvent} from `soroban-events.ts`,
 * which is the single canonical decoder shared with the reconciler.  A
 * {@link MalformedEventError} is counted and logged as an operational failure;
 * it does NOT stall the poll loop.  An `null` result (unknown/governance topic)
 * is silently skipped.
 */
export class SorobanListener {
  private readonly server: rpc.Server;
  private readonly log: Logger;
  private cursor: string | undefined;
  private stopped = false;
  private lastProcessedLedger = 0;

  /**
   * In-process event deduplication cache.
   * Key: `"<kind>:<txHash>"` — e.g. `"created:0xabc…"`.
   * Bounded at DEDUP_CACHE_MAX entries; oldest evicted on overflow.
   */
  private readonly processedEventKeys = new Map<string, true>();

  constructor(
    private readonly cfg: CoordinatorConfig,
    private readonly orders: OrderService,
    log: Logger
  ) {
    this.log = log.child({ component: "SorobanListener" });
    this.server = new rpc.Server(cfg.soroban.rpcUrl, {
      allowHttp: cfg.soroban.rpcUrl.startsWith("http://"),
    });
  }

  start(): void {
    if (!this.cfg.soroban.htlcContract) {
      this.log.warn(
        "SOROBAN_HTLC contract not configured - Soroban listener disabled"
      );
      return;
    }
    const contractId = this.cfg.soroban.htlcContract;
    this.log.info({ contract: contractId }, "starting");
    void this.loop(contractId);
  }

  stop(): void {
    this.stopped = true;
  }

  // ─── Event deduplication helpers ─────────────────────────────────────────

  /** Build the dedup cache key: `"<kind>:<txHash>"`. */
  private dedupKey(kind: string, txHash: string): string {
    return `${kind}:${txHash}`;
  }

  /** Returns true if this (kind, txHash) pair was already processed in-process. */
  isDuplicate(kind: string, txHash: string): boolean {
    return this.processedEventKeys.has(this.dedupKey(kind, txHash));
  }

  /** Mark (kind, txHash) as processed; evicts oldest entry on overflow. */
  private markProcessed(kind: string, txHash: string): void {
    const key = this.dedupKey(kind, txHash);
    if (this.processedEventKeys.has(key)) return;
    if (this.processedEventKeys.size >= DEDUP_CACHE_MAX) {
      const oldest = this.processedEventKeys.keys().next().value;
      if (oldest !== undefined) this.processedEventKeys.delete(oldest);
    }
    this.processedEventKeys.set(key, true);
  }

  private async loop(contractId: string): Promise<void> {
    while (!this.stopped) {
      try {
        const startedAt = Date.now();
        const latest = await this.server.getLatestLedger();

        // When we have no cursor, start just behind the chain tip.
        const startLedger =
          this.cursor === undefined ? latest.sequence - 1 : undefined;

        // processedLedger tracks the highest ledger we process this iteration
        // for recordListenerProgress. Seed it from the resolved start point.
        let processedLedger = startLedger ?? this.lastProcessedLedger;

        let events: Awaited<ReturnType<rpc.Server["getEvents"]>>;
        try {
          events = await this.server.getEvents({
            filters: [{ type: "contract", contractIds: [contractId] }],
            startLedger: startLedger,
            cursor: this.cursor,
            limit: 100,
          });
        } catch (rpcErr) {
          // Stale / expired cursor — reset and let the next iteration re-scan.
          this.log.warn({ err: rpcErr }, "Soroban cursor reset due to error");
          this.cursor = undefined;
          await new Promise((r) => setTimeout(r, this.cfg.pollIntervalMs));
          continue;
        }

        for (const ev of events.events) {
          // ── Guard 1: out-of-order event ──────────────────────────────────
          if (ev.ledger < this.lastProcessedLedger) {
            this.log.warn(
              {
                evLedger: ev.ledger,
                lastProcessedLedger: this.lastProcessedLedger,
              },
              "Soroban event out of order — possible node inconsistency"
            );
            continue;
          }

          // ── Guard 2: ledger gap ───────────────────────────────────────────
          if (
            this.lastProcessedLedger > 0 &&
            ev.ledger > this.lastProcessedLedger + MAX_LEDGER_GAP
          ) {
            this.log.warn(
              {
                evLedger: ev.ledger,
                lastProcessedLedger: this.lastProcessedLedger,
                MAX_LEDGER_GAP,
              },
              "Soroban ledger gap detected, re-scanning from last known ledger"
            );
            this.cursor = undefined;
            break;
          }

          processedLedger = Math.max(processedLedger, ev.ledger);
          this.lastProcessedLedger = Math.max(
            this.lastProcessedLedger,
            ev.ledger
          );

          await this.processSorobanEvent(ev as unknown as SorobanRpcEvent);
        }

        recordListenerProgress("soroban", processedLedger, latest.sequence);
        observeListenerEventProcessing("soroban", "poll", startedAt);

        // Advance the cursor only when this.cursor was NOT reset by the gap
        // guard above.
        if (events.cursor && this.cursor !== undefined) {
          this.cursor = events.cursor;
        }
      } catch (err) {
        this.log.warn({ err }, "Soroban poll failed");
      }
      await new Promise((r) => setTimeout(r, this.cfg.pollIntervalMs));
    }
  }

  /**
   * Decode a single Soroban contract event via the shared
   * {@link decodeHtlcEvent} utility and dispatch to the appropriate
   * OrderService method.
   *
   * A {@link MalformedEventError} is treated as an operational failure:
   * it is counted, logged at warn level, and skipped — it does NOT mutate
   * order state.  Unknown/governance topics (null) are silently skipped.
   *
   * Duplicate events (same kind + txHash already processed in this session)
   * are dropped before any DB interaction.
   */
  private async processSorobanEvent(ev: SorobanRpcEvent): Promise<void> {
    const result = decodeHtlcEvent(ev.topic, ev.value);

    // ── Malformed payload ─────────────────────────────────────────────────
    if (isMalformedEvent(result)) {
      sorobanDecodeErrors.inc({ reason: result.reason });
      this.log.warn(
        {
          ledger: ev.ledger,
          txHash: ev.txHash,
          kind: result.kind,
          reason: result.reason,
          detail: result.detail,
        },
        "Soroban event payload malformed — skipping without mutating order state"
      );
      return;
    }

    // ── Unknown / governance topic ────────────────────────────────────────
    if (result === null) {
      this.log.debug(
        { ledger: ev.ledger, txHash: ev.txHash },
        "Soroban event with unknown topic — skipping"
      );
      return;
    }

    const decoded: DecodedHtlcEvent = result;

    // ── In-process deduplication ──────────────────────────────────────────
    if (this.isDuplicate(decoded.kind, ev.txHash)) {
      this.log.debug(
        { kind: decoded.kind, txHash: ev.txHash, ledger: ev.ledger },
        "Soroban event duplicate skipped (in-process cache)"
      );
      return;
    }

    this.log.info(
      { kind: decoded.kind, schemaVersion: decoded.schemaVersion, ledger: ev.ledger, txHash: ev.txHash },
      "Soroban HTLC event decoded"
    );

    // ── created ────────────────────────────────────────────────────────────
    if (decoded.kind === "created") {
      try {
        const order = await this.orders.findByHashlock(decoded.hashlock);
        if (!order) {
          this.log.info(
            {
              hashlock: decoded.hashlock,
              orderId: decoded.orderId.toString(),
            },
            "Soroban created event: no matching announced order — skipping"
          );
          return;
        }
        const decision = decideDispatch({
          path: "live",
          mutation: "src_lock",
          incomingSequence: ev.ledger,
          existingSequence: order.srcLockBlock,
          alreadyApplied: order.srcOrderId !== null,
        });
        workflowDispatchDecisions.inc({
          path: "live",
          mutation: "src_lock",
          outcome: decision.reason,
        });
        if (!decision.shouldApply) return;
        await this.orders.recordSrcLock({
          publicId: order.publicId,
          orderId: decoded.orderId.toString(),
          txHash: ev.txHash,
          blockNumber: ev.ledger,
          timelock: decoded.timelock,
        });
        this.markProcessed(decoded.kind, ev.txHash);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("cannot record") && !msg.includes("duplicate")) {
          this.log.warn(
            { err, hashlock: decoded.hashlock },
            "Soroban created event processing error"
          );
        }
      }
      return;
    }

    // ── claimed ────────────────────────────────────────────────────────────
    if (decoded.kind === "claimed") {
      try {
        const order = await this.orders.findBySrcOrderId(
          "stellar",
          decoded.orderId.toString()
        );
        if (!order) {
          const byHash = await this.orders.findByHashlock(decoded.hashlock);
          if (!byHash) {
            this.log.info(
              {
                orderId: decoded.orderId.toString(),
                hashlock: decoded.hashlock,
              },
              "Soroban claimed event: order not found — skipping"
            );
            return;
          }
          const decision = decideDispatch({
            path: "live",
            mutation: "secret_reveal",
            incomingSequence: ev.ledger,
            existingSequence: null,
            alreadyApplied: byHash.preimage !== null,
          });
          workflowDispatchDecisions.inc({
            path: "live",
            mutation: "secret_reveal",
            outcome: decision.reason,
          });
          if (!decision.shouldApply) return;
          await this.orders.recordSecret(
            byHash.publicId,
            decoded.preimage,
            ev.txHash
          );
          this.markProcessed(decoded.kind, ev.txHash);
          return;
        }
        const decision = decideDispatch({
          path: "live",
          mutation: "secret_reveal",
          incomingSequence: ev.ledger,
          existingSequence: null,
          alreadyApplied: order.preimage !== null,
        });
        workflowDispatchDecisions.inc({
          path: "live",
          mutation: "secret_reveal",
          outcome: decision.reason,
        });
        if (!decision.shouldApply) return;
        await this.orders.recordSecret(
          order.publicId,
          decoded.preimage,
          ev.txHash
        );
        this.markProcessed(decoded.kind, ev.txHash);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("cannot record") && !msg.includes("duplicate")) {
          this.log.warn(
            { err, orderId: decoded.orderId.toString() },
            "Soroban claimed event processing error"
          );
        }
      }
      return;
    }

    // ── refunded ───────────────────────────────────────────────────────────
    if (decoded.kind === "refunded") {
      try {
        const order = await this.orders.findBySrcOrderId(
          "stellar",
          decoded.orderId.toString()
        );
        if (!order) {
          const byHash = await this.orders.findByHashlock(decoded.hashlock);
          if (!byHash) {
            this.log.info(
              {
                orderId: decoded.orderId.toString(),
                hashlock: decoded.hashlock,
              },
              "Soroban refunded event: order not found — skipping"
            );
            return;
          }
          const decision = decideDispatch({
            path: "live",
            mutation: "refund",
            incomingSequence: ev.ledger,
            existingSequence: byHash.srcLockBlock,
            alreadyApplied: byHash.status === "refunded" || byHash.status === "completed",
          });
          workflowDispatchDecisions.inc({
            path: "live",
            mutation: "refund",
            outcome: decision.reason,
          });
          if (!decision.shouldApply) return;
          await this.orders.markStatus(byHash.publicId, "refunded");
          this.markProcessed(decoded.kind, ev.txHash);
          return;
        }
        const decision = decideDispatch({
          path: "live",
          mutation: "refund",
          incomingSequence: ev.ledger,
          existingSequence: order.srcLockBlock,
          alreadyApplied: order.status === "refunded" || order.status === "completed",
        });
        workflowDispatchDecisions.inc({
          path: "live",
          mutation: "refund",
          outcome: decision.reason,
        });
        if (!decision.shouldApply) return;
        await this.orders.markStatus(order.publicId, "refunded");
        this.markProcessed(decoded.kind, ev.txHash);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("cannot transition") && !msg.includes("duplicate")) {
          this.log.warn(
            { err, orderId: decoded.orderId.toString() },
            "Soroban refunded event processing error"
          );
        }
      }
      return;
    }
  }
}
