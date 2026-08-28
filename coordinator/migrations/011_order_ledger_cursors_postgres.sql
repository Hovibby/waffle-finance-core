-- Migration: 011_order_ledger_cursors (Postgres)
-- Adds per-order high-water mark columns to track the highest processed
-- Ethereum block, Soroban ledger, and Solana slot for each order.
--
-- BIGINT is used for all chain positions in Postgres.

ALTER TABLE orders ADD COLUMN IF NOT EXISTS last_eth_block BIGINT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS last_soroban_ledger BIGINT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS last_solana_slot BIGINT;
