/* jslint node: true */
'use strict';

const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const DB_PATH = path.join(__dirname, '..', 'db', 'notifications.sqlite3');

function nowIso() {
    return new Date().toISOString();
}

function isoAfterMs(baseIso, offsetMs) {
    return new Date(new Date(baseIso).getTime() + offsetMs).toISOString();
}

function openDb() {
    return new sqlite3.Database(DB_PATH);
}

function run(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (err) {
            if (err) {
                return reject(err);
            }
            return resolve({
                lastID: this.lastID,
                changes: this.changes,
            });
        });
    });
}

function get(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) {
                return reject(err);
            }
            return resolve(row || null);
        });
    });
}

function all(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) {
                return reject(err);
            }
            return resolve(rows || []);
        });
    });
}

function exec(db, sql) {
    return new Promise((resolve, reject) => {
        db.exec(sql, err => {
            if (err) {
                return reject(err);
            }
            return resolve();
        });
    });
}

function close(db) {
    return new Promise((resolve, reject) => {
        db.close(err => {
            if (err) {
                return reject(err);
            }
            return resolve();
        });
    });
}

function normalizeLeaseRecord(row) {
    if (!row || !row.state_value) {
        return null;
    }

    try {
        const parsed = JSON.parse(row.state_value);
        if (!parsed || 'object' !== typeof parsed) {
            return null;
        }

        return {
            owner: parsed.owner || null,
            expires_ts: parsed.expires_ts || null,
            meta: parsed.meta || null,
        };
    } catch (err) {
        return null;
    }
}

function toBoolInt(value, fallback = 0) {
    if (true === value || 1 === value || '1' === value) {
        return 1;
    }

    if (false === value || 0 === value || '0' === value) {
        return 0;
    }

    return fallback ? 1 : 0;
}

function normalizeAreaTag(areaTag) {
    return 'string' === typeof areaTag ? areaTag.trim() : '';
}

function getAreaFlagColumnForEvent(eventType) {
    switch ((eventType || '').toLowerCase()) {
        case 'reply_to_own_post':
        case 'reply':
            return 'reply_to_own_post_email';
        case 'new_post':
        case 'new_topic':
        default:
            return 'new_post_email';
    }
}

async function getTableColumns(db, tableName) {
    const rows = await all(db, `PRAGMA table_info(${tableName})`);
    return new Set((rows || []).map(row => row.name));
}

async function ensureUserAreaSubscriptionColumns(db) {
    const columns = await getTableColumns(db, 'user_area_subscriptions');

    if (!columns.has('new_post_email')) {
        await exec(
            db,
            `
            ALTER TABLE user_area_subscriptions
            ADD COLUMN new_post_email INTEGER NOT NULL DEFAULT 1
            `
        );
    }

    if (!columns.has('reply_to_own_post_email')) {
        await exec(
            db,
            `
            ALTER TABLE user_area_subscriptions
            ADD COLUMN reply_to_own_post_email INTEGER NOT NULL DEFAULT 0
            `
        );
    }
}

async function migrateLegacyReplySettings(db) {
    const migrationStateKey = 'migration_reply_to_own_post_per_area_v1';
    const existingState = await get(
        db,
        `
        SELECT state_key
        FROM email_notification_state
        WHERE state_key = ?
        `,
        [migrationStateKey]
    );

    if (existingState) {
        return false;
    }

    const ts = nowIso();

    await run(
        db,
        `
        UPDATE user_area_subscriptions
        SET reply_to_own_post_email = 1,
            updated_ts = ?
        WHERE reply_to_own_post_email = 0
          AND user_id IN (
              SELECT user_id
              FROM user_notification_settings
              WHERE reply_to_own_post_email = 1
          )
        `,
        [ts]
    );

    await run(
        db,
        `
        INSERT OR IGNORE INTO email_notification_state
            (state_key, state_value, updated_ts)
        VALUES
            (?, ?, ?)
        `,
        [migrationStateKey, 'done', ts]
    );

    return true;
}


async function ensureSchema() {
    const db = openDb();

    try {
        await exec(
            db,
            `
            PRAGMA journal_mode=WAL;
            PRAGMA busy_timeout=5000;

            CREATE TABLE IF NOT EXISTS user_notification_settings (
                user_id                    INTEGER PRIMARY KEY,
                reply_to_own_post_email    INTEGER NOT NULL DEFAULT 0,
                created_ts                 TEXT NOT NULL,
                updated_ts                 TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS user_area_subscriptions (
                user_id                    INTEGER NOT NULL,
                area_tag                   TEXT NOT NULL,
                new_post_email             INTEGER NOT NULL DEFAULT 1,
                reply_to_own_post_email    INTEGER NOT NULL DEFAULT 0,
                created_ts                 TEXT NOT NULL,
                updated_ts                 TEXT NOT NULL,
                PRIMARY KEY (user_id, area_tag)
            );

            CREATE TABLE IF NOT EXISTS email_notification_queue (
                id                         INTEGER PRIMARY KEY AUTOINCREMENT,
                message_id                 INTEGER NOT NULL,
                area_tag                   TEXT NOT NULL,
                event_type                 TEXT NOT NULL,
                recipient_user_id          INTEGER NOT NULL,
                recipient_email            TEXT NOT NULL,
                subject                    TEXT NOT NULL,
                body                       TEXT NOT NULL,
                status                     TEXT NOT NULL,
                attempts                   INTEGER NOT NULL DEFAULT 0,
                not_before_ts              TEXT NOT NULL,
                lease_until_ts             TEXT,
                last_error                 TEXT,
                dedupe_key                 TEXT NOT NULL,
                created_ts                 TEXT NOT NULL,
                updated_ts                 TEXT NOT NULL,
                sent_ts                    TEXT
            );

            CREATE TABLE IF NOT EXISTS email_notification_state (
                state_key                  TEXT PRIMARY KEY,
                state_value                TEXT NOT NULL,
                updated_ts                 TEXT NOT NULL
            );

            CREATE UNIQUE INDEX IF NOT EXISTS idx_email_queue_dedupe
                ON email_notification_queue (dedupe_key);

            CREATE INDEX IF NOT EXISTS idx_email_queue_status_not_before
                ON email_notification_queue (status, not_before_ts);

            CREATE INDEX IF NOT EXISTS idx_email_queue_lease_until
                ON email_notification_queue (lease_until_ts);

            CREATE INDEX IF NOT EXISTS idx_email_queue_recipient
                ON email_notification_queue (recipient_user_id);

            CREATE INDEX IF NOT EXISTS idx_email_queue_message
                ON email_notification_queue (message_id);

            CREATE INDEX IF NOT EXISTS idx_user_area_subscriptions_area
                ON user_area_subscriptions (area_tag);
            `
        );

        await ensureUserAreaSubscriptionColumns(db);

        await run(
            db,
            `
            INSERT OR IGNORE INTO email_notification_state
                (state_key, state_value, updated_ts)
            VALUES
                ('last_sent_ts', '', ?)
            `,
            [nowIso()]
        );

        await migrateLegacyReplySettings(db);
    } finally {
        await close(db);
    }
}

async function getUserNotificationSettings(userId) {
    const db = openDb();

    try {
        const row = await get(
            db,
            `
            SELECT
                user_id,
                reply_to_own_post_email,
                created_ts,
                updated_ts
            FROM user_notification_settings
            WHERE user_id = ?
            `,
            [userId]
        );

        if (row) {
            row.reply_to_own_post_email = !!row.reply_to_own_post_email;
            return row;
        }

        return {
            user_id: userId,
            reply_to_own_post_email: false,
            created_ts: null,
            updated_ts: null,
        };
    } finally {
        await close(db);
    }
}

async function setReplyNotification(userId, enabled) {
    const db = openDb();
    const ts = nowIso();

    try {
        await run(
            db,
            `
            INSERT INTO user_notification_settings
                (user_id, reply_to_own_post_email, created_ts, updated_ts)
            VALUES
                (?, ?, ?, ?)
            ON CONFLICT(user_id)
            DO UPDATE SET
                reply_to_own_post_email = excluded.reply_to_own_post_email,
                updated_ts = excluded.updated_ts
            `,
            [userId, enabled ? 1 : 0, ts, ts]
        );
    } finally {
        await close(db);
    }
}

async function getUserAreaNotificationSettings(userId, areaTag) {
    const db = openDb();
    const normalizedAreaTag = normalizeAreaTag(areaTag);

    try {
        const row = await get(
            db,
            `
            SELECT
                user_id,
                area_tag,
                new_post_email,
                reply_to_own_post_email,
                created_ts,
                updated_ts
            FROM user_area_subscriptions
            WHERE user_id = ?
              AND area_tag = ?
            `,
            [userId, normalizedAreaTag]
        );

        if (row) {
            row.new_post_email = !!row.new_post_email;
            row.reply_to_own_post_email = !!row.reply_to_own_post_email;
            row.exists = true;
            return row;
        }

        return {
            user_id: userId,
            area_tag: normalizedAreaTag,
            new_post_email: false,
            reply_to_own_post_email: false,
            created_ts: null,
            updated_ts: null,
            exists: false,
        };
    } finally {
        await close(db);
    }
}

async function setUserAreaNotificationSettings(userId, areaTag, settings = {}) {
    const db = openDb();
    const ts = nowIso();
    const normalizedAreaTag = normalizeAreaTag(areaTag);
    const newPostEmail = toBoolInt(settings.new_post_email, 0);
    const replyToOwnPostEmail = toBoolInt(settings.reply_to_own_post_email, 0);

    try {
        if (!normalizedAreaTag) {
            throw new Error('Invalid areaTag for notification settings');
        }

        if (0 === newPostEmail && 0 === replyToOwnPostEmail) {
            await run(
                db,
                `
                DELETE FROM user_area_subscriptions
                WHERE user_id = ?
                  AND area_tag = ?
                `,
                [userId, normalizedAreaTag]
            );

            return {
                inserted: false,
                removed: true,
            };
        }

        await run(
            db,
            `
            INSERT INTO user_area_subscriptions
                (
                    user_id,
                    area_tag,
                    new_post_email,
                    reply_to_own_post_email,
                    created_ts,
                    updated_ts
                )
            VALUES
                (?, ?, ?, ?, ?, ?)
            ON CONFLICT(user_id, area_tag)
            DO UPDATE SET
                new_post_email = excluded.new_post_email,
                reply_to_own_post_email = excluded.reply_to_own_post_email,
                updated_ts = excluded.updated_ts
            `,
            [userId, normalizedAreaTag, newPostEmail, replyToOwnPostEmail, ts, ts]
        );

        return {
            inserted: true,
            removed: false,
        };
    } finally {
        await close(db);
    }
}

async function subscribeUserToArea(userId, areaTag) {
    const existing = await getUserAreaNotificationSettings(userId, areaTag);
    return setUserAreaNotificationSettings(userId, areaTag, {
        new_post_email: true,
        reply_to_own_post_email: existing.reply_to_own_post_email,
    });
}

async function unsubscribeUserFromArea(userId, areaTag) {
    const existing = await getUserAreaNotificationSettings(userId, areaTag);
    return setUserAreaNotificationSettings(userId, areaTag, {
        new_post_email: false,
        reply_to_own_post_email: existing.reply_to_own_post_email,
    });
}

async function getUserSubscriptions(userId) {
    const db = openDb();

    try {
        const rows = await all(
            db,
            `
            SELECT area_tag, new_post_email, reply_to_own_post_email, created_ts, updated_ts
            FROM user_area_subscriptions
            WHERE user_id = ?
            ORDER BY area_tag ASC
            `,
            [userId]
        );

        return rows.map(row => Object.assign({}, row, {
            new_post_email: !!row.new_post_email,
            reply_to_own_post_email: !!row.reply_to_own_post_email,
        }));
    } finally {
        await close(db);
    }
}

async function getAreaSubscriptions(areaTag, eventType = 'new_topic') {
    const db = openDb();
    const normalizedAreaTag = normalizeAreaTag(areaTag);
    const flagColumn = getAreaFlagColumnForEvent(eventType);

    try {
        const rows = await all(
            db,
            `
            SELECT
                user_id,
                area_tag,
                new_post_email,
                reply_to_own_post_email,
                created_ts,
                updated_ts
            FROM user_area_subscriptions
            WHERE area_tag = ?
              AND ${flagColumn} = 1
            ORDER BY user_id ASC
            `,
            [normalizedAreaTag]
        );

        return rows.map(row => Object.assign({}, row, {
            new_post_email: !!row.new_post_email,
            reply_to_own_post_email: !!row.reply_to_own_post_email,
        }));
    } finally {
        await close(db);
    }
}

async function isReplyNotificationEnabled(userId, areaTag) {
    if (areaTag) {
        const areaSettings = await getUserAreaNotificationSettings(userId, areaTag);
        if (areaSettings.exists) {
            return !!areaSettings.reply_to_own_post_email;
        }
    }

    const settings = await getUserNotificationSettings(userId);
    return !!settings.reply_to_own_post_email;
}

async function getStateValue(stateKey) {
    const db = openDb();

    try {
        const row = await get(
            db,
            `
            SELECT state_value, updated_ts
            FROM email_notification_state
            WHERE state_key = ?
            `,
            [stateKey]
        );

        return row || null;
    } finally {
        await close(db);
    }
}

async function setStateValue(stateKey, stateValue) {
    const db = openDb();
    const ts = nowIso();

    try {
        await run(
            db,
            `
            INSERT INTO email_notification_state
                (state_key, state_value, updated_ts)
            VALUES
                (?, ?, ?)
            ON CONFLICT(state_key)
            DO UPDATE SET
                state_value = excluded.state_value,
                updated_ts = excluded.updated_ts
            `,
            [stateKey, stateValue, ts]
        );
    } finally {
        await close(db);
    }
}

async function isUserSubscribedToArea(userId, areaTag) {
    const settings = await getUserAreaNotificationSettings(userId, areaTag);
    return !!settings.new_post_email;
}

async function enqueueNotification(job) {
    const db = openDb();
    const ts = nowIso();

    try {
        const result = await run(
            db,
            `
            INSERT OR IGNORE INTO email_notification_queue (
                message_id,
                area_tag,
                event_type,
                recipient_user_id,
                recipient_email,
                subject,
                body,
                status,
                attempts,
                not_before_ts,
                lease_until_ts,
                last_error,
                dedupe_key,
                created_ts,
                updated_ts,
                sent_ts
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `,
            [
                job.message_id,
                job.area_tag,
                job.event_type,
                job.recipient_user_id,
                job.recipient_email,
                job.subject,
                job.body,
                job.status || 'pending',
                job.attempts || 0,
                job.not_before_ts || ts,
                job.lease_until_ts || null,
                job.last_error || null,
                job.dedupe_key,
                job.created_ts || ts,
                job.updated_ts || ts,
                job.sent_ts || null,
            ]
        );

        return {
            inserted: result.changes > 0,
            lastID: result.lastID || null,
        };
    } finally {
        await close(db);
    }
}

async function getQueueCountByStatus(status) {
    const db = openDb();

    try {
        const row = await get(
            db,
            `
            SELECT COUNT(*) AS count
            FROM email_notification_queue
            WHERE status = ?
            `,
            [status]
        );

        return row ? row.count : 0;
    } finally {
        await close(db);
    }
}

async function getQueueJob(jobId) {
    const db = openDb();

    try {
        return await get(
            db,
            `
            SELECT *
            FROM email_notification_queue
            WHERE id = ?
            `,
            [jobId]
        );
    } finally {
        await close(db);
    }
}

async function reclaimExpiredLeases(nowTs = nowIso()) {
    const db = openDb();

    try {
        const result = await run(
            db,
            `
            UPDATE email_notification_queue
            SET status = 'retry',
                lease_until_ts = NULL,
                updated_ts = ?
            WHERE status = 'leased'
              AND lease_until_ts IS NOT NULL
              AND lease_until_ts <= ?
            `,
            [nowTs, nowTs]
        );

        return result.changes || 0;
    } finally {
        await close(db);
    }
}

async function leaseNextPendingNotification(options = {}) {
    const db = openDb();
    const nowTs = options.nowTs || nowIso();
    const leaseMs = parseInt(options.leaseMs, 10) || 60000;
    const leaseUntilTs = isoAfterMs(nowTs, leaseMs);
    let inTransaction = false;

    try {
        await exec(db, 'BEGIN IMMEDIATE TRANSACTION;');
        inTransaction = true;

        const candidate = await get(
            db,
            `
            SELECT *
            FROM email_notification_queue
            WHERE status IN ('pending', 'retry')
              AND not_before_ts <= ?
              AND (lease_until_ts IS NULL OR lease_until_ts <= ?)
            ORDER BY id ASC
            LIMIT 1
            `,
            [nowTs, nowTs]
        );

        if (!candidate) {
            await exec(db, 'COMMIT;');
            inTransaction = false;
            return null;
        }

        const result = await run(
            db,
            `
            UPDATE email_notification_queue
            SET status = 'leased',
                attempts = attempts + 1,
                lease_until_ts = ?,
                updated_ts = ?
            WHERE id = ?
              AND status IN ('pending', 'retry')
              AND (lease_until_ts IS NULL OR lease_until_ts <= ?)
            `,
            [leaseUntilTs, nowTs, candidate.id, nowTs]
        );

        if (result.changes < 1) {
            await exec(db, 'ROLLBACK;');
            inTransaction = false;
            return null;
        }

        const leasedJob = await get(
            db,
            `
            SELECT *
            FROM email_notification_queue
            WHERE id = ?
            `,
            [candidate.id]
        );

        await exec(db, 'COMMIT;');
        inTransaction = false;
        return leasedJob;
    } catch (err) {
        if (inTransaction) {
            try {
                await exec(db, 'ROLLBACK;');
            } catch (rollbackErr) {
                // ignore rollback errors; original error is more useful
            }
        }
        throw err;
    } finally {
        await close(db);
    }
}

async function markNotificationSent(jobId, sentTs = nowIso()) {
    const db = openDb();

    try {
        const result = await run(
            db,
            `
            UPDATE email_notification_queue
            SET status = 'sent',
                lease_until_ts = NULL,
                last_error = NULL,
                updated_ts = ?,
                sent_ts = ?
            WHERE id = ?
              AND status = 'leased'
            `,
            [sentTs, sentTs, jobId]
        );

        return result.changes > 0;
    } finally {
        await close(db);
    }
}

async function markNotificationForRetry(jobId, lastError, notBeforeTs, updatedTs = nowIso()) {
    const db = openDb();

    try {
        const result = await run(
            db,
            `
            UPDATE email_notification_queue
            SET status = 'retry',
                lease_until_ts = NULL,
                last_error = ?,
                not_before_ts = ?,
                updated_ts = ?
            WHERE id = ?
              AND status = 'leased'
            `,
            [lastError || null, notBeforeTs, updatedTs, jobId]
        );

        return result.changes > 0;
    } finally {
        await close(db);
    }
}

async function markNotificationFailed(jobId, lastError, updatedTs = nowIso()) {
    const db = openDb();

    try {
        const result = await run(
            db,
            `
            UPDATE email_notification_queue
            SET status = 'failed',
                lease_until_ts = NULL,
                last_error = ?,
                updated_ts = ?
            WHERE id = ?
              AND status = 'leased'
            `,
            [lastError || null, updatedTs, jobId]
        );

        return result.changes > 0;
    } finally {
        await close(db);
    }
}

async function acquireStateLease(stateKey, options = {}) {
    const db = openDb();
    const nowTs = options.nowTs || nowIso();
    const leaseMs = parseInt(options.leaseMs, 10) || 3600000;
    const leaseUntilTs = options.leaseUntilTs || isoAfterMs(nowTs, leaseMs);
    const owner = options.owner || `lease-${Date.now()}`;
    const meta = options.meta || null;
    let inTransaction = false;

    try {
        await exec(db, 'BEGIN IMMEDIATE TRANSACTION;');
        inTransaction = true;

        const existing = await get(
            db,
            `
            SELECT state_value, updated_ts
            FROM email_notification_state
            WHERE state_key = ?
            `,
            [stateKey]
        );

        const currentLease = normalizeLeaseRecord(existing);
        if (currentLease && currentLease.expires_ts && currentLease.expires_ts > nowTs) {
            await exec(db, 'ROLLBACK;');
            inTransaction = false;
            return {
                acquired: false,
                currentLease,
            };
        }

        const leaseState = JSON.stringify({
            owner,
            expires_ts: leaseUntilTs,
            meta,
        });

        await run(
            db,
            `
            INSERT INTO email_notification_state
                (state_key, state_value, updated_ts)
            VALUES
                (?, ?, ?)
            ON CONFLICT(state_key)
            DO UPDATE SET
                state_value = excluded.state_value,
                updated_ts = excluded.updated_ts
            `,
            [stateKey, leaseState, nowTs]
        );

        await exec(db, 'COMMIT;');
        inTransaction = false;

        return {
            acquired: true,
            owner,
            leaseUntilTs,
        };
    } catch (err) {
        if (inTransaction) {
            try {
                await exec(db, 'ROLLBACK;');
            } catch (rollbackErr) {
                // ignore rollback errors; original error is more useful
            }
        }
        throw err;
    } finally {
        await close(db);
    }
}

async function releaseStateLease(stateKey, owner, nowTs = nowIso()) {
    const db = openDb();
    let inTransaction = false;

    try {
        await exec(db, 'BEGIN IMMEDIATE TRANSACTION;');
        inTransaction = true;

        const existing = await get(
            db,
            `
            SELECT state_value, updated_ts
            FROM email_notification_state
            WHERE state_key = ?
            `,
            [stateKey]
        );

        const currentLease = normalizeLeaseRecord(existing);
        if (!currentLease || currentLease.owner !== owner) {
            await exec(db, 'ROLLBACK;');
            inTransaction = false;
            return false;
        }

        await run(
            db,
            `
            UPDATE email_notification_state
            SET state_value = '',
                updated_ts = ?
            WHERE state_key = ?
            `,
            [nowTs, stateKey]
        );

        await exec(db, 'COMMIT;');
        inTransaction = false;
        return true;
    } catch (err) {
        if (inTransaction) {
            try {
                await exec(db, 'ROLLBACK;');
            } catch (rollbackErr) {
                // ignore rollback errors; original error is more useful
            }
        }
        throw err;
    } finally {
        await close(db);
    }
}

module.exports = {
    DB_PATH,
    ensureSchema,
    getUserNotificationSettings,
    setReplyNotification,
    subscribeUserToArea,
    unsubscribeUserFromArea,
    getUserAreaNotificationSettings,
    setUserAreaNotificationSettings,
    getUserSubscriptions,
    isUserSubscribedToArea,
    enqueueNotification,
    getQueueCountByStatus,
    getQueueJob,
    getAreaSubscriptions,
    isReplyNotificationEnabled,
    getStateValue,
    setStateValue,
    reclaimExpiredLeases,
    leaseNextPendingNotification,
    markNotificationSent,
    markNotificationForRetry,
    markNotificationFailed,
    acquireStateLease,
    releaseStateLease,
};
