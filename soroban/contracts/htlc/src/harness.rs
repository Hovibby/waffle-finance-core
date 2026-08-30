//! Migration test harness for the WaffleFinance HTLC contract.
//!
//! This module provides low-level helpers that migration tests use to:
//!
//! 1. **Plant legacy state** – write `OrderV0` (pre-versioning layout) and/or
//!    a missing `SchemaVersion` key directly into the contract's storage,
//!    simulating what an old on-chain deployment would look like before any
//!    migration has run.
//! 2. **Simulate pre-migration ledger** – set the contract into the exact
//!    state a V0 deployment would be in (no `SchemaVersion` key, `NextOrderId`
//!    advanced to reflect previously created orders).
//! 3. **Assert post-migration invariants** – verify that every order in a
//!    range is readable as the current `Order` layout, that balances are
//!    consistent, and that the schema version key is correctly stamped.
//!
//! # Design notes
//!
//! All helpers operate through `env.as_contract(&htlc_address, || …)` to
//! bypass the usual `require_auth` / entry-point guards and write arbitrary
//! storage values. This is only available in the Soroban `testutils` feature
//! and is never compiled into production builds.
//!
//! The helpers are `pub` so that both `test.rs` and `prop_tests.rs` can share
//! them without duplication.

#![cfg(test)]

use soroban_sdk::{
    testutils::{storage::Persistent as _, storage::Instance as _, Address as _, Ledger, LedgerInfo},
    token::{StellarAssetClient, TokenClient},
    Address, Bytes, BytesN, Env,
};

use crate::{
    migration::{OrderV0, SchemaVersion, CURRENT_SCHEMA_VERSION},
    DataKey, HtlcContract, HtlcContractClient, Order, OrderStatus,
    FINALISED_ORDER_TTL_LEDGERS, ORDER_TTL_MARGIN_LEDGERS, ASSUMED_MIN_LEDGER_TIME_SECS,
};

// ─────────────────────────────────────────────────────────────────────────────
// Token deployment
// ─────────────────────────────────────────────────────────────────────────────

/// Deploy a Stellar Asset Contract and return `(address, sac_client, token_client)`.
pub fn deploy_token<'a>(
    env: &'a Env,
    admin: &Address,
) -> (Address, StellarAssetClient<'a>, TokenClient<'a>) {
    let contract = env.register_stellar_asset_contract_v2(admin.clone());
    let address = contract.address();
    (
        address.clone(),
        StellarAssetClient::new(env, &address),
        TokenClient::new(env, &address),
    )
}

// ─────────────────────────────────────────────────────────────────────────────
// Contract deployment helpers
// ─────────────────────────────────────────────────────────────────────────────

/// Deploy a fresh HTLC contract and return `(admin, client)`. The constructor
/// stamps `SchemaVersion::V1` automatically so this represents a *current*
/// deployment.
pub fn deploy_htlc<'a>(env: &'a Env, min_safety_deposit: i128) -> (Address, HtlcContractClient<'a>) {
    let admin = Address::generate(env);
    let contract_id = env.register(HtlcContract, (admin.clone(), min_safety_deposit));
    let client = HtlcContractClient::new(env, &contract_id);
    env.mock_all_auths();
    (admin, client)
}

/// Deploy a *legacy* (V0) HTLC contract. The contract binary is the same, but
/// immediately after deployment this helper:
///
/// 1. Removes the `SchemaVersion` key from instance storage (simulating a
///    pre-versioning deployment).
/// 2. Optionally removes `MigrationLock` (should never be set after a fresh
///    deploy, but included for completeness).
///
/// The result looks identical to what an old deployed contract's state would
/// be when this codebase is first deployed over it.
pub fn deploy_htlc_legacy<'a>(
    env: &'a Env,
    min_safety_deposit: i128,
) -> (Address, HtlcContractClient<'a>) {
    let admin = Address::generate(env);
    let contract_id = env.register(HtlcContract, (admin.clone(), min_safety_deposit));
    let client = HtlcContractClient::new(env, &contract_id);
    env.mock_all_auths();

    // Erase the schema version key to simulate a pre-versioning deployment.
    env.as_contract(&contract_id, || {
        env.storage().instance().remove(&DataKey::SchemaVersion);
    });

    (admin, client)
}

// ─────────────────────────────────────────────────────────────────────────────
// Legacy state planting
// ─────────────────────────────────────────────────────────────────────────────

/// Write an `OrderV0` (pre-versioning layout, no `created_at`/`finalised_at`)
/// directly into persistent storage at `DataKey::Order(order_id)`. This
/// simulates what a V0 deployment would store on-chain.
///
/// `ttl_ledgers` is the TTL to assign to the entry; pass
/// `ORDER_TTL_MARGIN_LEDGERS + timelock_ledgers` for a live order or
/// `FINALISED_ORDER_TTL_LEDGERS` for a terminal one.
pub fn plant_v0_order(
    env: &Env,
    contract_id: &Address,
    order: OrderV0,
    ttl_ledgers: u32,
) {
    let key = DataKey::Order(order.id);
    env.as_contract(contract_id, || {
        env.storage().persistent().set(&key, &order);
        env.storage().persistent().extend_ttl(&key, ttl_ledgers, ttl_ledgers);
    });
}

/// Build a minimal `OrderV0` with sensible defaults. Callers override only
/// the fields they care about.
pub struct OrderV0Builder {
    pub id: u64,
    pub sender: Option<Address>,
    pub beneficiary: Option<Address>,
    pub refund_address: Option<Address>,
    pub asset: Option<Address>,
    pub amount: i128,
    pub safety_deposit: i128,
    pub hashlock: Option<BytesN<32>>,
    pub timelock: u64,
    pub status: OrderStatus,
    pub preimage: Option<Bytes>,
}

impl OrderV0Builder {
    pub fn new(id: u64) -> Self {
        Self {
            id,
            sender: None,
            beneficiary: None,
            refund_address: None,
            asset: None,
            amount: 10_0000000,
            safety_deposit: 0,
            hashlock: None,
            timelock: 0,
            status: OrderStatus::Funded,
            preimage: None,
        }
    }

    pub fn build(self, env: &Env) -> OrderV0 {
        let sender = self.sender.unwrap_or_else(|| Address::generate(env));
        let beneficiary = self.beneficiary.unwrap_or_else(|| Address::generate(env));
        let refund_address = self.refund_address.unwrap_or_else(|| sender.clone());
        let asset = self.asset.unwrap_or_else(|| Address::generate(env));
        let preimage_bytes = self
            .preimage
            .unwrap_or_else(|| Bytes::from_array(env, &[0u8; 32]));
        let hashlock = self.hashlock.unwrap_or_else(|| {
            BytesN::<32>::from(env.crypto().sha256(&preimage_bytes))
        });

        OrderV0 {
            id: self.id,
            sender,
            beneficiary,
            refund_address,
            asset,
            amount: self.amount,
            safety_deposit: self.safety_deposit,
            hashlock,
            timelock: self.timelock,
            status: self.status,
            preimage: preimage_bytes,
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Schema version helpers
// ─────────────────────────────────────────────────────────────────────────────

/// Read the raw `SchemaVersion` out of a contract's instance storage, bypassing
/// the normal entry-point path. Returns `None` when the key is absent (which
/// represents a V0 deployment).
pub fn read_raw_schema_version(env: &Env, contract_id: &Address) -> Option<SchemaVersion> {
    env.as_contract(contract_id, || {
        env.storage().instance().get(&DataKey::SchemaVersion)
    })
}

/// Force-write a specific schema version directly into a contract's instance
/// storage. Used to set up "mid-migration" or "future version" scenarios.
pub fn write_raw_schema_version(env: &Env, contract_id: &Address, version: SchemaVersion) {
    env.as_contract(contract_id, || {
        env.storage().instance().set(&DataKey::SchemaVersion, &version);
    });
}

/// Remove the `SchemaVersion` key from instance storage, simulating a V0
/// pre-versioning deployment.
pub fn erase_schema_version(env: &Env, contract_id: &Address) {
    env.as_contract(contract_id, || {
        env.storage().instance().remove(&DataKey::SchemaVersion);
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Migration lock helpers
// ─────────────────────────────────────────────────────────────────────────────

/// Set the `MigrationLock` directly — simulates a crashed mid-batch migration.
pub fn plant_migration_lock(env: &Env, contract_id: &Address) {
    env.as_contract(contract_id, || {
        env.storage().instance().set(&DataKey::MigrationLock, &true);
    });
}

/// Clear the `MigrationLock` directly — simulates manual recovery after a
/// crashed migration.
pub fn clear_migration_lock(env: &Env, contract_id: &Address) {
    env.as_contract(contract_id, || {
        env.storage().instance().remove(&DataKey::MigrationLock);
    });
}

/// Return whether the `MigrationLock` is currently set.
pub fn has_migration_lock(env: &Env, contract_id: &Address) -> bool {
    env.as_contract(contract_id, || {
        env.storage()
            .instance()
            .get::<DataKey, bool>(&DataKey::MigrationLock)
            .unwrap_or(false)
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// Post-migration invariant checks
// ─────────────────────────────────────────────────────────────────────────────

/// Assert that the schema version stored in the contract equals
/// `CURRENT_SCHEMA_VERSION` (i.e. the migration completed successfully).
pub fn assert_current_schema(env: &Env, contract_id: &Address) {
    let version = read_raw_schema_version(env, contract_id);
    assert_eq!(
        version,
        Some(CURRENT_SCHEMA_VERSION),
        "expected schema version {:?} but found {:?}",
        CURRENT_SCHEMA_VERSION,
        version,
    );
}

/// Assert that the `MigrationLock` is NOT set (migration fully committed).
pub fn assert_no_migration_lock(env: &Env, contract_id: &Address) {
    assert!(
        !has_migration_lock(env, contract_id),
        "MigrationLock should be absent after finalised migration"
    );
}

/// Assert that a specific order `id` is readable as the current `Order` layout
/// and that its key fields match the original `OrderV0` values. Fields added
/// in V1 (`created_at`, `finalised_at`) are allowed to be 0 (sentinel for
/// pre-migration provenance).
pub fn assert_order_migrated(env: &Env, contract_id: &Address, id: u64, original: &OrderV0) {
    let order: Option<Order> = env.as_contract(contract_id, || {
        env.storage().persistent().get(&DataKey::Order(id))
    });
    let order = order.unwrap_or_else(|| panic!("order {} not found after migration", id));

    assert_eq!(order.id, original.id, "id mismatch for order {id}");
    assert_eq!(order.sender, original.sender, "sender mismatch for order {id}");
    assert_eq!(order.beneficiary, original.beneficiary, "beneficiary mismatch for order {id}");
    assert_eq!(order.refund_address, original.refund_address, "refund_address mismatch for order {id}");
    assert_eq!(order.asset, original.asset, "asset mismatch for order {id}");
    assert_eq!(order.amount, original.amount, "amount mismatch for order {id}");
    assert_eq!(order.safety_deposit, original.safety_deposit, "safety_deposit mismatch for order {id}");
    assert_eq!(order.hashlock, original.hashlock, "hashlock mismatch for order {id}");
    assert_eq!(order.timelock, original.timelock, "timelock mismatch for order {id}");
    assert_eq!(order.status, original.status, "status mismatch for order {id}");
    // V1 sentinel: created_at and finalised_at should be 0 for migrated V0 orders.
    assert_eq!(order.created_at, 0, "created_at should be 0 for migrated V0 order {id}");
    assert_eq!(order.finalised_at, 0, "finalised_at should be 0 for migrated V0 order {id}");
}

/// Assert that every order in `order_ids` has a live storage entry with a TTL
/// of at least `min_ttl` ledgers.
pub fn assert_order_ttls(env: &Env, contract_id: &Address, order_ids: &[u64], min_ttl: u32) {
    env.as_contract(contract_id, || {
        for &id in order_ids {
            let ttl = env.storage().persistent().get_ttl(&DataKey::Order(id));
            assert!(
                ttl >= min_ttl,
                "order {id} TTL {ttl} is below minimum {min_ttl} after migration"
            );
        }
    });
}

/// Assert that required instance-storage config keys are all present.
pub fn assert_config_keys_present(env: &Env, contract_id: &Address) {
    env.as_contract(contract_id, || {
        assert!(
            env.storage().instance().has(&DataKey::Admin),
            "Admin key missing"
        );
        assert!(
            env.storage().instance().has(&DataKey::NextOrderId),
            "NextOrderId key missing"
        );
        assert!(
            env.storage().instance().has(&DataKey::MinSafetyDeposit),
            "MinSafetyDeposit key missing"
        );
        assert!(
            env.storage().instance().has(&DataKey::SchemaVersion),
            "SchemaVersion key missing"
        );
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Ledger helpers
// ─────────────────────────────────────────────────────────────────────────────

/// Advance the ledger wall-clock timestamp by `seconds`.
pub fn advance_ledger(env: &Env, seconds: u64) {
    let current = env.ledger().get();
    env.ledger().set(LedgerInfo {
        timestamp: current.timestamp + seconds,
        protocol_version: current.protocol_version,
        sequence_number: current.sequence_number + 1,
        network_id: current.network_id,
        base_reserve: current.base_reserve,
        min_temp_entry_ttl: current.min_temp_entry_ttl,
        min_persistent_entry_ttl: current.min_persistent_entry_ttl,
        max_entry_ttl: current.max_entry_ttl,
    });
}

/// Advance the ledger sequence number (erodes entry TTLs) without advancing
/// wall-clock time.
pub fn advance_sequence(env: &Env, ledgers: u32) {
    env.ledger().with_mut(|li| {
        li.sequence_number += ledgers;
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// SHA256 helper
// ─────────────────────────────────────────────────────────────────────────────

/// Compute sha256(bytes) and return as `BytesN<32>`.
pub fn sha256_32(env: &Env, bytes: &Bytes) -> BytesN<32> {
    BytesN::<32>::from(env.crypto().sha256(bytes))
}

// ─────────────────────────────────────────────────────────────────────────────
// Token keep-alive (prevents test failures from unrelated SAC archival)
// ─────────────────────────────────────────────────────────────────────────────

/// Re-extend the SAC token's instance and balance entries so they don't
/// expire during large sequence-number advances in TTL tests.
pub fn keep_token_alive(env: &Env, asset: &Address, holders: &[&Address]) {
    const LONG: u32 = 5_000_000;
    env.as_contract(asset, || {
        env.storage().instance().extend_ttl(LONG, LONG);
        for holder in holders {
            let key = (soroban_sdk::Symbol::new(env, "Balance"), (*holder).clone());
            env.storage().persistent().extend_ttl(&key, LONG, LONG);
        }
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Full "legacy deployment" scenario builder
// ─────────────────────────────────────────────────────────────────────────────

/// A complete legacy-deployment scenario: a contract with N pre-planted V0
/// orders, no `SchemaVersion` key, and funds transferred to the contract
/// address (simulating what a live V0 deployment with locked funds would look
/// like on-chain).
///
/// Returns `(client, asset_address, planted_orders)` where `planted_orders`
/// is the list of `OrderV0` values written to storage (in id order).
pub struct LegacyScenario<'a> {
    pub admin: Address,
    pub client: HtlcContractClient<'a>,
    pub asset: Address,
    pub sac: StellarAssetClient<'a>,
    pub token: TokenClient<'a>,
    /// The V0 orders planted directly into storage.
    pub orders: soroban_sdk::Vec<OrderV0>,
    /// The total amount locked in the contract (sum of amount + safety_deposit
    /// across all planted funded orders).
    pub total_locked: i128,
}

impl<'a> LegacyScenario<'a> {
    /// Build a scenario with `n_funded` funded orders and `n_terminal`
    /// already-finalised orders (alternating Claimed/Refunded).
    pub fn build(env: &'a Env, n_funded: u32, n_terminal: u32) -> Self {
        let asset_admin = Address::generate(env);
        let (asset, sac, token) = deploy_token(env, &asset_admin);

        // Deploy via constructor (which stamps V1), then erase the schema
        // version key to simulate a pre-versioning deployment.
        let admin = Address::generate(env);
        let contract_id = env.register(HtlcContract, (admin.clone(), 0i128));
        let client = HtlcContractClient::new(env, &contract_id);
        env.mock_all_auths();

        erase_schema_version(env, &contract_id);

        // Mint enough tokens to the contract to represent locked funds.
        let amount_per_order: i128 = 10_0000000;
        let safety_per_order: i128 = 1_000_000;
        let total_per_funded = amount_per_order + safety_per_order;
        let total_funded_locked = total_per_funded * n_funded as i128;
        sac.mint(&contract_id, &total_funded_locked);

        let now = env.ledger().timestamp();
        let timelock_secs: u64 = 600;
        let timelock = now + timelock_secs;

        let mut orders = soroban_sdk::Vec::new(env);
        let total = n_funded + n_terminal;

        for i in 1..=total {
            let sender = Address::generate(env);
            let beneficiary = Address::generate(env);
            // Use i as a seed byte; wrapping cast handles scenario counts > 255.
            let preimage_bytes = Bytes::from_array(env, &[(i as u8).wrapping_add(1); 32]);
            let hashlock = sha256_32(env, &preimage_bytes);

            let status = if i <= n_funded {
                OrderStatus::Funded
            } else if i % 2 == 0 {
                OrderStatus::Claimed
            } else {
                OrderStatus::Refunded
            };

            let safety = if status == OrderStatus::Funded {
                safety_per_order
            } else {
                0
            };

            let v0 = OrderV0 {
                id: i as u64,
                sender,
                beneficiary,
                refund_address: Address::generate(env),
                asset: asset.clone(),
                amount: amount_per_order,
                safety_deposit: safety,
                hashlock,
                timelock,
                status,
                preimage: preimage_bytes,
            };

            let ttl = if status == OrderStatus::Funded {
                let tl_ledgers = timelock_secs.div_ceil(ASSUMED_MIN_LEDGER_TIME_SECS) as u32;
                tl_ledgers + ORDER_TTL_MARGIN_LEDGERS
            } else {
                FINALISED_ORDER_TTL_LEDGERS
            };

            plant_v0_order(env, &contract_id, v0.clone(), ttl);
            orders.push_back(v0);
        }

        // Advance NextOrderId so it reflects the planted orders.
        env.as_contract(&contract_id, || {
            env.storage()
                .instance()
                .set(&DataKey::NextOrderId, &((total + 1) as u64));
        });

        Self {
            admin,
            client,
            asset,
            sac,
            token,
            orders,
            total_locked: total_funded_locked,
        }
    }
}
