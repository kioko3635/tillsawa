#!/bin/sh
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set=app_password="$POS_APP_PASSWORD" --set=system_password="$POS_SYSTEM_PASSWORD" <<'SQL'
CREATE ROLE kenya_pos_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD :'app_password';
CREATE ROLE pos_system LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD :'system_password';
GRANT kenya_pos_app TO pos_system;
ALTER DATABASE kenya_pos_hub OWNER TO kenya_pos_app;
SQL
