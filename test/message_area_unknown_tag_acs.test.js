'use strict';

const { strict: assert } = require('assert');

//
//  hasMessageConfAndAreaRead() / hasMessageConfAndAreaWrite() given an area
//  tag that is not configured (#1141). It was checked as an empty area, so
//  the default ACS (GM[users]) applied and any user could read and post to a
//  tag the board does not have. It is no access now, for sysops too.
//
//  Private mail, bulletins and the ActivityPub shared area come from the
//  default config's conferences, which every board's config is merged over:
//  they resolve, and are checked exactly as before.
//

const configModule = require('../core/config.js');
const configDefault = require('../core/config_default.js');
const ACS = require('../core/acs.js');
const { WellKnownAreaTags, WellKnownConfTags } = require('../core/message_const.js');

const defaultConfs = configDefault().messageConferences;

const TEST_CONFIG = {
    debug: { assertsEnabled: false },
    messageConferences: {
        //  as a board's config gets them: merged in from the defaults
        [WellKnownConfTags.SystemInternal]:
            defaultConfs[WellKnownConfTags.SystemInternal],
        [WellKnownConfTags.ActivityPubInternal]:
            defaultConfs[WellKnownConfTags.ActivityPubInternal],
        local: {
            name: 'Local',
            areas: {
                local_general: { name: 'General' },
                sysops_only: {
                    name: 'Sysops Only',
                    acs: { read: 'GM[sysops]', write: 'GM[sysops]' },
                },
            },
        },
    },
};

//  the real ACS checks, against a user in |groups|
function makeClient(groups) {
    const user = {
        userId: 2,
        username: 'caller',
        isGroupMember: group => groups.includes(group),
        realName: () => 'Real Caller',
    };
    const client = { user };
    client.acs = new ACS({ client, user });
    return client;
}

const regularUser = () => makeClient(['users']);
const sysop = () => makeClient(['users', 'sysops']);

//  passes everything, and records the conf / area objects it was asked about
function makeRecordingClient() {
    const seen = [];
    const record = obj => {
        seen.push(obj);
        return true;
    };
    return {
        seen,
        acs: {
            hasMessageConfRead: record,
            hasMessageConfWrite: record,
            hasMessageAreaRead: record,
            hasMessageAreaWrite: record,
        },
    };
}

describe('message area access for a tag that is not configured (#1141)', function () {
    let previousGet;
    let messageArea;

    before(() => {
        previousGet = configModule._pushTestConfig(TEST_CONFIG);
        messageArea = require('../core/message_area.js');
    });
    after(() => {
        configModule._popTestConfig(previousGet);
    });

    describe('a tag that is not configured', () => {
        [
            ['a regular user', regularUser],
            ['a sysop', sysop],
        ].forEach(([who, makeWho]) => {
            it(`is no read access for ${who}`, () => {
                assert.equal(
                    messageArea.hasMessageConfAndAreaRead(makeWho(), 'gone_area'),
                    false
                );
            });

            it(`is no write access for ${who}`, () => {
                assert.equal(
                    messageArea.hasMessageConfAndAreaWrite(makeWho(), 'gone_area'),
                    false
                );
            });
        });

        it('is no access for an empty tag', () => {
            assert.equal(
                messageArea.hasMessageConfAndAreaWrite(regularUser(), ''),
                false
            );
            assert.equal(messageArea.hasMessageConfAndAreaRead(regularUser(), ''), false);
        });

        it('lists nothing from getMessageListForArea()', done => {
            messageArea.getMessageListForArea(regularUser(), 'gone_area', (err, list) => {
                assert.ifError(err);
                assert.deepEqual(list, []);
                return done();
            });
        });

        it('drops its messages in filterMessageListByReadACS(), not private mail', () => {
            const list = [
                { messageId: 1, areaTag: 'local_general' },
                { messageId: 2, areaTag: 'gone_area' },
                { messageId: 3, areaTag: WellKnownAreaTags.Private },
                { messageId: 4, areaTag: 'sysops_only' },
            ];
            assert.deepEqual(
                messageArea
                    .filterMessageListByReadACS(regularUser(), list)
                    .map(m => m.messageId),
                [1, 3]
            );
        });
    });

    describe('configured areas are checked as before', () => {
        it('an open area: read and write for a regular user', () => {
            const client = regularUser();
            assert.equal(
                messageArea.hasMessageConfAndAreaRead(client, 'local_general'),
                true
            );
            assert.equal(
                messageArea.hasMessageConfAndAreaWrite(client, 'local_general'),
                true
            );
        });

        it('a restricted area: none for a regular user, both for a sysop', () => {
            assert.equal(
                messageArea.hasMessageConfAndAreaRead(regularUser(), 'sysops_only'),
                false
            );
            assert.equal(
                messageArea.hasMessageConfAndAreaWrite(regularUser(), 'sysops_only'),
                false
            );
            assert.equal(
                messageArea.hasMessageConfAndAreaRead(sysop(), 'sysops_only'),
                true
            );
            assert.equal(
                messageArea.hasMessageConfAndAreaWrite(sysop(), 'sysops_only'),
                true
            );
        });

        it('area objects, including one that is not configured, as before', () => {
            const general = messageArea.getMessageAreaByTag('local_general');
            const locked = messageArea.getMessageAreaByTag('sysops_only');
            assert.equal(
                messageArea.hasMessageConfAndAreaWrite(regularUser(), general),
                true
            );
            assert.equal(
                messageArea.hasMessageConfAndAreaWrite(regularUser(), locked),
                false
            );
            //  an object is the caller's to vouch for: checked as given
            assert.equal(messageArea.hasMessageConfAndAreaWrite(regularUser(), {}), true);
            assert.equal(
                messageArea.hasMessageConfAndAreaRead(regularUser(), {
                    acs: { read: 'GM[sysops]' },
                }),
                false
            );
        });
    });

    describe('well-known areas are checked as before', () => {
        [WellKnownAreaTags.Private, WellKnownAreaTags.Bulletin].forEach(areaTag => {
            it(`${areaTag}: read and write for a regular user`, () => {
                const client = regularUser();
                assert.equal(
                    messageArea.hasMessageConfAndAreaRead(client, areaTag),
                    true
                );
                assert.equal(
                    messageArea.hasMessageConfAndAreaWrite(client, areaTag),
                    true
                );
            });

            it(`${areaTag}: none for a user in no group`, () => {
                const client = makeClient([]);
                assert.equal(
                    messageArea.hasMessageConfAndAreaRead(client, areaTag),
                    false
                );
                assert.equal(
                    messageArea.hasMessageConfAndAreaWrite(client, areaTag),
                    false
                );
            });
        });

        it(`${WellKnownAreaTags.ActivityPubShared}: checked against its configured ACS`, () => {
            const client = makeRecordingClient();
            assert.equal(
                messageArea.hasMessageConfAndAreaRead(
                    client,
                    WellKnownAreaTags.ActivityPubShared
                ),
                true
            );
            const [conf, area] = client.seen;
            assert.equal(conf.confTag, WellKnownConfTags.ActivityPubInternal);
            assert.equal(
                conf.acs.read,
                defaultConfs[WellKnownConfTags.ActivityPubInternal].acs.read
            );
            assert.equal(area.areaTag, WellKnownAreaTags.ActivityPubShared);
        });

        it('each well-known tag resolves to its configured area', () => {
            [
                WellKnownAreaTags.Private,
                WellKnownAreaTags.Bulletin,
                WellKnownAreaTags.ActivityPubShared,
            ].forEach(areaTag => {
                const client = makeRecordingClient();
                messageArea.hasMessageConfAndAreaWrite(client, areaTag);
                assert.equal(client.seen[1].areaTag, areaTag);
            });
        });
    });

    //
    //  The defaults always configure these, but a board that somehow lost
    //  one keeps today's behaviour for it rather than losing private mail.
    //
    describe('a well-known tag that does not resolve', () => {
        let previous;
        before(() => {
            previous = configModule._pushTestConfig({
                debug: { assertsEnabled: false },
                messageConferences: { local: TEST_CONFIG.messageConferences.local },
            });
        });
        after(() => {
            configModule._popTestConfig(previous);
        });

        it('is still checked as an empty area, as before', () => {
            const client = regularUser();
            assert.equal(
                messageArea.hasMessageConfAndAreaWrite(client, WellKnownAreaTags.Private),
                true
            );
            assert.equal(
                messageArea.hasMessageConfAndAreaRead(client, WellKnownAreaTags.Private),
                true
            );
            assert.equal(
                messageArea.hasMessageConfAndAreaWrite(client, 'PRIVATE_MAIL'),
                true
            );
        });

        it('while any other tag that does not resolve is no access', () => {
            assert.equal(
                messageArea.hasMessageConfAndAreaWrite(regularUser(), 'gone_area'),
                false
            );
        });
    });

    describe('offline import', () => {
        let importer;
        before(() => {
            //  required here, not at load: see bluewave_offline_config.test.js
            importer = require('../core/message_base_offline_import.js').getModule
                .prototype;
        });

        const persist = (client, areaTag, cb) => {
            const persisted = [];
            const context = Object.create(importer);
            Object.assign(context, {
                client,
                _resolveReplyTo: (message, done) => done(),
                _persistAndCount: (message, done) => {
                    persisted.push(message.areaTag);
                    return done(null);
                },
            });
            const message = {
                areaTag,
                setLocalFromUserId: () => {},
                setExternalFlavor: () => {},
            };
            context._persistMessage(message, err => cb(err, persisted));
        };

        it('rejects a message for an area that is not configured', done => {
            persist(sysop(), 'gone_area', (err, persisted) => {
                assert.ok(err);
                assert.equal(err.code, -32003); //  Errors.AccessDenied
                assert.deepEqual(persisted, []);
                return done();
            });
        });

        it('persists a message for a configured area it can write', done => {
            persist(regularUser(), 'local_general', (err, persisted) => {
                assert.ifError(err);
                assert.deepEqual(persisted, ['local_general']);
                return done();
            });
        });

        it('rejects a message for a configured area it cannot write', done => {
            persist(regularUser(), 'sysops_only', (err, persisted) => {
                assert.ok(err);
                assert.deepEqual(persisted, []);
                return done();
            });
        });
    });
});
