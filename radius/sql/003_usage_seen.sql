-- Migration 003: what the usage roll-up has already counted per session, so overlapping runs never double count.
CREATE TABLE usage_seen (
  radacctid  bigint PRIMARY KEY,
  in_bytes   bigint NOT NULL,
  out_bytes  bigint NOT NULL,
  secs       bigint NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX usage_seen_updated_idx ON usage_seen (updated_at);
