# Health Endpoints — WaffleFinance Services

This document maps every health/readiness endpoint exposed by the three WaffleFinance
services and describes how to interpret each response for CI/CD pipeline configuration,
Kubernetes probe setup, and monitoring dashboard alerting.

---

## Coordinator (`@wafflefinance/coordinator`)

| Endpoint   | Method | Purpose                 | HTTP 200 means         | HTTP 503 means              |
|-----------|--------|-------------------------|------------------------|-----------------------------|
| `/healthz` | GET    | Liveness probe          | Process is alive       | Never returns 503           |
| `/readyz`  | GET    | Readiness probe         | All dependencies OK    | One or more deps degraded   |
| `/health`  | GET    | Detailed health status  | Service is healthy     | N/A (always 200)            |

### `/readyz` response shape

```json
{
  "status": "ok" | "degraded",
  "mode": "healthy" | "partially_healthy" | "degraded",
  "degradedServices": ["ethereum_rpc"],
  "service": "wafflefinance-coordinator",
  "version": "1.0.0",
  "uptimeSeconds": 42,
  "timestamp": "2026-08-26T10:00:00.000Z",
  "checks": [
    { "name": "database",      "ok": true,  "latencyMs": 1 },
    { "name": "ethereum_rpc",  "ok": true,  "latencyMs": 8 },
    { "name": "soroban_rpc",   "ok": true,  "latencyMs": 12 },
    { "name": "solana_rpc",    "ok": true,  "detail": "disabled_placeholder" },
    { "name": "reconciliation","ok": true,  "detail": "last_run_ok" }
  ]
}
```

### Dependency checks

| Check name      | ok:false condition                                      | Severity       |
|----------------|--------------------------------------------------------|----------------|
| `database`     | SQLite/Postgres probe failed (`SELECT 1`)              | Critical — all listeners disabled |
| `ethereum_rpc` | JSON-RPC probe timed out or returned HTTP error        | Partial — Ethereum listener disabled |
| `soroban_rpc`  | JSON-RPC probe timed out or returned HTTP error        | Partial — Soroban listener disabled |
| `solana_rpc`   | Probe failed (skipped when programId=PLACEHOLDER)      | Partial — Solana listener disabled |
| `reconciliation` | Last reconciliation run returned ok=false           | Partial — order sync lagging |

### Startup phase

When the coordinator is starting up, a synthetic `startup_phase` check is prepended:

| Phase       | check.ok | check.detail | /readyz HTTP |
|------------|----------|--------------|--------------|
| `starting` | false    | "starting"   | 503          |
| `pending`  | true     | "pending"    | 200          |
| `ready`    | *(absent)*| *(absent)*  | 200          |

---

## Relayer (`@wafflefinance/relayer`)

| Endpoint   | Method | Purpose                 | HTTP 200 means         | HTTP 503 means              |
|-----------|--------|-------------------------|------------------------|-----------------------------|
| `/healthz` | GET    | Liveness probe          | Process is alive       | Never returns 503           |
| `/readyz`  | GET    | Readiness probe         | All RPC probes OK      | One or more RPC probes failed |
| `/health`  | GET    | Detailed health status  | healthy or degraded    | Monitor reports unhealthy   |

### `/readyz` response shape

```json
{
  "status": "ok" | "degraded",
  "service": "wafflefinance-relayer",
  "version": "1.0.0",
  "uptime": 42000,
  "timestamp": 1724666400000,
  "checks": [
    { "name": "ethereum_rpc", "ok": true,  "detail": "ok",                    "latencyMs": 6 },
    { "name": "stellar_rpc",  "ok": true,  "detail": "ok",                    "latencyMs": 9 },
    { "name": "soroban_rpc",  "ok": true,  "detail": "disabled_placeholder"               },
    { "name": "solana_rpc",   "ok": true,  "detail": "disabled_placeholder"               }
  ]
}
```

### RPC checks

| Check name     | Probe method       | ok:false conditions                                   |
|---------------|-------------------|-------------------------------------------------------|
| `ethereum_rpc` | `eth_blockNumber` | Connection refused / timeout / HTTP error             |
| `stellar_rpc`  | GET `/<horizon>/` | Connection refused / timeout / HTTP error             |
| `soroban_rpc`  | `getHealth`       | Same (skipped when `SOROBAN_RPC_URL` unset)           |
| `solana_rpc`   | `getHealth`       | Same (skipped when `SOLANA_HTLC_PROGRAM=PLACEHOLDER`) |

---

## Resolver (`@wafflefinance/resolver`)

| Endpoint    | Method | Purpose                     | HTTP 200 means               | HTTP 503 means              |
|------------|--------|-----------------------------|------------------------------|-----------------------------|
| `/healthz`  | GET    | Liveness probe              | Process is alive             | Never returns 503           |
| `/readyz`   | GET    | Readiness probe             | Config OK + supervisor OK    | Config missing or supervisor crashed/stopping |
| `/health`   | GET    | Detailed health + restarts  | healthy / degraded / stopping| supervisor failed           |
| `/telemetry`| GET    | Runtime chain telemetry     | connected / degraded         | inactive (no events yet)    |
| `/support`  | GET    | Declared capabilities       | Has at least one actionable route | No actionable routes  |

### `/readyz` response shape

```json
{
  "status": "ok" | "degraded",
  "supervisorState": "idle" | "running" | "restarting" | "stopping" | "stopped" | "failed",
  "service": "wafflefinance-resolver",
  "version": "1.0.0",
  "uptimeSeconds": 5,
  "timestamp": "2026-08-26T10:00:00.000Z",
  "checks": [
    { "name": "ethereum_config", "ok": true, "detail": "configured", "level": "required" },
    { "name": "soroban_config",  "ok": true, "detail": "configured", "level": "required" },
    { "name": "supervisor",      "ok": true, "detail": "idle" }
  ]
}
```

### Config checks

| Check name         | ok:false condition                              |
|-------------------|-------------------------------------------------|
| `ethereum_config`  | `htlcEscrow` or `resolverPrivateKey` is null   |
| `soroban_config`   | `htlc` or `resolverSecret` is null             |
| `supervisor`       | supervisor is in `failed` state                 |
| `registry_status`  | On-chain resolver standing is slashed/inactive (when registry configured) |

---

## CI/CD Probe Configuration

### Kubernetes

```yaml
# Liveness probe — restart the pod when the process hangs
livenessProbe:
  httpGet:
    path: /healthz
    port: 3000
  initialDelaySeconds: 5
  periodSeconds: 10

# Readiness probe — stop routing traffic when deps are down
readinessProbe:
  httpGet:
    path: /readyz
    port: 3000
  initialDelaySeconds: 10
  periodSeconds: 15
  failureThreshold: 3
```

### GitHub Actions health gate

```yaml
- name: Wait for coordinator readiness
  run: |
    for i in $(seq 1 30); do
      status=$(curl -sf http://localhost:3001/readyz | jq -r .status)
      [ "$status" = "ok" ] && exit 0
      sleep 2
    done
    echo "Coordinator did not become ready" && exit 1
```

---

## Failure interpretation quick reference

| Symptom                                    | Likely cause                  | Action                              |
|-------------------------------------------|-------------------------------|-------------------------------------|
| Coordinator `/readyz` 503, `database` failing | DB connection lost           | Check DB process / connection string |
| Coordinator `/readyz` 503, `ethereum_rpc` failing | RPC node overloaded/down  | Switch to fallback RPC URL          |
| Relayer `/readyz` 503, `ethereum_rpc` failing | `ETHEREUM_RPC_URL` misconfigured or node down | Check env var + node health |
| Resolver `/readyz` 503, `supervisor` failing  | Listener crashed (exhausted restarts) | Check resolver logs, restart pod |
| Resolver `/readyz` 503, `ethereum_config` failing | `htlcEscrow` not set | Set contract address in config |
| Resolver `/telemetry` 503, state=inactive     | No chain events received yet  | Normal at startup; wait for first event |
| Any service `/healthz` 503                     | Container OOM-killed or process deadlock | Pod restart |
