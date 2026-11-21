-- Migration 008: per-ISP traffic by day (dashboard "Today total usage" and its 14-day chart) reads usage_daily
-- by tenant and day; the primary key leads with username, so add (tenant_id, day).
CREATE INDEX IF NOT EXISTS usage_daily_tenant_day_idx ON usage_daily (tenant_id, day);
