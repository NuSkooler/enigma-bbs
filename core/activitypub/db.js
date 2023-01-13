const apDb = require('../database').dbs.activitypub;

exports.persistToOutbox = persistToOutbox;
exports.getOutboxEntries = getOutboxEntries;

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
