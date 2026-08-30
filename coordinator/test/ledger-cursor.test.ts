import { describe, it, expect } from "vitest";
import {
  LedgerCursor,
  createLedgerCursor,
  type GapSeverity,
} from "../src/reconciliation/ledger-cursor.js";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Build a cursor with a 1 000-unit lookback window and the given initial HWM. */
function cursor(initialHwm = 0, lookback = 1_000): LedgerCursor {
  return new LedgerCursor("ethereum", lookback, initialHwm);
}

// ─────────────────────────────────────────────────────────────────────────────
// Construction & accessors
// ─────────────────────────────────────────────────────────────────────────────

describe("LedgerCursor — construction", () => {
  it("getHwm() returns the initial HWM", () => {
    expect(cursor(5_000).getHwm()).toBe(5_000);
  });

  it("getHwm() returns 0 when no initial HWM provided", () => {
    expect(cursor().getHwm()).toBe(0);
  });

  it("getLookbackWindow() returns the configured lookback", () => {
    expect(cursor(0, 14_400).getLookbackWindow()).toBe(14_400);
  });

  it("getLookbackExceededCount() starts at 0", () => {
    expect(cursor(0).getLookbackExceededCount()).toBe(0);
  });

  it("createLedgerCursor factory produces a correctly seeded cursor", () => {
    const c = createLedgerCursor("soroban", 34_560, 100_000);
    expect(c.getHwm()).toBe(100_000);
    expect(c.getLookbackWindow()).toBe(34_560);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// advance()
// ─────────────────────────────────────────────────────────────────────────────

describe("LedgerCursor.advance()", () => {
  it("advances the HWM to a higher value", () => {
    const c = cursor(100);
    c.advance(200);
    expect(c.getHwm()).toBe(200);
  });

  it("is a no-op when called with a value equal to the current HWM", () => {
    const c = cursor(100);
    c.advance(100);
    expect(c.getHwm()).toBe(100);
  });

  it("is a no-op when called with a value below the current HWM (no regression)", () => {
    const c = cursor(500);
    c.advance(100);
    expect(c.getHwm()).toBe(500);
  });

  it("can be called multiple times — only the highest value wins", () => {
    const c = cursor(0);
    c.advance(300);
    c.advance(200); // lower — no-op
    c.advance(400);
    expect(c.getHwm()).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// seed()
// ─────────────────────────────────────────────────────────────────────────────

describe("LedgerCursor.seed()", () => {
  it("unconditionally sets the HWM", () => {
    const c = cursor(500);
    c.seed(100); // lower than current HWM — still applied
    expect(c.getHwm()).toBe(100);
  });

  it("can seed to 0 to reset the cursor", () => {
    const c = cursor(999);
    c.seed(0);
    expect(c.getHwm()).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// assess() — severity classification
// ─────────────────────────────────────────────────────────────────────────────

describe("LedgerCursor.assess() — gap severity", () => {
  const lookback = 1_000;

  it("severity=none when tip equals HWM", () => {
    const c = cursor(5_000, lookback);
    const a = c.assess(5_000);
    expect(a.severity).toBe<GapSeverity>("none");
    expect(a.gap).toBe(0);
    expect(a.lookbackExceeded).toBe(false);
  });

  it("severity=none when tip is behind HWM (already ahead)", () => {
    const c = cursor(5_000, lookback);
    const a = c.assess(4_999);
    expect(a.severity).toBe<GapSeverity>("none");
    expect(a.gap).toBe(0);
  });

  it("severity=normal for gap == 1 (one block behind)", () => {
    const c = cursor(5_000, lookback);
    const a = c.assess(5_001);
    expect(a.severity).toBe<GapSeverity>("normal");
    expect(a.gap).toBe(1);
    expect(a.lookbackExceeded).toBe(false);
  });

  it("severity=normal for gap == lookback (exactly at window boundary)", () => {
    const c = cursor(5_000, lookback);
    const a = c.assess(6_000); // gap == 1000 == lookback
    expect(a.severity).toBe<GapSeverity>("normal");
    expect(a.gap).toBe(lookback);
  });

  it("severity=large for gap == lookback + 1", () => {
    const c = cursor(5_000, lookback);
    const a = c.assess(6_001); // gap == 1001
    expect(a.severity).toBe<GapSeverity>("large");
  });

  it("severity=large for gap == 2 × lookback (exactly at the exceeded boundary)", () => {
    const c = cursor(5_000, lookback);
    const a = c.assess(7_000); // gap == 2000 == 2 × lookback
    expect(a.severity).toBe<GapSeverity>("large");
    expect(a.lookbackExceeded).toBe(false);
  });

  it("severity=exceeded for gap == 2 × lookback + 1", () => {
    const c = cursor(5_000, lookback);
    const a = c.assess(7_001); // gap == 2001 > 2 × lookback
    expect(a.severity).toBe<GapSeverity>("exceeded");
    expect(a.lookbackExceeded).toBe(true);
  });

  it("severity=exceeded for a very large gap", () => {
    const c = cursor(0, lookback);
    const a = c.assess(100_000);
    expect(a.severity).toBe<GapSeverity>("exceeded");
    expect(a.lookbackExceeded).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// assess() — fromBlock computation
// ─────────────────────────────────────────────────────────────────────────────

describe("LedgerCursor.assess() — fromBlock", () => {
  const lookback = 1_000;

  it("fromBlock == HWM when gap is within the lookback window", () => {
    const c = cursor(5_000, lookback);
    const a = c.assess(5_500); // gap == 500 <= lookback
    expect(a.fromBlock).toBe(5_000);
  });

  it("fromBlock == HWM when gap equals the large boundary (2 × lookback)", () => {
    const c = cursor(5_000, lookback);
    const a = c.assess(7_000); // gap == 2000 == 2 × lookback
    expect(a.fromBlock).toBe(5_000);
  });

  it("fromBlock falls back to tip - lookback when gap exceeds 2 × lookback", () => {
    const c = cursor(5_000, lookback);
    const a = c.assess(10_000); // gap == 5000 > 2 × lookback
    expect(a.fromBlock).toBe(10_000 - lookback);
  });

  it("fromBlock is 0 when the fallback would be negative (early chain history)", () => {
    const c = cursor(0, 14_400);
    const a = c.assess(1_000); // tip < lookback
    // gap == 1000 <= 14400 — no exceeded, fromBlock == hwm == 0
    expect(a.fromBlock).toBe(0);
  });

  it("fromBlock is 0 clamped when HWM=0 and tip < lookback", () => {
    // lookback=5000, tip=3000 → gap=3000 ≤ lookback 5000 → 'normal', fromBlock=HWM=0
    const c = cursor(0, 5_000);
    const a = c.assess(3_000);
    expect(a.severity).toBe<GapSeverity>("normal");
    expect(a.fromBlock).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// assess() — lookbackExceededCount
// ─────────────────────────────────────────────────────────────────────────────

describe("LedgerCursor — lookbackExceededCount", () => {
  it("increments on each exceeded assessment", () => {
    const c = cursor(0, 100);
    c.assess(500);  // exceeded
    c.assess(600);  // exceeded
    expect(c.getLookbackExceededCount()).toBe(2);
  });

  it("does NOT increment for normal or large gaps", () => {
    const c = cursor(0, 100);
    c.assess(50);   // normal
    c.assess(150);  // large (exactly 2 × lookback)
    expect(c.getLookbackExceededCount()).toBe(0);
  });

  it("increments even when assess() is called in the same run multiple times", () => {
    const c = cursor(0, 100);
    for (let i = 0; i < 5; i++) c.assess(10_000); // all exceeded
    expect(c.getLookbackExceededCount()).toBe(5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// assess() — tip / hwm fields in returned assessment
// ─────────────────────────────────────────────────────────────────────────────

describe("LedgerCursor.assess() — returned fields", () => {
  it("populates tip and hwm accurately", () => {
    const c = cursor(1_234, 500);
    const a = c.assess(2_000);
    expect(a.tip).toBe(2_000);
    expect(a.hwm).toBe(1_234);
  });

  it("gap matches tip - hwm for positive gaps", () => {
    const c = cursor(1_000, 500);
    const a = c.assess(1_700);
    expect(a.gap).toBe(700);
  });

  it("gap is 0 (never negative) when tip < hwm", () => {
    const c = cursor(5_000, 500);
    const a = c.assess(4_000);
    expect(a.gap).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveFromBlock()
// ─────────────────────────────────────────────────────────────────────────────

describe("LedgerCursor.resolveFromBlock()", () => {
  it("returns HWM for a gap within the lookback window", () => {
    const c = cursor(5_000, 1_000);
    expect(c.resolveFromBlock(5_500)).toBe(5_000);
  });

  it("returns tip - lookback for an exceeded gap", () => {
    const c = cursor(0, 1_000);
    expect(c.resolveFromBlock(10_000)).toBe(9_000);
  });

  it("returns the same value as assess(tip).fromBlock", () => {
    const c = cursor(3_000, 500);
    const tip = 4_500;
    expect(c.resolveFromBlock(tip)).toBe(c.assess(tip).fromBlock);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Boundary values — lookback = 1 (pathological)
// ─────────────────────────────────────────────────────────────────────────────

describe("LedgerCursor — lookback=1 boundary", () => {
  it("gap of 1 is normal (== lookback)", () => {
    const c = cursor(100, 1);
    expect(c.assess(101).severity).toBe("normal");
  });

  it("gap of 2 is large (== 2 × lookback)", () => {
    const c = cursor(100, 1);
    expect(c.assess(102).severity).toBe("large");
  });

  it("gap of 3 is exceeded (> 2 × lookback)", () => {
    const c = cursor(100, 1);
    const a = c.assess(103);
    expect(a.severity).toBe("exceeded");
    expect(a.lookbackExceeded).toBe(true);
    expect(a.fromBlock).toBe(102); // 103 - 1
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Real-world scenario: Ethereum 48-hour lookback
// ─────────────────────────────────────────────────────────────────────────────

describe("LedgerCursor — Ethereum real-world scenario", () => {
  const ETH_LOOKBACK = 14_400; // ~48h at 12s/block

  it("seed from DB + tip just ahead → normal gap, fromBlock == seed", () => {
    const dbHwm = 20_000_000;
    const c = createLedgerCursor("ethereum", ETH_LOOKBACK, dbHwm);
    const a = c.assess(20_001_000); // 1000-block gap — well within window
    expect(a.severity).toBe("normal");
    expect(a.fromBlock).toBe(dbHwm);
    expect(a.lookbackExceeded).toBe(false);
  });

  it("seed from DB + 3-day gap → exceeded, falls back to tip - lookback", () => {
    const dbHwm = 19_500_000;
    const currentTip = 20_000_000; // gap = 500 000 >> 2 × 14400
    const c = createLedgerCursor("ethereum", ETH_LOOKBACK, dbHwm);
    const a = c.assess(currentTip);
    expect(a.severity).toBe("exceeded");
    expect(a.fromBlock).toBe(currentTip - ETH_LOOKBACK);
    expect(a.lookbackExceeded).toBe(true);
  });

  it("no prior DB records (HWM=0) → normal when tip < lookback", () => {
    const c = createLedgerCursor("ethereum", ETH_LOOKBACK, 0);
    const a = c.assess(10_000); // fresh testnet with few blocks
    expect(a.severity).toBe("normal");
    expect(a.fromBlock).toBe(0);
  });

  it("cursor advances correctly after replay", () => {
    const c = createLedgerCursor("ethereum", ETH_LOOKBACK, 20_000_000);
    c.advance(20_005_000);
    const a = c.assess(20_005_000);
    expect(a.severity).toBe("none");
    expect(a.gap).toBe(0);
  });
});
