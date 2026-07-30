/**
 * Order lifecycle export routes.
 *
 * Provides HTTP endpoints for exporting order lifecycle data in a structured,
 * compliance-friendly format. Intended for:
 *  - Auditors reviewing order histories
 *  - Incident responders investigating failures
 *  - Operators analyzing completion rates and failure modes
 *
 * Security: these routes should be gated behind authentication in production.
 * Exported data includes sensitive order details (addresses, amounts, etc.).
 */

import { Router } from "express";
import { z } from "zod";
import type { Logger } from "pino";
import type { OrderExportService } from "../../services/order-export.js";
import { validationError, notFoundError } from "../errors.js";

/** Validation schema for single-order export requests. */
const exportOrderSchema = z.object({
  orderId: z.string().min(1, "Order ID is required"),
});

/** Validation schema for bulk export filter requests. */
const exportFiltersSchema = z.object({
  orderIds: z.array(z.string()).optional(),
  status: z.enum([
    "announced",
    "src_locked",
    "dst_locked",
    "secret_revealed",
    "completed",
    "refunded",
    "failed",
    "expired",
  ]).optional(),
  srcChain: z.enum(["ethereum", "stellar", "solana"]).optional(),
  dstChain: z.enum(["ethereum", "stellar", "solana"]).optional(),
  createdAfter: z.coerce.number().int().nonnegative().optional(),
  createdBefore: z.coerce.number().int().nonnegative().optional(),
  updatedAfter: z.coerce.number().int().nonnegative().optional(),
  updatedBefore: z.coerce.number().int().nonnegative().optional(),
  includeArchived: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().positive().max(1000).optional(),
});

/**
 * Create the export router with the given export service.
 *
 * @param exportService - Order export service instance
 * @param log - Optional logger for request logging
 * @returns Express router with export routes
 */
export function exportRoutes(exportService: OrderExportService, log?: Logger): Router {
  const router = Router();

  /**
   * GET /export/orders/:orderId
   *
   * Export a single order's full lifecycle.
   *
   * Response: OrderLifecycleExport (see order-export.ts)
   * Status: 200 OK | 400 Bad Request | 404 Not Found
   */
  router.get("/export/orders/:orderId", async (req, res, next) => {
    try {
      const { orderId } = exportOrderSchema.parse(req.params);

      const lifecycle = await exportService.exportOrder(orderId);

      if (!lifecycle) {
        res.status(404).json(notFoundError(`Order ${orderId} not found`));
        return;
      }

      log?.info({ orderId }, "Order lifecycle export generated");
      res.json(lifecycle);
    } catch (err) {
      if (err instanceof z.ZodError) {
        res.status(400).json(validationError(err.errors));
        return;
      }
      next(err);
    }
  });

  /**
   * POST /export/orders
   *
   * Bulk export: export multiple orders matching the given filters.
   *
   * Request body: OrderExportFilters (see order-export.ts)
   * Response: OrderExportResult
   * Status: 200 OK | 400 Bad Request
   */
  router.post("/export/orders", async (req, res, next) => {
    try {
      const filters = exportFiltersSchema.parse(req.body);

      const result = await exportService.exportOrders(filters);

      log?.info(
        { count: result.orders.length, filters },
        "Bulk order export generated"
      );
      res.json(result);
    } catch (err) {
      if (err instanceof z.ZodError) {
        res.status(400).json(validationError(err.errors));
        return;
      }
      next(err);
    }
  });

  return router;
}
