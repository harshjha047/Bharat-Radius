#!/usr/bin/env bash
# Loads the RADIUS schema, functions and grants into an empty PostgreSQL (no FreeRADIUS) for app/worker tests.
# Usage: ADMIN_URL=postgres://postgres:pw@host:port bash radius/tests/schema-only.sh <db> <fr_role> <app_role> <app_password>
set -Eeuo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
db="$1" fr="$2" app="$3" app_pw="$4"
psql_() { psql -X -q -v ON_ERROR_STOP=1 "$@"; }
psql_ "$ADMIN_URL/postgres" -c "CREATE ROLE $fr LOGIN" -c "CREATE ROLE $app LOGIN PASSWORD '$app_pw'"
psql_ "$ADMIN_URL/postgres" -c "CREATE DATABASE $db"
[[ -z ${PW_KEY:-} ]] || psql_ "$ADMIN_URL/postgres" -v role="$fr" -v key="$PW_KEY" <<<"ALTER ROLE :\"role\" SET app.pw_key = :'key';"
for f in "$DIR"/sql/0*.sql "$DIR"/sql/100_functions.sql; do psql_ "$ADMIN_URL/$db" -f "$f" >/dev/null; done
psql_ "$ADMIN_URL/$db" -v fr_role="$fr" -v app_role="$app" -f "$DIR/sql/200_grants.sql"
psql_ "$ADMIN_URL/$db" -c "GRANT CONNECT ON DATABASE $db TO $fr, $app" -c "SELECT radius_ensure_partitions(1)" >/dev/null
echo "schema loaded into $db"
