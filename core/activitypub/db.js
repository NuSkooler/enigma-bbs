const apDb = require('../database').dbs.activitypub;

exports.persistToOutbox = persistToOutbox;
exports.getOutboxEntries = getOutboxEntries;
exports.persistFollower = persistFollower;
exports.getFollowerEntries = getFollowerEntries;

const FollowerEntryStatus = {
    Invalid: 0, //  Invalid
    Requested: 1, //  Entry is a *request* to local user
    Accepted: 2, //  Accepted by local user
    Rejected: 3, //  Rejected by local user
};
exports.FollowerEntryStatus = FollowerEntryStatus;

function persistToOutbox(activity, fromUser, message, cb) {
    const activityJson = JSON.stringify(activity);

    apDb.run(
        `INSERT INTO outbox (activity_id, user_id, message_id, activity_json, published_timestamp)
        VALUES (?, ?, ?, ?, ?);`,
        [
            activity.id,
            fromUser.userId,
            message.messageId,
            activityJson,
            activity.object.published,
        ],
        function res(err) {
            // non-arrow for 'this' scope
            return cb(err, this.lastID);
        }
    );
}

function getOutboxEntries(owningUser, options, cb) {
    apDb.all(
        `SELECT id, activity_id, message_id, activity_json, published_timestamp
        FROM outbox
        WHERE user_id = ? AND json_extract(activity_json, '$.type') = "Create";`,
        [owningUser.userId],
        (err, rows) => {
            if (err) {
                return cb(err);
            }

            const entries = rows.map(r => {
                let parsed;
                try {
                    parsed = JSON.parse(r.activity_json);
                } catch (e) {
                    return cb(e);
                }

                return {
                    id: r.id,
                    activityId: r.activity_id,
                    messageId: r.message_id,
                    activity: parsed,
                    published: r.published_timestamp,
                };
            });

            return cb(null, entries);
        }
    );
}

function persistFollower(localUser, remoteActor, options, cb) {
    const status = options.status || FollowerEntryStatus.Requested;

    apDb.run(
        `INSERT OR IGNORE INTO followers (user_id, follower_id, status)
        VALUES (?, ?, ?);`,
        [localUser.userId, remoteActor.id, status],
        function res(err) {
            // non-arrow for 'this' scope
            return cb(err, this.lastID);
        }
    );
}

function getFollowerEntries(localUser, options, cb) {
    const status = options.status || FollowerEntryStatus.Accepted;

    apDb.all(
        `SELECT follower_id
        FROM followers
        WHERE user_id = ? AND status = ?;`,
        [localUser.userId, status],
        (err, rows) => {
            if (err) {
                return cb(err);
            }

            const entries = rows.map(r => r.follower_id);
            return cb(null, entries);
        }
    );
}
