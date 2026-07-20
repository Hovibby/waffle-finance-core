/**
 * ProgressiveFillManager stub — minimal EventEmitter implementation used
 * by FusionEventManager. Full progressive fill logic is not yet implemented.
 */

import { EventEmitter } from 'events';

export interface Fragment {
  secretHash: string;
  amount: string;
  index: number;
}

export interface ProgressiveFillOrder {
  srcChainId: number;
  dstChainId: number;
  allowPartialFills: boolean;
  allowMultipleFills: boolean;
  quoteId?: string;
  extension?: string;
}

export class ProgressiveFillManager extends EventEmitter {
  createOrder(
    _orderId: string,
    _order: ProgressiveFillOrder,
    _fragments: Fragment[],
  ): void {
    // Stub — no-op
  }

  executeFill(_orderId: string, _fragmentIndex: number): void {
    // Stub — no-op
  }

  getOrder(_orderId: string): ProgressiveFillOrder | undefined {
    return undefined;
  }
}

export default ProgressiveFillManager;
