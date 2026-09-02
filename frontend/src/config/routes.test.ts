/**
 * Tests for the route configuration layer.
 *
 * Verifies supported routes, token metadata, and route lookup behavior.
 */

import { describe, expect, it } from 'vitest';
import {
  SUPPORTED_ROUTES,
  ROUTE_TOKENS,
  getRoute,
  isRouteSupported,
} from '../config/routes';

describe('SUPPORTED_ROUTES', () => {
  it('includes all expected directions', () => {
    const directions = SUPPORTED_ROUTES.map((r) => r.direction);
    expect(directions).toContain('eth_to_xlm');
    expect(directions).toContain('xlm_to_eth');
    expect(directions).toContain('eth_to_sol');
    expect(directions).toContain('sol_to_eth');
  });

  it('does not include xlm_to_sol or sol_to_xlm by default', () => {
    const directions = SUPPORTED_ROUTES.map((r) => r.direction);
    expect(directions).not.toContain('xlm_to_sol');
    expect(directions).not.toContain('sol_to_xlm');
  });

  it('each route has fromToken and toToken with stable metadata', () => {
    for (const route of SUPPORTED_ROUTES) {
      expect(route.fromToken.symbol).toBeTruthy();
      expect(route.toToken.symbol).toBeTruthy();
      expect(route.fromToken.chain).toBeTruthy();
      expect(route.toToken.chain).toBeTruthy();
    }
  });
});

describe('ROUTE_TOKENS', () => {
  it('defines ETH, XLM, and SOL tokens', () => {
    expect(ROUTE_TOKENS.ETH.symbol).toBe('ETH');
    expect(ROUTE_TOKENS.XLM.symbol).toBe('XLM');
    expect(ROUTE_TOKENS.SOL.symbol).toBe('SOL');
  });
});

describe('getRoute', () => {
  it('returns the matching route for a supported direction', () => {
    const route = getRoute('eth_to_xlm');
    expect(route?.direction).toBe('eth_to_xlm');
    expect(route?.fromToken.symbol).toBe('ETH');
    expect(route?.toToken.symbol).toBe('XLM');
  });

  it('returns undefined for an unsupported direction', () => {
    expect(getRoute('xlm_to_sol')).toBeUndefined();
  });
});

describe('isRouteSupported', () => {
  it('returns true for supported routes', () => {
    expect(isRouteSupported('eth_to_xlm')).toBe(true);
    expect(isRouteSupported('sol_to_eth')).toBe(true);
  });

  it('returns false for unsupported routes', () => {
    expect(isRouteSupported('xlm_to_sol')).toBe(false);
  });
});
