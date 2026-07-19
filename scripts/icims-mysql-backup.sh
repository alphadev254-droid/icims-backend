#!/usr/bin/env bash
set -euo pipefail

# ICIMS MySQL backup script.
# Creates one compressed logical backup and removes backups older than RETENTION_DAYS.
#
# Recommended cron:
#   0 2 * * * /data/icims-backend/scripts/icims-mysql-backup.sh >> /var/log/icims-mysql-backup.log 2>&1
#
# Authentication:
#   Prefer MYSQL_CNF=/root/.my.cnf with:
#     [client]
#     user=root
#     password=your-password
#     host=127.0.0.1
#     port=3306

DB_NAME="${DB_NAME:-icims}"
BACKUP_DIR="${BACKUP_DIR:-/data/backups/mysql/icims}"
RETENTION_DAYS="${RETENTION_DAYS:-31}"
MYSQL_CNF="${MYSQL_CNF:-/root/.my.cnf}"
MYSQLDUMP_BIN="${MYSQLDUMP_BIN:-/opt/lampp/bin/mysqldump}"
MYSQL_BIN="${MYSQL_BIN:-/opt/lampp/bin/mysql}"
LOCK_FILE="${LOCK_FILE:-/tmp/icims-mysql-backup.lock}"

timestamp() {
  date -u +"%Y-%m-%dT%H:%M:%SZ"
}

log() {
  printf '%s %s\n' "$(timestamp)" "$*"
}

if ! command -v gzip >/dev/null 2>&1; then
  log "ERROR gzip is required"
  exit 1
fi

if ! command -v sha256sum >/dev/null 2>&1; then
  log "ERROR sha256sum is required"
  exit 1
fi

if [ ! -x "$MYSQLDUMP_BIN" ]; then
  log "ERROR mysqldump not found or not executable: $MYSQLDUMP_BIN"
  exit 1
fi

if [ ! -x "$MYSQL_BIN" ]; then
  log "ERROR mysql not found or not executable: $MYSQL_BIN"
  exit 1
fi

if [ ! -f "$MYSQL_CNF" ]; then
  log "ERROR MySQL client config not found: $MYSQL_CNF"
  log "Create it with [client] user/password/host/port, chmod 600 it, then rerun."
  exit 1
fi

mkdir -p "$BACKUP_DIR"

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  log "Another backup is already running, exiting."
  exit 0
fi

backup_stamp="$(date -u +"%Y%m%dT%H%M%SZ")"
backup_file="$BACKUP_DIR/${DB_NAME}_${backup_stamp}.sql.gz"
tmp_file="${backup_file}.tmp"
checksum_file="${backup_file}.sha256"

log "Starting backup for database '$DB_NAME' into $backup_file"

"$MYSQL_BIN" --defaults-extra-file="$MYSQL_CNF" -e "SELECT 1" "$DB_NAME" >/dev/null

"$MYSQLDUMP_BIN" \
  --defaults-extra-file="$MYSQL_CNF" \
  --single-transaction \
  --quick \
  --routines \
  --triggers \
  --events \
  --hex-blob \
  "$DB_NAME" | gzip -9 > "$tmp_file"

mv "$tmp_file" "$backup_file"
sha256sum "$backup_file" > "$checksum_file"

log "Backup complete: $(du -h "$backup_file" | awk '{print $1}')"
log "Checksum written: $checksum_file"

log "Removing backups older than $RETENTION_DAYS days from $BACKUP_DIR"
find "$BACKUP_DIR" -type f \( -name "${DB_NAME}_*.sql.gz" -o -name "${DB_NAME}_*.sql.gz.sha256" \) -mtime +"$RETENTION_DAYS" -print -delete

log "Backup job finished successfully"
