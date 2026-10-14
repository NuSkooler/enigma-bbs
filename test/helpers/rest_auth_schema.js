'use strict';

function applyUserSchema(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS user (
            id        INTEGER PRIMARY KEY,
            user_name VARCHAR NOT NULL,
            UNIQUE(user_name)
        );
        CREATE TABLE IF NOT EXISTS user_property (
            user_id    INTEGER NOT NULL,
            prop_name  VARCHAR NOT NULL,
            prop_value VARCHAR,
            UNIQUE(user_id, prop_name),
            FOREIGN KEY(user_id) REFERENCES user(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS user_property_idx ON user_property (user_id, prop_name);
        CREATE TABLE IF NOT EXISTS user_group_member (
            group_name VARCHAR NOT NULL,
            user_id    INTEGER NOT NULL,
            UNIQUE(group_name, user_id)
        );
        CREATE TABLE IF NOT EXISTS user_achievement (
            user_id         INTEGER NOT NULL,
            achievement_tag VARCHAR NOT NULL,
            timestamp       DATETIME NOT NULL,
            match           VARCHAR NOT NULL,
            title           VARCHAR NOT NULL,
            text            VARCHAR NOT NULL,
            points          INTEGER NOT NULL,
            UNIQUE(user_id, achievement_tag, match),
            FOREIGN KEY(user_id) REFERENCES user(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS user_temporary_token (
            user_id    INTEGER NOT NULL,
            token      VARCHAR NOT NULL,
            token_type VARCHAR NOT NULL,
            timestamp  DATETIME NOT NULL,
            UNIQUE(user_id, token_type),
            FOREIGN KEY(user_id) REFERENCES user(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS api_refresh_tokens (
            id         INTEGER PRIMARY KEY,
            user_id    INTEGER NOT NULL,
            token_hash VARCHAR NOT NULL,
            issued_at  DATETIME NOT NULL,
            expires_at DATETIME NOT NULL,
            revoked    INTEGER NOT NULL DEFAULT 0,
            UNIQUE(token_hash),
            FOREIGN KEY(user_id) REFERENCES user(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS api_keys (
            id           INTEGER PRIMARY KEY,
            user_id      INTEGER NOT NULL,
            key_hash     VARCHAR NOT NULL,
            label        VARCHAR NOT NULL DEFAULT '',
            scope        VARCHAR NOT NULL DEFAULT 'read',
            created_at   DATETIME NOT NULL,
            last_used_at DATETIME,
            revoked      INTEGER NOT NULL DEFAULT 0,
            UNIQUE(key_hash),
            FOREIGN KEY(user_id) REFERENCES user(id) ON DELETE CASCADE
        );
    `);
}

function applySystemSchema(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS system_stat (
            stat_name  VARCHAR PRIMARY KEY NOT NULL,
            stat_value VARCHAR NOT NULL
        );
    `);
}

module.exports = { applyUserSchema, applySystemSchema };
