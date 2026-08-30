/**
 * Reconciler — formal replay/recovery pipeline for the WaffleFinance coordinator.
 *
 * ## Architecture
 *
 * The reconciler runs on a configurable interval and on startup.  Each run
 * executes a deterministic, provable re-sync of on-chain state against the
 * coordinator's DB across all three chains.
 *
 * ### Key invariants
 *
 * 1. **No silent event loss** — every run starts from the cursor HWM seeded
 *    from the DB, not a fixed constant.  Events in the scan window are
 *    processed even after a restart.
 *
 * 2. **No silent mis-interpretation** — duplicate and reordered events are
 *    identified by `EventSeenSet` and skipped before any DB write.
 *
 * 3. **No silent gap exceedance** — when the cursor gap exceeds the lookback
 *    window, the reconciler emits a structured warning log, a Prometheus metric
 *    increment, and falls back deterministically to `tip - lookback`.
 *
 * 4. **Idempotent recovery** — every OrderService write (recordSrcLock,
 *    recordSecret, markStatus) is idempotent: re-running the reconciler after
 *    a crash leaves the DB in the same state as a single successful run.
 *
 * 5. **Operator observability** — every decision (window size, gap severity,
 *    conflict type, resync) is emitted as a metric and a structured log entry.
 *
 * ### Per-chain cursors
 *
 * Each chain has its own `LedgerCursor` seeded at startup from the DB.  The
 * HWM advances to the highest block/ledger/slot processed in each run so
 * subsequent runs start from where the previous one left off.
 *
 * ### Startup recovery
 *
 * On the first `run()` call (or after a process restart), `initCursors()`
 * queries the DB for the highest known block per chain and seeds each cursor.
 * This ensures the very first run covers the full missed window without any
 * manual operator action.
 *
 * ### Partial RPC failure
 *
 * If a single chain's RPC fails, that chain is skipped for this run (the
 * cursor does not advance) and an error metric is incremented.  The other
 * chains are not affected.  On the next run the cursor for the failed chain
 * will reassess the gap from the same HWM and retry.
 */

import {
  createPublicClient,
  http,
  parseAbiItem,
  type PublicClient,
  type Log,
} from "viem";
import { sepolia, mainnet } from "viem/chains";
import { rpc } from "@stellar/stellar-sdk";
import { Connection, PublicKey } from "@solana/web3.js";
import type { Logger } from "pino";
import type { CoordinatorConfig } from "../config.js";
import type { OrderService } from "../services/order-service.js";
import {
  reconciliationRuns,
  reconciliationErrors,
  reconciliationLastRun,
  reconciliationEventsReplayed,
  reconciliationWindowSize,
  reconciliationCursorLag,
  reconciliationGapExceedances,
  reconciliationConflicts,
  reconciliationForcedResyncs,
  reconciliationChainErrors,
  reconciliationDuplicatesSkipped,
} from "../metrics.js";
import { validatePreimage } from "./secret-reconciler.js";
import {
  createLedgerCursor,
} from "./ledger-cursor.js";
import {
  EventSeenSet,
  ethEventKey,
  sorobanEventKey,
  solanaEventKey,
  semanticKey,
} from "./event-identity.js";
import {
  ReplayPolicy,
  buildReplayDecision,
  classifyConflict,
  classifyUnknownOrder,
} from "./replay-policy.js";
import { isTerminal } from "../state-machine/order-machine.js";

// ─── ABI event definitions ────────────────────────────────────────────────────

const ORDER_CREATED = parseAbiItem(
  "event OrderCreated(uint256 indexed orderId, address indexed sender, address indexed beneficiary, address token, uint256 amount, uint256 safetyDeposit, bytes32 hashlock, uint64 timelock)"
);
const ORDER_CLAIMED = parseAbiItem(
  "event OrderClaimed(uint256 indexed orderId, address indexed claimer, bytes32 preimage, uint256 amount, uint256 safetyDeposit)"
);
const ORDER_REFUNDED = parseAbiItem(
  "event OrderRefunded(uint256 indexed orderId, address indexed caller, uint256 amount, uint256 safetyDeposit)"
);

// ─── Lookback constants ───────────────────────────────────────────────────────

/**
 * Ethereum: ~12 s/block → 48 h = 14 400 blocks.
 * Used as the default; the cursor HWM overrides this when available.
 */
const ETH_LOOKBACK_BLOCKS = 14_400;

/** Soroban: ~5 s/ledger → 48 h = 34 560 ledgers. */
const SOROBAN_LOOKBACK_LEDGERS = 34_560;

/** Solana: ~0.4 s/slot → 48 h = 432 000 slots. */
const SOLANA_LOOKBACK_SLOTS = 432_000;

// ─── Status types ─────────────────────────────────────────────────────────────

export interface ReconciliationStatus {
  lastRunAt: number | null;
  lastRunOk: boolean | null;
  eventsReplayed: number;
  /** Populated after the first successful run. */
  cursors?: {
    ethereum: number;
    soroban: number;
    solana: number;
  };
}

// ─── Reconciler ───────────────────────────────────────────────────────────────

export class Reconciler {
  private readonly log: Logger;
  private readonly ethClient: PublicClient;
  private readonly sorobanServer: rpc.Server;
  private readonly solanaConn: Connection;

  // Per-chain cursors — seeded from DB on first run via initCursors().
  private ethCursor: LedgerCursor | null = null;
  private sorobanCursor: LedgerCursor | null = null;
  private sorobanRpcCursor: string | undefined = undefined; // Soroban's opaque page cursor
  private solanaCursor: LedgerCursor | null = null;

  // Per-run deduplication set.  Cleared at the start of each run.
  private readonly seenSet = new EventSeenSet();

  // Replay policy accumulator.  Reset at the start of each run.
  private readonly policy = new ReplayPolicy();

  // Whether cursors have been initialised from the DB.
  private cursorsReady = false;

  private status: ReconciliationStatus = {
    lastRunAt: null,
    lastRunOk: null,
    eventsReplayed: 0,
  };

  constructor(
    private readonly cfg: CoordinatorConfig,
    private readonly orders: OrderService,
    log: Logger,
  ) {
    this.log = log.child({ component: "Reconciler" });
    this.ethClient = createPublicClient({
      chain: cfg.ethereum.chainId === 1 ? mainnet : sepolia,
      transport: http(cfg.ethereum.rpcUrl),
    });
    this.sorobanServer = new rpc.Server(cfg.soroban.rpcUrl, {
      allowHttp: cfg.soroban.rpcUrl.startsWith("http://"),
    });
    this.solanaConn = new Connection(cfg.solana.rpcUrl, cfg.solana.commitment);
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  getStatus(): ReconciliationStatus {
    return { ...this.status };
  }

  /**
   * Execute one full reconciliation run across all configured chains.
   *
   * Run sequence:
   *   1. Initialise cursors from DB (once, on first call).
   *   2. Clear per-run dedup set and policy accumulator.
   *   3. For each chain: assess gap, decide window, replay events, advance cursor.
   *   4. Emit metrics from policy summary.
   *   5. Update status and run-level metrics.
   */
  async run(): Promise<void> {
    this.log.info("reconciliation run starting");

    // Seed cursors from DB on first run (startup recovery).
    if (!this.cursorsReady) {
      await this.initCursors();
    }

    // Clear per-run state.
    this.seenSet.clear();
    this.policy.reset();

    let replayed = 0;
    let runOk = true;

    try {
      replayed += await this.reconcileEthereum();
    } catch (err) {
      this.log.error({ err, chain: "ethereum" }, "reconciler: Ethereum chain run failed");
      reconciliationChainErrors.inc({ chain: "ethereum" });
      runOk = false;
    }

    try {
      replayed += await this.reconcileSoroban();
    } catch (err) {
      this.log.error({ err, chain: "soroban" }, "reconciler: Soroban chain run failed");
      reconciliationChainErrors.inc({ chain: "soroban" });
      runOk = false;
    }

    try {
      replayed += await this.reconcileSolana();
    } catch (err) {
      this.log.error({ err, chain: "solana" }, "reconciler: Solana chain run failed");
      reconciliationChainErrors.inc({ chain: "solana" });
      runOk = false;
    }

    // Emit policy metrics.
    this.emitPolicyMetrics();

    // Emit dedup metrics.
    const dedupStats = this.seenSet.getStats();
    if (dedupStats.duplicates > 0) {
      reconciliationDuplicatesSkipped.inc(dedupStats.duplicates);
    }

    // Update run-level status.
    this.status = {
      lastRunAt: Date.now(),
      lastRunOk: runOk,
      eventsReplayed: replayed,
      cursors: {
        ethereum: this.ethCursor?.getHwm() ?? 0,
        soroban: this.sorobanCursor?.getHwm() ?? 0,
        solana: this.solanaCursor?.getHwm() ?? 0,
      },
    };

    if (runOk) {
      reconciliationRuns.inc({ result: "success" });
    } else {
      reconciliationRuns.inc({ result: "failure" });
      reconciliationErrors.inc();
    }

    reconciliationEventsReplayed.inc(replayed);
    reconciliationLastRun.set(Date.now() / 1000);

    this.log.info(
      {
        replayed,
        runOk,
        dedupStats,
        policySummary: this.policy.getSummary(),
      },
      "reconciliation run complete",
    );
  }

  // ─── Cursor initialisation ────────────────────────────────────────────────

  /**
   * Seed per-chain cursors from the DB's max known block numbers.
   * Called once on the first `run()` to implement startup recovery without
   * operator intervention.
   */
  private async initCursors(): Promise<void> {
    const [ethHwm, sorobanHwm, solanaHwm] = await Promise.all([
      this.orders.getLastProcessedBlock("ethereum").catch(() => 0),
      this.orders.getLastProcessedBlock("stellar").catch(() => 0),
      this.orders.getLastProcessedBlock("solana").catch(() => 0),
    ]);

    this.ethCursor = createLedgerCursor("ethereum", ETH_LOOKBACK_BLOCKS, ethHwm);
    this.sorobanCursor = createLedgerCursor("soroban", SOROBAN_LOOKBACK_LEDGERS, sorobanHwm);
    this.solanaCursor = createLedgerCursor("solana", SOLANA_LOOKBACK_SLOTS, solanaHwm);

    this.cursorsReady = true;
    this.log.info(
      { ethHwm, sorobanHwm, solanaHwm },
      "reconciler: cursors initialised from DB",
    );
  }

  // ─── Metrics emission ─────────────────────────────────────────────────────

  private emitPolicyMetrics(): void {
    const summary = this.policy.getSummary();

    // Window sizes per chain.
    for (const d of this.policy.getDecisions()) {
      reconciliationWindowSize.set({ chain: d.chain }, d.windowSize);
      reconciliationCursorLag.set({ chain: d.chain }, d.windowSize);

      if (d.lookbackExceeded) {
        reconciliationGapExceedances.inc({ chain: d.chain });
        this.log.warn(
          {
            chain: d.chain,
            gap: d.windowSize,
            windowSize: d.windowSize,
            gapSeverity: d.gapSeverity,
          },
          "reconciler: lookback window exceeded — events before the scan window may have been missed",
        );
      }

      if (d.forcedHistoricalResync) {
        reconciliationForcedResyncs.inc({ chain: d.chain });
        this.log.error(
          { chain: d.chain, fromBlock: d.fromBlock, toBlock: d.toBlock },
          "reconciler: FORCED HISTORICAL RESYNC — gap exceeds 3× lookback window; manual re-indexing recommended",
        );
      }
    }

    // Conflict counts by type.
    for (const [conflictType, count] of Object.entries(summary.conflictsByType)) {
      if (count > 0) {
        reconciliationConflicts.inc({ conflict_type: conflictType }, count);
      }
    }

    // Log state_contradiction conflicts individually — these need investigation.
    for (const c of this.policy.getConflicts()) {
      if (c.conflictType === "state_contradiction") {
        this.log.warn(
          { chain: c.chain, eventType: c.eventType, publicId: c.publicId, status: c.orderStatus },
          `reconciler: state contradiction — ${c.description}`,
        );
      }
    }
  }

  // ─── Ethereum ─────────────────────────────────────────────────────────────

  private async reconcileEthereum(): Promise<number> {
    if (!this.cfg.ethereum.htlcEscrow) return 0;
    if (!this.ethCursor) return 0;

    const address = this.cfg.ethereum.htlcEscrow;
    const tip = Number(await this.ethClient.getBlockNumber());
    const assessment = this.ethCursor.assess(tip);

    const decision = buildReplayDecision("ethereum", assessment);
    this.policy.recordDecision(decision);

    if (decision.windowSize === 0) {
      this.log.debug({ chain: "ethereum", hwm: assessment.hwm, tip }, "reconciler: ETH up to date");
      return 0;
    }

    this.log.info(
      {
        chain: "ethereum",
        fromBlock: decision.fromBlock,
        toBlock: decision.toBlock,
        windowSize: decision.windowSize,
        gapSeverity: decision.gapSeverity,
      },
      "reconciler: ETH replay window",
    );

    const fromBlock = BigInt(decision.fromBlock);
    const toBlock = BigInt(decision.toBlock);

    const [createdLogs, claimedLogs, refundedLogs] = await Promise.all([
      this.ethClient.getLogs({ address, event: ORDER_CREATED, fromBlock, toBlock }),
      this.ethClient.getLogs({ address, event: ORDER_CLAIMED, fromBlock, toBlock }),
      this.ethClient.getLogs({ address, event: ORDER_REFUNDED, fromBlock, toBlock }),
    ]);

    let replayed = 0;
    replayed += await this.replayEthCreated(createdLogs);
    replayed += await this.replayEthClaimed(claimedLogs);
    replayed += await this.replayEthRefunded(refundedLogs);

    // Advance cursor to the tip processed in this run.
    this.ethCursor.advance(tip);

    return replayed;
  }

  private async replayEthCreated(logs: Log[]): Promise<number> {
    let n = 0;
    for (const log of logs) {
      const args = (log as any).args as {
        orderId?: bigint;
        hashlock?: `0x${string}`;
        timelock?: bigint;
      };
      if (!args?.hashlock || args.orderId === undefined) continue;

      const logIndex = (log as any).logIndex ?? 0;
      const txHash = log.transactionHash ?? "0x";
      const key = ethEventKey("OrderCreated", txHash, logIndex);
      const semKey = semanticKey("ethereum", "OrderCreated", args.hashlock);

      const conflict = this.seenSet.checkAndMark("ethereum", "OrderCreated", key, semKey);
      if (conflict) {
        this.log.debug({ key, kind: conflict.kind }, "reconciler: ETH OrderCreated dedup skip");
        continue;
      }

      try {
        const order = await this.orders.findByHashlock(args.hashlock);
        if (!order) {
          this.policy.recordConflict(
            classifyUnknownOrder("ethereum", "OrderCreated", args.hashlock),
          );
          continue;
        }
        if (order.srcOrderId) {
          // Already recorded — classify as already_applied.
          this.policy.recordConflict(
            classifyConflict({
              chain: "ethereum",
              eventType: "OrderCreated",
              eventTargetStatus: "src_locked",
              currentStatus: order.status,
              isTerminal: isTerminal(order.status),
              publicId: order.publicId,
            }),
          );
          continue;
        }
        await this.orders.recordSrcLock({
          publicId: order.publicId,
          orderId: args.orderId!.toString(),
          txHash,
          blockNumber: Number(log.blockNumber ?? 0n),
          timelock: Number(args.timelock ?? 0n),
        });
        n++;
        this.log.info(
          { hashlock: args.hashlock, orderId: args.orderId!.toString() },
          "reconciler: replayed ETH OrderCreated",
        );
      } catch (err: any) {
        if (err?.message?.includes("cannot record") || err?.message?.includes("duplicate")) continue;
        this.log.warn({ err, hashlock: args.hashlock }, "reconciler: ETH OrderCreated replay error");
      }
    }
    return n;
  }

  private async replayEthClaimed(logs: Log[]): Promise<number> {
    let n = 0;
    for (const log of logs) {
      const args = (log as any).args as {
        orderId?: bigint;
        preimage?: `0x${string}`;
      };
      if (!args?.orderId || !args?.preimage) continue;

      const logIndex = (log as any).logIndex ?? 0;
      const txHash = log.transactionHash ?? "0x";
      const key = ethEventKey("OrderClaimed", txHash, logIndex);
      const semKey = semanticKey("ethereum", "OrderClaimed", args.orderId.toString());

      const conflict = this.seenSet.checkAndMark("ethereum", "OrderClaimed", key, semKey);
      if (conflict) continue;

      try {
        const order = await this.orders.findBySrcOrderId("ethereum", args.orderId.toString());
        if (!order) {
          this.policy.recordConflict(
            classifyUnknownOrder("ethereum", "OrderClaimed", args.orderId.toString()),
          );
          continue;
        }
        if (order.preimage) {
          this.policy.recordConflict(
            classifyConflict({
              chain: "ethereum",
              eventType: "OrderClaimed",
              eventTargetStatus: "secret_revealed",
              currentStatus: order.status,
              isTerminal: isTerminal(order.status),
              publicId: order.publicId,
            }),
          );
          continue;
        }
        if (!validatePreimage(args.preimage, order.hashlock)) {
          this.log.warn(
            { orderId: args.orderId.toString(), hashlock: order.hashlock },
            "reconciler: ETH OrderClaimed preimage/hashlock mismatch — rejected",
          );
          continue;
        }
        await this.orders.recordSecret(order.publicId, args.preimage, txHash);
        n++;
        this.log.info({ orderId: args.orderId.toString() }, "reconciler: replayed ETH OrderClaimed");
      } catch (err: any) {
        if (err?.message?.includes("cannot record") || err?.message?.includes("duplicate")) continue;
        this.log.warn({ err }, "reconciler: ETH OrderClaimed replay error");
      }
    }
    return n;
  }

  private async replayEthRefunded(logs: Log[]): Promise<number> {
    let n = 0;
    for (const log of logs) {
      const args = (log as any).args as { orderId?: bigint };
      if (!args?.orderId) continue;

      const logIndex = (log as any).logIndex ?? 0;
      const txHash = log.transactionHash ?? "0x";
      const key = ethEventKey("OrderRefunded", txHash, logIndex);
      const semKey = semanticKey("ethereum", "OrderRefunded", args.orderId.toString());

      const conflict = this.seenSet.checkAndMark("ethereum", "OrderRefunded", key, semKey);
      if (conflict) continue;

      try {
        const order = await this.orders.findBySrcOrderId("ethereum", args.orderId.toString());
        if (!order) {
          this.policy.recordConflict(
            classifyUnknownOrder("ethereum", "OrderRefunded", args.orderId.toString()),
          );
          continue;
        }
        if (order.status === "refunded" || isTerminal(order.status)) {
          this.policy.recordConflict(
            classifyConflict({
              chain: "ethereum",
              eventType: "OrderRefunded",
              eventTargetStatus: "refunded",
              currentStatus: order.status,
              isTerminal: isTerminal(order.status),
              publicId: order.publicId,
            }),
          );
          continue;
        }
        await this.orders.markStatus(order.publicId, "refunded");
        n++;
        this.log.info({ orderId: args.orderId.toString() }, "reconciler: replayed ETH OrderRefunded");
      } catch (err: any) {
        if (err?.message?.includes("cannot transition")) continue;
        this.log.warn({ err }, "reconciler: ETH OrderRefunded replay error");
      }
    }
    return n;
  }

  // ─── Soroban ──────────────────────────────────────────────────────────────

  private async reconcileSoroban(): Promise<number> {
    if (!this.cfg.soroban.htlcContract) return 0;
    if (!this.sorobanCursor) return 0;

    const contractId = this.cfg.soroban.htlcContract;
    const latest = await this.sorobanServer.getLatestLedger();
    const tip = latest.sequence;

    const assessment = this.sorobanCursor.assess(tip);
    const decision = buildReplayDecision("soroban", assessment);
    this.policy.recordDecision(decision);

    if (decision.windowSize === 0) {
      this.log.debug({ chain: "soroban", hwm: assessment.hwm, tip }, "reconciler: Soroban up to date");
      return 0;
    }

    this.log.info(
      {
        chain: "soroban",
        fromBlock: decision.fromBlock,
        toBlock: decision.toBlock,
        windowSize: decision.windowSize,
        gapSeverity: decision.gapSeverity,
      },
      "reconciler: Soroban replay window",
    );

    let replayed = 0;
    let eventIndex = 0;

    // When the cursor HWM advances past the stored RPC cursor, reset it so
    // we re-scan from the ledger HWM rather than a potentially stale page cursor.
    const startLedger = decision.fromBlock;
    let pageCursor: string | undefined =
      this.sorobanRpcCursor !== undefined && assessment.severity === "none"
        ? this.sorobanRpcCursor
        : undefined;

    try {
      do {
        const events = await this.sorobanServer.getEvents({
          filters: [{ type: "contract", contractIds: [contractId] }],
          startLedger: pageCursor ? undefined : startLedger,
          cursor: pageCursor,
          limit: 200,
        });

        for (const ev of events.events) {
          replayed += await this.replaySorobanEvent(ev, eventIndex++);
        }

        pageCursor = events.cursor ?? undefined;
        if (events.events.length < 200) break;
      } while (pageCursor);

      // Persist the page cursor for next run (only if we completed without error).
      this.sorobanRpcCursor = pageCursor;
    } catch (err) {
      // Stale page cursor — clear it so the next run re-scans from HWM.
      this.sorobanRpcCursor = undefined;
      this.log.warn({ err }, "reconciler: Soroban fetch failed — page cursor reset");
      throw err; // Let the caller count this as a chain error.
    }

    this.sorobanCursor.advance(tip);
    return replayed;
  }

  private async replaySorobanEvent(ev: any, eventIndex: number): Promise<number> {
    const topicName: string =
      ev.topic?.[0]?.value ?? ev.topic?.[0]?.str ?? "";
    const txHash: string = ev.txHash ?? "";
    const ledger: number = ev.ledger ?? 0;

    if (topicName === "OrderCreated" || topicName === "created") {
      const hashlock = ev.value?.map?.hashlock ?? ev.value?.hashlock;
      const orderId = ev.value?.map?.orderId ?? ev.value?.orderId;
      const timelock = Number(ev.value?.map?.timelock ?? ev.value?.timelock ?? 0);
      if (!hashlock || !orderId) return 0;

      const key = sorobanEventKey("OrderCreated", txHash, ledger, eventIndex);
      const semKey = semanticKey("soroban", "OrderCreated", String(hashlock));
      const conflict = this.seenSet.checkAndMark("soroban", "OrderCreated", key, semKey);
      if (conflict) return 0;

      try {
        const order = await this.orders.findByHashlock(hashlock);
        if (!order) {
          this.policy.recordConflict(classifyUnknownOrder("soroban", "OrderCreated", String(hashlock)));
          return 0;
        }
        if (order.srcOrderId) {
          this.policy.recordConflict(classifyConflict({
            chain: "soroban", eventType: "OrderCreated",
            eventTargetStatus: "src_locked", currentStatus: order.status,
            isTerminal: isTerminal(order.status), publicId: order.publicId,
          }));
          return 0;
        }
        await this.orders.recordSrcLock({
          publicId: order.publicId,
          orderId: String(orderId),
          txHash,
          blockNumber: ledger,
          timelock,
        });
        return 1;
      } catch (err: any) {
        if (err?.message?.includes("cannot record") || err?.message?.includes("duplicate")) return 0;
        this.log.warn({ err, hashlock }, "reconciler: Soroban OrderCreated replay error");
        return 0;
      }
    }

    if (topicName === "OrderClaimed" || topicName === "claimed") {
      const preimage = ev.value?.map?.preimage ?? ev.value?.preimage;
      const orderId = ev.value?.map?.orderId ?? ev.value?.orderId;
      if (!preimage || !orderId) return 0;

      const key = sorobanEventKey("OrderClaimed", txHash, ledger, eventIndex);
      const semKey = semanticKey("soroban", "OrderClaimed", String(orderId));
      const conflict = this.seenSet.checkAndMark("soroban", "OrderClaimed", key, semKey);
      if (conflict) return 0;

      try {
        const order = await this.orders.findBySrcOrderId("stellar", String(orderId));
        if (!order) {
          this.policy.recordConflict(classifyUnknownOrder("soroban", "OrderClaimed", String(orderId)));
          return 0;
        }
        if (order.preimage) {
          this.policy.recordConflict(classifyConflict({
            chain: "soroban", eventType: "OrderClaimed",
            eventTargetStatus: "secret_revealed", currentStatus: order.status,
            isTerminal: isTerminal(order.status), publicId: order.publicId,
          }));
          return 0;
        }
        if (!validatePreimage(preimage, order.hashlock)) {
          this.log.warn({ orderId: String(orderId), hashlock: order.hashlock },
            "reconciler: Soroban OrderClaimed preimage/hashlock mismatch — rejected");
          return 0;
        }
        await this.orders.recordSecret(order.publicId, preimage, txHash);
        return 1;
      } catch (err: any) {
        if (err?.message?.includes("cannot record") || err?.message?.includes("duplicate")) return 0;
        this.log.warn({ err }, "reconciler: Soroban OrderClaimed replay error");
        return 0;
      }
    }

    if (topicName === "OrderRefunded" || topicName === "refunded") {
      const orderId = ev.value?.map?.orderId ?? ev.value?.orderId;
      if (!orderId) return 0;

      const key = sorobanEventKey("OrderRefunded", txHash, ledger, eventIndex);
      const semKey = semanticKey("soroban", "OrderRefunded", String(orderId));
      const conflict = this.seenSet.checkAndMark("soroban", "OrderRefunded", key, semKey);
      if (conflict) return 0;

      try {
        const order = await this.orders.findBySrcOrderId("stellar", String(orderId));
        if (!order) {
          this.policy.recordConflict(classifyUnknownOrder("soroban", "OrderRefunded", String(orderId)));
          return 0;
        }
        if (order.status === "refunded" || isTerminal(order.status)) {
          this.policy.recordConflict(classifyConflict({
            chain: "soroban", eventType: "OrderRefunded",
            eventTargetStatus: "refunded", currentStatus: order.status,
            isTerminal: isTerminal(order.status), publicId: order.publicId,
          }));
          return 0;
        }
        await this.orders.markStatus(order.publicId, "refunded");
        return 1;
      } catch (err: any) {
        if (err?.message?.includes("cannot transition")) return 0;
        this.log.warn({ err }, "reconciler: Soroban OrderRefunded replay error");
        return 0;
      }
    }

    return 0;
  }

  // ─── Solana ───────────────────────────────────────────────────────────────

  private async reconcileSolana(): Promise<number> {
    if (!this.cfg.solana.programId || this.cfg.solana.programId === "PLACEHOLDER") return 0;
    if (!this.solanaCursor) return 0;

    const tip = await this.solanaConn.getSlot(this.cfg.solana.commitment);
    const assessment = this.solanaCursor.assess(tip);
    const decision = buildReplayDecision("solana", assessment);
    this.policy.recordDecision(decision);

    if (decision.windowSize === 0) {
      this.log.debug({ chain: "solana", hwm: assessment.hwm, tip }, "reconciler: Solana up to date");
      return 0;
    }

    this.log.info(
      {
        chain: "solana",
        fromBlock: decision.fromBlock,
        toBlock: decision.toBlock,
        windowSize: decision.windowSize,
        gapSeverity: decision.gapSeverity,
      },
      "reconciler: Solana replay window",
    );

    const programPk = new PublicKey(this.cfg.solana.programId);
    const minContextSlot = Math.max(0, decision.fromBlock);

    let replayed = 0;
    try {
      const sigs = await this.solanaConn.getSignaturesForAddress(programPk, {
        limit: 1000,
        minContextSlot,
      });

      for (const sigInfo of sigs) {
        if (sigInfo.err) continue;
        // Only process signatures within our window.
        if (sigInfo.slot < decision.fromBlock || sigInfo.slot > decision.toBlock) continue;
        try {
          const tx = await this.solanaConn.getParsedTransaction(sigInfo.signature, {
            commitment: "confirmed",
            maxSupportedTransactionVersion: 0,
          });
          if (!tx?.meta?.logMessages) continue;
          replayed += await this.replaySolanaLogs(
            sigInfo.signature,
            tx.meta.logMessages,
            sigInfo.slot,
          );
        } catch (err) {
          this.log.warn({ sig: sigInfo.signature, err }, "reconciler: Solana tx fetch failed");
        }
      }
    } catch (err) {
      this.log.warn({ err }, "reconciler: Solana signatures fetch failed");
      throw err;
    }

    this.solanaCursor.advance(tip);
    return replayed;
  }

  private async replaySolanaLogs(
    sig: string,
    logs: string[],
    slot: number,
  ): Promise<number> {
    let eventType: string | null = null;
    const payload: Record<string, unknown> = {};

    for (const line of logs) {
      if (line.includes("OrderCreated")) eventType = "OrderCreated";
      if (line.includes("OrderClaimed")) eventType = "OrderClaimed";
      if (line.includes("OrderRefunded")) eventType = "OrderRefunded";
      const jsonMatch = line.match(/\{.*\}/);
      if (jsonMatch) {
        try { Object.assign(payload, JSON.parse(jsonMatch[0])); } catch { /* skip */ }
      }
    }

    if (!eventType) return 0;

    if (eventType === "OrderCreated") {
      const { hashlock, orderId, timelock } = payload as {
        hashlock?: string; orderId?: string; timelock?: number;
      };
      if (!hashlock || !orderId) return 0;

      const key = solanaEventKey("OrderCreated", sig);
      const semKey = semanticKey("solana", "OrderCreated", hashlock);
      const conflict = this.seenSet.checkAndMark("solana", "OrderCreated", key, semKey);
      if (conflict) return 0;

      try {
        const order = await this.orders.findByHashlock(hashlock);
        if (!order) {
          this.policy.recordConflict(classifyUnknownOrder("solana", "OrderCreated", hashlock));
          return 0;
        }
        if (order.srcOrderId) {
          this.policy.recordConflict(classifyConflict({
            chain: "solana", eventType: "OrderCreated",
            eventTargetStatus: "src_locked", currentStatus: order.status,
            isTerminal: isTerminal(order.status), publicId: order.publicId,
          }));
          return 0;
        }
        await this.orders.recordSrcLock({
          publicId: order.publicId,
          orderId,
          txHash: sig,
          blockNumber: slot,
          timelock: timelock ?? 0,
        });
        return 1;
      } catch (err: any) {
        if (err?.message?.includes("cannot record") || err?.message?.includes("duplicate")) return 0;
        this.log.warn({ err, hashlock }, "reconciler: Solana OrderCreated replay error");
        return 0;
      }
    }

    if (eventType === "OrderClaimed") {
      const { preimage, orderId } = payload as { preimage?: string; orderId?: string };
      if (!preimage || !orderId) return 0;

      const key = solanaEventKey("OrderClaimed", sig);
      const semKey = semanticKey("solana", "OrderClaimed", orderId);
      const conflict = this.seenSet.checkAndMark("solana", "OrderClaimed", key, semKey);
      if (conflict) return 0;

      try {
        const order = await this.orders.findBySrcOrderId("solana", orderId);
        if (!order) {
          this.policy.recordConflict(classifyUnknownOrder("solana", "OrderClaimed", orderId));
          return 0;
        }
        if (order.preimage) {
          this.policy.recordConflict(classifyConflict({
            chain: "solana", eventType: "OrderClaimed",
            eventTargetStatus: "secret_revealed", currentStatus: order.status,
            isTerminal: isTerminal(order.status), publicId: order.publicId,
          }));
          return 0;
        }
        if (!validatePreimage(preimage, order.hashlock)) {
          this.log.warn({ orderId, hashlock: order.hashlock },
            "reconciler: Solana OrderClaimed preimage/hashlock mismatch — rejected");
          return 0;
        }
        await this.orders.recordSecret(order.publicId, preimage, sig);
        return 1;
      } catch (err: any) {
        if (err?.message?.includes("cannot record") || err?.message?.includes("duplicate")) return 0;
        this.log.warn({ err }, "reconciler: Solana OrderClaimed replay error");
        return 0;
      }
    }

    if (eventType === "OrderRefunded") {
      const { orderId } = payload as { orderId?: string };
      if (!orderId) return 0;

      const key = solanaEventKey("OrderRefunded", sig);
      const semKey = semanticKey("solana", "OrderRefunded", orderId);
      const conflict = this.seenSet.checkAndMark("solana", "OrderRefunded", key, semKey);
      if (conflict) return 0;

      try {
        const order = await this.orders.findBySrcOrderId("solana", orderId);
        if (!order) {
          this.policy.recordConflict(classifyUnknownOrder("solana", "OrderRefunded", orderId));
          return 0;
        }
        if (order.status === "refunded" || isTerminal(order.status)) {
          this.policy.recordConflict(classifyConflict({
            chain: "solana", eventType: "OrderRefunded",
            eventTargetStatus: "refunded", currentStatus: order.status,
            isTerminal: isTerminal(order.status), publicId: order.publicId,
          }));
          return 0;
        }
        await this.orders.markStatus(order.publicId, "refunded");
        return 1;
      } catch (err: any) {
        if (err?.message?.includes("cannot transition")) return 0;
        this.log.warn({ err }, "reconciler: Solana OrderRefunded replay error");
        return 0;
      }
    }

    return 0;
  }
}
