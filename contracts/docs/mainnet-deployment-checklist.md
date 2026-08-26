# Mainnet Deployment Checklist

This checklist must be completed before deploying or upgrading any WaffleFinance
contract on Ethereum mainnet.  Every item is testable — the corresponding test
file is referenced in the "Verified by" column.

## Pre-deployment

| # | Item | Verified by |
|---|------|-------------|
| 1 | `MAINNET_RPC_URL` or `INFURA_API_KEY` is set and resolves to a valid Ethereum mainnet endpoint (chain ID 1) | `test/mainnet-fork/escrow-factory.test.ts` — "mainnet chain ID is 1" |
| 2 | `PRIVATE_KEY` (or `RELAYER_PRIVATE_KEY`) is a 64-hex-char key, not all-zeros and not a placeholder | `relayer/test/config-validator.test.ts` |
| 3 | The 1inch EscrowFactory at `0xa7bcb4eac8964306f9e3764f67db6a7af6ddf99a` has contract code on mainnet | `test/mainnet-fork/escrow-factory.test.ts` — "has contract code on mainnet" |
| 4 | `ESCROW_SRC_IMPLEMENTATION` and `ESCROW_DST_IMPLEMENTATION` return non-zero addresses (factory is live) | `test/mainnet-fork/escrow-factory.test.ts` — "ESCROW_SRC_IMPLEMENTATION() returns a non-zero address" |
| 5 | `addressOfEscrowDst()` is deterministic for the same immutables (no randomness in address derivation) | `test/mainnet-fork/escrow-factory.test.ts` — "deterministic address" |
| 6 | Mainnet ABI (`createDstEscrow`) is selected when `isMainnet=true` in `getEscrowFactoryABI()` | `test/mainnet-fork/escrow-factory.test.ts` — "ABI branching" |
| 7 | Testnet ABI (`createEscrow`) is NOT deployed to mainnet — selectors do not collide | `test/mainnet-fork/escrow-factory.test.ts` — "selectors do not collide" |
| 8 | `NETWORK_CONFIG.mainnet.ethereum.escrowFactory` matches the deployed 1inch address | `test/mainnet-fork/escrow-factory.test.ts` — "getEscrowFactoryAddress('mainnet')" |
| 9 | Mainnet and testnet Stellar network passphrases are distinct | `test/mainnet-fork/escrow-factory.test.ts` — "networkPassphrase differs" |
| 10 | Horizon URL for mainnet is a reachable `https://` endpoint | `test/mainnet-fork/escrow-factory.test.ts` — "valid https URL" |

## Contract deployment

| # | Item | Notes |
|---|------|-------|
| 11 | Deploy `HTLCEscrow` with `resolverRegistry=address(0)` (permissionless) or with the live `ResolverRegistry` address | Use `scripts/deploy.ts --network mainnet` |
| 12 | Verify contract source on Etherscan with `npx hardhat verify` | Required for transparency |
| 13 | Record the deployed address in `deployments.mainnet.json` | Update `NETWORK_CONFIG.mainnet.ethereum.htlcBridge` |
| 14 | Record the deployment block number for event re-indexing | Needed by coordinator listeners |
| 15 | Confirm `minSafetyDeposit` in constructor reflects current gas cost × relayer margin | Re-deploy if gas conditions have shifted significantly |

## Post-deployment smoke test

| # | Item | Command |
|---|------|---------|
| 16 | Fork mainnet at the deployment block and run the full integration suite | `MAINNET_RPC_URL=<url> npx hardhat test test/mainnet-fork/ --network hardhat` |
| 17 | Create a single small native-ETH order on the forked chain and verify it can be claimed | Covered by `test/mainnet-fork/escrow-factory.test.ts` |
| 18 | Verify USDC order creation and `InsufficientAllowance` revert on the forked chain | Covered by `test/mainnet-fork/escrow-factory.test.ts` |
| 19 | Verify `refundOrder` succeeds after `advanceTime(TIMELOCK + 10)` on the fork | Covered by `test/mainnet-fork/escrow-factory.test.ts` |
| 20 | Confirm the relayer's `config-validator` passes all checks with mainnet env vars | `pnpm --filter @wafflefinance/relayer test` |

## Relayer configuration

| # | Item | Reference |
|---|------|-----------|
| 21 | Set `NETWORK_MODE=mainnet` in relayer environment | `relayer/.env.example` |
| 22 | Set `ETHEREUM_RPC_URL` to a **mainnet** endpoint | `relayer/src/config-validator.ts` |
| 23 | Set `STELLAR_HORIZON_URL` to `https://horizon.stellar.org` | `relayer/src/config/networks.ts` — `NETWORK_CONFIG.mainnet.stellar.horizonUrl` |
| 24 | Confirm relayer `/readyz` returns HTTP 200 after deploying with mainnet env | `relayer/test/health.test.ts` |
| 25 | Confirm no `PLACEHOLDER` or `YOUR_` patterns remain in any env var | `relayer/test/config-validator.test.ts` |

## Rollback plan

- **Coordinator**: point `HTLC_ESCROW_ADDRESS` back to the previous deployment; no state
  migration required (all order data is in the DB).
- **Relayer**: revert `NETWORK_MODE` and `ETHEREUM_RPC_URL`; the relayer is stateless.
- **Contracts**: HTLC orders are immutable once created. Existing orders expire naturally
  via `refundOrder`. No emergency withdrawal exists by design.
