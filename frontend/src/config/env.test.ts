/**
 * Tests for the runtime environment config layer.
 *
 * Verifies that envConfig reads safe defaults when Vite env vars are missing
 * and respects them when they are present.
 */

import { describe, expect, it, vi } from 'vitest';
import { envConfig } from '../config/env';

describe('envConfig', () => {
  it('defaults apiBaseUrl to localhost:3001 when VITE_API_BASE_URL is absent', () => {
    expect(envConfig.apiBaseUrl).toBe('http://localhost:3001');
  });

  it('defaults enableMockData to false when VITE_ENABLE_MOCK_DATA is absent', () => {
    expect(envConfig.enableMockData).toBe(false);
  });

  it('defaults publicAssetsBaseUrl to / when VITE_PUBLIC_ASSETS_BASE_URL is absent', () => {
    expect(envConfig.publicAssetsBaseUrl).toBe('/');
  });
});
