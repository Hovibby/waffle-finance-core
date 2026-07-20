/**
 * OrdersService stub — minimal interface used by FusionEventManager
 * and the event-handlers test suite.
 *
 * The full implementation lives in src/index.ts (inline) and is not
 * extracted into a class at this time. This file provides the TypeScript
 * type so imports compile cleanly.
 */

import { EventEmitter } from 'events';

export interface ActiveOrder {
  orderHash: string;
  srcChainId: number;
  dstChainId: number;
  order: {
    makingAmount: string;
    makerAsset: string;
    takingAmount: string;
    takerAsset: string;
  };
  deadline: number;
}

export class OrdersService extends EventEmitter {
  private orders: Map<string, ActiveOrder> = new Map();

  getActiveOrders(): { items: ActiveOrder[] } {
    return { items: Array.from(this.orders.values()) };
  }

  getOrder(orderHash: string): ActiveOrder | undefined {
    return this.orders.get(orderHash);
  }

  addOrder(order: ActiveOrder): void {
    this.orders.set(order.orderHash, order);
    this.emit('orderAdded', order);
  }

  removeOrder(orderHash: string): void {
    this.orders.delete(orderHash);
  }
}

export default OrdersService;
