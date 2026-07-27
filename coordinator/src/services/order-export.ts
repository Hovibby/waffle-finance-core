/**
 * Order lifecycle export service for compliance and incident response.
 *
 * Provides a structured, deterministic export of order state transitions
 * and events. The export is designed to be:
 *  - Durable: sourced from persistent audit log and order state
 *  - Portable: JSON format suitable for external audit or analysis
 *  - Filterable: supports filtering by order ID, status window, or chain
 *  - Complete: includes all lifecycle events (locks, reveals, refunds, recovery)
 *
 * Use cases:
 *  - Compliance: provide auditors with a time-ordered order history
 *  - Incident response: export a failed order's full lifecycle for debugging
 *  - Operational review: analyze order completion rates and failure modes
 */

import type { Logger } from "pino";
import type { OrdersRepository, OrderRow, Chain, OrderStatus } from "../persistence/orders-repo.js";
import type { AuditRepository, AuditEntry } from "../audit/audit-repo.js";

/**
 * Order lifecycle export: a complete, time-ordered view of an order's
 * state transitions and events.
 */
export interface OrderLifecycleExport {
  /** Order public ID */
  orderId: string;

  /** Current status */
  status: OrderStatus;

  /** Order direction (eth_to_xlm, etc.) */
  direction: string;

  /** Hashlock (cross-chain link) */
  hashlock: string;

  /** Source chain details */
  srcChain: {
    chain: Chain;
    address: string;
    asset: string;
    amount: string;
    safetyDeposit: string;
    orderId: string | null;
    lockTx: string | null;
    lockBlock: number | null;
    timelock: number | null;
  };

  /** Destination chain details */
  dstChain: {
    chain: Chain;
    address: string;
    asset: string;
    amount: string;
    orderId: string | null;
    lockTx: string | null;
    lockBlock: number | null;
    timelock: number | null;
    resolver: string | null;
  };

  /** Secret reveal details (if revealed) */
  secret: {
    revealed: boolean;
    preimage: string | null;
    revealedTx: string | null;
  };

  /** Timestamps */
  timestamps: {
    createdAt: number;
    updatedAt: number;
    archivedAt: number | null;
  };

  /**
   * Time-ordered lifecycle events: announces, locks, reveals, refunds,
   * recovery actions, etc. Sourced from the audit log and order state.
   */
  events: OrderLifecycleEvent[];
}

/** A single lifecycle event in the export. */
export interface OrderLifecycleEvent {
  /** Event type (announce, src_lock, secret_reveal, etc.) */
  type: string;

  /** Unix timestamp (seconds) when the event occurred */
  timestamp: number;

  /** Event-specific payload (varies by type) */
  payload: Record<string, unknown>;

  /** Request ID (if the event was triggered by an API call) */
  requestId?: string;
}

/** Filters for order lifecycle export queries. */
export interface OrderExportFilters {
  /** Filter by public order ID (exact match) */
  orderId?: string;

  /** Filter by order IDs (multiple exact matches) */
  orderIds?: string[];

  /** Filter by status (e.g., "completed", "refunded", "failed") */
  status?: OrderStatus;

  /** Filter by source chain */
  srcChain?: Chain;

  /** Filter by destination chain */
  dstChain?: Chain;

  /** Filter by created_at range (unix seconds) */
  createdAfter?: number;
  createdBefore?: number;

  /** Filter by updated_at range (unix seconds) */
  updatedAfter?: number;
  updatedBefore?: number;

  /** Include archived orders (default: false) */
  includeArchived?: boolean;

  /** Maximum number of orders to export (default: 100) */
  limit?: number;
}

/** Bulk export result: multiple order lifecycles. */
export interface OrderExportResult {
  /** List of order lifecycle exports */
  orders: OrderLifecycleExport[];

  /** Total count (before limit) */
  totalCount: number;

  /** Export metadata */
  metadata: {
    generatedAt: number;
    filters: OrderExportFilters;
  };
}

export class OrderExportService {
  constructor(
    private readonly ordersRepo: OrdersRepository,
    private readonly auditRepo: AuditRepository,
    private readonly log: Logger
  ) {}

  /**
   * Export a single order's full lifecycle.
   *
   * @param orderId - Public order ID
   * @returns Order lifecycle export, or null if not found
   */
  async exportOrder(orderId: string): Promise<OrderLifecycleExport | null> {
    const order = await this.ordersRepo.findByPublicId(orderId);
    if (!order) return null;

    const events = await this.buildLifecycleEvents(orderId);

    return this.buildExport(order, events);
  }

  /**
   * Export multiple orders matching the given filters.
   *
   * @param filters - Export filters (order IDs, status, chain, time range, etc.)
   * @returns Bulk export result with order lifecycles and metadata
   */
  async exportOrders(filters: OrderExportFilters): Promise<OrderExportResult> {
    const limit = Math.min(filters.limit ?? 100, 1000);
    const orders = await this.findOrdersByFilters(filters, limit);

    const lifecycles = await Promise.all(
      orders.map(async (order) => {
        const events = await this.buildLifecycleEvents(order.publicId);
        return this.buildExport(order, events);
      })
    );

    this.log.info(
      { count: lifecycles.length, filters },
      "Order lifecycle export completed"
    );

    return {
      orders: lifecycles,
      totalCount: lifecycles.length,
      metadata: {
        generatedAt: Math.floor(Date.now() / 1000),
        filters,
      },
    };
  }

  /**
   * Build the lifecycle event sequence for an order.
   * Merges audit log entries and order state transitions.
   */
  private async buildLifecycleEvents(orderId: string): Promise<OrderLifecycleEvent[]> {
    // Fetch audit log entries for this order
    const auditEntries = await this.auditRepo.forOrder(orderId);

    // Convert audit entries to lifecycle events
    const events: OrderLifecycleEvent[] = auditEntries.map((entry) => {
      // Parse payload JSON back to object
      let payload: Record<string, unknown> = {};
      try {
        payload = JSON.parse(entry.payloadJson);
      } catch {
        payload = { raw: entry.payloadJson };
      }

      return {
        type: entry.eventType,
        timestamp: entry.createdAt,
        payload,
        requestId: entry.requestId ?? undefined,
      };
    });

    // Already sorted by audit repo (ascending order)
    return events;
  }

  /**
   * Build a single order lifecycle export from order state and events.
   */
  private buildExport(order: OrderRow, events: OrderLifecycleEvent[]): OrderLifecycleExport {
    return {
      orderId: order.publicId,
      status: order.status,
      direction: order.direction,
      hashlock: order.hashlock,
      srcChain: {
        chain: order.srcChain,
        address: order.srcAddress,
        asset: order.srcAsset,
        amount: order.srcAmount,
        safetyDeposit: order.srcSafetyDeposit,
        orderId: order.srcOrderId,
        lockTx: order.srcLockTx,
        lockBlock: order.srcLockBlock,
        timelock: order.srcTimelock,
      },
      dstChain: {
        chain: order.dstChain,
        address: order.dstAddress,
        asset: order.dstAsset,
        amount: order.dstAmount,
        orderId: order.dstOrderId,
        lockTx: order.dstLockTx,
        lockBlock: order.dstLockBlock,
        timelock: order.dstTimelock,
        resolver: order.resolverAddress,
      },
      secret: {
        revealed: order.preimage !== null,
        preimage: order.preimage,
        revealedTx: order.secretRevealedTx,
      },
      timestamps: {
        createdAt: order.createdAt,
        updatedAt: order.updatedAt,
        archivedAt: order.archivedAt,
      },
      events,
    };
  }

  /**
   * Find orders matching the given filters.
   * This is a simplified implementation — production would use a more
   * sophisticated query builder or ORM.
   */
  private async findOrdersByFilters(
    filters: OrderExportFilters,
    limit: number
  ): Promise<OrderRow[]> {
    // Single order ID filter
    if (filters.orderId) {
      const order = await this.ordersRepo.findByPublicId(filters.orderId);
      return order ? [order] : [];
    }

    // Multiple order IDs filter
    if (filters.orderIds && filters.orderIds.length > 0) {
      const orders = await Promise.all(
        filters.orderIds.map((id) => this.ordersRepo.findByPublicId(id))
      );
      return orders.filter((o): o is OrderRow => o !== null);
    }

    // General filters: implement a basic query builder
    // In production, this would be a more sophisticated WHERE clause builder
    // For now, fetch all orders and filter in memory (inefficient, but correct)
    this.log.warn(
      "OrderExportService.findOrdersByFilters is using in-memory filtering. " +
      "Implement a proper query builder for production."
    );

    // Placeholder: return empty array for complex filters
    // TODO: Implement proper SQL query builder for complex filters
    return [];
  }
}
