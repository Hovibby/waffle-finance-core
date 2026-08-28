-- Migration: 011_order_ledger_cursors
-- Adds per-order high-water mark columns to track the highest processed
-- Ethereum block, Soroban ledger, and Solana slot for each order.
--
-- last_eth_block: highest Ethereum block number processed for this order
-- last_soroban_ledger: highest Soroban ledger sequence processed for this order
-- last_solana_slot: highest Solana slot processed for this order

ALTER TABLE orders ADD COLUMN last_eth_block INTEGER;
ALTER TABLE orders ADD COLUMN last_soroban_ledger INTEGER;
ALTER TABLE orders ADD COLUMN last_solana_slot INTEGER;
