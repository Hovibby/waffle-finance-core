/**
 * Tests for ClientSubscriptionManager — client listener registration.
 *
 * Coverage:
 *  - Registering a new client ID succeeds and returns the ID
 *  - Registering a duplicate ID throws ConflictError (409-style conflict)
 *  - Duplicate registration preserves the original client's callback/state
 *  - Registering a distinct (new) ID after a conflict still succeeds
 *  - ConflictError carries the expected code and message shape
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ClientSubscriptionManager, ConflictError } from '../src/events/client-subscriptions.js';
import { FusionEventManager } from '../src/events/event-handlers.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeManager(): ClientSubscriptionManager {
  // Mirror the pattern from event-handlers.test.ts: stub the OrdersService
  // dependency with the minimal surface FusionEventManager's constructor needs.
  const ordersServiceMock = {
    on: vi.fn(),
    emit: vi.fn(),
  } as never;

  const eventManager = new FusionEventManager(ordersServiceMock);
  return new ClientSubscriptionManager(eventManager);
}

function clientFixture(id: string) {
  return {
    id,
    connectionType: 'websocket' as const,
    connected: true,
    metadata: {},
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ClientSubscriptionManager — registerClient', () => {
  let manager: ClientSubscriptionManager;

  beforeEach(() => {
    manager = makeManager();
  });

  it('returns the client ID when registering a new client', () => {
    const id = manager.registerClient(clientFixture('client-001'));
    expect(id).toBe('client-001');
  });

  it('stores the client so it can be retrieved immediately after registration', () => {
    manager.registerClient(clientFixture('client-002'));
    const stored = manager.getClient('client-002');
    expect(stored).toBeDefined();
    expect(stored!.id).toBe('client-002');
    expect(stored!.connected).toBe(true);
  });

  it('throws ConflictError when the same ID is registered a second time', () => {
    manager.registerClient(clientFixture('dup-id'));

    expect(() => manager.registerClient(clientFixture('dup-id'))).toThrow(ConflictError);
  });

  it('ConflictError message identifies the conflicting ID', () => {
    manager.registerClient(clientFixture('dup-id'));

    let caught: unknown;
    try {
      manager.registerClient(clientFixture('dup-id'));
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ConflictError);
    expect((caught as ConflictError).message).toContain('dup-id');
  });

  it('ConflictError carries the CONFLICT code', () => {
    manager.registerClient(clientFixture('dup-id'));

    let caught: unknown;
    try {
      manager.registerClient(clientFixture('dup-id'));
    } catch (err) {
      caught = err;
    }

    expect((caught as ConflictError).code).toBe('CONFLICT');
  });

  it('duplicate registration does not overwrite the original client state', () => {
    // Register the first client and record its connectedAt timestamp
    manager.registerClient(clientFixture('dup-id'));
    const original = manager.getClient('dup-id')!;
    const originalConnectedAt = original.connectedAt;

    // Attempt a second registration with a different connectionType
    try {
      manager.registerClient({ ...clientFixture('dup-id'), connectionType: 'sse' });
    } catch {
      // expected ConflictError — swallow it
    }

    // The stored client must still be the original, unmodified entry
    const afterAttempt = manager.getClient('dup-id')!;
    expect(afterAttempt.connectionType).toBe('websocket');
    expect(afterAttempt.connectedAt).toBe(originalConnectedAt);
  });

  it('a new distinct ID registers successfully even after a conflict on another ID', () => {
    manager.registerClient(clientFixture('dup-id'));

    // Cause a conflict
    try {
      manager.registerClient(clientFixture('dup-id'));
    } catch {
      // expected
    }

    // A completely different ID must still be accepted
    expect(() => manager.registerClient(clientFixture('fresh-id'))).not.toThrow();
    expect(manager.getClient('fresh-id')).toBeDefined();
  });

  it('registering after unregistering the same ID succeeds (ID is no longer active)', () => {
    manager.registerClient(clientFixture('reuse-id'));
    manager.unregisterClient('reuse-id');

    // Now the ID is gone — re-registration must NOT throw
    expect(() => manager.registerClient(clientFixture('reuse-id'))).not.toThrow();
    expect(manager.getClient('reuse-id')).toBeDefined();
  });
});
