---
layout: page
title: Administration
---

# Administration

## Keeping Up to Date
See [Updating](updating.md).

## Viewing Activity
Monitor your system via the [Waiting For Caller (WFC)](../modding/wfc.md) screen and learn how to [monitoring logs](../troubleshooting/monitoring-logs.md).

## Managing Users
User management is currently handled via the [oputil CLI](oputil.md).

## Backing Up Your System
It is *highly* recommended to perform **regular backups** of your system. Nothing is worse than spending a lot of time setting up a system only to have to go away unexpectedly!

In general, simply creating a copy/archive of your system is enough for the default configuration. If you have changed default paths to point outside of your main ENiGMA½ installation take special care to ensure these are preserved as well. Database files may be in a state of flux when simply copying files. See [Database Backups](#database-backups) below for details on consistent backups.

### Database Backups
[SQLite's CLI backup command](https://sqlite.org/cli.html#special_commands_to_sqlite3_dot_commands_) can be used for creating database backup files. This can be performed as an additional step to a full backup to ensure the database is backed up in a consistent state (whereas simply copying the files does not make any guarantees).

As an example, consider the following Bash script that creates foo.sqlite3.backup files:

```bash
for dbfile in /path/to/enigma-bbs/db/*.sqlite3; do
    sqlite3 $dbfile ".backup '/path/to/db_backup/$(basename $dbfile).backup'"
done
```

### Backup Tools
There are many backup solutions available across all platforms. Configuration of such tools is outside the scope of this documentation. With that said, the author has had great success with [Borg](https://www.borgbackup.org/).

## General Maintenance Tasks
### Vacuuming Database Files
SQLite database files become less performant over time and waste space. It is recommended to periodically vacuum your databases. Before proceeding, you should make a backup!

Example:
```bash
sqlite3 ./db/message.sqlite3 "vacuum;"
```
