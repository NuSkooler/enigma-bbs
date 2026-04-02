--  ENiGMA½ schema update — 2026-04-01
--
--  Adds storage_tag_rel_path to the file table to support recursive storage
--  tags (/* suffix).  NULL / empty means the file lives at the tag base dir,
--  which is correct for all existing rows — no data migration required.
--
--  NOTE: ENiGMA½ applies this migration automatically on startup.
--  This script is provided for reference or manual recovery only.
--
--  If needed, run against the file database (usually db/file.sqlite3):
--    sqlite3 /path/to/db/file.sqlite3 < tables_update_2026-04-01.sql

PRAGMA foreign_keys=OFF;

BEGIN;

ALTER TABLE file ADD COLUMN storage_tag_rel_path VARCHAR DEFAULT NULL;

CREATE INDEX IF NOT EXISTS file_by_storage_tag_index
ON file (storage_tag);

PRAGMA foreign_key_check;

COMMIT;

PRAGMA foreign_keys=ON;
