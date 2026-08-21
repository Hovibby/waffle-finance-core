import { keccak256, sha256 } from "viem";

export type Hex = `0x${string}`;

export type OrderStatus = "Funded" | "Claimed" | "Refunded";

export interface CreateOrderInput {
  hashlock: Hex;
  timelockSeconds: number;
}

export interface OrderView {
  id: bigint;
  hashlock: Hex;
  timelockAbsolute: number;
  status: OrderStatus;
  createdAt: number;
  finalisedAt: number;
}

export type SimErrorCode =
  | "InvalidHashlock"
  | "InvalidTimelock"
  | "OrderNotFound"
  | "OrderNotClaimable"
  | "OrderNotRefundable"
  | "InvalidPreimage"
  | "Expired"
  | "NotExpired"
  | "AlreadyClaimed"
  | "AlreadyRefunded";

export class SimError extends Error {
  constructor(public readonly code: SimErrorCode) {
    super(code);
    this.name = "SimError";
  }
}

export interface HtlcSim {
  readonly name: "evm" | "soroban" | "solana";
  createOrder(input: CreateOrderInput): bigint;
  claimOrder(id: bigint, preimage: Hex): void;
  refundOrder(id: bigint): void;
  getOrder(id: bigint): OrderView;
  advanceTime(seconds: number): void;
}

// Mirrors the [MIN_TIMELOCK, MAX_TIMELOCK] bounds enforced by both
// HTLCEscrow.sol and the Soroban htlc contract.
const MIN_TIMELOCK = 300;
const MAX_TIMELOCK = 24 * 60 * 60;

abstract class BaseHtlcSim {
  protected readonly orders = new Map<bigint, OrderView>();
  protected nextId = 1n;
  protected now: number;

  constructor() {
    this.now = Math.floor(Date.now() / 1000);
  }

  advanceTime(seconds: number): void {
    this.now += seconds;
  }

  createOrder(input: CreateOrderInput): bigint {
    if (!/^0x[0-9a-fA-F]{64}$/.test(input.hashlock) || /^0x0+$/.test(input.hashlock)) {
      throw new SimError("InvalidHashlock");
    }
    if (input.timelockSeconds < MIN_TIMELOCK || input.timelockSeconds > MAX_TIMELOCK) {
      throw new SimError("InvalidTimelock");
    }
    const id = this.nextId++;
    this.orders.set(id, {
      id,
      hashlock: input.hashlock,
      timelockAbsolute: this.now + input.timelockSeconds,
      status: "Funded",
      createdAt: this.now,
      finalisedAt: 0
    });
    return id;
  }

  getOrder(id: bigint): OrderView {
    const o = this.orders.get(id);
    if (!o) throw new SimError("OrderNotFound");
    return { ...o };
  }

  protected getMutable(id: bigint): OrderView {
    const o = this.orders.get(id);
    if (!o) throw new SimError("OrderNotFound");
    return o;
  }

  refundOrder(id: bigint): void {
    const o = this.getMutable(id);
    if (o.status !== "Funded") throw new SimError("OrderNotRefundable");
    if (this.now <= o.timelockAbsolute) throw new SimError("NotExpired");
    o.status = "Refunded";
    o.finalisedAt = this.now;
  }
}

/**
 * Faithful re-encoding of HTLCEscrow.sol's claim/refund branch logic.
 * The contract accepts a preimage if EITHER sha256(preimage) OR
 * keccak256(preimage) equals the stored hashlock, which is how a
 * single hashlock can interop with Soroban (sha256-only) and classic
 * keccak-flavoured EVM counterparties.
 */
export class EvmHtlcSim extends BaseHtlcSim implements HtlcSim {
  readonly name = "evm" as const;

  claimOrder(id: bigint, preimage: Hex): void {
    const o = this.getMutable(id);
    if (o.status !== "Funded") throw new SimError("OrderNotClaimable");
    if (this.now > o.timelockAbsolute) throw new SimError("Expired");
    const sha = sha256(preimage);
    const kek = keccak256(preimage);
    if (sha !== o.hashlock && kek !== o.hashlock) {
      throw new SimError("InvalidPreimage");
    }
    o.status = "Claimed";
    o.finalisedAt = this.now;
  }
}

/**
 * Faithful re-encoding of the Soroban wafflefinance-htlc claim branch. The
 * Soroban contract accepts a preimage only when sha256(preimage) equals
 * the stored hashlock — keccak256 is not consulted.
 */
export class SorobanHtlcSim extends BaseHtlcSim implements HtlcSim {
  readonly name = "soroban" as const;

  claimOrder(id: bigint, preimage: Hex): void {
    const o = this.getMutable(id);
    if (o.status !== "Funded") throw new SimError("OrderNotClaimable");
    if (this.now > o.timelockAbsolute) throw new SimError("Expired");
    const sha = sha256(preimage);
    if (sha !== o.hashlock) {
      throw new SimError("InvalidPreimage");
    }
    o.status = "Claimed";
    o.finalisedAt = this.now;
  }
}

/**
 * Faithful simulation of the Solana HTLC Anchor program's claim branch.
 *
 * Claim semantics mirror the Soroban contract exactly: only sha256(preimage)
 * is accepted as the valid hashlock.  keccak256-only hashlocks will be
 * rejected.  This is intentional — the `sol_to_eth` cross-chain route MUST
 * use sha256 end-to-end to satisfy both the Solana program and the EVM
 * HTLCEscrow contract's sha256 branch.
 *
 * Timelock semantics match the EVM and Soroban simulators: the timelock is an
 * absolute unix-seconds deadline, refund is only permitted after expiry, and
 * claim is only permitted before expiry.
 *
 * The Solana program uses 12-hour / 24-hour timelocks for the src/dst legs
 * respectively (see README). This simulator accepts any value within
 * [MIN_TIMELOCK, MAX_TIMELOCK] to stay chain-agnostic.
 */
export class SolanaHtlcSim extends BaseHtlcSim implements HtlcSim {
  readonly name = "solana" as const;

  claimOrder(id: bigint, preimage: Hex): void {
    const o = this.getMutable(id);
    if (o.status !== "Funded") throw new SimError("OrderNotClaimable");
    if (this.now > o.timelockAbsolute) throw new SimError("Expired");
    const sha = sha256(preimage);
    if (sha !== o.hashlock) {
      throw new SimError("InvalidPreimage");
    }
    o.status = "Claimed";
    o.finalisedAt = this.now;
  }
}

// ── Async interface for live-network devnet simulators ───────────────────────

/**
 * Async counterpart of HtlcSim for real-network devnet implementations.
 *
 * createOrder / claimOrder / refundOrder / getOrder are async because they
 * submit on-chain transactions and wait for confirmation. advanceTime is
 * retained as a synchronous no-op — time advances naturally on live networks.
 */
export interface AsyncHtlcSim {
  readonly name: "evm" | "soroban" | "solana";
  createOrder(input: CreateOrderInput): Promise<bigint>;
  claimOrder(id: bigint, preimage: Hex): Promise<void>;
  refundOrder(id: bigint): Promise<void>;
  getOrder(id: bigint): Promise<OrderView>;
  advanceTime(seconds: number): void;
}
