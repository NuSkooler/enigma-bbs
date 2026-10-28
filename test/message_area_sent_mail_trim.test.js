'use strict';

//
//  Exported external private mail -- a caller's FTN or email "outbox" -- is
//  trimmed once it is older than the private area's |maxExternalSentAgeDays|.
//  The setting used to be read off the Config accessor function rather than
//  the config it returns, so it was always 30 whatever the sysop set.
//

const { strict: assert } = require('assert');
const Database = require('better-sqlite3');
const moment = require('moment');

const configModule = require('../core/config.js');
const {
    WellKnownConfTags,
    WellKnownAreaTags,
    SystemMetaNames,
    StateFlags0,
    AddressFlavor,
} = require('../core/message_const.js');

//  only what the trim touches; see core/database.js for the real thing
function applySchema(db) {
    db.exec(`
        CREATE TABLE message (
            message_id              INTEGER PRIMARY KEY,
            area_tag                VARCHAR NOT NULL,
            message_uuid            VARCHAR(36) NOT NULL,
            reply_to_message_id     INTEGER,
            to_user_name            VARCHAR NOT NULL,
            from_user_name          VARCHAR NOT NULL,
            subject,
            message,
            modified_timestamp      DATETIME NOT NULL,
            view_count              INTEGER NOT NULL DEFAULT 0,
            UNIQUE(message_uuid)
        );

        CREATE TABLE message_meta (
            message_id      INTEGER NOT NULL,
            meta_category   INTEGER NOT NULL,
            meta_name       VARCHAR NOT NULL,
            meta_value      VARCHAR NOT NULL,
            UNIQUE(message_id, meta_category, meta_name, meta_value),
            FOREIGN KEY(message_id) REFERENCES message(message_id) ON DELETE CASCADE
        );
    `);
}

const configWith = privateArea => ({
    debug: { assertsEnabled: false },
    messageAreaDefaults: { maxMessages: 0, maxAgeDays: 0 },
    messageConferences: {
        [WellKnownConfTags.SystemInternal]: {
            name: 'System Internal',
            areas: {
                [WellKnownAreaTags.Private]: Object.assign(
                    { name: 'Private Mail' },
                    privateArea
                ),
            },
        },
    },
});

//  message.js and message_area.js capture the message base at load
const FreshModules = ['../core/message.js', '../core/message_area.js'].map(m =>
    require.resolve(m)
);

describe('trimming exported external private mail', () => {
    let testDb;
    let prevMessageDb;
    let prevConfig;
    let savedModules;
    let MessageArea;

    before(() => {
        prevConfig = configModule._pushTestConfig(configWith({}));

        const dbModule = require('../core/database.js');
        prevMessageDb = dbModule.dbs.message;
        testDb = new Database(':memory:');
        testDb.pragma('foreign_keys = ON');
        applySchema(testDb);
        dbModule.dbs.message = testDb;

        savedModules = FreshModules.map(path => [path, require.cache[path]]);
        FreshModules.forEach(path => delete require.cache[path]);
        MessageArea = require('../core/message_area.js');
    });

    after(() => {
        savedModules.forEach(([path, cached]) => {
            if (cached) {
                require.cache[path] = cached;
            } else {
                delete require.cache[path];
            }
        });
        require('../core/database.js').dbs.message = prevMessageDb;
        testDb.close();
        configModule._popTestConfig(prevConfig);
    });

    //  id 1: exported, 10 days old; id 2: exported, 40 days old;
    //  id 3: 40 days old but never exported, so never trimmed here
    beforeEach(() => {
        testDb.exec('DELETE FROM message_meta; DELETE FROM message;');

        const addMessage = (messageId, ageDays, exported) => {
            testDb
                .prepare(
                    `INSERT INTO message (message_id, area_tag, message_uuid,
                        to_user_name, from_user_name, subject, message, modified_timestamp)
                    VALUES (?, ?, ?, 'Remote', 'Caller', 'Subject', 'Body', ?);`
                )
                .run(
                    messageId,
                    WellKnownAreaTags.Private,
                    `uuid-${messageId}`,
                    moment().subtract(ageDays, 'days').format('YYYY-MM-DDTHH:mm:ss.SSSZ')
                );

            const addMeta = (name, value) =>
                testDb
                    .prepare(
                        `INSERT INTO message_meta (message_id, meta_category, meta_name, meta_value)
                        VALUES (?, 'System', ?, ?);`
                    )
                    .run(messageId, name, value);

            addMeta(SystemMetaNames.ExternalFlavor, AddressFlavor.FTN);
            addMeta(
                SystemMetaNames.StateFlags0,
                exported ? StateFlags0.Exported : StateFlags0.None
            );
        };

        addMessage(1, 10, true);
        addMessage(2, 40, true);
        addMessage(3, 40, false);
    });

    const trimWith = (privateArea, cb) => {
        const previous = configModule._pushTestConfig(configWith(privateArea));
        MessageArea.trimMessageAreasScheduledEvent([], err => {
            configModule._popTestConfig(previous);
            if (err) {
                return cb(err);
            }
            return cb(
                null,
                testDb
                    .prepare('SELECT message_id FROM message ORDER BY message_id')
                    .all()
                    .map(row => row.message_id)
            );
        });
    };

    it('honours a configured age', done => {
        trimWith({ maxExternalSentAgeDays: 5 }, (err, remaining) => {
            assert.ifError(err);
            assert.deepEqual(remaining, [3]);
            done();
        });
    });

    it('defaults to 30 days when nothing is configured', done => {
        trimWith({}, (err, remaining) => {
            assert.ifError(err);
            assert.deepEqual(remaining, [1, 3]);
            done();
        });
    });

    it('keeps sent mail when the age is 0', done => {
        trimWith({ maxExternalSentAgeDays: 0 }, (err, remaining) => {
            assert.ifError(err);
            assert.deepEqual(remaining, [1, 2, 3]);
            done();
        });
    });

    it('falls back to 30 days for a value that is not a whole number of days', done => {
        trimWith(
            { maxExternalSentAgeDays: '5 days; DROP TABLE message' },
            (err, remaining) => {
                assert.ifError(err);
                assert.deepEqual(remaining, [1, 3]);
                done();
            }
        );
    });
});
