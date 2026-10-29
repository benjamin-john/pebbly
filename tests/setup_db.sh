#!/bin/sh
# Builds a throwaway test database with every Pebbly schema loaded (see CLAUDE.md → Testing).
#   sh tests/setup_db.sh <dbname> [nomigrations]
# Starts the shared test Postgres (/tmp/pebbly-pgtest, port 5439) if it isn't running.
set -e
DB=${1:?database name}
cd "$(dirname "$0")/.."
PGDIR=/tmp/pebbly-pgtest
if [ ! -d $PGDIR/data ]; then
  mkdir -p $PGDIR && chown postgres $PGDIR
  su postgres -c "/usr/lib/postgresql/16/bin/initdb -D $PGDIR/data -A trust >/dev/null"
fi
if ! su postgres -c "/usr/lib/postgresql/16/bin/pg_ctl -D $PGDIR/data status" >/dev/null 2>&1; then
  su postgres -c "/usr/lib/postgresql/16/bin/pg_ctl -D $PGDIR/data -o '-p 5439 -k $PGDIR -c listen_addresses=' -l $PGDIR/log start" >/dev/null
  sleep 1
fi
P="psql -h $PGDIR -p 5439 -U postgres -v ON_ERROR_STOP=1 -q"
$P -c "drop database if exists $DB" -c "create database $DB" >/dev/null
FILES="tests/wdw_fixture.sql whichdayworks/schema_snapshot.sql whichdayworks/organizer.sql whichdayworks/final_date.sql
  rsvp/schema.sql rsvp/update_2.sql rsvp/update_3.sql rsvp/update_4.sql rsvp/rsvp_admin.sql poll/schema_snapshot.sql tests/poll_fixture.sql play/play.sql"
[ "$2" = nomigrations ] || FILES="$FILES $(ls supabase/migrations/*.sql | sort)"
for f in $FILES; do $P -d $DB -f $f >/dev/null 2>/tmp/setup_db_err.txt || { echo "setup_db: $f failed"; cat /tmp/setup_db_err.txt; exit 1; }; done
echo "ready: $DB"
