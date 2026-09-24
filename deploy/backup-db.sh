#!/usr/bin/env bash
# Back up the SQLite database with private permissions and retain 30 days.
set -euo pipefail
umask 077

db_path="$1"
backup_dir="$2"
mkdir -p "$backup_dir"
backup_path="$backup_dir/access-$(date +%F).db"
sqlite3 "$db_path" ".backup '$backup_path'"
find "$backup_dir" -name 'access-*.db' -type f -mtime +30 -delete
