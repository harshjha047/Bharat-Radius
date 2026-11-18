-- Re-applied on every install. psql variables: fr_role, app_role, repl_role.
REVOKE ALL ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO :"fr_role", :"app_role";

-- FreeRADIUS: read config, write sessions and auth log, nothing else.
GRANT SELECT ON tenants, nas, plans, plan_attributes, subscribers TO :"fr_role";
GRANT SELECT, INSERT, UPDATE ON radacct TO :"fr_role";
GRANT INSERT ON radpostauth TO :"fr_role";
GRANT USAGE ON SEQUENCE radacct_radacctid_seq, radpostauth_id_seq TO :"fr_role";
GRANT EXECUTE ON FUNCTION
  radius_pw_key(),
  radius_check(inet, text, text),
  radius_reply(inet, text),
  radius_online_count(inet, text),
  radius_log_auth(inet, text, text, text, text),
  radius_acct(text, inet, text, text, text, text, text, text, text, text, text, text, text, text, text, text,
              text, text, text, text, text, text, text, text, text, text, text)
  TO :"fr_role";
GRANT EXECUTE ON FUNCTION pgp_sym_decrypt(bytea, text) TO :"fr_role";

-- Node API (outbox writer): manage config, read sessions/auth log, close sessions, maintain usage_daily.
GRANT SELECT, INSERT, UPDATE, DELETE ON tenants, nas, plans, plan_attributes, subscribers TO :"app_role";
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO :"app_role";
GRANT SELECT, UPDATE ON radacct TO :"app_role";
GRANT SELECT ON radpostauth TO :"app_role";
GRANT SELECT, INSERT, UPDATE, DELETE ON usage_daily, usage_seen TO :"app_role";
GRANT EXECUTE ON FUNCTION
  radius_encrypt_password(text, text),
  radius_online_count(inet, text),
  -- CoA: the worker sends exactly the rate/lists FreeRADIUS would reply with now.
  radius_reply(inet, text),
  radius_close_stale_sessions(),
  radius_usage_rollup(interval),
  pgp_sym_encrypt(text, text, text)
  TO :"app_role";

-- pg_trgm (migration 006): near-match usernames in the auth log's "Why?".
GRANT EXECUTE ON FUNCTION similarity(text, text), similarity_op(text, text) TO :"app_role";

-- Statistics extension: give back to PostgreSQL's monitoring role what the REVOKEs above took from PUBLIC.
DO $$ BEGIN
  IF to_regclass('public.pg_stat_statements') IS NOT NULL THEN
    GRANT SELECT ON pg_stat_statements, pg_stat_statements_info TO pg_read_all_stats;
    GRANT EXECUTE ON FUNCTION pg_stat_statements(boolean), pg_stat_statements_info() TO pg_read_all_stats;
  END IF;
END $$;

-- The app still passes RADIUS_PW_KEY to radius_encrypt_password(): never log statements for these roles.
ALTER ROLE :"fr_role" SET log_statement = 'none';
ALTER ROLE :"fr_role" SET log_min_duration_statement = -1;
ALTER ROLE :"fr_role" SET log_min_error_statement = 'panic';
ALTER ROLE :"fr_role" SET synchronous_commit = 'off';
ALTER ROLE :"app_role" SET log_statement = 'none';
ALTER ROLE :"app_role" SET log_min_duration_statement = -1;
ALTER ROLE :"app_role" SET log_min_error_statement = 'panic';
