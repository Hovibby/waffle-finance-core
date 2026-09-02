/**
 * @fileoverview Structured Pino logger for the WaffleFinance relayer.
 *
 * Mirrors the coordinator's logger pattern so logs from both services share
 * the same JSON schema and can be aggregated/correlated in a single sink.
 *
 * Structured fields included on every line:
 *   - service:    always "wafflefinance-relayer"
 *   - requestId:  injected from AsyncLocalStorage (coordinator correlation)
 *   - correlationId / orderId / route: injected from the relay correlation
 *     context when present (see correlation-context.ts)
 *
 * Usage
 * -----
 * ```ts
 * import { getLogger } from './logger.js';
 *
 * const logger = getLogger();
 *
 * // Plain message
 * logger.info('Relayer started');
 *
 * // Structured fields first, message second (Pino convention)
 * logger.info({ orderId, orderHash, chain: 'ethereum' }, 'Escrow created');
 * logger.warn({ orderId, direction }, 'Route rejected');
 * logger.error({ orderId, err }, 'Settlement failed');
 * ```
 *
 * Child loggers
 * -------------
 * Bind a sub-component name so every line carries the component label:
 * ```ts
 * const log = getLogger().child({ component: 'pricing-service' });
 * log.info({ xlmUsdPrice, ethUsdPrice }, 'Prices refreshed from CoinGecko');
 * ```
 */

import pino, { type Logger } from 'pino';
import { getRequestId } from './request-context.js';
import { correlationFields } from './correlation/correlation-context.js';

let cached: Logger | null = null;

/**
 * Return the singleton Pino logger, creating it on first call.
 *
 * @param level  Log level (defaults to the LOG_LEVEL env var or 'info').
 */
export function getLogger(level: string = process.env.LOG_LEVEL ?? 'info'): Logger {
  if (!cached) {
    cached = pino({
      level,
      base: { service: 'wafflefinance-relayer' },
      // Inject active request/correlation IDs at write time so they appear on
      // every log line without callers having to pass them explicitly.
      // AsyncLocalStorage guarantees the correct IDs are picked up even deep
      // inside service and repository methods.
      mixin() {
        const fields: Record<string, unknown> = {};

        // Coordinator request ID (for HTTP-originated operations)
        const requestId = getRequestId();
        if (requestId) fields.requestId = requestId;

        // Relay correlation fields (orderId, correlationId, route, retryCount)
        const corr = correlationFields();
        if (corr.correlationId) Object.assign(fields, corr);

        return fields;
      },
    });
  }
  return cached;
}

/**
 * Reset the cached logger. Only used in tests to re-create with a different
 * level without restarting the process.
 *
 * @internal
 */
export function _resetLoggerCache(): void {
  cached = null;
}
