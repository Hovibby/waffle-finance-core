/**
 * @file routes/export.ts
 *
 * Order export endpoint.
 *
 * POST /api/orders/export — export a batch of orders by their public IDs.
 *
 * Request body:
 *   { "orderIds": ["wf_0x…", "wf_0x…"] }
 *
 * Each entry in `orderIds` must be a non-empty string.  Empty strings are
 * rejected before any database work occurs (#551).
 *
 * Response:
 *   200 { orders: SerializedOrder[] }
 *   400 { error: "validation_error", message: string, details: ZodIssue[] }
 */

import { Router } from "express";
import { z } from "zod";
import type { Logger } from "pino";
import type { OrderService } from "../../services/order-service.js";
import { validationError } from "../errors.js";

// ─── Schema ───────────────────────────────────────────────────────────────────

/**
 * Schema for POST /api/orders/export.
 *
 * Each `orderIds` entry is trimmed and then required to contain at least one
 * meaningful character — empty or whitespace-only strings fail validation
 * before any database lookup is attempted.
 */
export const exportRequestSchema = z.object({
  orderIds: z
    .array(
      z.string().trim().min(1, "each orderIds entry must be a non-empty string"),
    )
    .min(1, "orderIds must contain at least one entry")
    .max(100, "orderIds must not exceed 100 entries"),
});

export type ExportRequest = z.infer<typeof exportRequestSchema>;

// ─── Route factory ────────────────────────────────────────────────────────────

export function exportRoutes(orders: OrderService, log?: Logger): Router {
  const router = Router();

  /**
   * POST /api/orders/export
   *
   * Returns the serialised order objects for each of the requested IDs.
   * Unknown IDs are omitted from the result (not an error).
   */
  router.post("/orders/export", async (req, res, next) => {
    const parsed = exportRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(validationError(parsed.error.errors));
      return;
    }

    const { orderIds } = parsed.data;

    try {
      const results = await Promise.all(orderIds.map((id) => orders.get(id)));
      const found = results.filter(Boolean);
      res.json({ orders: found });
    } catch (err) {
      log?.error({ err }, "export failed");
      next(err);
    }
  });

  return router;
}
