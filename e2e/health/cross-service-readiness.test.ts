/**
 * E2E health-check test suite — Cross-service readiness
 *
 * Issue #475: Implement comprehensive health check and readiness probe E2E test suite
 *
 * Scope:
 *   - Cross-service readiness: all three services (coordinator, relayer, resolver)
 *     individually healthy
 *   - Cross-service readiness: one service degraded does not false-positive others
 *   - Graceful degradation: system degrades gracefully when individual service
 *     components fail
 *   - Recovery: all services recover independently when their dependencies come back
 *   - Documentation: readiness probe interpretation matrix
 *
 * Strategy: exercise each service's health infrastructure in isolation within the
 * same process using the same in-memory patterns as the per-service tests, then
 * validate that the status of each is independently correct (no cross-contamination).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import express from "express";
import supertest from "supertest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

// Coordinator
import { openDatabase } from "../../coordinator/src/persistence/db.js";
import { healthRoutes as coordinatorHealthRoutes } from "../../coordinator/src/server/routes/health.js";
import { createReadinessChecks } from "../../coordinator/src/readiness.js";
import type { CoordinatorConfig } from "../../coordinator/src/config.js";

// Relayer
import { healthRouter as relayerHealthRouter } from "../../relayer/src/routes/health.js";

// Resolver
import { createResolverHealthServer } from "../../resolver/src/health.js";
import { Supervisor } from "../../resolver/src/supervisor.js";
import type { ResolverConfig } from "../../resolver/src/config.js";

// ── Shared config ─────────────────────────────────────────────────────────────

const COORDINATOR_CFG: CoordinatorConfig = {
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

const RESOLVER_CFG: ResolverConfig = {
  network: "testnet",
  pollIntervalMs: 15_000,
  coordinatorUrl: "http://localhost:3001",
  logLevel: "error",
  ethereum: {
    rpcUrl: "https://ethereum.example/rpc",
    chainId: 11_155_111,
    htlcEscrow: "0x0000000000000000000000000000000000000001",
    resolverRegistry: null,
    resolverPrivateKey:
      "0x0000000000000000000000000000000000000000000000000000000000000001",
  },
  soroban: {
    rpcUrl: "https://soroban.example/rpc",
    horizonUrl: "https://horizon.example",
    networkPassphrase: "Test SDF Network ; September 2015",
    htlc: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB",
    resolverRegistry: null,
    resolverSecret: "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  },
};

const log = { child: () => log, error: () => {}, warn: () => {}, info: () => {} } as any;

// ── Fetcher stubs ─────────────────────────────────────────────────────────────

type Fetcher = Parameters<typeof createReadinessChecks>[0]["fetcher"];

const okFetcher: Fetcher = async () => ({
  ok: true,
  status: 200,
  json: async () => ({ result: "ok" }),
});

const failFetcher: Fetcher = async () => ({
  ok: false,
  status: 503,
  json: async () => ({}),
});

// ── Factory helpers ───────────────────────────────────────────────────────────

async function freshCoordinatorApp(fetcher: Fetcher = okFetcher, reconciliationOk = true) {
  const dir = mkdtempSync(resolve(tmpdir(), "waffle-cross-svc-"));
  const db = await openDatabase(`file:${dir}/test.db`);
  const getReadinessChecks = createReadinessChecks({
    cfg: COORDINATOR_CFG,
    db,
    getReconciliationStatus: () => ({
      lastRunAt: Date.now(),
      lastRunOk: reconciliationOk,
      eventsReplayed: 0,
    }),
    fetcher,
    timeoutMs: 15,
  });
  const app = express();
  app.use(
    coordinatorHealthRoutes({
      getReconciliationStatus: () => ({
        lastRunAt: Date.now(),
        lastRunOk: reconciliationOk,
        eventsReplayed: 0,
      }),
      getReadinessChecks,
    }),
  );
  return app;
}

function makeRelayerApp() {
  const app = express();
  app.use(relayerHealthRouter());
  return app;
}

async function startResolverServer(cfg: ResolverConfig = RESOLVER_CFG) {
  const supervisor = new Supervisor({ log });
  const server: Server = createResolverHealthServer({ cfg, supervisor, startedAt: Date.now() });
  await new Promise<void>((r) => server.listen(0, r));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    supervisor,
    server,
    stop: () => new Promise<void>((r) => server.close(() => r())),
  };
}

// Relayer env helpers
function setRelayerEnv() {
  process.env.ETHEREUM_RPC_URL = "https://eth.internal/rpc";
  process.env.STELLAR_HORIZON_URL = "https://horizon.internal";
  delete process.env.SOROBAN_RPC_URL;
  process.env.SOLANA_HTLC_PROGRAM = "PLACEHOLDER";
  delete process.env.SOLANA_RPC_URL;
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Cross-service — all three services individually healthy
// ═══════════════════════════════════════════════════════════════════════════

describe("cross-service readiness — all services healthy", () => {
  let savedEnv: Record<string, string | undefined>;
  let resolverHandle: Awaited<ReturnType<typeof startResolverServer>>;

  beforeEach(async () => {
    savedEnv = {
      ETHEREUM_RPC_URL: process.env.ETHEREUM_RPC_URL,
      STELLAR_HORIZON_URL: process.env.STELLAR_HORIZON_URL,
      SOROBAN_RPC_URL: process.env.SOROBAN_RPC_URL,
      SOLANA_HTLC_PROGRAM: process.env.SOLANA_HTLC_PROGRAM,
      SOLANA_RPC_URL: process.env.SOLANA_RPC_URL,
    };
    setRelayerEnv();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}), text: async () => "" }),
    );
    resolverHandle = await startResolverServer();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await resolverHandle.stop();
    for (const [k, v] of Object.entries(savedEnv)) {
      v === undefined ? delete process.env[k] : (process.env[k] = v);
    }
  });

  it("coordinator /readyz returns 200 when all RPCs are healthy", async () => {
    const app = await freshCoordinatorApp();
    const res = await supertest(app).get("/readyz");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });

  it("relayer /readyz returns 200 when all configured RPCs are healthy", async () => {
    const app = makeRelayerApp();
    const res = await supertest(app).get("/readyz");
    expect(res.status).toBe(200);
  });

  it("resolver /readyz returns 200 when fully configured", async () => {
    const res = await fetch(`${resolverHandle.baseUrl}/readyz`);
    expect(res.status).toBe(200);
  });

  it("all three services return their correct service name", async () => {
    const coordApp = await freshCoordinatorApp();
    const relayerApp = makeRelayerApp();

    const [coordRes, relayerRes, resolverRes] = await Promise.all([
      supertest(coordApp).get("/healthz"),
      supertest(relayerApp).get("/healthz"),
      fetch(`${resolverHandle.baseUrl}/healthz`).then((r) => r.json()),
    ]);

    expect(coordRes.body.service).toBe("wafflefinance-coordinator");
    expect(relayerRes.body.service).toBe("wafflefinance-relayer");
    expect((resolverRes as any).service).toBe("wafflefinance-resolver");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Cross-service isolation — one service degraded does not affect others
// ═══════════════════════════════════════════════════════════════════════════

describe("cross-service readiness — degradation isolation", () => {
  let savedEnv: Record<string, string | undefined>;
  let resolverHandle: Awaited<ReturnType<typeof startResolverServer>>;

  beforeEach(async () => {
    savedEnv = {
      ETHEREUM_RPC_URL: process.env.ETHEREUM_RPC_URL,
      STELLAR_HORIZON_URL: process.env.STELLAR_HORIZON_URL,
      SOROBAN_RPC_URL: process.env.SOROBAN_RPC_URL,
      SOLANA_HTLC_PROGRAM: process.env.SOLANA_HTLC_PROGRAM,
      SOLANA_RPC_URL: process.env.SOLANA_RPC_URL,
    };
    setRelayerEnv();
    resolverHandle = await startResolverServer();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await resolverHandle.stop();
    for (const [k, v] of Object.entries(savedEnv)) {
      v === undefined ? delete process.env[k] : (process.env[k] = v);
    }
  });

  it("coordinator degradation does not affect resolver readiness", async () => {
    // Coordinator: RPCs failing
    const coordApp = await freshCoordinatorApp(failFetcher, false);
    const coordRes = await supertest(coordApp).get("/readyz");
    expect(coordRes.status).toBe(503);

    // Resolver: still fully configured and healthy
    const resolverRes = await fetch(`${resolverHandle.baseUrl}/readyz`);
    expect(resolverRes.status).toBe(200);
  });

  it("relayer RPC failure does not affect coordinator readiness", async () => {
    // Relayer: eth RPC is down
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    const relayerApp = makeRelayerApp();
    const relayerRes = await supertest(relayerApp).get("/readyz");
    expect(relayerRes.status).toBe(503);

    // Coordinator readiness uses its own okFetcher — restore for coordinator check
    vi.restoreAllMocks();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}), text: async () => "" }),
    );

    const coordApp = await freshCoordinatorApp(okFetcher);
    const coordRes = await supertest(coordApp).get("/readyz");
    expect(coordRes.status).toBe(200);
  });

  it("resolver config missing does not affect relayer or coordinator liveness", async () => {
    // Resolver with missing soroban config
    const { server: badServer, baseUrl: badUrl, stop } = await startResolverServer({
      ...RESOLVER_CFG,
      soroban: { ...RESOLVER_CFG.soroban, htlc: null },
    });

    try {
      const resolverRes = await fetch(`${badUrl}/readyz`);
      expect(resolverRes.status).toBe(503);

      // Relayer liveness is independent
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}), text: async () => "" }),
      );
      const relayerApp = makeRelayerApp();
      const relayerRes = await supertest(relayerApp).get("/healthz");
      expect(relayerRes.status).toBe(200);

      // Coordinator liveness is independent
      const coordApp = await freshCoordinatorApp();
      const coordRes = await supertest(coordApp).get("/healthz");
      expect(coordRes.status).toBe(200);
    } finally {
      await stop();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Graceful degradation — system behaviour under partial failures
// ═══════════════════════════════════════════════════════════════════════════

describe("cross-service readiness — graceful degradation", () => {
  it("coordinator /readyz response body always includes degradedServices even when healthy", async () => {
    const app = await freshCoordinatorApp(okFetcher);
    const res = await supertest(app).get("/readyz");
    expect(Array.isArray(res.body.degradedServices)).toBe(true);
  });

  it("coordinator degradedServices lists all failing RPC checks", async () => {
    const app = await freshCoordinatorApp(failFetcher, false);
    const res = await supertest(app).get("/readyz");
    expect(res.body.degradedServices).toContain("ethereum_rpc");
    expect(res.body.degradedServices).toContain("soroban_rpc");
    expect(res.body.degradedServices).toContain("reconciliation");
  });

  it("coordinator /healthz always 200 regardless of RPC state (liveness not readiness)", async () => {
    const app = await freshCoordinatorApp(failFetcher, false);
    const healthz = await supertest(app).get("/healthz");
    expect(healthz.status).toBe(200);
    const readyz = await supertest(app).get("/readyz");
    expect(readyz.status).toBe(503);
  });

  it("resolver /healthz always 200 regardless of readyz state", async () => {
    const { server, baseUrl, stop } = await startResolverServer({
      ...RESOLVER_CFG,
      ethereum: { ...RESOLVER_CFG.ethereum, htlcEscrow: null },
      soroban: { ...RESOLVER_CFG.soroban, htlc: null },
    });
    try {
      const healthzRes = await fetch(`${baseUrl}/healthz`);
      const readyzRes = await fetch(`${baseUrl}/readyz`);
      expect(healthzRes.status).toBe(200);
      expect(readyzRes.status).toBe(503);
    } finally {
      await stop();
    }
  });

  it("relayer /healthz always 200 regardless of readyz state", async () => {
    const savedEth = process.env.ETHEREUM_RPC_URL;
    const savedHorizon = process.env.STELLAR_HORIZON_URL;
    process.env.ETHEREUM_RPC_URL = "https://eth.internal/rpc";
    process.env.STELLAR_HORIZON_URL = "https://horizon.internal";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    try {
      const app = makeRelayerApp();
      const healthzRes = await supertest(app).get("/healthz");
      const readyzRes = await supertest(app).get("/readyz");
      expect(healthzRes.status).toBe(200);
      expect(readyzRes.status).toBe(503);
    } finally {
      vi.restoreAllMocks();
      savedEth === undefined
        ? delete process.env.ETHEREUM_RPC_URL
        : (process.env.ETHEREUM_RPC_URL = savedEth);
      savedHorizon === undefined
        ? delete process.env.STELLAR_HORIZON_URL
        : (process.env.STELLAR_HORIZON_URL = savedHorizon);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Recovery — independent per-service
// ═══════════════════════════════════════════════════════════════════════════

describe("cross-service readiness — failure recovery", () => {
  it("coordinator recovers immediately when RPC comes back up", async () => {
    let failing = true;
    const dynamicFetcher: Fetcher = async () => ({
      ok: !failing,
      status: failing ? 503 : 200,
      json: async () => ({}),
    });

    const dir = mkdtempSync(resolve(tmpdir(), "waffle-recovery-"));
    const db = await openDatabase(`file:${dir}/test.db`);
    const getReadinessChecks = createReadinessChecks({
      cfg: COORDINATOR_CFG,
      db,
      getReconciliationStatus: () => ({ lastRunAt: Date.now(), lastRunOk: true, eventsReplayed: 0 }),
      fetcher: dynamicFetcher,
      timeoutMs: 15,
    });
    const app = express();
    app.use(coordinatorHealthRoutes({ getReadinessChecks }));

    const degraded = await supertest(app).get("/readyz");
    expect(degraded.status).toBe(503);

    failing = false;

    const recovered = await supertest(app).get("/readyz");
    expect(recovered.status).toBe(200);
    expect(recovered.body.status).toBe("ok");
  });

  it("resolver recovers to healthy readyz once config is corrected (re-instantiation)", async () => {
    // Start degraded (missing soroban htlc)
    const { server: badServer, baseUrl: badUrl, stop: stopBad } = await startResolverServer({
      ...RESOLVER_CFG,
      soroban: { ...RESOLVER_CFG.soroban, htlc: null },
    });
    const degraded = await fetch(`${badUrl}/readyz`);
    expect(degraded.status).toBe(503);
    await stopBad();

    // Start recovered (full config)
    const { server: goodServer, baseUrl: goodUrl, stop: stopGood } = await startResolverServer(RESOLVER_CFG);
    try {
      const recovered = await fetch(`${goodUrl}/readyz`);
      expect(recovered.status).toBe(200);
    } finally {
      await stopGood();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Readiness probe interpretation matrix (documentation as tests)
// ═══════════════════════════════════════════════════════════════════════════

describe("readiness probe interpretation matrix", () => {
  /**
   * This suite documents the expected HTTP status codes and response shape
   * for each service's health endpoints, serving as an executable specification
   * for CI/CD pipeline configuration.
   */

  it("coordinator /healthz: HTTP 200 → process alive, always use as liveness probe", async () => {
    const app = await freshCoordinatorApp(failFetcher, false);
    const res = await supertest(app).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });

  it("coordinator /readyz: HTTP 200 → ready to serve (mode=healthy or partially_healthy)", async () => {
    const app = await freshCoordinatorApp(okFetcher);
    const res = await supertest(app).get("/readyz");
    expect(res.status).toBe(200);
    expect(["healthy", "ok"]).toContain(res.body.status);
  });

  it("coordinator /readyz: HTTP 503 → not ready, stop sending traffic (degraded)", async () => {
    const app = await freshCoordinatorApp(failFetcher, false);
    const res = await supertest(app).get("/readyz");
    expect(res.status).toBe(503);
    expect(res.body.status).toBe("degraded");
  });

  it("relayer /healthz: HTTP 200 → process alive", async () => {
    const app = makeRelayerApp();
    const res = await supertest(app).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });

  it("resolver /healthz: HTTP 200 → process alive", async () => {
    const { server, baseUrl, stop } = await startResolverServer(RESOLVER_CFG);
    try {
      const res = await fetch(`${baseUrl}/healthz`);
      expect(res.status).toBe(200);
    } finally {
      await stop();
    }
  });

  it("resolver /readyz: HTTP 200 → ready to relay cross-chain orders", async () => {
    const { server, baseUrl, stop } = await startResolverServer(RESOLVER_CFG);
    try {
      const res = await fetch(`${baseUrl}/readyz`);
      expect(res.status).toBe(200);
    } finally {
      await stop();
    }
  });

  it("resolver /readyz: HTTP 503 → not ready (missing config or supervisor crashed)", async () => {
    const { server, baseUrl, stop } = await startResolverServer({
      ...RESOLVER_CFG,
      ethereum: { ...RESOLVER_CFG.ethereum, htlcEscrow: null },
    });
    try {
      const res = await fetch(`${baseUrl}/readyz`);
      expect(res.status).toBe(503);
    } finally {
      await stop();
    }
  });
});
