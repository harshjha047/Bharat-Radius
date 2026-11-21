-- Migration 007 (F-17): packets RADIUS could not use, per minute: from addresses that are not a router of any ISP
-- (FreeRADIUS "unknown client", or dropped by the firewall allow-list) and from routers with the wrong shared secret.
-- Filled by radius/scripts/log-events.sh (FreeRADIUS log + kernel firewall log); counts are lower bounds because
-- both sources rate-limit their messages. Kept 30 days.
CREATE TABLE radius_events (
  kind     text        NOT NULL CHECK (kind IN ('unknown_client', 'firewall_block', 'bad_secret')),
  src_ip   inet        NOT NULL,
  dst_port integer     NOT NULL DEFAULT 0,
  minute   timestamptz NOT NULL,
  packets  integer     NOT NULL DEFAULT 1,
  PRIMARY KEY (kind, src_ip, dst_port, minute)
);
CREATE INDEX radius_events_minute_idx ON radius_events (minute DESC);
CREATE INDEX radius_events_ip_idx ON radius_events (src_ip, minute DESC);
