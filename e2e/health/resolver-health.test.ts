/**
 * E2E health-check test suite — Resolver service
 *
 * Issue #475: Implement comprehensive health check and readiness probe E2E test suite
 *
 * Scope:
 *   - Maps all resolver health endpoints (/healthz, /readyz, /health, /telemetry, /support)
 *   - Validates healthy baseline (ethereum + soroban configured)
 *   - Simulates listener crash via supervisor state
 *   - Simulates network disconnection (telemetry goes stale/inactive)
 *   - Validates graceful degradation (missing chain config)
 *   - Validates support policy endpoint
 *   - CI/CD readiness probe contract
 *
 * Strategy: spin up a real ResolverHealthServer on an ephemeral port backed by
 * a Supervisor instance.  No live RPC calls are made — the resolver health
 * endpoints are capability checks against the support policy, not live probes.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createResolverHealthServer } from "../../resolver/src/health.js";
import { Supervisor } from "../../resolver/src/supervisor.js";
import type { ResolverConfig } from "../../resolver/src/config.js";
import { listenerLastEventTimestampSeconds } from "../../resolver/src/metrics.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const log = {
  child: () => log,
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
} as any;

const FULL_CFG: ResolverConfig = {
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

const MISSING_ETH_CFG: ResolverConfig = {
  ...FULL_CFG,
  ethereum: { ...FULL_CFG.ethereum, htlcEscrow: null },
};

const MISSING_SOROBAN_CFG: ResolverConfig = {
  ...FULL_CFG,
  soroban: { ...FULL_CFG.soroban, htlc: null },
};

// ── Server lifecycle helpers ──────────────────────────────────────────────────

async function startServer(cfg: ResolverConfig = FULL_CFG, supervisor?: Supervisor) {
  const sup = supervisor ?? new Supervisor({ log });
  const server: Server = createResolverHealthServer({
    cfg,
    supervisor: sup,
    startedAt: Date.now(),
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, supervisor: sup, server };
}

async function stopServer(server: Server) {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Endpoint mapping
// ═══════════════════════════════════════════════════════════════════════════

describe("resolver health endpoints — endpoint mapping", () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    ({ server, baseUrl } = await startServer());
  });
  afterEach(() => stopServer(server));

  it("GET /healthz returns 200", async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
  });

  it("GET /readyz returns 200 or 503", async () => {
    const res = await fetch(`${baseUrl}/readyz`);
    expect([200, 503]).toContain(res.status);
  });

  it("GET /health returns 200 or 503", async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect([200, 503]).toContain(res.status);
  });

  it("GET /telemetry returns 200 or 503", async () => {
    const res = await fetch(`${baseUrl}/telemetry`);
    expect([200, 503]).toContain(res.status);
  });

  it("GET /support returns 200 or 503", async () => {
    const res = await fetch(`${baseUrl}/support`);
    expect([200, 503]).toContain(res.status);
  });

  it("unknown path returns 404", async () => {
    const res = await fetch(`${baseUrl}/unknown-path`);
    expect(res.status).toBe(404);
  });

  it("non-GET method returns 405", async () => {
    const res = await fetch(`${baseUrl}/healthz`, { method: "POST" });
    expect(res.status).toBe(405);
  });

  it("all health endpoints return JSON content-type", async () => {
    for (const path of ["/healthz", "/readyz", "/health", "/support"]) {
      const res = await fetch(`${baseUrl}${path}`);
      expect(res.headers.get("content-type")).toMatch(/application\/json/);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. /healthz — liveness
// ═══════════════════════════════════════════════════════════════════════════

describe("resolver /healthz — liveness probe", () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => ({ server, baseUrl } = await startServer()));
  afterEach(() => stopServer(server));

  it("always returns 200 with status ok while process is alive", async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    const body = await res.json() as any;
    expect(res.status).toBe(200);
    expect(body.status).toBe("ok");
  });

  it("includes correct service name wafflefinance-resolver", async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    const body = await res.json() as any;
    expect(body.service).toBe("wafflefinance-resolver");
  });

  it("includes version, uptimeSeconds, and timestamp fields", async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    const body = await res.json() as any;
    expect(typeof body.version).toBe("string");
    expect(typeof body.uptimeSeconds).toBe("number");
    expect(typeof body.timestamp).toBe("string");
  });

  it("returns 200 even when ethereum htlcEscrow is not configured", async () => {
    server.close();
    ({ server, baseUrl } = await startServer(MISSING_ETH_CFG));
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. /readyz — healthy baseline
// ═══════════════════════════════════════════════════════════════════════════

describe("resolver /readyz — healthy baseline (full config)", () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => ({ server, baseUrl } = await startServer(FULL_CFG)));
  afterEach(() => stopServer(server));

  it("returns 200 and status ok when all config is present", async () => {
    const res = await fetch(`${baseUrl}/readyz`);
    const body = await res.json() as any;
    expect(res.status).toBe(200);
    expect(body.status).toBe("ok");
  });

  it("includes ethereum_config, soroban_config, and supervisor checks", async () => {
    const res = await fetch(`${baseUrl}/readyz`);
    const body = await res.json() as any;
    const names = (body.checks as Array<{ name: string }>).map((c) => c.name);
    expect(names).toContain("ethereum_config");
    expect(names).toContain("soroban_config");
    expect(names).toContain("supervisor");
  });

  it("ethereum_config check is ok:true with detail:configured", async () => {
    const res = await fetch(`${baseUrl}/readyz`);
    const body = await res.json() as any;
    const eth = (body.checks as Array<{ name: string; ok: boolean; detail?: string }>).find(
      (c) => c.name === "ethereum_config",
    );
    expect(eth!.ok).toBe(true);
    expect(eth!.detail).toBe("configured");
  });

  it("soroban_config check is ok:true with detail:configured", async () => {
    const res = await fetch(`${baseUrl}/readyz`);
    const body = await res.json() as any;
    const soroban = (body.checks as Array<{ name: string; ok: boolean; detail?: string }>).find(
      (c) => c.name === "soroban_config",
    );
    expect(soroban!.ok).toBe(true);
    expect(soroban!.detail).toBe("configured");
  });

  it("supervisor check is ok:true when supervisor is in idle state", async () => {
    const res = await fetch(`${baseUrl}/readyz`);
    const body = await res.json() as any;
    const sup = (body.checks as Array<{ name: string; ok: boolean; detail?: string }>).find(
      (c) => c.name === "supervisor",
    );
    expect(sup!.ok).toBe(true);
    expect(sup!.detail).toBe("idle");
  });

  it("includes supervisorState field in the readyz response body", async () => {
    const res = await fetch(`${baseUrl}/readyz`);
    const body = await res.json() as any;
    expect(typeof body.supervisorState).toBe("string");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. /readyz — graceful degradation (missing chain config)
// ═══════════════════════════════════════════════════════════════════════════

describe("resolver /readyz — graceful degradation", () => {
  it("returns 503 when ethereum htlcEscrow is null (unconfigured)", async () => {
    const { server, baseUrl } = await startServer(MISSING_ETH_CFG);
    try {
      const res = await fetch(`${baseUrl}/readyz`);
      const body = await res.json() as any;
      expect(res.status).toBe(503);
      expect(body.status).toBe("degraded");
      const eth = (body.checks as Array<{ name: string; ok: boolean }>).find(
        (c) => c.name === "ethereum_config",
      );
      expect(eth!.ok).toBe(false);
    } finally {
      await stopServer(server);
    }
  });

  it("returns 503 when soroban htlc is null (unconfigured)", async () => {
    const { server, baseUrl } = await startServer(MISSING_SOROBAN_CFG);
    try {
      const res = await fetch(`${baseUrl}/readyz`);
      const body = await res.json() as any;
      expect(res.status).toBe(503);
      expect(body.status).toBe("degraded");
      const soroban = (body.checks as Array<{ name: string; ok: boolean }>).find(
        (c) => c.name === "soroban_config",
      );
      expect(soroban!.ok).toBe(false);
    } finally {
      await stopServer(server);
    }
  });

  it("liveness (/healthz) stays 200 even when readyz is 503", async () => {
    const { server, baseUrl } = await startServer(MISSING_ETH_CFG);
    try {
      const livenessRes = await fetch(`${baseUrl}/healthz`);
      const readyzRes = await fetch(`${baseUrl}/readyz`);
      expect(livenessRes.status).toBe(200);
      expect(readyzRes.status).toBe(503);
    } finally {
      await stopServer(server);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Listener crash simulation — supervisor state
// ═══════════════════════════════════════════════════════════════════════════

describe("resolver /readyz — listener crash (supervisor state)", () => {
  it("returns 503 when supervisor has failed (listener crash)", async () => {
    const supervisor = new Supervisor({ log });
    // Simulate a crash by running with an action that immediately throws
    const runPromise = supervisor.run({
      start: async () => { throw new Error("listener crashed"); },
      stop: async () => {},
    }).catch(() => {});
    await runPromise;

    const { server, baseUrl } = await startServer(FULL_CFG, supervisor);
    try {
      const res = await fetch(`${baseUrl}/readyz`);
      const body = await res.json() as any;
      expect(res.status).toBe(503);
      const sup = (body.checks as Array<{ name: string; ok: boolean; detail?: string }>).find(
        (c) => c.name === "supervisor",
      );
      // After exhausting restarts, the supervisor enters failed state
      expect(sup).toBeDefined();
    } finally {
      await stopServer(server);
    }
  });

  it("returns 503 during supervisor stopping state (pod graceful teardown)", async () => {
    const supervisor = new Supervisor({ log });
    const runPromise = supervisor.run({
      start: () => new Promise(() => {}), // never resolves
      stop: async () => {},
    });
    void runPromise;
    supervisor.stop();

    // Allow the stopping transition to propagate
    await new Promise<void>((r) => setTimeout(r, 10));

    const { server, baseUrl } = await startServer(FULL_CFG, supervisor);
    try {
      const res = await fetch(`${baseUrl}/readyz`);
      // stopping/stopped → 503 (don't route new traffic to a shutting-down pod)
      expect(res.status).toBe(503);
    } finally {
      await stopServer(server);
    }
  });

  it("/health returns stopping status during graceful shutdown", async () => {
    const supervisor = new Supervisor({ log });
    const runPromise = supervisor.run({
      start: () => new Promise(() => {}),
      stop: async () => {},
    });
    void runPromise;
    supervisor.stop();
    await new Promise<void>((r) => setTimeout(r, 10));

    const { server, baseUrl } = await startServer(FULL_CFG, supervisor);
    try {
      const res = await fetch(`${baseUrl}/health`);
      const body = await res.json() as any;
      // Either stopping or stopped depending on timing
      expect(["stopping", "stopped", "degraded"]).toContain(body.status);
    } finally {
      await stopServer(server);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. Network disconnection — telemetry endpoint
// ═══════════════════════════════════════════════════════════════════════════

describe("resolver /telemetry — network disconnection simulation", () => {
  it("returns 503 state:inactive before supervisor starts (no events yet)", async () => {
    const { server, baseUrl } = await startServer();
    try {
      const res = await fetch(`${baseUrl}/telemetry`);
      const body = await res.json() as any;
      expect(res.status).toBe(503);
      expect(body.state).toBe("inactive");
      expect(body.supervisorState).toBe("idle");
    } finally {
      await stopServer(server);
    }
  });

  it("returns chains array with ethereum and soroban entries", async () => {
    const { server, baseUrl } = await startServer();
    try {
      const res = await fetch(`${baseUrl}/telemetry`);
      const body = await res.json() as any;
      const chainNames = (body.chains as Array<{ chain: string }>).map((c) => c.chain);
      expect(chainNames).toContain("ethereum");
      expect(chainNames).toContain("soroban");
    } finally {
      await stopServer(server);
    }
  });

  it("returns state:connected once chains report recent events", async () => {
    const supervisor = new Supervisor({ log });
    const runPromise = supervisor.run({
      start: () => new Promise(() => {}),
      stop: async () => {},
    });
    void runPromise;

    const now = Math.floor(Date.now() / 1000);
    listenerLastEventTimestampSeconds.set({ chain: "ethereum" }, now);
    listenerLastEventTimestampSeconds.set({ chain: "soroban" }, now);

    const { server, baseUrl } = await startServer(FULL_CFG, supervisor);
    try {
      const res = await fetch(`${baseUrl}/telemetry`);
      const body = await res.json() as any;
      expect(res.status).toBe(200);
      expect(body.state).toBe("connected");
    } finally {
      supervisor.stop();
      await stopServer(server);
    }
  });

  it("includes service payload (service, version, uptimeSeconds, timestamp) in telemetry", async () => {
    const { server, baseUrl } = await startServer();
    try {
      const res = await fetch(`${baseUrl}/telemetry`);
      const body = await res.json() as any;
      expect(body.service).toBe("wafflefinance-resolver");
      expect(typeof body.version).toBe("string");
      expect(typeof body.uptimeSeconds).toBe("number");
    } finally {
      await stopServer(server);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. /support — declared capabilities
// ═══════════════════════════════════════════════════════════════════════════

describe("resolver /support — declared capabilities", () => {
  it("returns 200 and actionable:true when fully configured", async () => {
    const { server, baseUrl } = await startServer(FULL_CFG);
    try {
      const res = await fetch(`${baseUrl}/support`);
      const body = await res.json() as any;
      expect(res.status).toBe(200);
      expect(body.actionable).toBe(true);
    } finally {
      await stopServer(server);
    }
  });

  it("returns 503 and actionable:false when no chain is configured", async () => {
    const noChainCfg: ResolverConfig = {
      ...FULL_CFG,
      ethereum: { ...FULL_CFG.ethereum, htlcEscrow: null },
      soroban: { ...FULL_CFG.soroban, htlc: null },
    };
    const { server, baseUrl } = await startServer(noChainCfg);
    try {
      const res = await fetch(`${baseUrl}/support`);
      const body = await res.json() as any;
      expect(res.status).toBe(503);
      expect(body.actionable).toBe(false);
    } finally {
      await stopServer(server);
    }
  });

  it("includes service payload in support response", async () => {
    const { server, baseUrl } = await startServer(FULL_CFG);
    try {
      const res = await fetch(`${baseUrl}/support`);
      const body = await res.json() as any;
      expect(body.service).toBe("wafflefinance-resolver");
    } finally {
      await stopServer(server);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. CI/CD readiness probe contract
// ═══════════════════════════════════════════════════════════════════════════

describe("resolver health endpoints — CI/CD probe contract", () => {
  it("/healthz HTTP 200 = process alive (use as K8s liveness probe)", async () => {
    const { server, baseUrl } = await startServer(MISSING_ETH_CFG);
    try {
      const res = await fetch(`${baseUrl}/healthz`);
      expect(res.status).toBe(200);
    } finally {
      await stopServer(server);
    }
  });

  it("/readyz HTTP 200 = resolver is ready to process cross-chain orders", async () => {
    const { server, baseUrl } = await startServer(FULL_CFG);
    try {
      const res = await fetch(`${baseUrl}/readyz`);
      expect(res.status).toBe(200);
    } finally {
      await stopServer(server);
    }
  });

  it("/readyz HTTP 503 = resolver is NOT ready — stop routing orders", async () => {
    const { server, baseUrl } = await startServer(MISSING_ETH_CFG);
    try {
      const res = await fetch(`${baseUrl}/readyz`);
      expect(res.status).toBe(503);
    } finally {
      await stopServer(server);
    }
  });

  it("/readyz body always includes supervisorState and checks array", async () => {
    const { server, baseUrl } = await startServer(FULL_CFG);
    try {
      const res = await fetch(`${baseUrl}/readyz`);
      const body = await res.json() as any;
      expect(typeof body.supervisorState).toBe("string");
      expect(Array.isArray(body.checks)).toBe(true);
    } finally {
      await stopServer(server);
    }
  });
});
