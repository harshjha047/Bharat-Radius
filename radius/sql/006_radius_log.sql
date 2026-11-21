-- Migration 006: ISP-wide auth log and live Radius log (newest first per ISP), near-match usernames for "Why?".
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX radpostauth_tenant_date_idx ON radpostauth (tenant_id, authdate DESC);
CREATE INDEX radacct_tenant_start_idx ON radacct (tenant_id, acctstarttime DESC);
CREATE INDEX subscribers_username_trgm_idx ON subscribers USING gin (lower(username) gin_trgm_ops);
