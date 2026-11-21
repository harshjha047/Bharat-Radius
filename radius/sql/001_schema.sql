-- Migration 001: Radius hot-path schema (BACKEND_SCHEMA.md §3). Applied once, tracked in schema_migrations.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE tenants (
  id                   serial PRIMARY KEY,
  external_id          char(24) UNIQUE,
  slug                 text NOT NULL UNIQUE,
  name                 text NOT NULL,
  status               text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  expired_rate         text NOT NULL DEFAULT '256k/256k',
  expired_address_list text NOT NULL DEFAULT 'expired',
  expired_session_secs integer NOT NULL DEFAULT 3600 CHECK (expired_session_secs >= 60),
  interim_interval     integer NOT NULL DEFAULT 300 CHECK (interim_interval BETWEEN 60 AND 3600),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE nas (
  id          serial PRIMARY KEY,
  external_id char(24) UNIQUE,
  tenant_id   integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  nasname     inet NOT NULL UNIQUE,
  shortname   text NOT NULL,
  type        text NOT NULL DEFAULT 'other',
  secret      text NOT NULL CHECK (length(secret) >= 12),
  coa_port    integer NOT NULL DEFAULT 3799,
  description text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX nas_tenant_idx ON nas (tenant_id);

CREATE TABLE plans (
  id          serial PRIMARY KEY,
  external_id char(24) UNIQUE,
  tenant_id   integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        text NOT NULL,
  rate_limit  text NOT NULL,
  fup_rate    text,
  ip_pool     text,
  sim_use     integer NOT NULL DEFAULT 1 CHECK (sim_use >= 1),
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

CREATE TABLE plan_attributes (
  id        serial PRIMARY KEY,
  plan_id   integer NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  attribute text NOT NULL,
  op        text NOT NULL DEFAULT ':=' CHECK (op IN (':=', '=', '+=')),
  value     text NOT NULL
);
CREATE INDEX plan_attributes_plan_idx ON plan_attributes (plan_id);

-- password_enc: pgp_sym_encrypt(cleartext, key). Key never stored in the database (TRD §5.5).
CREATE TABLE subscribers (
  id           bigserial PRIMARY KEY,
  external_id  char(24) UNIQUE,
  tenant_id    integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  username     text NOT NULL,
  password_enc bytea NOT NULL,
  plan_id      integer REFERENCES plans(id) ON DELETE SET NULL,
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'disabled')),
  expires_at   timestamptz,
  static_ip    inet,
  mac_lock     text CHECK (mac_lock ~ '^([0-9A-F]{2}:){5}[0-9A-F]{2}$'),
  sim_use      integer CHECK (sim_use >= 1),
  fup_active   boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, username)
);
CREATE INDEX subscribers_tenant_expires_idx ON subscribers (tenant_id, expires_at);
CREATE INDEX subscribers_plan_idx ON subscribers (plan_id);

CREATE TABLE radacct (
  radacctid           bigserial,
  tenant_id           integer NOT NULL,
  acctsessionid       text NOT NULL,
  acctuniqueid        text NOT NULL,
  username            text NOT NULL,
  nasipaddress        inet NOT NULL,
  nasportid           text,
  nasporttype         text,
  acctstarttime       timestamptz NOT NULL,
  acctupdatetime      timestamptz NOT NULL,
  acctstoptime        timestamptz,
  acctinterval        bigint,
  acctsessiontime     bigint NOT NULL DEFAULT 0,
  acctauthentic       text,
  connectinfo_start   text,
  connectinfo_stop    text,
  acctinputoctets     bigint NOT NULL DEFAULT 0,
  acctoutputoctets    bigint NOT NULL DEFAULT 0,
  calledstationid     text,
  callingstationid    text,
  acctterminatecause  text,
  servicetype         text,
  framedprotocol      text,
  framedipaddress     inet,
  framedipv6address   inet,
  framedipv6prefix    inet,
  framedinterfaceid   text,
  delegatedipv6prefix inet,
  PRIMARY KEY (radacctid, acctstarttime),
  UNIQUE (acctuniqueid, acctstarttime)
) PARTITION BY RANGE (acctstarttime);
CREATE INDEX radacct_uniqueid_idx ON radacct (acctuniqueid);
CREATE INDEX radacct_open_user_idx ON radacct (tenant_id, username) WHERE acctstoptime IS NULL;
CREATE INDEX radacct_open_nas_idx ON radacct (nasipaddress) WHERE acctstoptime IS NULL;
CREATE INDEX radacct_open_update_idx ON radacct (acctupdatetime) WHERE acctstoptime IS NULL;
CREATE INDEX radacct_stop_idx ON radacct (acctstoptime) WHERE acctstoptime IS NOT NULL;
CREATE INDEX radacct_framedip_idx ON radacct (framedipaddress, acctstarttime);
CREATE INDEX radacct_user_start_idx ON radacct (tenant_id, username, acctstarttime DESC);
CREATE TABLE radacct_default PARTITION OF radacct DEFAULT;

CREATE TABLE radpostauth (
  id               bigserial,
  tenant_id        integer,
  username         text NOT NULL,
  reply            text NOT NULL,
  reason           text,
  nasipaddress     inet NOT NULL,
  callingstationid text,
  authdate         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, authdate)
) PARTITION BY RANGE (authdate);
CREATE INDEX radpostauth_user_idx ON radpostauth (tenant_id, username, authdate DESC);
CREATE TABLE radpostauth_default PARTITION OF radpostauth DEFAULT;

CREATE TABLE usage_daily (
  tenant_id    integer NOT NULL,
  username     text NOT NULL,
  day          date NOT NULL,
  bytes_in     bigint NOT NULL DEFAULT 0,
  bytes_out    bigint NOT NULL DEFAULT 0,
  session_secs bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, username, day)
);
