/**
 * Runtime environment layer for the frontend.
 *
 * This layer is responsible for reading raw browser/runtime values from
 * `import.meta.env` and exposing safe defaults when values are missing.
 * It does NOT know about networks, routes, or feature flags.
 */

const raw = (import.meta as any).env || {};

export type EnvConfig = Readonly<{
  /** Base URL for the relayer/coordinator API. */
  apiBaseUrl: string;
  /** Whether mock data mode is enabled. */
  enableMockData: boolean;
  /** Public assets base URL (CDN or static folder). */
  publicAssetsBaseUrl: string;
}>;

function readEnvConfig(): EnvConfig {
  return {
    apiBaseUrl: raw.VITE_API_BASE_URL ?? 'http://localhost:3001',
    enableMockData: raw.VITE_ENABLE_MOCK_DATA === 'true',
    publicAssetsBaseUrl: raw.VITE_PUBLIC_ASSETS_BASE_URL ?? '/',
  };
}

export const envConfig: EnvConfig = readEnvConfig();
