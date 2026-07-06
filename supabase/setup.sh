#!/usr/bin/env bash
# supabase/setup.sh
#
# Idempotent one-shot Supabase setup: applies ALL numbered migrations in
# order, then runs the corpus seed file. Re-running is a no-op because
# every SQL statement is idempotent (create-if-not-exists,
# on-conflict-do-nothing, etc.).
#
# Usage:
#
#   export SUPABASE_DB_URL='postgres://postgres:<pw>@db.<ref>.supabase.co:6543/postgres?sslmode=require'
#   ./supabase/setup.sh
#
# Or piped from the project root:
#
#   SUPABASE_DB_URL=... ./supabase/setup.sh
#
# The DB URL is the "Connection string" shown under
# Project Settings > Database > Connection string > URI in the Supabase
# dashboard. Use the pooled connection on port 6543 for one-shot runs.
#
# Exit codes:
#   0 = all migrations + seed applied cleanly
#   1 = a migration or the seed errored
#   2 = SUPABASE_DB_URL was not set

set -euo pipefail

if [[ -z "${SUPABASE_DB_URL:-}" ]]; then
  echo "[setup.sh] SUPABASE_DB_URL is required."
  echo "  Set it to the Connection string from the Supabase dashboard."
  echo "  Example:"
  echo "    export SUPABASE_DB_URL='postgres://postgres:<password>@db.<ref>.supabase.co:6543/postgres?sslmode=require'"
  exit 2
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MIGRATIONS_DIR="$ROOT/supabase/migrations"
SEED_FILE="$ROOT/supabase/seed.sql"

if ! command -v psql >/dev/null 2>&1; then
  echo "[setup.sh] psql not found. Install it via:"
  echo "  macOS:   brew install libpq && brew link --force libpq"
  echo "  Ubuntu:  apt-get install postgresql-client"
  exit 2
fi

# Match every numbered migration (001_..160_.. and beyond). The old
# glob was `0*.sql`, which silently skipped everything from 100_ onward.
# Filenames are zero-padded, so shell (lexical) glob order == numeric order.
mig_count=$(ls "$MIGRATIONS_DIR"/[0-9]*.sql 2>/dev/null | wc -l | tr -d ' ')
echo "[setup.sh] applying $mig_count migrations from $MIGRATIONS_DIR ..."
fail=0
for f in "$MIGRATIONS_DIR"/[0-9]*.sql; do
  bn=$(basename "$f")
  echo "  [$bn] starting..."
  if psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -q -f "$f" 2>&1 | tee /tmp/setup-last.log | grep -E "ERROR|FATAL" >/dev/null; then
    echo "  [$bn] FAILED. See /tmp/setup-last.log."
    fail=$((fail+1))
  else
    echo "  [$bn] ok"
  fi
done

if [[ $fail -ne 0 ]]; then
  echo "[setup.sh] $fail migration(s) failed. Stopping before seed."
  exit 1
fi

echo "[setup.sh] running seed.sql ..."
if [[ -f "$SEED_FILE" ]]; then
  psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f "$SEED_FILE"
  echo "[setup.sh] seed complete."
else
  echo "[setup.sh] $SEED_FILE missing; skipping seed (you can paste 010_seed_corpus_round2_data.sql manually)."
fi

cat <<EOF

[setup.sh] Done.

Next steps:
  1. Storage: create a private bucket named 'obara-documents' in the
     Supabase dashboard (Storage > New bucket).
  2. Auth: enable Email provider with Magic Link (Authentication >
     Providers > Email). Add /auth/callback.html to redirect URLs.
  3. Sign in once via magic link, then run this SQL to make yourself
     an admin of the default tenant:

       insert into tenant_members (tenant_id, user_id, role)
       values ('00000000-0000-0000-0000-000000000001',
               (select id from auth.users where email = 'YOU@example.com'),
               'admin')
       on conflict (tenant_id, user_id) do update set role = excluded.role;

  4. Configure Vercel env vars per .env.example. Deploy.
EOF
