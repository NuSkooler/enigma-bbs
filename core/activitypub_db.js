const apDb = require('./database').dbs.activitypub;

exports.persistToOutbox = persistToOutbox;

function persistToOutbox(activity, userId, messageId, cb) {
    const activityJson = JSON.stringify(activity);

    apDb.run(
        `INSERT INTO activitypub_outbox (activity_id, user_id, message_id, activity_json)
        VALUES (?, ?, ?, ?);`,
        [activity.id, userId, messageId, activityJson],
        function res(err) {
            // non-arrow for 'this' scope
            return cb(err, this.lastID);
        }
    );
}
