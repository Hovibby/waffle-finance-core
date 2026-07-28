/**
 * Tests for the feature flag layer.
 *
 * Verifies that feature flags are present and have stable defaults.
 */

import { describe, expect, it } from 'vitest';
import {
  featureFlags,
  isFeatureEnabled,
} from '../config/feature-flags';

describe('featureFlags', () => {
  it('exposes all expected flags', () => {
    expect(featureFlags).toHaveProperty('faucetEnabled');
    expect(featureFlags).toHaveProperty('historyStreamEnabled');
    expect(featureFlags).toHaveProperty('refundFlowEnabled');
    expect(featureFlags).toHaveProperty('solanaRoutesEnabled');
    expect(featureFlags).toHaveProperty('introAnimationEnabled');
    expect(featureFlags).toHaveProperty('darkVeilEnabled');
  });

  it('defaults all flags to true', () => {
    Object.values(featureFlags).forEach((value) => {
      expect(value).toBe(true);
    });
  });
});

describe('isFeatureEnabled', () => {
  it('returns true for known flags by default', () => {
    expect(isFeatureEnabled('faucetEnabled')).toBe(true);
    expect(isFeatureEnabled('solanaRoutesEnabled')).toBe(true);
  });
});
