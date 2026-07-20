/**
 * @fileoverview Recovery admin routes
 *
 * Provides operator visibility into and control over settlement failures.
 *
 * All routes require admin authentication (Bearer token or X-Api-Key header
 * matching RELAYER_ADMIN_API_KEY) via `requireAdminAuth`.
 *
 * Routes:
 *
 *   GET  /api/recovery/status
 *     Full snapshot of all settlement ledger entries, grouped by phase.
 *     Includes per-phase counts and entries needing manual intervention.
 *
 *   GET  /api/recovery/status/:orderId
 *     Settlement failure entries for a specific order across all actions.
 *
 *   GET  /api/recovery/intervention
 *     Subset of entries in `failed_terminal` or exhausted `failed_ambiguous`
 *     phases that require manual operator attention.
 *
 *   GET  /api/recovery/due
 *     Entries currently eligible for retry (back-off window expired).
 *
 *   POST /api/recovery/retry/:orderId/:action
 *     Trigger an immediate manual recovery attempt for an order + action.
 *     Body: { metadata?: Record<string, unknown> }
 *
 *   POST /api/recovery/scan
 *     Trigger an immediate retry scan (same as the background timer tick).
 *     Useful for forcing recovery without waiting for the next interval.
 */

import { Router, Request, Response } from 'express';
import { requireAdminAuth } from '../middleware/admin-auth.js';
import type { RecoveryService } from '../services/recovery-service.js';
import type { SettlementAction } from '../services/settlement-failure-ledger.js';

const VALID_ACTIONS: SettlementAction[] = [
  'eth_send',
  'xlm_refund',
  'xlm_release',
  'eth_escrow_claim',
];

function isValidAction(value: string): value is SettlementAction {
  return (VALID_ACTIONS as string[]).includes(value);
}

/**
 * Build the recovery router.
 *
 * @param recoveryService - The RecoveryService instance to delegate to.
 *   Pass the relayer's singleton at startup; pass a fresh test instance
 *   in unit tests.
 */
export function buildRecoveryRouter(recoveryService: RecoveryService): Router {
  const router = Router();

  // ── Authentication ────────────────────────────────────────────────────────
  // All recovery routes are admin-only.
  router.use(requireAdminAuth());

  // ── GET /api/recovery/status ──────────────────────────────────────────────
  router.get('/status', (_req: Request, res: Response) => {
    const all = recoveryService.snapshot();
    const ledgerStats = recoveryService.getLedgerStats();
    const serviceStats = recoveryService.getStats();

    res.json({
      ledger: {
        counts: ledgerStats,
        entries: all,
      },
      service: serviceStats,
    });
  });

  // ── GET /api/recovery/status/:orderId ─────────────────────────────────────
  router.get('/status/:orderId', (req: Request, res: Response) => {
    const { orderId } = req.params;

    const entries = recoveryService
      .snapshot()
      .filter((e) => e.orderId === orderId);

    if (entries.length === 0) {
      return res.status(404).json({
        error: 'No recovery entries found for this order',
        orderId,
      });
    }

    res.json({ orderId, entries });
  });

  // ── GET /api/recovery/intervention ───────────────────────────────────────
  router.get('/intervention', (_req: Request, res: Response) => {
    const entries = recoveryService.getFailedEntries();
    res.json({
      count: entries.length,
      entries,
      message:
        entries.length > 0
          ? 'These entries have exhausted automatic retries and require manual operator action.'
          : 'No entries require manual intervention.',
    });
  });

  // ── GET /api/recovery/due ─────────────────────────────────────────────────
  router.get('/due', (_req: Request, res: Response) => {
    const entries = recoveryService.getDueForRetry();
    res.json({
      count: entries.length,
      entries,
    });
  });

  // ── POST /api/recovery/retry/:orderId/:action ────────────────────────────
  router.post('/retry/:orderId/:action', async (req: Request, res: Response) => {
    const { orderId, action } = req.params;
    const metadata: Record<string, unknown> = req.body?.metadata ?? {};

    if (!isValidAction(action)) {
      return res.status(400).json({
        error: 'Invalid action',
        action,
        validActions: VALID_ACTIONS,
      });
    }

    try {
      const txHash = await recoveryService.manualRecover(orderId, action, {
        ...metadata,
        triggeredBy: 'admin_api',
        triggeredAt: Math.floor(Date.now() / 1000),
      });

      res.json({
        success: true,
        orderId,
        action,
        txHash,
        message: `Recovery succeeded for orderId=${orderId} action=${action}`,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      // 409 for "no executor registered" (config gap), 500 for on-chain failure
      const isConfig = message.includes('No executor registered');
      res.status(isConfig ? 409 : 500).json({
        error: 'Recovery attempt failed',
        orderId,
        action,
        details: message,
        message: 'Check /api/recovery/status/:orderId for the updated entry state.',
      });
    }
  });

  // ── POST /api/recovery/scan ───────────────────────────────────────────────
  router.post('/scan', async (_req: Request, res: Response) => {
    try {
      // Fire-and-forget — we don't await the full scan here so the HTTP
      // request completes promptly. The scan result is visible through
      // /api/recovery/status after completion.
      void recoveryService.runRetryScan();
      res.json({
        success: true,
        message: 'Retry scan triggered. Check /api/recovery/status for results.',
        triggeredAt: new Date().toISOString(),
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: 'Failed to trigger scan', details: message });
    }
  });

  return router;
}
