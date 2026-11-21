-- Migration 009 (WP 5.9): connection type per subscriber. pppoe = username/password over PPP; hotspot = MikroTik
-- Hotspot login page; static = IPoE / static IP, authorised by MAC (MikroTik DHCP server with use-radius).
ALTER TABLE subscribers
  ADD COLUMN conn_type text NOT NULL DEFAULT 'pppoe' CHECK (conn_type IN ('pppoe', 'hotspot', 'static'));
ALTER TABLE subscribers
  ADD CONSTRAINT subscribers_static_mac_chk CHECK (conn_type <> 'static' OR mac_lock IS NOT NULL);
CREATE UNIQUE INDEX subscribers_static_mac_key ON subscribers (tenant_id, mac_lock) WHERE conn_type = 'static';
