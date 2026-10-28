'use strict';

//
//  Offline mail packets and online reading share one area selection and one
//  set of scan pointers -- the caller's lastread -- issue #928. QWK and Blue
//  Wave each used to keep their own list with a "newer than" timestamp per
//  area, so switching formats re-sent what the other had already delivered.
//
//  What is checked here, against a real message base:
//
//    * the one-time migration from the two per-format lists;
//    * that an export packs from lastread, late arrivals included, and moves
//      lastread only once the packet is downloaded;
//    * that an area a Blue Wave reader turns on starts from now only if the
//      caller has never read it.
//

const { strict: assert } = require('assert');
const { EventEmitter } = require('events');
const Database = require('better-sqlite3');
const moment = require('moment');

const configModule = require('../core/config.js');
const Events = require('../core/events.js');
const { clientConnections } = require('../core/client_connections.js');
const { WellKnownConfTags } = require('../core/message_const.js');

//  only what these paths touch; see core/database.js for the real thing
function applySchema(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS message (
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

        CREATE TABLE IF NOT EXISTS message_meta (
            message_id      INTEGER NOT NULL,
            meta_category   INTEGER NOT NULL,
            meta_name       VARCHAR NOT NULL,
            meta_value      VARCHAR NOT NULL,
            UNIQUE(message_id, meta_category, meta_name, meta_value),
            FOREIGN KEY(message_id) REFERENCES message(message_id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS user_message_area_last_read (
            user_id     INTEGER NOT NULL,
            area_tag    VARCHAR NOT NULL,
            message_id  INTEGER NOT NULL,
            UNIQUE(user_id, area_tag)
        );
    `);
}

const TestConfig = {
    debug: { assertsEnabled: false },
    menus: { cls: false },
    general: { boardName: 'Test Board' },
    messageNetworks: {},
    messageConferences: {
        [WellKnownConfTags.SystemInternal]: {
            name: 'System Internal',
            areas: { private_mail: { name: 'Private Mail' } },
        },
        local: {
            name: 'Local',
            areas: {
                general: { name: 'General Chat' },
                fido_tech: { name: 'FidoNet Tech' },
                fido_quiet: { name: 'FidoNet Quiet' },
                secret: { name: 'Sysops Only', secret: true },
            },
        },
    },
};

//
//  Every module that captures the message base, or something that does, at
//  load. They are loaded afresh against the test database and the cached
//  copies put back afterwards, so no other suite sees either.
//
const FreshModules = [
    '../core/message.js',
    '../core/message_area.js',
    '../core/offline_mail_areas.js',
    '../core/message_base_offline_export.js',
    '../core/message_base_qwk_export.js',
    '../core/message_base_bluewave_export.js',
    '../core/message_base_offline_import.js',
    '../core/set_newscan_date.js',
].map(m => require.resolve(m));

const UserId = 1;
const OtherUserId = 2;
const Private = 'private_mail';

const ts = date => moment(date).format('YYYY-MM-DDTHH:mm:ss.SSSZ');

describe('offline mail scan pointers (#928)', function () {
    let testDb;
    let prevMessageDb;
    let prevConfig;
    let savedModules;

    let getUserExportAreas;
    let QWKExport;
    let BlueWaveExport;
    let ImportModule;
    let MessageArea;
    let User;
    let realLoadProperties;
    let userDb = {};
    let SetNewScanDate;

    before(() => {
        prevConfig = configModule._pushTestConfig(TestConfig);

        const dbModule = require('../core/database.js');
        prevMessageDb = dbModule.dbs.message;
        testDb = new Database(':memory:');
        testDb.pragma('foreign_keys = ON');
        applySchema(testDb);
        dbModule.dbs.message = testDb;

        savedModules = FreshModules.map(path => [path, require.cache[path]]);
        FreshModules.forEach(path => delete require.cache[path]);

        ({ getUserExportAreas } = require('../core/offline_mail_areas.js'));
        QWKExport = require('../core/message_base_qwk_export.js').getModule;
        BlueWaveExport = require('../core/message_base_bluewave_export.js').getModule;
        ImportModule = require('../core/message_base_offline_import.js');
        MessageArea = require('../core/message_area.js');
        SetNewScanDate = require('../core/set_newscan_date.js').getModule;

        //  the user database, as far as a fresh read of a property goes: what
        //  any session of the caller has stored
        User = require('../core/user.js');
        realLoadProperties = User.loadProperties;
        User.loadProperties = (userId, options, cb) =>
            cb(null, Object.assign({}, userDb));
    });

    after(() => {
        User.loadProperties = realLoadProperties;
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

    beforeEach(() => {
        userDb = {};
        testDb.exec('DELETE FROM message_meta;');
        testDb.exec('DELETE FROM message;');
        testDb.exec('DELETE FROM user_message_area_last_read;');
    });

    //  an explicit ID, since IDs out of date order are the point
    function addMessage(messageId, areaTag, date, { toUserId } = {}) {
        testDb
            .prepare(
                `INSERT INTO message (message_id, area_tag, message_uuid, to_user_name,
                    from_user_name, subject, message, modified_timestamp)
                VALUES (?, ?, ?, 'All', 'Someone', ?, 'body', ?);`
            )
            .run(
                messageId,
                areaTag,
                `uuid-${messageId}`,
                `Message ${messageId}`,
                ts(date)
            );

        if (toUserId) {
            testDb
                .prepare(
                    `INSERT INTO message_meta VALUES (?, 'System', 'local_to_user_id', ?);`
                )
                .run(messageId, String(toUserId));
        }
    }

    function setLastRead(areaTag, messageId, userId = UserId) {
        testDb
            .prepare('REPLACE INTO user_message_area_last_read VALUES (?, ?, ?);')
            .run(userId, areaTag, messageId);
    }

    function lastRead(areaTag, userId = UserId) {
        const row = testDb
            .prepare(
                'SELECT message_id FROM user_message_area_last_read ' +
                    'WHERE user_id = ? AND area_tag = ?;'
            )
            .get(userId, areaTag);
        return row ? row.message_id : 0;
    }

    function makeClient(properties = {}) {
        const persisted = [];
        const log = {};
        ['trace', 'debug', 'info', 'warn', 'error', 'fatal'].forEach(
            level => (log[level] = () => {})
        );

        return {
            persisted,
            properties,
            log,
            session: { uniqueId: 'session-1' },
            acs: {
                hasMessageConfRead: () => true,
                hasMessageAreaRead: area => !area.secret,
            },
            stopIdleMonitor: () => {},
            startIdleMonitor: () => {},
            on: () => {},
            removeListener: () => {},
            user: {
                userId: UserId,
                username: 'anne',
                getProperty: name => properties[name],
                persistProperty: (name, value, cb) => {
                    persisted.push({ name, value: JSON.parse(value) });
                    properties[name] = value;
                    userDb[name] = value;
                    return cb(null);
                },
            },
        };
    }

    const tagsOf = exportAreas => exportAreas.map(a => a.areaTag);

    describe('migrating the per-format lists', () => {
        const T1 = '2026-09-01T00:00:00Z';
        const T2 = '2026-09-10T00:00:00Z';
        const T3 = '2026-09-20T00:00:00Z';

        //
        //  Both formats, disagreeing: each is later for one area, and an area
        //  is in only one of them.
        //
        const bothLegacy = () => ({
            bluewave_export_msg_areas: JSON.stringify([
                { areaTag: 'general', newerThanTimestamp: T2 },
                { areaTag: 'fido_tech', newerThanTimestamp: T1 },
                { areaTag: Private, newerThanTimestamp: T1 },
            ]),
            qwk_export_msg_areas: JSON.stringify([
                { areaTag: 'general', newerThanTimestamp: T1 },
                { areaTag: 'fido_tech', newerThanTimestamp: T3 },
                { areaTag: 'fido_quiet', newerThanTimestamp: T2 },
                //  named, but there is nothing in it
                { areaTag: 'gone_now', newerThanTimestamp: T2 },
            ]),
        });

        beforeEach(() => {
            //  general: 13 arrived last but carries its author's older date
            addMessage(10, 'general', '2026-08-25');
            addMessage(11, 'general', '2026-09-05');
            addMessage(12, 'general', '2026-09-15');
            addMessage(13, 'general', '2026-09-03');

            addMessage(20, 'fido_tech', '2026-09-15');
            addMessage(21, 'fido_tech', '2026-09-25');

            //  nothing after its timestamp: the area is caught up
            addMessage(30, 'fido_quiet', '2026-09-01');
            addMessage(31, 'fido_quiet', '2026-09-05');

            addMessage(40, Private, '2026-08-20', { toUserId: UserId });
            addMessage(41, Private, '2026-09-02', { toUserId: UserId });
        });

        it('takes the later timestamp per area, as the lowest ID after it, less one', done => {
            setLastRead('general', 5); //  behind: raised
            setLastRead('fido_tech', 21); //  read further online: kept

            const client = makeClient(bothLegacy());
            getUserExportAreas(client, err => {
                assert.ifError(err);

                //  Blue Wave's T2 beats QWK's T1. 12 is the first after it, so
                //  13 -- dated before T2 but arrived after 12 -- is new again;
                //  the timestamps never sent it
                assert.equal(lastRead('general'), 11);
                //  QWK's T3 would give 20, but the pointer never moves back
                assert.equal(lastRead('fido_tech'), 21);
                //  only in QWK's list; nothing after T2, so caught up
                assert.equal(lastRead('fido_quiet'), 31);
                assert.equal(lastRead(Private), 40);
                assert.equal(lastRead('gone_now'), 0);
                done();
            });
        });

        it('takes the selection from the Blue Wave list, and stores it', done => {
            const client = makeClient(bothLegacy());
            getUserExportAreas(client, (err, exportAreas) => {
                assert.ifError(err);
                assert.deepEqual(tagsOf(exportAreas), ['general', 'fido_tech', Private]);

                assert.equal(client.persisted.length, 1);
                assert.equal(client.persisted[0].name, 'offline_mail_msg_areas');
                assert.deepEqual(client.persisted[0].value, [
                    { areaTag: 'general' },
                    { areaTag: 'fido_tech' },
                    { areaTag: Private },
                ]);

                //  left for a downgrade
                assert.ok(client.properties.bluewave_export_msg_areas);
                assert.ok(client.properties.qwk_export_msg_areas);
                done();
            });
        });

        it('migrates once', done => {
            const client = makeClient(bothLegacy());
            getUserExportAreas(client, err => {
                assert.ifError(err);

                //  the caller sets their new scan date back afterwards
                setLastRead('general', 3);

                getUserExportAreas(client, (err, exportAreas) => {
                    assert.ifError(err);
                    assert.deepEqual(tagsOf(exportAreas), [
                        'general',
                        'fido_tech',
                        Private,
                    ]);
                    assert.equal(client.persisted.length, 1, 'stored once');
                    assert.equal(lastRead('general'), 3, 'not migrated again');
                    done();
                });
            });
        });

        //
        //  Two sessions of the same caller, each with the User it loaded at
        //  logon. The first migrates and then stores a reader's selection;
        //  the second, migrating late, must not store the legacy list over it.
        //
        it('does not store over a selection another session stored first', done => {
            const first = makeClient(bothLegacy());
            const second = makeClient(bothLegacy());

            getUserExportAreas(first, err => {
                assert.ifError(err);
                first.user.persistProperty(
                    'offline_mail_msg_areas',
                    JSON.stringify([{ areaTag: 'fido_tech' }]),
                    () => {
                        getUserExportAreas(second, (err, exportAreas) => {
                            assert.ifError(err);
                            assert.deepEqual(second.persisted, [], 'stored nothing');
                            assert.deepEqual(exportAreas, [{ areaTag: 'fido_tech' }]);
                            assert.deepEqual(JSON.parse(userDb.offline_mail_msg_areas), [
                                { areaTag: 'fido_tech' },
                            ]);
                            done();
                        });
                    }
                );
            });
        });

        it('takes a QWK list on its own', done => {
            const client = makeClient({
                qwk_export_msg_areas: bothLegacy().qwk_export_msg_areas,
            });
            getUserExportAreas(client, (err, exportAreas) => {
                assert.ifError(err);
                assert.deepEqual(tagsOf(exportAreas), [
                    'general',
                    'fido_tech',
                    'fido_quiet',
                    'gone_now',
                ]);
                assert.equal(client.persisted.length, 1);

                //  T1 alone: 11 is the first after it
                assert.equal(lastRead('general'), 10);
                assert.equal(lastRead('fido_tech'), 20);
                assert.equal(lastRead('fido_quiet'), 31);
                assert.equal(lastRead(Private), 0, 'not in the QWK list');
                done();
            });
        });

        it('gives a caller with neither list every area they can see, and stores nothing', done => {
            const client = makeClient();
            getUserExportAreas(client, (err, exportAreas) => {
                assert.ifError(err);
                assert.deepEqual(tagsOf(exportAreas), [
                    'general',
                    'fido_tech',
                    'fido_quiet',
                    Private,
                ]);
                assert.equal(client.persisted.length, 0);
                assert.equal(
                    testDb
                        .prepare('SELECT COUNT(*) AS n FROM user_message_area_last_read')
                        .get().n,
                    0
                );
                done();
            });
        });
    });

    describe('exporting', () => {
        //  a writer that records what it was given, by message ID
        class FakeWriter extends EventEmitter {
            constructor() {
                super();
                this.messageIds = [];
                this.cap = Infinity;
            }
            init() {
                process.nextTick(() => this.emit('ready'));
            }
            addArea() {}
            //  |cap| stands in for a format's per-area limit
            appendMessage(message) {
                if (this.messageIds.length >= this.cap) {
                    return false;
                }
                this.messageIds.push(message.messageId);
                return true;
            }
            finish() {
                process.nextTick(() => {
                    this.emit('packet', { path: '/tmp/TEST.PKT', stats: { size: 7 } });
                    this.emit('finished');
                });
            }
        }

        let nextFileId = 100;

        //  the real format, with a writer that keeps the packet in memory and a
        //  download queue that is only a file ID
        function makeExport(Format, client) {
            const Testable = class extends Format {
                createPacketWriter() {
                    return this.writer;
                }
            };

            const mod = Object.create(Testable.prototype);
            mod.config = { progBarChar: '▒' };
            mod.writer = new FakeWriter();
            mod.tempPacketDir = '/tmp/packet-work';
            mod.viewControllers = { main: { getView: () => null } };
            mod.updateCustomViewTextsWithFilter = () => {};
            mod.client = client;
            mod._deliverPacket = (packetInfo, dir, cb) => {
                mod.fileId = nextFileId++;
                return cb(null, { fileId: mod.fileId });
            };
            if (!clientConnections.includes(client)) {
                clientConnections.push(client);
            }
            return mod;
        }

        const runExport = (mod, cb) => mod._performExport('/tmp/downloads', cb);

        const download = (client, fileId) =>
            Events.emit(Events.getSystemEvents().UserDownload, {
                user: client.user,
                files: [{ fileId }],
            });

        //  as removeClient() does it: gone from the list, then the event
        const disconnect = client => {
            const i = clientConnections.indexOf(client);
            if (i > -1) {
                clientConnections.splice(i, 1);
            }
            Events.emit(Events.getSystemEvents().ClientDisconnected, { client });
        };

        //  the pointer update is callback-shaped; let it land
        const settle = cb => setImmediate(cb);

        const listeners = () => ({
            download: Events.listenerCount(Events.getSystemEvents().UserDownload),
            disconnect: Events.listenerCount(Events.getSystemEvents().ClientDisconnected),
        });

        let baseline;
        beforeEach(() => {
            baseline = listeners();
        });

        //  every test ends its session, so nothing waits past it
        afterEach(() => {
            clientConnections
                .filter(client => client.session && client.persisted)
                .forEach(disconnect);
            disconnect({ session: { uniqueId: 'session-1' } });
            assert.deepEqual(listeners(), baseline, 'no listener outlives the session');
        });

        const selection = areaTags =>
            JSON.stringify(areaTags.map(areaTag => ({ areaTag })));

        it('packs a late arrival, and moves lastread only once the packet is downloaded', done => {
            addMessage(10, 'general', '2026-09-01');
            addMessage(11, 'general', '2026-09-05');
            addMessage(12, 'general', '2026-09-15');
            //  arrived last, dated before everything already read
            addMessage(13, 'general', '2020-01-01');
            setLastRead('general', 11);

            const client = makeClient({ offline_mail_msg_areas: selection(['general']) });
            const mod = makeExport(QWKExport, client);

            runExport(mod, err => {
                assert.ifError(err);
                assert.deepEqual(mod.writer.messageIds, [12, 13]);
                assert.equal(lastRead('general'), 11, 'not moved by queueing');

                //  somebody else's download, and another file of this caller's
                Events.emit(Events.getSystemEvents().UserDownload, {
                    user: { userId: OtherUserId },
                    files: [{ fileId: mod.fileId }],
                });
                download(client, mod.fileId + 1000);

                settle(() => {
                    assert.equal(lastRead('general'), 11);

                    download(client, mod.fileId);
                    settle(() => {
                        assert.equal(lastRead('general'), 13);
                        assert.deepEqual(listeners(), baseline, 'stops listening');
                        done();
                    });
                });
            });
        });

        it('leaves lastread alone when the caller leaves without downloading', done => {
            addMessage(10, 'general', '2026-09-01');
            addMessage(11, 'general', '2026-09-05');

            const client = makeClient({ offline_mail_msg_areas: selection(['general']) });
            const mod = makeExport(QWKExport, client);

            runExport(mod, err => {
                assert.ifError(err);
                assert.deepEqual(mod.writer.messageIds, [10, 11]);
                assert.notDeepEqual(listeners(), baseline, 'waiting for the download');

                //  another caller's session ending changes nothing
                disconnect({ session: { uniqueId: 'session-2' } });
                assert.notDeepEqual(listeners(), baseline);

                disconnect(client);
                assert.deepEqual(listeners(), baseline);

                //  too late: the packet went with the session
                download(client, mod.fileId);
                settle(() => {
                    assert.equal(lastRead('general'), 0);
                    done();
                });
            });
        });

        it('leaves an area it could not read untouched', done => {
            addMessage(10, 'general', '2026-09-01');
            addMessage(20, 'secret', '2026-09-01');
            setLastRead('secret', 5);

            const client = makeClient({
                offline_mail_msg_areas: selection(['general', 'secret', 'gone_now']),
            });
            const mod = makeExport(QWKExport, client);

            runExport(mod, err => {
                assert.ifError(err);
                assert.deepEqual(mod.writer.messageIds, [10]);

                download(client, mod.fileId);
                settle(() => {
                    assert.equal(lastRead('general'), 10);
                    assert.equal(lastRead('secret'), 5);
                    assert.equal(lastRead('gone_now'), 0);
                    done();
                });
            });
        });

        //  the issue's own case: Blue Wave every day, then QWK once
        it('does not re-send in QWK what a downloaded Blue Wave packet carried', done => {
            addMessage(10, 'general', '2026-09-01');
            addMessage(11, 'fido_tech', '2026-09-02');
            addMessage(12, Private, '2026-09-03', { toUserId: UserId });
            //  somebody else's private mail is never theirs to pack
            addMessage(13, Private, '2026-09-03', { toUserId: OtherUserId });

            const client = makeClient({
                offline_mail_msg_areas: selection(['general', 'fido_tech', Private]),
            });

            const blueWave = makeExport(BlueWaveExport, client);
            runExport(blueWave, err => {
                assert.ifError(err);
                assert.deepEqual(blueWave.writer.messageIds, [10, 11, 12]);

                download(client, blueWave.fileId);
                settle(() => {
                    assert.equal(lastRead(Private), 12);

                    addMessage(14, 'general', '2026-09-04');

                    const qwk = makeExport(QWKExport, client);
                    runExport(qwk, err => {
                        assert.ifError(err);
                        assert.deepEqual(qwk.writer.messageIds, [14]);
                        done();
                    });
                });
            });
        });

        //
        //  A second packet built before the first is downloaded carries all
        //  the first did. Downloaded in either order, the pointer ends at the
        //  later one's.
        //
        it('never moves lastread backwards when two packets are downloaded out of order', done => {
            addMessage(10, 'general', '2026-09-01');

            const client = makeClient({ offline_mail_msg_areas: selection(['general']) });
            const first = makeExport(QWKExport, client);
            runExport(first, err => {
                assert.ifError(err);
                addMessage(11, 'general', '2026-09-02');

                const second = makeExport(BlueWaveExport, client);
                runExport(second, err => {
                    assert.ifError(err);
                    assert.deepEqual(second.writer.messageIds, [10, 11]);

                    download(client, second.fileId);
                    settle(() => {
                        download(client, first.fileId);
                        settle(() => {
                            assert.equal(lastRead('general'), 11);
                            done();
                        });
                    });
                });
            });
        });

        //
        //  A caller who hangs up while the packet is built has had their
        //  ClientDisconnected before it is queued: nothing may wait for it.
        //
        it('waits for nothing when the session ended during the export', done => {
            addMessage(10, 'general', '2026-09-01');

            const client = makeClient({ offline_mail_msg_areas: selection(['general']) });
            const mod = makeExport(QWKExport, client);
            runExport(mod, err => {
                assert.ifError(err);
                assert.deepEqual(mod.writer.messageIds, [10]);
                assert.deepEqual(listeners(), baseline);

                download(client, mod.fileId);
                settle(() => {
                    assert.equal(lastRead('general'), 0);
                    done();
                });
            });
            disconnect(client);
        });

        //
        //  A format that holds only so many messages per area (Blue Wave's
        //  65535) refuses the rest. Those were counted as packed, so the
        //  pointer jumped past messages the caller never got.
        //
        it('moves lastread only past what the writer took, and packs the rest next time', done => {
            addMessage(10, 'general', '2026-09-01');
            addMessage(11, 'general', '2026-09-02');
            addMessage(12, 'general', '2026-09-03');

            const client = makeClient({ offline_mail_msg_areas: selection(['general']) });
            const first = makeExport(BlueWaveExport, client);
            first.writer.cap = 2;

            runExport(first, err => {
                assert.ifError(err);
                assert.deepEqual(first.writer.messageIds, [10, 11]);

                download(client, first.fileId);
                settle(() => {
                    assert.equal(lastRead('general'), 11);

                    const second = makeExport(BlueWaveExport, client);
                    runExport(second, err => {
                        assert.ifError(err);
                        assert.deepEqual(second.writer.messageIds, [12]);
                        done();
                    });
                });
            });
        });

        //
        //  However many packets are waiting, in however many sessions, one
        //  listener of each kind serves them, and each session's packets are
        //  its own: one session's download or hang-up leaves the other's.
        //
        it('waits on one pair of listeners, keeping each session apart', done => {
            addMessage(10, 'general', '2026-09-01');
            addMessage(20, 'fido_tech', '2026-09-01');

            const first = makeClient({ offline_mail_msg_areas: selection(['general']) });
            //  the same caller on a second node
            const second = makeClient({
                offline_mail_msg_areas: selection(['fido_tech']),
            });
            second.session = { uniqueId: 'session-2' };

            const a = makeExport(QWKExport, first);
            const b = makeExport(BlueWaveExport, second);
            runExport(a, err => {
                assert.ifError(err);
                runExport(b, err => {
                    assert.ifError(err);
                    assert.deepEqual(b.writer.messageIds, [20]);
                    assert.deepEqual(listeners(), {
                        download: baseline.download + 1,
                        disconnect: baseline.disconnect + 1,
                    });

                    download(first, a.fileId);
                    settle(() => {
                        assert.equal(lastRead('general'), 10);
                        assert.equal(lastRead('fido_tech'), 0);
                        assert.notDeepEqual(listeners(), baseline, 'still waiting');

                        disconnect(second);
                        download(second, b.fileId);
                        settle(() => {
                            assert.equal(
                                lastRead('fido_tech'),
                                0,
                                'went with its session'
                            );
                            assert.deepEqual(listeners(), baseline);
                            done();
                        });
                    });
                });
            });
        });

        //  set_newscan_date's floor applies to packets as it does online
        it('starts no earlier than the caller new scan floor', done => {
            addMessage(10, 'general', '2026-08-01');
            addMessage(11, 'general', '2026-09-15');

            const client = makeClient({
                offline_mail_msg_areas: selection(['general']),
                newscan_min_timestamp: '2026-09-01T00:00:00.000Z',
            });
            const mod = makeExport(QWKExport, client);
            runExport(mod, err => {
                assert.ifError(err);
                assert.deepEqual(mod.writer.messageIds, [11]);
                done();
            });
        });
    });

    describe('an area a Blue Wave reader turns on', () => {
        //  the importer's own apply path, with the selection already stored
        const applyOlc = (client, echoTags, cb) => {
            const BlueWave = ImportModule.PacketFormats.find(f => 'Blue Wave' === f.name);
            const source = BlueWave.createSource(client, {
                packetDir: '/does-not-matter',
                limits: { maxMessages: 500, maxMessageLength: 64 * 1024 },
            });

            const context = Object.create(ImportModule.getModule.prototype);
            Object.assign(context, {
                client,
                summary: { imported: 0, rejected: 0, byArea: {}, areaChanges: null },
            });

            context._applyOfflineConfig(
                source,
                {
                    format: 'OLC',
                    areaChanges: true,
                    areas: echoTags.map(echoTag => ({ echoTag, scan: 'ALL' })),
                },
                err => cb(err, context)
            );
        };

        beforeEach(() => {
            addMessage(10, 'fido_tech', '2026-09-01');
            addMessage(11, 'fido_tech', '2026-09-02');
            addMessage(20, 'fido_quiet', '2026-09-01');
            addMessage(21, 'fido_quiet', '2026-09-02');
            addMessage(30, 'general', '2026-09-01');
            addMessage(40, Private, '2026-09-01', { toUserId: UserId });
            addMessage(41, Private, '2026-09-02', { toUserId: UserId });
        });

        //  mail sent to the caller is not backlog: none of it is marked read
        it('never starts private mail from now', done => {
            const client = makeClient({
                offline_mail_msg_areas: JSON.stringify([{ areaTag: 'general' }]),
            });
            applyOlc(client, ['GENERAL', 'PRIVATE_MAIL'], (err, context) => {
                assert.ifError(err);
                assert.deepEqual(context.summary.areaChanges.added, ['PRIVATE_MAIL']);
                assert.deepEqual(tagsOf(client.persisted[0].value), ['general', Private]);
                assert.equal(lastRead(Private), 0);
                done();
            });
        });

        it('starts from now if the caller has never read it, and resumes if they have', done => {
            setLastRead('fido_quiet', 20);
            setLastRead('general', 5);

            const client = makeClient({
                offline_mail_msg_areas: JSON.stringify([{ areaTag: 'general' }]),
            });
            applyOlc(client, ['GENERAL', 'FIDO_TECH', 'FIDO_QUIET'], (err, context) => {
                assert.ifError(err);
                assert.deepEqual(context.summary.areaChanges.added, [
                    'FIDO_TECH',
                    'FIDO_QUIET',
                ]);
                assert.deepEqual(client.persisted[0].value, [
                    { areaTag: 'general' },
                    { areaTag: 'fido_tech' },
                    { areaTag: 'fido_quiet' },
                ]);

                assert.equal(lastRead('fido_tech'), 11, 'never read: from now');
                assert.equal(lastRead('fido_quiet'), 20, 'read before: resumes');
                assert.equal(lastRead('general'), 5, 'stayed on: untouched');
                done();
            });
        });
    });
    //
    //  The new scan floor (set_newscan_date's "floor" target, and the one a
    //  new user starts with) and its "message" target turn a date into a
    //  pointer. Both used the earliest-*dated* message after the date, which
    //  can have arrived last.
    //
    describe('turning a new scan date into a pointer', () => {
        const Floor = '2026-09-10T00:00:00.000Z';

        const effective = (properties, areaTag, cb) =>
            MessageArea.getEffectiveNewScanLastReadId(
                makeClient(properties).user,
                areaTag,
                cb
            );

        it('starts the floor at the lowest ID dated after it, not the earliest dated', done => {
            addMessage(1, 'general', '2026-09-01');
            addMessage(2, 'general', '2026-09-20');
            //  arrived last, dated between the floor and 2
            addMessage(3, 'general', '2026-09-12');

            effective({ newscan_min_timestamp: Floor }, 'general', (err, lastReadId) => {
                assert.ifError(err);
                //  2 and 3 are both after the floor, so both are new
                assert.equal(lastReadId, 1);
                done();
            });
        });

        it('treats an area with nothing after the floor as caught up', done => {
            addMessage(1, 'general', '2026-09-01');
            addMessage(2, 'general', '2026-09-05');

            effective({ newscan_min_timestamp: Floor }, 'general', (err, lastReadId) => {
                assert.ifError(err);
                assert.equal(lastReadId, 2);
                done();
            });
        });

        it('keeps a pointer that is already past the floor', done => {
            addMessage(1, 'general', '2026-09-01');
            addMessage(2, 'general', '2026-09-20');
            addMessage(3, 'general', '2026-09-25');
            setLastRead('general', 3);

            effective({ newscan_min_timestamp: Floor }, 'general', (err, lastReadId) => {
                assert.ifError(err);
                assert.equal(lastReadId, 3);
                done();
            });
        });

        //
        //  Mail addressed to the caller is not backlog: an unread message
        //  dated before the floor is still new, as the %NP count, which reads
        //  the raw pointer, already says.
        //
        it('never applies the floor to private mail', done => {
            addMessage(1, Private, '2026-09-01', { toUserId: UserId });
            addMessage(2, Private, '2026-09-20', { toUserId: UserId });

            effective({ newscan_min_timestamp: Floor }, Private, (err, lastReadId) => {
                assert.ifError(err);
                assert.equal(lastReadId, 0);
                done();
            });
        });

        describe("set_newscan_date's message target", () => {
            const setScanDate = (scanDate, cb) => {
                const mod = Object.create(SetNewScanDate.prototype);
                mod.client = makeClient();
                mod.targetSelections = [
                    { area: { areaTag: '' } },
                    { area: { areaTag: 'general' } },
                    { area: { areaTag: 'tech' } },
                ];
                mod.setNewScanDateForMessageBase(0, moment(scanDate), cb);
            };

            it('marks new everything dated after the date, late arrivals included', done => {
                addMessage(1, 'general', '2026-09-01');
                addMessage(2, 'general', '2026-09-20');
                addMessage(3, 'general', '2026-09-12');
                setLastRead('general', 3);

                setScanDate(Floor, err => {
                    assert.ifError(err);
                    assert.equal(lastRead('general'), 1, 'moved back, as asked');
                    done();
                });
            });

            //  one short of message 1 is 0, which is not "an empty area"
            it('moves back to 0 when the first message is dated after the date', done => {
                addMessage(1, 'general', '2026-09-20');
                addMessage(2, 'general', '2026-09-21');
                setLastRead('general', 2);

                setScanDate(Floor, err => {
                    assert.ifError(err);
                    assert.equal(lastRead('general'), 0);
                    done();
                });
            });

            it('marks an area with nothing after the date as read', done => {
                addMessage(1, 'tech', '2026-09-01');
                addMessage(2, 'tech', '2026-09-05');

                setScanDate(Floor, err => {
                    assert.ifError(err);
                    assert.equal(lastRead('tech'), 2);
                    assert.equal(lastRead('general'), 0, 'an empty area is left alone');
                    done();
                });
            });
        });
    });
    //
    //  These answered from inside their try, so a callback that threw was
    //  called again with the error -- which, in a test, turned a failed
    //  assertion into a second, passing call.
    //
    describe('answering a callback that throws', () => {
        const callsOf = fn => {
            const calls = [];
            assert.throws(() =>
                fn((...args) => {
                    calls.push(args);
                    throw new Error('from the callback');
                })
            );
            return calls.length;
        };

        it('calls back once', () => {
            addMessage(1, 'general', '2026-09-20');
            setLastRead('general', 1);

            assert.equal(
                callsOf(cb =>
                    MessageArea.getMessageAreaLastReadId(UserId, 'general', cb)
                ),
                1
            );
            assert.equal(
                callsOf(cb => MessageArea.getHighestMessageIdByArea('general', cb)),
                1
            );
            assert.equal(
                callsOf(cb =>
                    MessageArea.getMessageIdNewerThanTimestampByArea(
                        'general',
                        '2026-09-01T00:00:00.000Z',
                        cb
                    )
                ),
                1
            );
        });
    });

    //  the read lower-cased the tag and the write did not, so a mixed-case
    //  tag's pointer was written where it was never read back
    describe('lastread area tags', () => {
        const update = (areaTag, messageId, cb) =>
            MessageArea.updateMessageAreaLastReadId(
                UserId,
                areaTag,
                messageId,
                false,
                cb
            );

        it('reads back what it writes, whatever the case', done => {
            update('MixedCase', 5, err => {
                assert.ifError(err);
                MessageArea.getMessageAreaLastReadId(UserId, 'MixedCase', (err, id) => {
                    assert.ifError(err);
                    assert.equal(id, 5);
                    assert.equal(lastRead('mixedcase'), 5);
                    done();
                });
            });
        });

        it('never moves a mixed-case pointer backwards', done => {
            update('MixedCase', 5, err => {
                assert.ifError(err);
                update('mixedcase', 3, err => {
                    assert.ifError(err);
                    assert.equal(lastRead('mixedcase'), 5);
                    done();
                });
            });
        });
    });
});
