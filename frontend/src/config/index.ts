/**
 * Frontend configuration barrel export.
 *
 * Consumers should prefer the selector functions in `selectors.ts` over
 * destructuring the raw config objects directly. Selectors make the required
 * config subset explicit and keep components decoupled from the full config shape.
 */

export * from './env';
export * from './feature-flags';
export * from './networks';
export * from './routes';
export * from './rpc-urls';
export * from './selectors';
