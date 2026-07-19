# ICIMS MySQL Backup and Binary Log Runbook

This setup keeps 31 days of compressed daily backups and 31 days of MySQL binary logs.

## What This Gives You

- Full daily restore points.
- Point-in-time recovery within the last 31 days.
- Better investigation and reverse recovery using row-based binary logs.

## Backup Flow

Every day, cron runs `scripts/icims-mysql-backup.sh`.

It creates:

```text
/data/backups/mysql/icims/icims_20260719T020000Z.sql.gz
/data/backups/mysql/icims/icims_20260719T020000Z.sql.gz.sha256
```

Then it deletes backup files older than 31 days.

## Binary Log Flow

MySQL writes every insert, update, and delete into files like:

```text
/opt/lampp/var/mysql/mysql-bin.000001
/opt/lampp/var/mysql/mysql-bin.000002
```

With:

```ini
binlog_format=ROW
binlog_row_image=FULL
```

MySQL stores row-level changes with full before/after row images. This is safer for ICIMS because giving, pledges, users, attendance, withdrawals, and payments are important.

## Server Setup

Create backup directory:

```bash
mkdir -p /data/backups/mysql/icims
chmod 700 /data/backups/mysql/icims
```

Create a MySQL client config:

```bash
nano /root/.my.cnf
```

Use:

```ini
[client]
user=root
password=YOUR_MYSQL_PASSWORD
host=127.0.0.1
port=3306
```

Secure it:

```bash
chmod 600 /root/.my.cnf
```

Make the backup script executable:

```bash
chmod +x /data/icims-backend/scripts/icims-mysql-backup.sh
```

Test one backup:

```bash
DB_NAME=icims BACKUP_DIR=/data/backups/mysql/icims RETENTION_DAYS=31 /data/icims-backend/scripts/icims-mysql-backup.sh
ls -lh /data/backups/mysql/icims
```

Add cron:

```bash
crontab -e
```

Add:

```cron
0 2 * * * DB_NAME=icims BACKUP_DIR=/data/backups/mysql/icims RETENTION_DAYS=31 /data/icims-backend/scripts/icims-mysql-backup.sh >> /var/log/icims-mysql-backup.log 2>&1
```

## Enable Binary Logs

Open MySQL config:

```bash
nano /opt/lampp/etc/my.cnf
```

Under `[mysqld]`, add the settings from:

```text
docs/mysql-binlog-31-days.cnf
```

Restart MySQL:

```bash
/opt/lampp/lampp restartmysql
```

Verify:

```bash
/opt/lampp/bin/mysql --defaults-extra-file=/root/.my.cnf -e "
SHOW VARIABLES LIKE 'log_bin';
SHOW VARIABLES LIKE 'binlog_format';
SHOW VARIABLES LIKE 'binlog_row_image';
SHOW VARIABLES LIKE 'binlog_expire_logs_seconds';
SHOW BINARY LOGS;
"
```

Expected:

```text
log_bin = ON
binlog_format = ROW
binlog_row_image = FULL
binlog_expire_logs_seconds = 2678400
```

## Point-In-Time Recovery Concept

If a bad action happens at `2026-07-19 15:14:00`:

1. Restore the latest backup into a temporary database, for example `icims_restore`.
2. Replay binlogs into `icims_restore` until `2026-07-19 15:13:59`.
3. Copy only the needed rows back into the live `icims` database.

Do this first on a temporary database, not directly on production.

## Space Monitoring

Check backup size:

```bash
du -sh /data/backups/mysql/icims
```

Check binary log size:

```bash
du -sh /opt/lampp/var/mysql/mysql-bin.*
```

Check disk:

```bash
df -h
```

If disk grows too fast, reduce retention or move backups to another storage location.
