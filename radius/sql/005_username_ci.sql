-- Migration 005: usernames unique and matched ignoring case (radius_check / radius_reply / accounting use lower()).
CREATE UNIQUE INDEX subscribers_tenant_username_ci_key ON subscribers (tenant_id, lower(username));
