# WaffleFinance Feature Flags

Experimental features and partially supported chains are gated behind explicit
feature flags. This prevents accidental exposure of unstable functionality to
production users and makes it clear which flows are still under development.

## Available Flags

| Flag | Environment Variable | Default | Description |
|------|---------------------|---------|-------------|
| `solanaSimulationMode` | `FEATURE_SOLANA_SIMULATION_MODE` / `VITE_FEATURE_SOLANA_SIMULATION_MODE` | `false` | Enables Solana simulation/mock mode for testing settlement flows without a real on-chain program. |
| `sorobanEarlySupport` | `FEATURE_SOROBAN_EARLY_SUPPORT` / `VITE_FEATURE_SOROBAN_EARLY_SUPPORT` | `false` | Enables early Soroban chain support (experimental routes and contract bindings). |
| `experimentalUiRoutes` | `FEATURE_EXPERIMENTAL_UI_ROUTES` / `VITE_FEATURE_EXPERIMENTAL_UI_ROUTES` | `false` | Enables experimental UI routes and features not yet ready for production users. |

## Usage

### Backend services (coordinator, relayer, resolver)

Set the corresponding `FEATURE_*` environment variable in your `.env` file or
deployment secrets:

```bash
FEATURE_SOLANA_SIMULATION_MODE=true
FEATURE_SOROBAN_EARLY_SUPPORT=false
FEATURE_EXPERIMENTAL_UI_ROUTES=false
```

Access flags via the parsed config:

```ts
import { loadRelayerConfig } from '@wafflefinance/config/node';

const config = loadRelayerConfig();
if (config.featureFlags.solanaSimulationMode) {
  // enable mock settlement flow
}
```

### Frontend

Set the corresponding `VITE_FEATURE_*` environment variable in your `.env` file
or Vite deployment config:

```bash
VITE_FEATURE_SOLANA_SIMULATION_MODE=true
VITE_FEATURE_SOROBAN_EARLY_SUPPORT=false
VITE_FEATURE_EXPERIMENTAL_UI_ROUTES=false
```

Access flags via the frontend config:

```ts
import { frontendConfig } from '@wafflefinance/config';

if (frontendConfig.featureFlags.solanaSimulationMode) {
  // show simulation UI
}
```

## Gating Rules

- **Build-time**: Frontend flags are baked into the Vite bundle via
  `loadFrontendConfig()`. Disabling a flag removes the associated code paths
  from the production bundle.
- **Runtime**: Backend flags are parsed at startup from environment variables.
  Services refuse to start experimental flows unless the flag is explicitly
  enabled.
- **Default**: All experimental flags default to `false`. Misconfigured
  environments do not expose unstable functionality.

## Adding a New Feature Flag

1. Add the flag to `featureFlagsSchema` in `packages/config/src/schema.ts`.
2. Map the env var in `packages/config/src/node.ts` (backend) and
   `packages/config/src/index.ts` (frontend).
3. Document the flag in this file and in the relevant `.env.example`.
4. Gate the experimental code path behind the flag using `isFeatureEnabled()`
   or direct config access.
