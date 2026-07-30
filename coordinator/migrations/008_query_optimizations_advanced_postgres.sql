-- Migration: 008_query_optimizations_advanced (PostgreSQL)
-- Purpose: Systematic query optimization for coordinator hotspots
--
-- This is the PostgreSQL version of 008_query_optimizations_advanced.sql.
-- Differences from SQLite:
--   - Uses NULLS LAST for DESC indexes (PostgreSQL default is NULLS FIRST)
--   - CREATE INDEX syntax is slightly different (no IF NOT EXISTS worries)
--   - Partial index syntax is identical
--   - EXPLAIN vs EXPLAIN QUERY PLAN (PostgreSQL uses EXPLAIN ANALYZE)

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Stale announced orders cleanup index
-- ─────────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_orders_stale_announced
  ON orders (status, archived_at, src_order_id, created_at)
  WHERE status = 'announced' AND archived_at IS NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Expiry scan indexes (separate for src and dst timelocks)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_orders_src_timelock_expiry
  ON orders (src_timelock, status)
  WHERE status IN ('src_locked', 'dst_locked') AND src_timelock IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_orders_dst_timelock_expiry
  ON orders (dst_timelock, status)
  WHERE status IN ('src_locked', 'dst_locked') AND dst_timelock IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Secret recovery index (covering partial index)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_orders_missing_secret
  ON orders (status, preimage)
  WHERE status IN ('src_locked', 'dst_locked') AND preimage IS NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Last processed block indexes (DESC for MAX() optimization)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_orders_src_chain_block
  ON orders (src_chain, src_lock_block DESC NULLS LAST)
  WHERE src_lock_block IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_orders_dst_chain_block
  ON orders (dst_chain, dst_lock_block DESC NULLS LAST)
  WHERE dst_lock_block IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Archival index (soft-deleted orders)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_orders_archived
  ON orders (archived_at, created_at DESC NULLS LAST)
  WHERE archived_at IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Resolver activity index (resolver dashboard queries)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_orders_resolver_activity
  ON orders (resolver_address, created_at DESC NULLS LAST)
  WHERE resolver_address IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- Summary
-- ─────────────────────────────────────────────────────────────────────────────
-- New indexes: 8 (all partial, targeting specific query hot paths)
-- PostgreSQL notes:
--   - NULLS LAST ensures consistent ordering with SQLite behavior.
--   - Partial indexes (WHERE clause) are fully supported.
--   - Use EXPLAIN ANALYZE to verify index usage after deployment.
--   - Monitor pg_stat_user_indexes for actual index usage stats.
