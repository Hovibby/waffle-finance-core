// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IResolverRegistry} from "../interfaces/IResolverRegistry.sol";

/// @title MockRegistry
/// @notice Minimal IResolverRegistry stub for tests. Always returns
///         `isActive = true` so `createOrder` is permissionless in test
///         setups that use a real (non-zero) registry address.
contract MockRegistry is IResolverRegistry {
    function isActive(address) external pure override returns (bool) {
        return true;
    }
}
