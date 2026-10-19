#!/usr/bin/env bash
# Restores an encrypted nightly backup (from the "Database backup" workflow on GitHub)
# into an EMPTY database. See docs/DEPLOY.md, Backups.
#
#   scripts/restore-backup.sh qr-attendance-2026-10-18.dump.age 'postgres://user:pass@host/db?sslmode=require'
#
# Needs Docker (for pg_restore 18, which reads backups of any older version) and age (https://age-encryption.org; or set AGE=path).
# The private key is read from ~/.qr-attendance/backup-key.txt (or BACKUP_KEY=path).
set -euo pipefail

if [ $# -ne 2 ]; then
  echo "Usage: $0 <backup.dump.age> <target database URL>" >&2
  exit 2
fi
file=$1
target=$2
key=${BACKUP_KEY:-$HOME/.qr-attendance/backup-key.txt}
age=${AGE:-$(command -v age || echo "$HOME/opt/age/age")}

[ -f "$file" ] || { echo "No such file: $file" >&2; exit 1; }
[ -f "$key" ] || { echo "The private key isn't at $key (set BACKUP_KEY)" >&2; exit 1; }
[ -x "$age" ] || { echo "age isn't installed (set AGE=path to the age program)" >&2; exit 1; }

echo "Restoring $file …"
"$age" --decrypt --identity "$key" "$file" |
  docker run --rm -i --network host postgres:18-alpine \
    pg_restore --clean --if-exists --no-owner --no-privileges --exit-on-error --dbname="$target"
echo "Done. Point DATABASE_URL at this database to use it."
