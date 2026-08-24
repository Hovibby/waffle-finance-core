# Foundry Invariant & Stateful Fuzz Testing Suite for HTLCEscrow

This directory contains the Foundry unit, fuzz, and stateful invariant test suite for `HTLCEscrow`.

## Test File Architecture

- **`HTLCEscrow.t.sol`**: Unit and single-step fuzz tests for `createOrder`, `claimOrder`, and `refundOrder`.
- **`InvariantHTLCEscrow.t.sol`**: Stateful fuzzing harness (`HTLCEscrowHandler`) and invariant test contract (`InvariantHTLCEscrowTest`) exercising 1,000+ sequences across 6 specific system invariants and stateful bug-finding scenarios.

---

## 6 System Invariants Tested

1. **Balance & Solvency Invariant (`invariant_balanceMatchesFundedOrdersAndWithdrawals`)**
   - **Property**: The contract's native ETH and ERC20 token balances must strictly equal the sum of all currently `Funded` orders (amount + safety deposit) plus all pending pull-payment withdrawals across all users.
   - **Protection**: Ensures total solvency and verifies no ETH or token can be leaked, locked permanently without accounting, or lost during push/pull payouts.

2. **Pull-Payment Isolation Invariant (`invariant_pullPaymentIsolation`)**
   - **Property**: `pendingWithdrawals[account]` is strictly isolated per recipient account. Actions performed by other users (creating, claiming, refunding, or withdrawing) cannot modify or drain account `A`'s credited withdrawal balance.
   - **Protection**: Guarantees non-custodial isolation and prevents cross-user pull payment balance tampering.

3. **Reentrancy Safety Invariant (`invariant_reentrancySafety`)**
   - **Property**: Reentrant callbacks triggered when native ETH is pushed to a contract fallback (e.g. `ReentrantActor`) cannot bypass `ReentrancyGuard`, alter order states unexpectedly, double-spend, or withdraw uncredited funds.
   - **Protection**: Verifies `nonReentrant` defense across all state transitions.

4. **Timelock Enforcement & Immutable Finality Invariant (`invariant_timelockEnforcement`)**
   - **Property**: No order can be claimed if `block.timestamp > timelock`. No order can be refunded if `block.timestamp <= timelock`. Finalized orders (`Claimed` or `Refunded`) have immutable status and valid `finalisedAt >= createdAt` timestamps.
   - **Protection**: Prevents state machine violations and improper early/late order settlement.

5. **Preimage Integrity Invariant (`invariant_preimageIntegrity`)**
   - **Property**: `order.status == Claimed` iff the revealed preimage is exactly 32 bytes and satisfies `sha256(preimage) == hashlock` or `keccak256(preimage) == hashlock`. Additionally, `order.preimageKeccak` equals `keccak256(preimage)`. Unclaimed orders maintain `preimageKeccak == bytes32(0)`.
   - **Protection**: Protects atomic swap preimage verification cross-chain (Soroban sha256 & EVM keccak256).

6. **Safety Deposit Accounting Invariant (`invariant_safetyDepositAccounting`)**
   - **Property**: Active safety deposits in funded orders plus deferred safety deposits in `pendingWithdrawals` never exceed total safety deposits paid during order creation.
   - **Protection**: Ensures safety deposit incentives are credited without loss or double counting.

---

## Stateful Bug-Finding Scenarios

- **`testStateful_concurrentClaims`**: Tests multiple actors attempting to claim the same order sequentially or concurrently. Asserts first claim succeeds and subsequent claims revert `OrderNotClaimable`.
- **`testStateful_claimRefundRaces`**: Tests exact expiry edge conditions (`block.timestamp == timelock`). Asserts `claimOrder` succeeds at expiry timestamp while `refundOrder` reverts `NotExpired`, and once claimed, subsequent refund at `timelock + 1` reverts `OrderNotRefundable`.
- **`testStateful_zeroAmountsAndEdgeCases`**: Tests invalid order creations (zero amount, zero beneficiary, zero hashlock, timelock < 300s, safety deposit < minSafetyDeposit) and verifies proper custom error reverts.

---

## Running Tests Locally

```bash
# Run unit and fuzz tests
forge test --match-path "test/foundry/HTLCEscrow.t.sol" -v

# Run invariant tests with 1,000+ stateful call sequences
forge test --match-path "test/foundry/InvariantHTLCEscrow.t.sol" -v
```

## CI Integration

Foundry fuzz and invariant tests are integrated into GitHub Actions via `.github/workflows/contracts.yml`:
```yaml
- name: Run Foundry fuzz + invariant tests
  working-directory: contracts
  run: forge test --match-path "test/foundry/*" -v
```
