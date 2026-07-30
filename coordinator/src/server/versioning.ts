/**
 * API versioning infrastructure for the coordinator.
 *
 * Establishes a stable versioning strategy for public routes so the frontend
 * and external consumers can adapt gracefully when the API evolves.
 *
 * Design principles:
 *  - Version is specified via Accept header (e.g., Accept: application/vnd.waffle.v1+json)
 *  - Routes default to the latest version when no header is provided
 *  - New fields are added additively (backward compatible)
 *  - Deprecated fields remain for at least 2 major versions
 *  - Breaking changes require a new major version
 *
 * Version history:
 *  - v1: Initial coordinator API (current)
 *    - Order queries (GET /orders/:id, GET /orders/history)
 *    - Secrets (GET /secrets/:hashlock)
 *    - Readiness (GET /health/ready)
 *  - v2: (future) Adds order export and versioned order response shape
 */

import type { Request, Response, NextFunction } from "express";

/** Supported API versions. */
export type ApiVersion = "v1" | "v2";

/** Default version when no Accept header is provided. */
export const DEFAULT_API_VERSION: ApiVersion = "v1";

/** Latest stable version (for new integrations). */
export const LATEST_API_VERSION: ApiVersion = "v1";

/**
 * Parse the API version from the Accept header.
 *
 * Supports:
 *  - application/vnd.waffle.v1+json → "v1"
 *  - application/vnd.waffle.v2+json → "v2"
 *  - application/json → DEFAULT_API_VERSION
 *  - (no header) → DEFAULT_API_VERSION
 *
 * @param acceptHeader - The Accept header value
 * @returns Parsed API version, or default if not specified
 */
export function parseApiVersion(acceptHeader: string | undefined): ApiVersion {
  if (!acceptHeader) return DEFAULT_API_VERSION;

  const match = /application\/vnd\.waffle\.v(\d+)\+json/.exec(acceptHeader);
  if (!match) return DEFAULT_API_VERSION;

  const versionNum = match[1];
  const version = `v${versionNum}` as ApiVersion;

  // Validate that the version is supported
  if (version !== "v1" && version !== "v2") {
    return DEFAULT_API_VERSION;
  }

  return version;
}

/**
 * Middleware: extract API version from Accept header and attach to req.
 *
 * Usage:
 *   app.use(apiVersionMiddleware());
 *   // In route handlers:
 *   const version = req.apiVersion; // "v1" | "v2"
 */
export function apiVersionMiddleware() {
  return (req: Request, _res: Response, next: NextFunction) => {
    const version = parseApiVersion(req.get("Accept"));
    (req as any).apiVersion = version;
    next();
  };
}

/**
 * Get the API version from a request object.
 *
 * @param req - Express request
 * @returns API version (attached by middleware)
 */
export function getApiVersion(req: Request): ApiVersion {
  return (req as any).apiVersion ?? DEFAULT_API_VERSION;
}

/**
 * Versioned response transformer: adapts response data to the requested version.
 *
 * Usage:
 *   const data = buildOrderResponse(order);
 *   const versioned = versionResponse(req, data, {
 *     v1: (d) => ({ ...d, oldField: d.newField }),
 *     v2: (d) => d,
 *   });
 *   res.json(versioned);
 *
 * @param req - Express request (to extract version)
 * @param data - Response data (version-agnostic)
 * @param transformers - Version-specific transformers
 * @returns Transformed data for the requested version
 */
export function versionResponse<T>(
  req: Request,
  data: T,
  transformers: Partial<Record<ApiVersion, (data: T) => unknown>>
): unknown {
  const version = getApiVersion(req);
  const transformer = transformers[version];

  if (!transformer) {
    // No transformer for this version — return data as-is
    return data;
  }

  return transformer(data);
}

/**
 * Versioned order response shape.
 *
 * V1: Current shape (see orders.ts serialiseOrder)
 * V2: (future) Adds export-friendly fields, renames some fields for consistency
 */
export interface OrderResponseV1 {
  id: string;
  direction: string;
  status: string;
  isRefundable: boolean;
  hashlock: string;
  src: {
    chain: string;
    address: string;
    asset: string;
    amount: string;
    safetyDeposit: string;
    orderId: string | null;
    lockTx: string | null;
    lockBlock: number | null;
    timelock: number | null;
  };
  dst: {
    chain: string;
    address: string;
    asset: string;
    amount: string;
    orderId: string | null;
    lockTx: string | null;
    lockBlock: number | null;
    timelock: number | null;
  };
  secret: {
    revealed: boolean;
    preimage: string | null;
    revealedTx: string | null;
  };
  resolver: string | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * V2 adds:
 *  - archivedAt (soft-delete timestamp)
 *  - lifecycle state (enriched status with completion percentage)
 *  - fee breakdown (separate safety deposit from amounts)
 */
export interface OrderResponseV2 extends OrderResponseV1 {
  archivedAt: number | null;
  lifecycle: {
    state: string;
    completionPercent: number;
  };
  fees: {
    srcSafetyDeposit: string;
  };
}

/**
 * Transform an order response from internal shape to V1 API shape.
 * This is the identity transform (V1 matches current internal shape).
 */
export function toOrderV1(order: OrderResponseV1): OrderResponseV1 {
  return order;
}

/**
 * Transform an order response from internal shape to V2 API shape.
 * Adds new fields, maintains backward compatibility.
 */
export function toOrderV2(order: OrderResponseV1): OrderResponseV2 {
  // Calculate lifecycle completion (simple heuristic for now)
  const completionPercent = calculateCompletionPercent(order.status);

  return {
    ...order,
    archivedAt: null, // Would be populated from order.archivedAt if available
    lifecycle: {
      state: order.status,
      completionPercent,
    },
    fees: {
      srcSafetyDeposit: order.src.safetyDeposit,
    },
  };
}

/**
 * Calculate order completion percentage based on status.
 * Simple heuristic: announced = 0%, src_locked = 33%, dst_locked = 66%, completed = 100%
 */
function calculateCompletionPercent(status: string): number {
  switch (status) {
    case "announced":
      return 0;
    case "src_locked":
      return 33;
    case "dst_locked":
      return 66;
    case "secret_revealed":
      return 90;
    case "completed":
      return 100;
    case "refunded":
    case "failed":
    case "expired":
      return 100; // Terminal states are "complete" (even if not successful)
    default:
      return 0;
  }
}
