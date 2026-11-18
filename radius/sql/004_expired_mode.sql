-- Migration 004: per-ISP handling of expired customers. reject = Access-Reject; walled = slow speed + address list.
ALTER TABLE tenants
  ADD COLUMN expired_mode text NOT NULL DEFAULT 'reject' CHECK (expired_mode IN ('reject', 'walled'));
