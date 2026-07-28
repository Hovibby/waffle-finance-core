import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import pino from "pino";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { openDatabase } from "../src/persistence/db.js";
import { OrdersRepository } from "../src/persistence/orders-repo.js";
import { OrderService } from "../src/services/order-service.js";
import { decideDispatch, type WorkflowPath } from "../src/services/workflow-priority-policy.js";

const log = pino({ level: "silent" });
const VALID_ETH_ADDR = "0x1111111111111111111111111111111111111111";
const VALID_STELLAR_ADDR = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB422";

async function freshOrders() {
  const dir = mkdtempSync(resolve(tmpdir(), "wafflefinance-priority-test-"));
  const db = await openDatabase(`file:${dir}/test.db`);
  return new OrderService(new OrdersRepository(db), log);
}

async function seedOrder(orders: OrderService, hashlock: string) {
  return orders.announce({
    direction: "eth_to_xlm",
    hashlock,
    srcChain: "ethereum",
    srcAddress: VALID_ETH_ADDR,
    srcAsset: "native",
    srcAmount: "1",
    srcSafetyDeposit: "1",
    dstChain: "stellar",
    dstAddress: VALID_STELLAR_ADDR,
    dstAsset: "native",
    dstAmount: "1",
  });
}

describe("workflow priority policy", () => {
  it("prefers live over replay when sequence is equal", () => {
    const decision = decideDispatch({
      path: "replay",
      mutation: "src_lock",
      incomingSequence: 100,
      existingSequence: 100,
      alreadyApplied: false,
    });
    expect(decision.shouldApply).toBe(false);
    expect(decision.reason).toBe("lower_priority");
  });

  it("skips stale sequence even if source is replay", () => {
    const decision = decideDispatch({
      path: "replay",
      mutation: "src_lock",
      incomingSequence: 99,
      existingSequence: 100,
      alreadyApplied: false,
    });
    expect(decision.shouldApply).toBe(false);
    expect(decision.reason).toBe("stale_sequence");
  });
});

describe("deterministic overlap outcome", () => {
  const preimageBuf = Buffer.alloc(32, 0xdd);
  const preimage = "0x" + preimageBuf.toString("hex");
  const hashlock = "0x" + createHash("sha256").update(preimageBuf).digest("hex");

  type Event = {
    path: WorkflowPath;
    kind: "created" | "secret";
    seq: number;
  };

  async function runScenario(sequence: Event[]) {
    const orders = await freshOrders();
    const order = await seedOrder(orders, hashlock);

    for (const evt of sequence) {
      const current = await orders.get(order.publicId);
      if (!current) continue;

      if (evt.kind === "created") {
        const decision = decideDispatch({
          path: evt.path,
          mutation: "src_lock",
          incomingSequence: evt.seq,
          existingSequence: current.srcLockBlock,
          alreadyApplied: current.srcOrderId !== null,
        });
        if (!decision.shouldApply) continue;
        await orders.recordSrcLock({
          publicId: order.publicId,
          orderId: "42",
          txHash: "0xlock",
          blockNumber: evt.seq,
          timelock: 9999,
        });
        continue;
      }

      const decision = decideDispatch({
        path: evt.path,
        mutation: "secret_reveal",
        incomingSequence: evt.seq,
        existingSequence: null,
        alreadyApplied: current.preimage !== null,
      });
      if (!decision.shouldApply) continue;
      try {
        await orders.recordSecret(order.publicId, preimage, "0xclaim");
      } catch {
        // Out-of-order secret before src lock is expected in overlap tests.
      }
    }

    return orders.get(order.publicId);
  }

  it("reaches identical final state across live/replay ingestion order", async () => {
    const sequenceA: Event[] = [
      { path: "live", kind: "created", seq: 100 },
      { path: "replay", kind: "created", seq: 100 },
      { path: "live", kind: "secret", seq: 101 },
      { path: "replay", kind: "secret", seq: 101 },
    ];
    const sequenceB: Event[] = [
      { path: "replay", kind: "secret", seq: 101 },
      { path: "replay", kind: "created", seq: 100 },
      { path: "live", kind: "created", seq: 100 },
      { path: "live", kind: "secret", seq: 101 },
    ];

    const finalA = await runScenario(sequenceA);
    const finalB = await runScenario(sequenceB);

    expect(finalA?.status).toBe("secret_revealed");
    expect(finalB?.status).toBe("secret_revealed");
    expect(finalA?.srcOrderId).toBe(finalB?.srcOrderId);
    expect(finalA?.preimage).toBe(finalB?.preimage);
  });
});
