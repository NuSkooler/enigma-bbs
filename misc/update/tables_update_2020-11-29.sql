PRAGMA foreign_keys=OFF;

BEGIN;

CREATE TABLE IF NOT EXISTS file_hash_tag_new (
    hash_tag_id     INTEGER NOT NULL,
    file_id         INTEGER NOT NULL,

    UNIQUE(hash_tag_id, file_id),
    FOREIGN KEY(file_id) REFERENCES file(file_id) ON DELETE CASCADE
);
INSERT INTO file_hash_tag_new SELECT * FROM file_hash_tag;
DROP TABLE file_hash_tag;
ALTER TABLE file_hash_tag_new RENAME TO file_hash_tag;

CREATE TABLE IF NOT EXISTS file_user_rating_new (
    file_id         INTEGER NOT NULL,
    user_id         INTEGER NOT NULL,
    rating          INTEGER NOT NULL,

    UNIQUE(file_id, user_id),
    FOREIGN KEY(file_id) REFERENCES file(file_id) ON DELETE CASCADE
);
INSERT INTO file_user_rating_new SELECT * FROM file_user_rating;
DROP TABLE file_user_rating;
ALTER TABLE file_user_rating_new RENAME TO file_user_rating;

CREATE TABLE IF NOT EXISTS file_web_serve_batch_new (
    hash_id     VARCHAR NOT NULL,
    file_id     INTEGER NOT NULL,

    UNIQUE(hash_id, file_id),
    FOREIGN KEY(file_id) REFERENCES file(file_id) ON DELETE CASCADE
);
INSERT INTO file_web_serve_batch_new SELECT * FROM file_web_serve_batch;
DROP TABLE file_web_serve_batch;
ALTER TABLE file_web_serve_batch_new RENAME TO file_web_serve_batch;

PRAGMA foreign_key_check;
COMMIT;
PRAGMA foreign_keys=ON;
