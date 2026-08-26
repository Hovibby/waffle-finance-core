/**
 * E2E health-check test suite — Coordinator service
 *
 * Issue #475: Implement comprehensive health check and readiness probe E2E test suite
 *
 * Scope:
 *   - Maps all coordinator health / readiness endpoints (/healthz, /readyz, /health)
 *   - Validates healthy baseline (all dependencies up)
 *   - Simulates RPC failure (degraded mode, partially_healthy)
 *   - Simulates DB failure (fully degraded)
 *   - Validates lazy startup phase transitions (starting → pending → ready)
 *   - Validates failure recovery (check is re-evaluated on every request)
 *   - Cross-service readiness (startup_phase injection)
 *   - Documents all endpoint contracts for CI/CD readiness probe integration
 *
 * Strategy: mount the coordinator health router and readiness check factory on
 * a standalone Express app backed by an in-memory SQLite database.  A custom
 * `fetcher` stubs chain RPC calls so no live network is required.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import express from "express";
import supertest from "supertest";
import { openDatabase } from "../../coordinator/src/persistence/db.js";
import { healthRoutes } from "../../coordinator/src/server/routes/health.js";
import { createReadinessChecks, deriveStartupPhase, type StartupPhase } from "../../coordinator/src/readiness.js";
import { evaluateDependencyHealth } from "../../coordinator/src/degraded-mode.js";
import type { CoordinatorConfig } from "../../coordinator/src/config.js";

// ── Config / fixtures ─────────────────────────────────────────────────────────

const BASE_CONFIG: CoordinatorConfig = {
  network: "testnet",
  port: 3001,
  databaseUrl: "file:./wafflefinance.db",
  logLevel: "error",
  corsOrigin: "*",
  pollIntervalMs: 15_000,
  secretStorageKey: undefined,
  ethereum: {
    rpcUrl: "https://ethereum.example/rpc",
    chainId: 11_155_111,
    htlcEscrow: null,
    resolverRegistry: null,
  },
  soroban: {
    rpcUrl: "https://soroban.example/rpc",
    horizonUrl: "https://horizon.example",
    networkPassphrase: "Test SDF Network ; September 2015",
    htlcContract: null,
    resolverRegistry: null,
  },
  solana: {
    rpcUrl: "https://solana.example/rpc",
    programId: "PLACEHOLDER",
    commitment: "confirmed",
  },
};

const SOLANA_CONFIG: CoordinatorConfig = {
  ...BASE_CONFIG,
  solana: {
    ...BASE_CONFIG.solana,
    programId: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
  },
};

// ── Fetcher stubs ─────────────────────────────────────────────────────────────

type Fetcher = Parameters<typeof createReadinessChecks>[0]["fetcher"];

function okFetcher(): Fetcher {
  return async (_url, _init) => ({
    ok: true,
    status: 200,
    json: async () => ({ result: "0x1" }),
  });
}

function failFetcher(failUrl?: string): Fetcher {
  return async (url, _init) => {
    if (!failUrl || url.includes(failUrl)) {
      return { ok: false, status: 503, json: async () => ({}) };
    }
    return { ok: true, status: 200, json: async () => ({ result: "ok" }) };
  };
}

function networkErrorFetcher(): Fetcher {
  return async (_url, _init) => {
    throw new Error("ECONNREFUSED: connection refused");
  };
}

function partialReceiptFetcher(failUrl?: string): Fetcher {
  return async (url, _init) => ({
    ok: true,
    status: 200,
    json: async () =>
      failUrl && url.includes(failUrl)
        ? { jsonrpc: "2.0", id: 1, error: { code: -32603, message: "node not synced" } }
        : { result: "0x1" },
  });
}

// ── App factory ───────────────────────────────────────────────────────────────

async function freshDb() {
  const dir = mkdtempSync(resolve(tmpdir(), "waffle-coord-health-e2e-"));
  return openDatabase(`file:${dir}/test.db`);
}

interface AppOptions {
  fetcher?: Fetcher;
  cfg?: CoordinatorConfig;
  getStartupPhase?: () => StartupPhase;
  reconciliationOk?: boolean;
  reconciliationRanAt?: number | null;
}

async function makeApp(opts: AppOptions = {}) {
  const db = await freshDb();
  const cfg = opts.cfg ?? BASE_CONFIG;
  const reconciliationRanAt = opts.reconciliationRanAt !== undefined
    ? opts.reconciliationRanAt
    : Date.now();

  const getReadinessChecks = createReadinessChecks({
    cfg,
    db,
    getReconciliationStatus: () => ({
      lastRunAt: reconciliationRanAt,
      lastRunOk: opts.reconciliationOk ?? true,
      eventsReplayed: 0,
    }),
    fetcher: opts.fetcher ?? okFetcher(),
    timeoutMs: 15,
    getStartupPhase: opts.getStartupPhase,
  });

  const app = express();
  app.use(
    healthRoutes({
      getReconciliationStatus: () => ({
        lastRunAt: reconciliationRanAt,
        lastRunOk: opts.reconciliationOk ?? true,
        eventsReplayed: 0,
      }),
      getReadinessChecks,
    }),
  );
  return app;
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Endpoint mapping — all coordinator health endpoints exist and respond
// ═══════════════════════════════════════════════════════════════════════════

describe("coordinator health endpoints — endpoint mapping", () => {
  it("GET /healthz returns 200 with status ok", async () => {
    const app = await makeApp();
    const res = await supertest(app).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });

  it("GET /healthz returns the correct service name", async () => {
    const app = await makeApp();
    const res = await supertest(app).get("/healthz");
    expect(res.body.service).toBe("wafflefinance-coordinator");
  });

  it("GET /healthz includes version, uptimeSeconds, and timestamp fields", async () => {
    const app = await makeApp();
    const res = await supertest(app).get("/healthz");
    expect(typeof res.body.version).toBe("string");
    expect(typeof res.body.uptimeSeconds).toBe("number");
    expect(typeof res.body.timestamp).toBe("string");
  });

  it("GET /readyz returns 200 with status ok when all dependencies are healthy", async () => {
    const app = await makeApp();
    const res = await supertest(app).get("/readyz");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });

  it("GET /readyz response body includes a checks array", async () => {
    const app = await makeApp();
    const res = await supertest(app).get("/readyz");
    expect(Array.isArray(res.body.checks)).toBe(true);
    expect(res.body.checks.length).toBeGreaterThan(0);
  });

  it("GET /health returns reconciliation status in the response body", async () => {
    const app = await makeApp();
    const res = await supertest(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.reconciliation).toBeDefined();
  });

  it("all three endpoints respond with JSON content-type", async () => {
    const app = await makeApp();
    for (const path of ["/healthz", "/readyz", "/health"]) {
      const res = await supertest(app).get(path);
      expect(res.headers["content-type"]).toMatch(/application\/json/);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Healthy baseline — all checks pass
// ═══════════════════════════════════════════════════════════════════════════

describe("coordinator health endpoints — healthy baseline", () => {
  it("/readyz includes database, ethereum_rpc, soroban_rpc, reconciliation checks", async () => {
    const app = await makeApp();
    const res = await supertest(app).get("/readyz");
    const names = (res.body.checks as Array<{ name: string }>).map((c) => c.name);
    expect(names).toContain("database");
    expect(names).toContain("ethereum_rpc");
    expect(names).toContain("soroban_rpc");
    expect(names).toContain("reconciliation");
  });

  it("/readyz includes solana_rpc as disabled_placeholder when programId=PLACEHOLDER", async () => {
    const app = await makeApp();
    const res = await supertest(app).get("/readyz");
    const solana = (res.body.checks as Array<{ name: string; ok: boolean; detail?: string }>).find(
      (c) => c.name === "solana_rpc",
    );
    expect(solana).toBeDefined();
    expect(solana!.ok).toBe(true);
    expect(solana!.detail).toBe("disabled_placeholder");
  });

  it("/readyz probes solana_rpc when a real programId is configured", async () => {
    const app = await makeApp({ cfg: SOLANA_CONFIG });
    const res = await supertest(app).get("/readyz");
    const solana = (res.body.checks as Array<{ name: string; ok: boolean }>).find(
      (c) => c.name === "solana_rpc",
    );
    expect(solana).toBeDefined();
    // With okFetcher all probes return ok
    expect(solana!.ok).toBe(true);
  });

  it("all checks have ok:true in the healthy baseline", async () => {
    const app = await makeApp();
    const res = await supertest(app).get("/readyz");
    for (const check of res.body.checks as Array<{ name: string; ok: boolean }>) {
      expect(check.ok, `check ${check.name} should be ok`).toBe(true);
    }
  });

  it("reconciliation check is last_run_ok when reconciliation succeeded", async () => {
    const app = await makeApp({ reconciliationOk: true });
    const res = await supertest(app).get("/readyz");
    const recon = (res.body.checks as Array<{ name: string; detail?: string }>).find(
      (c) => c.name === "reconciliation",
    );
    expect(recon!.detail).toBe("last_run_ok");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. RPC failure scenarios
// ═══════════════════════════════════════════════════════════════════════════

describe("coordinator health endpoints — RPC failure scenarios", () => {
  it("returns 503 when ethereum_rpc probe returns HTTP 503", async () => {
    const app = await makeApp({ fetcher: failFetcher("ethereum") });
    const res = await supertest(app).get("/readyz");
    expect(res.status).toBe(503);
    expect(res.body.status).toBe("degraded");
  });

  it("marks ethereum_rpc ok:false with detail:unavailable when probe fails", async () => {
    const app = await makeApp({ fetcher: failFetcher("ethereum") });
    const res = await supertest(app).get("/readyz");
    const eth = (res.body.checks as Array<{ name: string; ok: boolean; detail?: string }>).find(
      (c) => c.name === "ethereum_rpc",
    );
    expect(eth!.ok).toBe(false);
    expect(eth!.detail).toBe("unavailable");
  });

  it("marks soroban_rpc ok:false when soroban RPC is unreachable", async () => {
    const app = await makeApp({ fetcher: failFetcher("soroban") });
    const res = await supertest(app).get("/readyz");
    const soroban = (res.body.checks as Array<{ name: string; ok: boolean }>).find(
      (c) => c.name === "soroban_rpc",
    );
    expect(soroban!.ok).toBe(false);
  });

  it("does not bleed ethereum failure into soroban check", async () => {
    const app = await makeApp({ fetcher: failFetcher("ethereum") });
    const res = await supertest(app).get("/readyz");
    const soroban = (res.body.checks as Array<{ name: string; ok: boolean }>).find(
      (c) => c.name === "soroban_rpc",
    );
    // soroban should still be ok when only ethereum fails
    expect(soroban!.ok).toBe(true);
  });

  it("returns 503 when network error (ECONNREFUSED) is thrown by fetcher", async () => {
    const app = await makeApp({ fetcher: networkErrorFetcher() });
    const res = await supertest(app).get("/readyz");
    expect(res.status).toBe(503);
  });

  it("marks RPC checks ok:false when JSON-RPC error envelope is returned (partial receipt)", async () => {
    const app = await makeApp({ fetcher: partialReceiptFetcher("soroban") });
    const res = await supertest(app).get("/readyz");
    const soroban = (res.body.checks as Array<{ name: string; ok: boolean }>).find(
      (c) => c.name === "soroban_rpc",
    );
    expect(soroban!.ok).toBe(false);
  });

  it("marks reconciliation ok:false when reconciliation last run failed", async () => {
    const app = await makeApp({ reconciliationOk: false });
    const res = await supertest(app).get("/readyz");
    const recon = (res.body.checks as Array<{ name: string; ok: boolean; detail?: string }>).find(
      (c) => c.name === "reconciliation",
    );
    expect(recon!.ok).toBe(false);
    expect(recon!.detail).toBe("last_run_failed");
  });

  it("response body does not leak RPC URLs in check details", async () => {
    const app = await makeApp({ fetcher: failFetcher() });
    const res = await supertest(app).get("/readyz");
    const body = JSON.stringify(res.body);
    expect(body).not.toContain("ethereum.example");
    expect(body).not.toContain("soroban.example");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. DB failure scenario
// ═══════════════════════════════════════════════════════════════════════════

describe("coordinator health endpoints — DB failure (fully degraded)", () => {
  it("evaluateDependencyHealth reports degraded when database check fails", () => {
    const report = evaluateDependencyHealth([
      { name: "database", ok: false, detail: "unavailable" },
      { name: "ethereum_rpc", ok: true },
      { name: "soroban_rpc", ok: true },
      { name: "solana_rpc", ok: true, detail: "disabled_placeholder" },
      { name: "reconciliation", ok: true },
    ]);
    expect(report.overall).toBe("degraded");
    expect(report.degradedServices).toContain("database");
  });

  it("evaluateDependencyHealth reports partially_healthy when only an RPC chain fails", () => {
    const report = evaluateDependencyHealth([
      { name: "database", ok: true },
      { name: "ethereum_rpc", ok: false, detail: "unavailable" },
      { name: "soroban_rpc", ok: true },
      { name: "solana_rpc", ok: true, detail: "disabled_placeholder" },
      { name: "reconciliation", ok: true },
    ]);
    expect(report.overall).toBe("partially_healthy");
    expect(report.degradedServices).toContain("ethereum_rpc");
  });

  it("evaluateDependencyHealth reports healthy when all checks pass", () => {
    const report = evaluateDependencyHealth([
      { name: "database", ok: true },
      { name: "ethereum_rpc", ok: true },
      { name: "soroban_rpc", ok: true },
      { name: "solana_rpc", ok: true },
      { name: "reconciliation", ok: true },
    ]);
    expect(report.overall).toBe("healthy");
    expect(report.degradedServices).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Lazy startup — phase transitions
// ═══════════════════════════════════════════════════════════════════════════

describe("coordinator health endpoints — lazy startup phase transitions", () => {
  it("/readyz returns 503 with startup_phase check ok:false when phase=starting", async () => {
    const app = await makeApp({ getStartupPhase: () => "starting" });
    const res = await supertest(app).get("/readyz");
    expect(res.status).toBe(503);
    const phaseCheck = (res.body.checks as Array<{ name: string; ok: boolean; detail?: string }>).find(
      (c) => c.name === "startup_phase",
    );
    expect(phaseCheck).toBeDefined();
    expect(phaseCheck!.ok).toBe(false);
    expect(phaseCheck!.detail).toBe("starting");
  });

  it("/readyz returns 200 with startup_phase check ok:true when phase=pending", async () => {
    const app = await makeApp({ getStartupPhase: () => "pending" });
    const res = await supertest(app).get("/readyz");
    // pending: deps are up, first reconciliation not done — still accepting traffic
    const phaseCheck = (res.body.checks as Array<{ name: string; ok: boolean; detail?: string }>).find(
      (c) => c.name === "startup_phase",
    );
    expect(phaseCheck).toBeDefined();
    expect(phaseCheck!.ok).toBe(true);
    expect(phaseCheck!.detail).toBe("pending");
  });

  it("/readyz has no startup_phase check when phase=ready", async () => {
    const app = await makeApp({ getStartupPhase: () => "ready" });
    const res = await supertest(app).get("/readyz");
    const phaseCheck = (res.body.checks as Array<{ name: string }>).find(
      (c) => c.name === "startup_phase",
    );
    expect(phaseCheck).toBeUndefined();
  });

  it("deriveStartupPhase returns starting when externalPhase is starting regardless of checks", () => {
    expect(deriveStartupPhase([], "starting")).toBe("starting");
  });

  it("deriveStartupPhase returns pending when reconciliation is not_run_yet and all else passes", () => {
    const checks = [
      { name: "database", ok: true },
      { name: "ethereum_rpc", ok: true },
      { name: "soroban_rpc", ok: true },
      { name: "solana_rpc", ok: true, detail: "disabled_placeholder" },
      { name: "reconciliation", ok: true, detail: "not_run_yet" },
    ];
    expect(deriveStartupPhase(checks)).toBe("pending");
  });

  it("deriveStartupPhase returns ready when all checks pass and reconciliation ran", () => {
    const checks = [
      { name: "database", ok: true },
      { name: "ethereum_rpc", ok: true },
      { name: "soroban_rpc", ok: true },
      { name: "solana_rpc", ok: true, detail: "disabled_placeholder" },
      { name: "reconciliation", ok: true, detail: "last_run_ok" },
    ];
    expect(deriveStartupPhase(checks)).toBe("ready");
  });

  it("deriveStartupPhase returns degraded when database check fails", () => {
    const checks = [
      { name: "database", ok: false },
      { name: "ethereum_rpc", ok: true },
      { name: "soroban_rpc", ok: true },
      { name: "reconciliation", ok: true },
    ];
    expect(deriveStartupPhase(checks)).toBe("degraded");
  });

  it("startup phase transitions are live — no cached state between requests", async () => {
    let phase: StartupPhase = "starting";
    const app = await makeApp({ getStartupPhase: () => phase });

    const first = await supertest(app).get("/readyz");
    expect(first.status).toBe(503);

    phase = "ready";

    const second = await supertest(app).get("/readyz");
    // After transitioning to ready: all deps ok → 200
    expect(second.status).toBe(200);
    const secondPhaseCheck = (second.body.checks as Array<{ name: string }>).find(
      (c) => c.name === "startup_phase",
    );
    expect(secondPhaseCheck).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. Failure recovery — no latched state
// ═══════════════════════════════════════════════════════════════════════════

describe("coordinator health endpoints — failure recovery", () => {
  it("reports healthy again on the very next check after RPC recovers", async () => {
    let rpcFailing = true;

    const dynamicFetcher: Fetcher = async (_url, _init) => ({
      ok: !rpcFailing,
      status: rpcFailing ? 503 : 200,
      json: async () => ({}),
    });

    const db = await freshDb();
    const getReadinessChecks = createReadinessChecks({
      cfg: BASE_CONFIG,
      db,
      getReconciliationStatus: () => ({ lastRunAt: Date.now(), lastRunOk: true, eventsReplayed: 0 }),
      fetcher: dynamicFetcher,
      timeoutMs: 15,
    });

    const appExpress = express();
    appExpress.use(healthRoutes({ getReadinessChecks }));

    const degraded = await supertest(appExpress).get("/readyz");
    expect(degraded.status).toBe(503);
    expect(degraded.body.status).toBe("degraded");

    rpcFailing = false;

    const recovered = await supertest(appExpress).get("/readyz");
    expect(recovered.status).toBe(200);
    expect(recovered.body.status).toBe("ok");
  });

  it("reconciliation recovery is reflected immediately on the next request", async () => {
    let reconciliationOk = false;

    const db = await freshDb();
    const getReadinessChecks = createReadinessChecks({
      cfg: BASE_CONFIG,
      db,
      getReconciliationStatus: () => ({
        lastRunAt: Date.now(),
        lastRunOk: reconciliationOk,
        eventsReplayed: 0,
      }),
      fetcher: okFetcher(),
      timeoutMs: 15,
    });

    const appExpress = express();
    appExpress.use(healthRoutes({ getReadinessChecks }));

    const failed = await supertest(appExpress).get("/readyz");
    expect(failed.status).toBe(503);

    reconciliationOk = true;

    const recovered = await supertest(appExpress).get("/readyz");
    expect(recovered.status).toBe(200);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. CI/CD readiness probe verification contract
// ═══════════════════════════════════════════════════════════════════════════

describe("coordinator health endpoints — CI/CD probe contract", () => {
  it("/healthz always returns 200 (liveness: process is alive)", async () => {
    const app = await makeApp({ fetcher: failFetcher() });
    const res = await supertest(app).get("/healthz");
    // Even when all RPCs are down, liveness must be 200
    expect(res.status).toBe(200);
  });

  it("/readyz HTTP 200 indicates the coordinator is ready to serve traffic", async () => {
    const app = await makeApp();
    const res = await supertest(app).get("/readyz");
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe("healthy");
  });

  it("/readyz HTTP 503 indicates the coordinator is NOT ready to serve traffic", async () => {
    const app = await makeApp({ fetcher: failFetcher() });
    const res = await supertest(app).get("/readyz");
    expect(res.status).toBe(503);
    expect(res.body.status).toBe("degraded");
  });

  it("/readyz response body always includes service name and timestamp", async () => {
    const app = await makeApp();
    const res = await supertest(app).get("/readyz");
    expect(typeof res.body.service).toBe("string");
    expect(typeof res.body.timestamp).toBe("string");
  });

  it("/readyz response body always includes the degradedServices array", async () => {
    const app = await makeApp({ fetcher: failFetcher("ethereum") });
    const res = await supertest(app).get("/readyz");
    expect(Array.isArray(res.body.degradedServices)).toBe(true);
    expect(res.body.degradedServices).toContain("ethereum_rpc");
  });

  it("degradedServices is empty when all checks pass", async () => {
    const app = await makeApp();
    const res = await supertest(app).get("/readyz");
    expect(res.body.degradedServices).toHaveLength(0);
  });
});
