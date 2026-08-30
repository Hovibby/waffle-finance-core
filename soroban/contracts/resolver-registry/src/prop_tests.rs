#![cfg(test)]

use super::*;
use proptest::prelude::*;
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{Address, Env};
use soroban_sdk::token::{StellarAssetClient, TokenClient};
use std::vec::Vec;

// Sequence of registry actions
#[derive(Clone, Debug)]
enum Action {
    Register { stake: i128 },
    Increase { idx: usize, additional: i128 },
    RequestUnregister { idx: usize },
    Withdraw { idx: usize },
    Slash { idx: usize, amount: i128 },
}

fn actions_strategy() -> impl Strategy<Value = Vec<Action>> {
    let register = (1i128..10_000_000i128).prop_map(|s| Action::Register { stake: s });
    let increase = (0usize..6usize, 1i128..5_000_000i128).prop_map(|(i,a)| Action::Increase{ idx: i, additional: a });
    let request = (0usize..6usize).prop_map(|i| Action::RequestUnregister { idx: i });
    let withdraw = (0usize..6usize).prop_map(|i| Action::Withdraw { idx: i });
    let slash = (0usize..6usize, 1i128..5_000_000i128).prop_map(|(i,a)| Action::Slash{ idx: i, amount: a });

    prop::collection::vec(prop_oneof![register, increase, request, withdraw, slash], 1..20)
}

proptest!{
    /// Every address that is still in the resolver list must have a
    /// corresponding persistent storage entry, and every address that
    /// successfully completed `withdraw_stake` must no longer appear in the
    /// list. Validates that list membership is always consistent with the
    /// on-chain registry state regardless of action ordering.
    #[test]
    fn list_membership_consistent_with_stored_entries(seq in actions_strategy()) {
        let env = Env::default();
        env.mock_all_auths();

        let asset_admin = Address::generate(&env);
        let (asset, sac, _token_client) = {
            let contract = env.register_stellar_asset_contract_v2(asset_admin.clone());
            let addr = contract.address();
            (
                addr.clone(),
                StellarAssetClient::new(&env, &addr),
                TokenClient::new(&env, &addr),
            )
        };

        let admin = Address::generate(&env);
        let slash_beneficiary = Address::generate(&env);
        let contract_id = env.register(
            ResolverRegistry,
            (admin.clone(), asset.clone(), 100i128, slash_beneficiary.clone(), DEFAULT_UNBONDING_PERIOD_SECS),
        );
        let client = ResolverRegistryClient::new(&env, &contract_id);

        let mut resolvers: std::vec::Vec<Address> = std::vec::Vec::new();
        for _ in 0..6 {
            let a = Address::generate(&env);
            sac.mint(&a, &10_000_0000000);
            resolvers.push(a);
        }

        // Track which resolvers have successfully withdrawn (entry removed).
        let mut withdrawn: std::vec::Vec<Address> = std::vec::Vec::new();

        for act in seq {
            match act {
                Action::Register { stake } => {
                    let idx = (env.ledger().sequence() as usize) % resolvers.len();
                    let who = resolvers[idx].clone();
                    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        client.register(&who, &stake)
                    }));
                }
                Action::Increase { idx, additional } => {
                    if let Some(who) = resolvers.get(idx) {
                        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                            client.increase_stake(who, &additional)
                        }));
                    }
                }
                Action::RequestUnregister { idx } => {
                    if let Some(who) = resolvers.get(idx) {
                        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                            client.request_unregister(who)
                        }));
                    }
                }
                Action::Withdraw { idx } => {
                    if let Some(who) = resolvers.get(idx) {
                        let ok = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                            client.withdraw_stake(who)
                        })).is_ok();
                        if ok {
                            withdrawn.push(who.clone());
                        }
                    }
                }
                Action::Slash { idx, amount } => {
                    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        client.slash(&resolvers[idx % resolvers.len()], &amount)
                    }));
                }
            }
        }

        // Invariant 1: every address in the list has a storage entry.
        let list = client.list();
        for addr in list.iter() {
            prop_assert!(
                client.get(&addr).is_some(),
                "list member has no storage entry: {:?}", addr
            );
        }

        // Invariant 2: no address that completed withdraw_stake appears in the list.
        for addr in &withdrawn {
            prop_assert!(
                !list.contains(addr),
                "withdrawn resolver still appears in the list: {:?}", addr
            );
        }
    }

    /// For every resolver that has a storage entry, `is_active()` must
    /// agree with both the `active` boolean field and the `lifecycle` enum.
    /// No combination of operations should leave these three signals out of
    /// sync with one another.
    #[test]
    fn is_active_iff_lifecycle_active(seq in actions_strategy()) {
        let env = Env::default();
        env.mock_all_auths();

        let asset_admin = Address::generate(&env);
        let (asset, sac, _token_client) = {
            let contract = env.register_stellar_asset_contract_v2(asset_admin.clone());
            let addr = contract.address();
            (
                addr.clone(),
                StellarAssetClient::new(&env, &addr),
                TokenClient::new(&env, &addr),
            )
        };

        let admin = Address::generate(&env);
        let slash_beneficiary = Address::generate(&env);
        let contract_id = env.register(
            ResolverRegistry,
            (admin.clone(), asset.clone(), 100i128, slash_beneficiary.clone(), DEFAULT_UNBONDING_PERIOD_SECS),
        );
        let client = ResolverRegistryClient::new(&env, &contract_id);

        let mut resolvers: std::vec::Vec<Address> = std::vec::Vec::new();
        for _ in 0..6 {
            let a = Address::generate(&env);
            sac.mint(&a, &10_000_0000000);
            resolvers.push(a);
        }

        for act in seq {
            match act {
                Action::Register { stake } => {
                    let idx = (env.ledger().sequence() as usize) % resolvers.len();
                    let who = resolvers[idx].clone();
                    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        client.register(&who, &stake)
                    }));
                }
                Action::Increase { idx, additional } => {
                    if let Some(who) = resolvers.get(idx) {
                        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                            client.increase_stake(who, &additional)
                        }));
                    }
                }
                Action::RequestUnregister { idx } => {
                    if let Some(who) = resolvers.get(idx) {
                        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                            client.request_unregister(who)
                        }));
                    }
                }
                Action::Withdraw { idx } => {
                    if let Some(who) = resolvers.get(idx) {
                        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                            client.withdraw_stake(who)
                        }));
                    }
                }
                Action::Slash { idx, amount } => {
                    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        client.slash(&resolvers[idx % resolvers.len()], &amount)
                    }));
                }
            }
        }

        // After all actions: for every resolver with a storage entry, the three
        // representations of activity must all agree.
        for addr in &resolvers {
            if let Some(info) = client.get(addr) {
                let lifecycle_says_active = info.lifecycle == ResolverLifecycle::Active;
                prop_assert_eq!(
                    info.active, lifecycle_says_active,
                    "active field ({}) disagrees with lifecycle ({:?}) for {:?}",
                    info.active, info.lifecycle, addr
                );
                prop_assert_eq!(
                    client.is_active(addr), lifecycle_says_active,
                    "is_active() ({}) disagrees with lifecycle ({:?}) for {:?}",
                    client.is_active(addr), info.lifecycle, addr
                );
            } else {
                // No entry → is_active must return false.
                prop_assert!(
                    !client.is_active(addr),
                    "is_active() returned true for an address with no storage entry"
                );
            }
        }
    }

    #[test]
    fn stake_conservation(seq in actions_strategy()) {
        let env = Env::default();
        env.mock_all_auths();

        let asset_admin = Address::generate(&env);
        let (asset, sac, token_client) = {
            let contract = env.register_stellar_asset_contract_v2(asset_admin.clone());
            let addr = contract.address();
            (
                addr.clone(),
                StellarAssetClient::new(&env, &addr),
                TokenClient::new(&env, &addr),
            )
        };

        let admin = Address::generate(&env);
        let slash_beneficiary = Address::generate(&env);
        let contract_id = env.register(ResolverRegistry, (admin.clone(), asset.clone(), 100i128, slash_beneficiary.clone(), DEFAULT_UNBONDING_PERIOD_SECS));
        let client = ResolverRegistryClient::new(&env, &contract_id);

        // prepare resolver accounts
        let mut resolvers: Vec<Address> = Vec::new();
        for _ in 0..6 { let a = Address::generate(&env); sac.mint(&a, &10_000_0000000); resolvers.push(a); }

        let initial_total: i128 = resolvers.iter().map(|a| token_client.balance(a)).sum::<i128>() + token_client.balance(&client.address) + token_client.balance(&slash_beneficiary);

        for act in seq {
            match act {
                Action::Register { stake } => {
                    let idx = (env.ledger().sequence() as usize) % resolvers.len();
                    let who = resolvers[idx].clone();
                    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| client.register(&who, &stake)));
                }
                Action::Increase { idx, additional } => {
                    if let Some(who) = resolvers.get(idx) { let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| client.increase_stake(who, &additional))); }
                }
                Action::RequestUnregister { idx } => { if let Some(who) = resolvers.get(idx) { let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| client.request_unregister(who))); } }
                Action::Withdraw { idx } => { if let Some(who) = resolvers.get(idx) { let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| client.withdraw_stake(who))); } }
                Action::Slash { idx, amount } => { let admin_caller = admin.clone(); let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| client.slash(&resolvers[idx % resolvers.len()], &amount))); }
            }
        }

        let final_total: i128 = resolvers.iter().map(|a| token_client.balance(a)).sum::<i128>() + token_client.balance(&client.address) + token_client.balance(&slash_beneficiary);
        prop_assert_eq!(initial_total, final_total);
    }
}
