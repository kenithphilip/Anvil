#!/usr/bin/env bash
#
# Apply the full migration set, in order, to a throwaway Postgres.
#
# WHY THIS EXISTS
# ---------------
# Anvil has no automated migration step: Vercel deploys the app, nobody runs
# supabase/migrations/. Merging a migration does NOT change the live database.
# CI never noticed, because it runs vitest against a MOCKED Supabase plus
# tsc/node --check/verify audits — so until now no migration SQL was ever
# parsed, let alone executed. Two real failures came from that blind spot:
#
#   • migration 186 shipped comparing `name[] = text[]`, which has no operator.
#     It could not run on ANY Postgres, and merged green anyway.
#   • migrations 140-145 sat unapplied through an entire feature arc, so
#     composition recipes / pricing bindings / material price refs / freight
#     consolidation were live code pointing at tables that did not exist.
#
# This script makes both classes a build failure: broken SQL fails here, and so
# does a migration that can't apply on top of its predecessors.
#
# It asserts the migrations APPLY. It does not assert runtime RLS behaviour —
# see supabase/ci-bootstrap.sql for what is stubbed and why.
#
# Usage: bash scripts/db/apply-migrations.sh
# Honours the standard PG* env vars; defaults suit the CI service container.

set -euo pipefail

export PGHOST="${PGHOST:-localhost}"
export PGPORT="${PGPORT:-5432}"
export PGUSER="${PGUSER:-postgres}"
export PGDATABASE="${PGDATABASE:-anvil_ci}"

MIGRATIONS_DIR="supabase/migrations"
BOOTSTRAP="supabase/ci-bootstrap.sql"

if ! command -v psql >/dev/null 2>&1; then
  echo "✗ psql not found on PATH" >&2
  exit 1
fi
for required in "$BOOTSTRAP" "$MIGRATIONS_DIR"; do
  if [ ! -e "$required" ]; then
    echo "✗ $required not found — run from the repo root" >&2
    exit 1
  fi
done

run_sql() { psql -v ON_ERROR_STOP=1 --quiet --no-psqlrc -f "$1"; }

echo "▸ bootstrap: Supabase shim (auth/storage schemas, roles, extensions)"
if ! run_sql "$BOOTSTRAP"; then
  echo "✗ bootstrap failed — the shim itself is broken, not a migration" >&2
  exit 1
fi

# Filenames are zero-padded 3-digit (001_… through 187_…), so glob order is
# numeric order. A non-padded file would sort wrong, so reject one loudly
# rather than silently applying the set out of order.
shopt -s nullglob
migrations=("$MIGRATIONS_DIR"/[0-9]*.sql)
if [ ${#migrations[@]} -eq 0 ]; then
  echo "✗ no migrations matched $MIGRATIONS_DIR/[0-9]*.sql" >&2
  exit 1
fi
for f in "${migrations[@]}"; do
  base="$(basename "$f")"
  if ! [[ "$base" =~ ^[0-9]{3}_ ]]; then
    echo "✗ $base is not zero-padded 3-digit (NNN_name.sql); ordering is unsafe" >&2
    exit 1
  fi
done

applied=0
for f in "${migrations[@]}"; do
  printf '▸ %s\n' "$(basename "$f")"
  if ! run_sql "$f"; then
    echo "" >&2
    echo "✗ MIGRATION FAILED: $f" >&2
    echo "  It could not apply on top of the $applied migration(s) before it." >&2
    echo "  Fix the SQL — do not merge; this migration cannot reach production." >&2
    exit 1
  fi
  applied=$((applied + 1))
done

echo ""
echo "✓ applied $applied migrations cleanly onto a fresh database"
