-- Migration 002: partitions are now created one month ahead (was three). Drop empty ones beyond that horizon.
DO $$
DECLARE
  v_rel text;
  v_empty boolean;
  v_horizon date := (date_trunc('month', now() AT TIME ZONE 'UTC') + interval '2 months')::date;
BEGIN
  FOR v_rel IN
    SELECT c.relname
      FROM pg_inherits i
      JOIN pg_class c ON c.oid = i.inhrelid
      JOIN pg_class p ON p.oid = i.inhparent
     WHERE p.relname IN ('radacct', 'radpostauth')
       AND c.relname ~ '_\d{4}_\d{2}$'
       AND to_date(right(c.relname, 7), 'YYYY_MM') >= v_horizon
  LOOP
    EXECUTE format('SELECT NOT EXISTS (SELECT 1 FROM %I)', v_rel) INTO v_empty;
    IF v_empty THEN
      EXECUTE format('DROP TABLE %I', v_rel);
    END IF;
  END LOOP;
END $$;
