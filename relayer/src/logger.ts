/**
 * @fileoverview Structured Pino logger for the WaffleFinance relayer.
 *
 * Design mirrors the coordinator's logger.ts so that log lines from both
 * services share the same JSON schema and can be aggregated by the same
 * pipeline (e.g. CloudWatch Logs Insights, Grafana Loki).
 *
 * Correlation injection
 * ---------------------
 * Every log line produced inside a `withCorrelation` scope automatically
 * carries the following fields via Pino's `mixin()` hook:
 *
 *   correlationId  — stable ID for the full relay operation
 *   orderId        — the order this relay operation serves
 *   route          — bridge direction (eth_to_xlm | xlm_to_eth | …)
 *   retryCount     — how many times this operation has been retried
 *
 * Outside a correlation scope (e.g. startup, background timers) those
 * fields are simply omitted — no sentinel values, no noise.
 *
 * Structured fields schema
 * ------------------------
 * Critical paths MUST log the following fields as top-level JSON keys,
 * NOT as string interpolation, so they are indexable:
 *
 *   orderId        string   — coordinator-assigned order identifier
 *   orderHash      string   — on-chain hash of the order
 *   chain          string   — "ethereum" | "stellar" | "solana"
 *   direction      string   — "eth_to_xlm" | "xlm_to_eth" | …
 *   requestId      string   — correlates relayer logs with coordinator logs
 *   txHash         string   — on-chain transaction hash
 *   amount         string   — always a string (bigint-safe)
 *   elapsedMs      number   — operation duration
 *
 * Usage
 * -----
 * ```ts
 * import { getLogger } from './logger.js';
 *
 * const logger = getLogger();
 *
 * // Plain log
 * logger.info('relay started');
 *
 * // Structured fields (preferred — indexable by log aggregators)
 * logger.info({ orderId, txHash, chain: 'ethereum' }, 'ETH transaction confirmed');
 *
 * // Child logger scoped to a subsystem
 * const log = getLogger().child({ service: 'refund-watchdog' });
 * log.warn({ orderId, ageSecs }, 'order stale — attempting refund');
 * ```
 */

import pino, { type Logger } from 'pino';
import { getCorrelation } from './correlation/correlation-context.js';

let cached: Logger | null = null;

/**
 * Return (or create) the process-wide Pino logger for the relayer.
 *
 * The singleton is initialised on first call and re-used on every
 * subsequent call, so it is safe to import and call `getLogger()` at
 * module scope in any file — no circular-init risk.
 *
 * @param level  Log level override.  Reads LOG_LEVEL env var when omitted;
 *               falls back to "info" in production and "debug" in development.
 */
export function getLogger(level?: string): Logger {
  if (!cached) {
    const resolvedLevel =
      level ??
      process.env.LOG_LEVEL ??
      (process.env.NODE_ENV === 'production' ? 'info' : 'debug');

    cached = pino({
      level: resolvedLevel,
      base: { service: 'wafflefinance-relayer' },
      // Inject the active correlation context into every log line at
      // write time.  Because `withCorrelation` wraps each relay
      // operation in an AsyncLocalStorage context, this picks up the
      // correct IDs even for log calls deep inside service methods —
      // identical to the coordinator's requestId injection pattern.
      mixin() {
        const ctx = getCorrelation();
        if (!ctx) return {};
        return {
          correlationId: ctx.correlationId,
          orderId: ctx.orderId,
          route: ctx.route,
          retryCount: ctx.retryCount,
        };
      },
      // Redact secrets that might accidentally appear in log fields.
      // The sanitizeForLog() utility handles Error objects; this covers
      // any raw field value that slips through as a plain string.
      redact: {
        paths: ['privateKey', 'secretKey', 'relayerSecret', 'secret', 'preimage'],
        censor: '[REDACTED]',
      },
      // Serializer for Error objects — includes message + stack without
      // leaking the raw private-key patterns that sanitizeForLog strips.
      serializers: {
        err: pino.stdSerializers.err,
        error: pino.stdSerializers.err,
      },
      // ISO timestamp so log lines are human-readable without a parser.
      timestamp: pino.stdTimeFunctions.isoTime,
    });
  }
  return cached;
}

/**
 * Reset the cached logger instance.
 *
 * Only intended for use in tests that need a fresh logger with a
 * different level or destination.  Not safe to call in production.
 *
 * @internal
 */
export function _resetLogger(): void {
  cached = null;
}
