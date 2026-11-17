-- Re-applied on every install (CREATE OR REPLACE). Login logic lives here (TRD §5.2–5.4).

CREATE OR REPLACE FUNCTION radius_encrypt_password(p_plain text, p_key text)
RETURNS bytea LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT pgp_sym_encrypt(p_plain, p_key, 'cipher-algo=aes256, compress-algo=0, s2k-mode=1');
$$;

-- PPPoE password key: a per-role setting (ALTER ROLE <fr_role> SET app.pw_key, install.sh), never query text,
-- so it cannot appear in `freeradius -X`, pg_stat_statements or a database dump.
CREATE OR REPLACE FUNCTION radius_pw_key()
RETURNS text LANGUAGE plpgsql STABLE AS $$
DECLARE
  k text := nullif(current_setting('app.pw_key', true), '');
BEGIN
  IF k IS NULL THEN
    RAISE EXCEPTION 'app.pw_key is not set for role %', current_user;
  END IF;
  RETURN k;
END $$;

SET client_min_messages = warning;
DROP FUNCTION IF EXISTS radius_check(inet, text, text, text); -- old form: key as an argument
RESET client_min_messages;
CREATE OR REPLACE FUNCTION radius_check(p_nas inet, p_user text, p_mac text)
RETURNS TABLE (id bigint, username text, attribute text, value text, op text)
LANGUAGE plpgsql STABLE AS $$
#variable_conflict use_column
DECLARE
  s record;
  v_reason text;
  v_mac text := upper(replace(nullif(btrim(p_mac), ''), '-', ':'));
BEGIN
  SELECT sub.id AS sid, sub.username AS uname, sub.status AS sstatus, sub.mac_lock, sub.password_enc,
         coalesce(sub.sim_use, pl.sim_use, 1) AS sim, t.id AS tid, t.status AS tstatus, t.interim_interval AS interim
    INTO s
    FROM nas n
    JOIN tenants t ON t.id = n.tenant_id
    JOIN subscribers sub ON sub.tenant_id = n.tenant_id AND sub.username = p_user
    LEFT JOIN plans pl ON pl.id = sub.plan_id
   WHERE n.nasname = p_nas;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  v_reason := CASE
    WHEN s.tstatus <> 'active' THEN 'Service provider suspended'
    WHEN s.sstatus = 'suspended' THEN 'Account suspended'
    WHEN s.sstatus = 'disabled' THEN 'Account disabled'
    WHEN s.mac_lock IS NOT NULL AND s.mac_lock IS DISTINCT FROM v_mac THEN 'MAC address not allowed'
  END;

  -- Simultaneous-use: only sessions heard from within 3 interim periods count, so a crashed router cannot lock users out.
  IF v_reason IS NULL AND (
       SELECT count(*)
         FROM radacct a
        WHERE a.tenant_id = s.tid AND a.username = s.uname AND a.acctstoptime IS NULL
          AND a.acctupdatetime > now() - make_interval(secs => 3 * s.interim)
     ) >= s.sim THEN
    v_reason := 'You are already logged in - access denied';
  END IF;

  id := s.sid; username := s.uname; op := ':=';
  IF v_reason IS NOT NULL THEN
    attribute := 'Auth-Type';    value := 'Reject';  RETURN NEXT;
    attribute := 'Tmp-String-0'; value := v_reason;  RETURN NEXT;
    RETURN;
  END IF;

  attribute := 'Cleartext-Password'; value := pgp_sym_decrypt(s.password_enc, radius_pw_key()); RETURN NEXT;
END $$;

CREATE OR REPLACE FUNCTION radius_reply(p_nas inet, p_user text)
RETURNS TABLE (id bigint, username text, attribute text, value text, op text)
LANGUAGE plpgsql STABLE AS $$
#variable_conflict use_column
DECLARE
  r record;
  v_fup boolean;
BEGIN
  SELECT sub.id AS sid, sub.username AS uname, sub.plan_id, sub.expires_at, sub.static_ip, sub.fup_active,
         pl.rate_limit, pl.fup_rate, pl.ip_pool,
         t.expired_rate, t.expired_address_list, t.expired_session_secs, t.interim_interval
    INTO r
    FROM nas n
    JOIN tenants t ON t.id = n.tenant_id AND t.status = 'active'
    JOIN subscribers sub ON sub.tenant_id = n.tenant_id AND sub.username = p_user AND sub.status = 'active'
    LEFT JOIN plans pl ON pl.id = sub.plan_id
   WHERE n.nasname = p_nas;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  id := r.sid; username := r.uname; op := ':=';

  IF r.static_ip IS NOT NULL THEN
    attribute := 'Framed-IP-Address'; value := host(r.static_ip); RETURN NEXT;
  ELSIF r.ip_pool IS NOT NULL THEN
    attribute := 'Framed-Pool'; value := r.ip_pool; RETURN NEXT;
  END IF;
  attribute := 'Acct-Interim-Interval'; value := r.interim_interval::text; RETURN NEXT;

  IF r.plan_id IS NULL OR (r.expires_at IS NOT NULL AND r.expires_at <= now()) THEN
    attribute := 'Mikrotik-Rate-Limit';  value := r.expired_rate;                   RETURN NEXT;
    attribute := 'Mikrotik-Address-List'; value := r.expired_address_list;          RETURN NEXT;
    attribute := 'Session-Timeout';      value := r.expired_session_secs::text;     RETURN NEXT;
    attribute := 'Reply-Message';        value := 'Plan expired';                   RETURN NEXT;
    RETURN;
  END IF;

  v_fup := r.fup_active AND r.fup_rate IS NOT NULL;
  attribute := 'Mikrotik-Rate-Limit';
  value := CASE WHEN v_fup THEN r.fup_rate ELSE r.rate_limit END;
  RETURN NEXT;
  IF v_fup THEN
    attribute := 'Mikrotik-Address-List'; value := 'fup'; RETURN NEXT;
  END IF;
  IF r.expires_at IS NOT NULL THEN
    attribute := 'Session-Timeout';
    value := greatest(60, least(2592000, ceil(extract(epoch FROM r.expires_at - now()))))::bigint::text;
    RETURN NEXT;
  END IF;

  RETURN QUERY
    SELECT r.sid, r.uname, pa.attribute, pa.value, pa.op
      FROM plan_attributes pa
     WHERE pa.plan_id = r.plan_id
     ORDER BY pa.id;
END $$;

CREATE OR REPLACE FUNCTION radius_online_count(p_nas inet, p_user text)
RETURNS integer LANGUAGE sql STABLE AS $$
  SELECT count(*)::integer
    FROM nas n
    JOIN tenants t ON t.id = n.tenant_id
    JOIN radacct a ON a.tenant_id = n.tenant_id AND a.username = p_user AND a.acctstoptime IS NULL
   WHERE n.nasname = p_nas
     AND a.acctupdatetime > now() - make_interval(secs => 3 * t.interim_interval);
$$;

-- plpgsql, not sql: PostgreSQL 16 re-plans SQL-language functions on every call (+40% login throughput).
CREATE OR REPLACE FUNCTION radius_log_auth(p_nas inet, p_user text, p_reply text, p_reason text, p_calling text)
RETURNS integer LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO radpostauth (tenant_id, username, reply, reason, nasipaddress, callingstationid, authdate)
  VALUES ((SELECT tenant_id FROM nas WHERE nasname = p_nas), p_user, p_reply,
          nullif(p_reason, ''), p_nas, nullif(upper(p_calling), ''), now());
  RETURN 1;
END $$;

-- p_type: start | interim-update | stop | accounting-on | accounting-off. All numeric args arrive as text from FreeRADIUS.
CREATE OR REPLACE FUNCTION radius_acct(
  p_type text, p_nas inet, p_uid text, p_sid text, p_user text,
  p_event_ts text, p_req_ts text, p_delay text, p_sesstime text,
  p_in_oct text, p_in_giga text, p_out_oct text, p_out_giga text,
  p_nasportid text, p_nasporttype text, p_authentic text, p_connectinfo text,
  p_called text, p_calling text, p_servicetype text, p_framedproto text,
  p_framedip text, p_framedipv6 text, p_framedipv6prefix text, p_ifaceid text, p_delegated text,
  p_cause text)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  v_tenant integer;
  v_ts timestamptz;
  v_sess bigint := coalesce(nullif(p_sesstime, '')::bigint, 0);
  v_in bigint := (coalesce(nullif(p_in_giga, '')::bigint, 0) << 32) | coalesce(nullif(p_in_oct, '')::bigint, 0);
  v_out bigint := (coalesce(nullif(p_out_giga, '')::bigint, 0) << 32) | coalesce(nullif(p_out_oct, '')::bigint, 0);
  v_ip inet := nullif(p_framedip, '')::inet;
  v_rows integer;
BEGIN
  SELECT tenant_id INTO v_tenant FROM nas WHERE nasname = p_nas;
  IF v_tenant IS NULL THEN
    RETURN 0;
  END IF;

  v_ts := CASE
    WHEN coalesce(nullif(p_event_ts, '')::bigint, 0) > 0 THEN to_timestamp(p_event_ts::bigint)
    ELSE to_timestamp(p_req_ts::bigint) - make_interval(secs => coalesce(nullif(p_delay, '')::integer, 0))
  END;

  IF p_type IN ('accounting-on', 'accounting-off') THEN
    UPDATE radacct
       SET acctstoptime = v_ts,
           acctterminatecause = 'NAS-Reboot',
           acctsessiontime = greatest(acctsessiontime, extract(epoch FROM v_ts - acctstarttime)::bigint)
     WHERE nasipaddress = p_nas AND acctstoptime IS NULL;
    RETURN 1;
  END IF;

  IF p_type = 'start' THEN
    UPDATE radacct
       SET framedipaddress = coalesce(v_ip, framedipaddress),
           connectinfo_start = coalesce(nullif(p_connectinfo, ''), connectinfo_start)
     WHERE acctuniqueid = p_uid;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows > 0 THEN
      RETURN 1;
    END IF;
  ELSIF p_type = 'interim-update' THEN
    UPDATE radacct
       SET acctinterval = extract(epoch FROM v_ts - acctupdatetime)::bigint,
           acctupdatetime = v_ts,
           acctsessiontime = v_sess,
           acctinputoctets = v_in,
           acctoutputoctets = v_out,
           framedipaddress = coalesce(v_ip, framedipaddress),
           acctstoptime = NULL,
           acctterminatecause = NULL
     WHERE acctuniqueid = p_uid
       AND (acctstoptime IS NULL OR acctterminatecause = 'Stale-Session');
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows > 0 OR EXISTS (SELECT 1 FROM radacct WHERE acctuniqueid = p_uid) THEN
      RETURN 1;
    END IF;
  ELSIF p_type = 'stop' THEN
    UPDATE radacct
       SET acctstoptime = v_ts,
           acctupdatetime = v_ts,
           acctsessiontime = v_sess,
           acctinputoctets = v_in,
           acctoutputoctets = v_out,
           acctterminatecause = nullif(p_cause, ''),
           connectinfo_stop = nullif(p_connectinfo, '')
     WHERE acctuniqueid = p_uid
       AND (acctstoptime IS NULL OR acctterminatecause IN ('Stale-Session', 'NAS-Reboot'));
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows > 0 OR EXISTS (SELECT 1 FROM radacct WHERE acctuniqueid = p_uid) THEN
      RETURN 1;
    END IF;
  ELSE
    RETURN 1;
  END IF;

  -- No row yet: Start, or Interim/Stop whose Start was lost.
  INSERT INTO radacct (
    tenant_id, acctsessionid, acctuniqueid, username, nasipaddress, nasportid, nasporttype,
    acctstarttime, acctupdatetime, acctstoptime, acctsessiontime, acctauthentic,
    connectinfo_start, connectinfo_stop, acctinputoctets, acctoutputoctets,
    calledstationid, callingstationid, acctterminatecause, servicetype, framedprotocol,
    framedipaddress, framedipv6address, framedipv6prefix, framedinterfaceid, delegatedipv6prefix)
  VALUES (
    v_tenant, p_sid, p_uid, p_user, p_nas, nullif(p_nasportid, ''), nullif(p_nasporttype, ''),
    v_ts - make_interval(secs => v_sess), v_ts,
    CASE WHEN p_type = 'stop' THEN v_ts END,
    v_sess, nullif(p_authentic, ''),
    CASE WHEN p_type = 'start' THEN nullif(p_connectinfo, '') END,
    CASE WHEN p_type = 'stop' THEN nullif(p_connectinfo, '') END,
    v_in, v_out, nullif(p_called, ''), nullif(upper(p_calling), ''),
    CASE WHEN p_type = 'stop' THEN nullif(p_cause, '') END,
    nullif(p_servicetype, ''), nullif(p_framedproto, ''),
    v_ip, nullif(p_framedipv6, '')::inet, nullif(p_framedipv6prefix, '')::inet,
    nullif(p_ifaceid, ''), nullif(p_delegated, '')::inet)
  ON CONFLICT (acctuniqueid, acctstarttime) DO NOTHING;
  RETURN 1;
END $$;

CREATE OR REPLACE FUNCTION radius_close_stale_sessions()
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  v_rows integer;
BEGIN
  UPDATE radacct a
     SET acctstoptime = a.acctupdatetime,
         acctterminatecause = 'Stale-Session'
    FROM tenants t
   WHERE t.id = a.tenant_id
     AND a.acctstoptime IS NULL
     AND a.acctupdatetime < now() - interval '3 minutes'
     AND a.acctupdatetime < now() - make_interval(secs => 3 * t.interim_interval);
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END $$;

-- Creates month partitions [current .. current+p_months_ahead] for radacct and radpostauth.
-- Keep the horizon short: every login scans all radacct partitions (open sessions are not prunable), and more
-- than 16 relation locks per query leave PostgreSQL's fast-path lock slots. The daily timer keeps one month ahead.
-- Rows that already landed in the default partition for a new range are moved into it.
CREATE OR REPLACE FUNCTION radius_ensure_partitions(p_months_ahead integer DEFAULT 1)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  v_parent text;
  v_col text;
  v_from date;
  v_to date;
  v_name text;
  v_created integer := 0;
  i integer;
BEGIN
  FOR v_parent, v_col IN VALUES ('radacct', 'acctstarttime'), ('radpostauth', 'authdate') LOOP
    FOR i IN 0..p_months_ahead LOOP
      v_from := (date_trunc('month', now() AT TIME ZONE 'UTC') + make_interval(months => i))::date;
      v_to := (v_from + interval '1 month')::date;
      v_name := format('%s_%s', v_parent, to_char(v_from, 'YYYY_MM'));
      CONTINUE WHEN to_regclass(v_name) IS NOT NULL;

      EXECUTE format('CREATE TEMP TABLE _moved (LIKE %I) ON COMMIT DROP', v_parent);
      EXECUTE format(
        'WITH m AS (DELETE FROM %I WHERE %I >= %L::timestamptz AND %I < %L::timestamptz RETURNING *) INSERT INTO _moved SELECT * FROM m',
        v_parent || '_default', v_col, v_from, v_col, v_to);
      EXECUTE format('CREATE TABLE %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
        v_name, v_parent, v_from::timestamptz, v_to::timestamptz);
      EXECUTE format('INSERT INTO %I SELECT * FROM _moved', v_parent);
      DROP TABLE _moved;
      v_created := v_created + 1;
    END LOOP;
  END LOOP;
  RETURN v_created;
END $$;

-- Drops radpostauth month partitions entirely older than p_keep_days (default 90).
CREATE OR REPLACE FUNCTION radius_drop_old_postauth(p_keep_days integer DEFAULT 1100)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  r record;
  v_dropped integer := 0;
BEGIN
  FOR r IN
    SELECT c.relname,
           to_date(right(c.relname, 7), 'YYYY_MM') AS month_start
      FROM pg_inherits i
      JOIN pg_class c ON c.oid = i.inhrelid
      JOIN pg_class p ON p.oid = i.inhparent
     WHERE p.relname = 'radpostauth' AND c.relname ~ '^radpostauth_\d{4}_\d{2}$'
  LOOP
    IF (r.month_start + interval '1 month') < now() - make_interval(days => p_keep_days) THEN
      EXECUTE format('DROP TABLE %I', r.relname);
      v_dropped := v_dropped + 1;
    END IF;
  END LOOP;
  DELETE FROM radpostauth_default WHERE authdate < now() - make_interval(days => p_keep_days);
  RETURN v_dropped;
END $$;

-- Stable hash of everything FreeRADIUS loads as clients; the NAS watcher restarts FreeRADIUS when it changes.
CREATE OR REPLACE FUNCTION radius_nas_hash()
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT md5(coalesce(string_agg(concat_ws('|', id, host(nasname), shortname, type, secret), ',' ORDER BY id), ''))
    FROM nas;
$$;

-- Usage roll-up (WP 2.8), run every 15 min by the workers. Adds what each session transferred since it was last
-- seen to usage_daily for today's IST date (a 15-minute attribution window around midnight is accepted).
-- Sessions are found through the open-session and stop-time indexes; the advisory lock makes concurrent runs wait.
CREATE OR REPLACE FUNCTION radius_usage_rollup(p_window interval DEFAULT interval '30 minutes')
RETURNS TABLE (sessions integer, users integer)
LANGUAGE plpgsql AS $$
DECLARE
  v_since timestamptz := now() - p_window;
  v_day   date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('radius_usage_rollup'));

  -- One statement: every CTE reads the same snapshot, so usage_seen is compared before it is updated.
  RETURN QUERY
  WITH cur AS (
    SELECT a.radacctid, a.tenant_id, a.username,
           a.acctinputoctets AS i, a.acctoutputoctets AS o, a.acctsessiontime AS s,
           coalesce(u.in_bytes, 0) AS pi, coalesce(u.out_bytes, 0) AS po, coalesce(u.secs, 0) AS ps
      FROM radacct a
      LEFT JOIN usage_seen u ON u.radacctid = a.radacctid
     WHERE (a.acctstoptime IS NULL AND a.acctupdatetime >= v_since)
        OR (a.acctstoptime IS NOT NULL AND a.acctstoptime >= v_since)
  ), delta AS (
    -- counters only grow within a session; a lower value means the row was rewritten: count it from zero
    SELECT radacctid, tenant_id, username, i, o, s,
           CASE WHEN i >= pi THEN i - pi ELSE i END AS di,
           CASE WHEN o >= po THEN o - po ELSE o END AS d_o,
           CASE WHEN s >= ps THEN s - ps ELSE s END AS ds
      FROM cur
  ), seen AS (
    INSERT INTO usage_seen (radacctid, in_bytes, out_bytes, secs, updated_at)
    SELECT radacctid, i, o, s, now() FROM delta
    ON CONFLICT (radacctid) DO UPDATE
      SET in_bytes = EXCLUDED.in_bytes, out_bytes = EXCLUDED.out_bytes, secs = EXCLUDED.secs, updated_at = now()
    RETURNING 1
  ), daily AS (
    INSERT INTO usage_daily (tenant_id, username, day, bytes_in, bytes_out, session_secs)
    SELECT tenant_id, username, v_day, sum(di), sum(d_o), sum(ds)
      FROM delta
     GROUP BY tenant_id, username
    HAVING sum(di) + sum(d_o) + sum(ds) > 0
    ON CONFLICT (tenant_id, username, day) DO UPDATE
      SET bytes_in = usage_daily.bytes_in + EXCLUDED.bytes_in,
          bytes_out = usage_daily.bytes_out + EXCLUDED.bytes_out,
          session_secs = usage_daily.session_secs + EXCLUDED.session_secs
    RETURNING 1
  )
  SELECT (SELECT count(*) FROM seen)::integer, (SELECT count(*) FROM daily)::integer;

  -- Sessions not seen for two days are finished; their last counters are already in usage_daily.
  DELETE FROM usage_seen WHERE updated_at < now() - interval '2 days';
END;
$$;
