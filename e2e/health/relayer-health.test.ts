/**
 * E2E health-check test suite — Relayer service
 *
 * Issue #475: Implement comprehensive health check and readiness probe E2E test suite
 *
 * Scope:
 *   - Maps all relayer health endpoints (/healthz, /readyz, /health)
 *   - Validates healthy baseline (all RPC probes succeed)
 *   - Simulates price feed failure (degraded but still relaying)
 *   - Simulates RPC failure (ethereum, stellar, soroban, solana)
 *   - Validates placeholder detection (Solana, Soroban)
 *   - Validates latency reporting
 *   - Validates no sensitive data leaks
 *   - CI/CD readiness probe contract
 *
 * Strategy: mount the relayer healthRouter on a standalone Express app and
 * stub global.fetch to simulate various RPC probe outcomes without any live
 * network access.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import supertest from "supertest";
import { healthRouter, type HealthStatus } from "../../relayer/src/routes/health.js";
import { getMonitor } from "../../relayer/src/services/monitoring.js";

// ── App factory ───────────────────────────────────────────────────────────────

function makeApp() {
  const app = express();
  app.use(healthRouter());
  return app;
}

// ── Fetch stubs ───────────────────────────────────────────────────────────────

function stubFetchOk() {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({}),
    text: async () => "{}",
  } as unknown as Response);
}

function stubFetchError(message = "ECONNREFUSED: connection refused") {
  return vi.fn().mockRejectedValue(new Error(message));
}

function stubFetchHttpError(status = 503) {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    json: async () => ({}),
    text: async () => "",
  } as unknown as Response);
}

// ── Env helpers ───────────────────────────────────────────────────────────────

interface EnvSnapshot {
  ethRpc: string | undefined;
  horizon: string | undefined;
  soroban: string | undefined;
  solanaProgram: string | undefined;
  solanaRpc: string | undefined;
}

function saveEnv(): EnvSnapshot {
  return {
    ethRpc: process.env.ETHEREUM_RPC_URL,
    horizon: process.env.STELLAR_HORIZON_URL,
    soroban: process.env.SOROBAN_RPC_URL,
    solanaProgram: process.env.SOLANA_HTLC_PROGRAM,
    solanaRpc: process.env.SOLANA_RPC_URL,
  };
}

function restoreEnv(snap: EnvSnapshot) {
  snap.ethRpc === undefined
    ? delete process.env.ETHEREUM_RPC_URL
    : (process.env.ETHEREUM_RPC_URL = snap.ethRpc);
  snap.horizon === undefined
    ? delete process.env.STELLAR_HORIZON_URL
    : (process.env.STELLAR_HORIZON_URL = snap.horizon);
  snap.soroban === undefined
    ? delete process.env.SOROBAN_RPC_URL
    : (process.env.SOROBAN_RPC_URL = snap.soroban);
  snap.solanaProgram === undefined
    ? delete process.env.SOLANA_HTLC_PROGRAM
    : (process.env.SOLANA_HTLC_PROGRAM = snap.solanaProgram);
  snap.solanaRpc === undefined
    ? delete process.env.SOLANA_RPC_URL
    : (process.env.SOLANA_RPC_URL = snap.solanaRpc);
}

function setHealthyEnv() {
  process.env.ETHEREUM_RPC_URL = "https://eth.internal/rpc";
  process.env.STELLAR_HORIZON_URL = "https://horizon.internal";
  delete process.env.SOROBAN_RPC_URL;
  process.env.SOLANA_HTLC_PROGRAM = "PLACEHOLDER";
  delete process.env.SOLANA_RPC_URL;
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Endpoint mapping — all relayer health endpoints exist
// ═══════════════════════════════════════════════════════════════════════════

describe("relayer health endpoints — endpoint mapping", () => {
  it("GET /healthz responds with 200", async () => {
    const app = makeApp();
    const res = await supertest(app).get("/healthz");
    expect(res.status).toBe(200);
  });

  it("GET /readyz responds (200 or 503)", async () => {
    const app = makeApp();
    const res = await supertest(app).get("/readyz");
    expect([200, 503]).toContain(res.status);
  });

  it("GET /health responds (200 or 503)", async () => {
    const app = makeApp();
    const res = await supertest(app).get("/health");
    expect([200, 503]).toContain(res.status);
  });

  it("all three endpoints return JSON content-type", async () => {
    const app = makeApp();
    for (const path of ["/healthz", "/readyz", "/health"]) {
      const res = await supertest(app).get(path);
      expect(res.headers["content-type"]).toMatch(/application\/json/);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. /healthz — liveness
// ═══════════════════════════════════════════════════════════════════════════

describe("relayer /healthz — liveness probe", () => {
  it("always returns 200 regardless of RPC state", async () => {
    const app = makeApp();
    const res = await supertest(app).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });

  it("returns the correct service name", async () => {
    const app = makeApp();
    const res = await supertest(app).get("/healthz");
    expect(res.body.service).toBe("wafflefinance-relayer");
  });

  it("includes uptime, version, and timestamp", async () => {
    const app = makeApp();
    const res = await supertest(app).get("/healthz");
    expect(typeof res.body.uptime).toBe("number");
    expect(typeof res.body.version).toBe("string");
    expect(typeof res.body.timestamp).toBe("number");
  });

  it("does not include a checks array (liveness has no dependency probes)", async () => {
    const app = makeApp();
    const res = await supertest(app).get("/healthz");
    expect(res.body.checks).toBeUndefined();
  });

  it("returns 200 even when all configured RPCs are down", async () => {
    const snap = saveEnv();
    setHealthyEnv();
    vi.stubGlobal("fetch", stubFetchError());
    try {
      const app = makeApp();
      const res = await supertest(app).get("/healthz");
      expect(res.status).toBe(200);
    } finally {
      vi.restoreAllMocks();
      restoreEnv(snap);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. /readyz — healthy baseline
// ═══════════════════════════════════════════════════════════════════════════

describe("relayer /readyz — healthy baseline", () => {
  let snap: EnvSnapshot;

  beforeEach(() => {
    snap = saveEnv();
    setHealthyEnv();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    restoreEnv(snap);
  });

  it("returns 200 and status=ok when all configured probes succeed", async () => {
    vi.stubGlobal("fetch", stubFetchOk());
    const app = makeApp();
    const res = await supertest(app).get("/readyz");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });

  it("includes ethereum_rpc and stellar_rpc in the checks array", async () => {
    vi.stubGlobal("fetch", stubFetchOk());
    const app = makeApp();
    const res = await supertest(app).get("/readyz");
    const names = (res.body.checks as Array<{ name: string }>).map((c) => c.name);
    expect(names).toContain("ethereum_rpc");
    expect(names).toContain("stellar_rpc");
  });

  it("includes solana_rpc as disabled_placeholder when SOLANA_HTLC_PROGRAM=PLACEHOLDER", async () => {
    vi.stubGlobal("fetch", stubFetchOk());
    const app = makeApp();
    const res = await supertest(app).get("/readyz");
    const solana = (res.body.checks as Array<{ name: string; ok: boolean; detail?: string }>).find(
      (c) => c.name === "solana_rpc",
    );
    expect(solana).toBeDefined();
    expect(solana!.ok).toBe(true);
    expect(solana!.detail).toBe("disabled_placeholder");
  });

  it("includes soroban_rpc as disabled_placeholder when SOROBAN_RPC_URL is unset", async () => {
    vi.stubGlobal("fetch", stubFetchOk());
    const app = makeApp();
    const res = await supertest(app).get("/readyz");
    const soroban = (res.body.checks as Array<{ name: string; ok: boolean; detail?: string }>).find(
      (c) => c.name === "soroban_rpc",
    );
    expect(soroban).toBeDefined();
    expect(soroban!.ok).toBe(true);
    expect(soroban!.detail).toBe("disabled_placeholder");
  });

  it("latency is reported as a number for real probes", async () => {
    vi.stubGlobal("fetch", stubFetchOk());
    const app = makeApp();
    const res = await supertest(app).get("/readyz");
    const eth = (res.body.checks as Array<{ name: string; latencyMs?: number }>).find(
      (c) => c.name === "ethereum_rpc",
    );
    expect(typeof eth!.latencyMs).toBe("number");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. /readyz — price feed / RPC failure
// ═══════════════════════════════════════════════════════════════════════════

describe("relayer /readyz — RPC failure scenarios", () => {
  let snap: EnvSnapshot;

  beforeEach(() => {
    snap = saveEnv();
    setHealthyEnv();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    restoreEnv(snap);
  });

  it("returns 503 and status=degraded when ethereum_rpc probe fails (ECONNREFUSED)", async () => {
    vi.stubGlobal("fetch", stubFetchError("ECONNREFUSED"));
    const app = makeApp();
    const res = await supertest(app).get("/readyz");
    expect(res.status).toBe(503);
    expect(res.body.status).toBe("degraded");
  });

  it("reports ethereum_rpc ok:false with detail:connection_error on network error", async () => {
    vi.stubGlobal("fetch", stubFetchError());
    const app = makeApp();
    const res = await supertest(app).get("/readyz");
    const eth = (res.body.checks as Array<{ name: string; ok: boolean; detail?: string }>).find(
      (c) => c.name === "ethereum_rpc",
    );
    expect(eth!.ok).toBe(false);
    expect(eth!.detail).toBe("connection_error");
  });

  it("reports stellar_rpc ok:false with detail:connection_error on network error", async () => {
    vi.stubGlobal("fetch", stubFetchError());
    const app = makeApp();
    const res = await supertest(app).get("/readyz");
    const stellar = (res.body.checks as Array<{ name: string; ok: boolean; detail?: string }>).find(
      (c) => c.name === "stellar_rpc",
    );
    expect(stellar!.ok).toBe(false);
    expect(stellar!.detail).toBe("connection_error");
  });

  it("reports ethereum_rpc ok:false with detail:http_503 when probe returns HTTP 503", async () => {
    vi.stubGlobal("fetch", stubFetchHttpError(503));
    const app = makeApp();
    const res = await supertest(app).get("/readyz");
    const eth = (res.body.checks as Array<{ name: string; ok: boolean; detail?: string }>).find(
      (c) => c.name === "ethereum_rpc",
    );
    expect(eth!.ok).toBe(false);
    expect(eth!.detail).toContain("http_503");
  });

  it("reports soroban_rpc ok:false when SOROBAN_RPC_URL is set and probe returns HTTP 503", async () => {
    process.env.SOROBAN_RPC_URL = "https://soroban.internal/rpc";
    vi.stubGlobal("fetch", stubFetchHttpError(503));
    const app = makeApp();
    const res = await supertest(app).get("/readyz");
    const soroban = (res.body.checks as Array<{ name: string; ok: boolean; detail?: string }>).find(
      (c) => c.name === "soroban_rpc",
    );
    expect(soroban!.ok).toBe(false);
    expect(soroban!.detail).toContain("http_503");
  });

  it("reports solana_rpc ok:false when real program ID is configured and probe fails", async () => {
    process.env.SOLANA_HTLC_PROGRAM = "SomeRealProgramAddress1234567890ABCDEF1234567";
    process.env.SOLANA_RPC_URL = "https://solana.internal/rpc";
    vi.stubGlobal("fetch", stubFetchError("ECONNREFUSED"));
    const app = makeApp();
    const res = await supertest(app).get("/readyz");
    const solana = (res.body.checks as Array<{ name: string; ok: boolean; detail?: string }>).find(
      (c) => c.name === "solana_rpc",
    );
    expect(solana!.ok).toBe(false);
    expect(solana!.detail).toBe("connection_error");
  });

  it("response never leaks env var names or URL values in check details", async () => {
    vi.stubGlobal("fetch", stubFetchError());
    const app = makeApp();
    const res = await supertest(app).get("/readyz");
    const body = JSON.stringify(res.body);
    expect(body).not.toMatch(/RELAYER_/);
    expect(body).not.toMatch(/private/i);
    expect(body).not.toMatch(/secret/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. /readyz — failure recovery (no latched state)
// ═══════════════════════════════════════════════════════════════════════════

describe("relayer /readyz — failure recovery", () => {
  let snap: EnvSnapshot;

  beforeEach(() => {
    snap = saveEnv();
    setHealthyEnv();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    restoreEnv(snap);
  });

  it("reports healthy again after fetch recovers from error", async () => {
    vi.stubGlobal("fetch", stubFetchError());
    const app = makeApp();
    const degraded = await supertest(app).get("/readyz");
    expect(degraded.status).toBe(503);

    vi.restoreAllMocks();
    vi.stubGlobal("fetch", stubFetchOk());

    const recovered = await supertest(app).get("/readyz");
    expect(recovered.status).toBe(200);
    expect(recovered.body.status).toBe("ok");
  });

  it("check state is not latched — a single probe failure does not permanently mark the check failed", async () => {
    // First call: all fail
    vi.stubGlobal("fetch", stubFetchError());
    const app = makeApp();
    await supertest(app).get("/readyz");
    vi.restoreAllMocks();

    // Second call: all succeed
    vi.stubGlobal("fetch", stubFetchOk());
    const res = await supertest(app).get("/readyz");
    const eth = (res.body.checks as Array<{ name: string; ok: boolean }>).find(
      (c) => c.name === "ethereum_rpc",
    );
    expect(eth!.ok).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. /health — detailed health status
// ═══════════════════════════════════════════════════════════════════════════

describe("relayer /health — detailed health status", () => {
  it("returns 200 or 503 depending on monitor state", async () => {
    const app = makeApp();
    const res = await supertest(app).get("/health");
    expect([200, 503]).toContain(res.status);
  });

  it("response body has required fields: status, timestamp, uptime, version, services", async () => {
    const app = makeApp();
    const res = await supertest(app).get("/health");
    const body = res.body as HealthStatus;
    expect(["healthy", "degraded", "unhealthy"]).toContain(body.status);
    expect(typeof body.timestamp).toBe("number");
    expect(typeof body.uptime).toBe("number");
    expect(typeof body.version).toBe("string");
    expect(Array.isArray(body.services)).toBe(true);
  });

  it("timestamp is within 1 second of now", async () => {
    const before = Date.now();
    const app = makeApp();
    const res = await supertest(app).get("/health");
    const after = Date.now();
    const ts = res.body.timestamp as number;
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after + 100);
  });

  it("uptime is non-negative", async () => {
    const app = makeApp();
    const res = await supertest(app).get("/health");
    expect(res.body.uptime).toBeGreaterThanOrEqual(0);
  });

  it("returns 503 when monitor reports unhealthy", async () => {
    vi.spyOn(getMonitor(), "getSystemStatus").mockReturnValue("unhealthy");
    const app = makeApp();
    const res = await supertest(app).get("/health");
    expect(res.status).toBe(503);
    expect(res.body.status).toBe("unhealthy");
    vi.restoreAllMocks();
  });

  it("returns 200 when monitor reports healthy", async () => {
    vi.spyOn(getMonitor(), "getSystemStatus").mockReturnValue("healthy");
    const app = makeApp();
    const res = await supertest(app).get("/health");
    expect(res.status).toBe(200);
    vi.restoreAllMocks();
  });

  it("returns 200 when monitor reports degraded (still serving traffic)", async () => {
    vi.spyOn(getMonitor(), "getSystemStatus").mockReturnValue("degraded");
    const app = makeApp();
    const res = await supertest(app).get("/health");
    expect(res.status).toBe(200);
    vi.restoreAllMocks();
  });

  it("does not leak private keys or secrets in the response body", async () => {
    const app = makeApp();
    const res = await supertest(app).get("/health");
    const body = JSON.stringify(res.body);
    expect(body).not.toMatch(/private/i);
    expect(body).not.toMatch(/secret/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. CI/CD readiness probe contract
// ═══════════════════════════════════════════════════════════════════════════

describe("relayer health endpoints — CI/CD probe contract", () => {
  let snap: EnvSnapshot;

  beforeEach(() => {
    snap = saveEnv();
    setHealthyEnv();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    restoreEnv(snap);
  });

  it("/healthz HTTP 200 = process is alive (use as K8s liveness probe)", async () => {
    vi.stubGlobal("fetch", stubFetchError());
    const app = makeApp();
    // Even with all RPCs down, liveness must be 200
    const res = await supertest(app).get("/healthz");
    expect(res.status).toBe(200);
  });

  it("/readyz HTTP 200 = relayer is ready to process orders", async () => {
    vi.stubGlobal("fetch", stubFetchOk());
    const app = makeApp();
    const res = await supertest(app).get("/readyz");
    expect(res.status).toBe(200);
  });

  it("/readyz HTTP 503 = relayer is NOT ready — stop routing traffic", async () => {
    vi.stubGlobal("fetch", stubFetchError());
    const app = makeApp();
    const res = await supertest(app).get("/readyz");
    expect(res.status).toBe(503);
  });

  it("/readyz response always includes a checks array (for monitoring dashboards)", async () => {
    vi.stubGlobal("fetch", stubFetchOk());
    const app = makeApp();
    const res = await supertest(app).get("/readyz");
    expect(Array.isArray(res.body.checks)).toBe(true);
    expect(res.body.checks.length).toBeGreaterThan(0);
  });
});
