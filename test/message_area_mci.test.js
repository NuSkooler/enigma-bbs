'use strict';

//
//  |NA |NC |NS |AT (#447): new and total message counts for any art, built on
//  getMessageAreaStats() and served, like |NM and |NP, from StatLog's cached
//  per-user stats.
//
//  Checked here: each code against getMessageAreaStats() over the areas it is
//  about; that a change of current area or conference, of the new scan
//  selection or floor, or a lastread pointer move is recounted at once rather
//  than after the cache window; and that nothing else is.
//

const { strict: assert } = require('assert');
const Database = require('better-sqlite3');
const moment = require('moment');

const configModule = require('../core/config.js');
const { WellKnownConfTags } = require('../core/message_const.js');

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
                general: { name: 'General' },
                fido_tech: { name: 'FidoNet Tech' },
                tucked: { name: 'Tucked Away', hideFromBrowse: true },
                secret: { name: 'Sysops Only', secret: true },
            },
        },
        elsewhere: {
            name: 'Elsewhere',
            hideFromBrowse: true,
            areas: { far: { name: 'Far' } },
        },
        locked: {
            name: 'Locked',
            locked: true,
            areas: { vault: { name: 'Vault' } },
        },
    },
};

//  modules that capture the message base (or StatLog) at load
const FreshModules = [
    '../core/message.js',
    '../core/message_area.js',
    '../core/stat_log.js',
    '../core/predefined_mci.js',
].map(m => require.resolve(m));

const UserId = 1;
const OtherUserId = 2;
const Private = 'private_mail';
const Floor = '2026-09-10T00:00:00.000Z';

const ts = date => moment.parseZone(date).format('YYYY-MM-DDTHH:mm:ss.SSSZ');

describe('message count MCI codes (#447)', function () {
    let testDb;
    let prevMessageDb;
    let prevConfig;
    let savedModules;
    let realNow;
    let now;

    let MessageArea;
    let mci;

    before(() => {
        prevConfig = configModule._pushTestConfig(TestConfig);

        const dbModule = require('../core/database.js');
        prevMessageDb = dbModule.dbs.message;
        testDb = new Database(':memory:');
        testDb.pragma('foreign_keys = ON');
        dbModule.initMessageDatabase(testDb);
        dbModule.dbs.message = testDb;

        savedModules = FreshModules.map(path => [path, require.cache[path]]);
        FreshModules.forEach(path => delete require.cache[path]);

        MessageArea = require('../core/message_area.js');
        mci = require('../core/predefined_mci.js');

        realNow = Date.now;
        Date.now = () => now;
    });

    after(() => {
        Date.now = realNow;
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
        now = Date.UTC(2026, 10, 18, 12, 0, 0);
        testDb.exec('DELETE FROM message_meta;');
        testDb.exec('DELETE FROM message;');
        testDb.exec('DELETE FROM user_message_area_last_read;');
        seed();
    });

    let nextId = 1;
    function addMessage(areaTag, date, { to = 'All', toUserId } = {}) {
        const messageId = nextId++;
        testDb
            .prepare(
                `INSERT INTO message (message_id, area_tag, message_uuid, to_user_name,
                    from_user_name, subject, message, modified_timestamp)
                VALUES (?, ?, ?, ?, 'Someone', 'subject', 'body', ?);`
            )
            .run(messageId, areaTag, `mci-447-${messageId}`, to, ts(date));
        if (toUserId) {
            testDb
                .prepare(
                    `INSERT INTO message_meta VALUES (?, 'System', 'local_to_user_id', ?);`
                )
                .run(messageId, String(toUserId));
        }
        return messageId;
    }

    function seed() {
        nextId = 1;
        const counts = {
            general: 3,
            fido_tech: 5,
            tucked: 2,
            secret: 4,
            far: 6,
            vault: 7,
        };
        for (const [areaTag, n] of Object.entries(counts)) {
            for (let i = 0; i < n; i++) {
                //  before the floor and after it, in turn
                addMessage(
                    areaTag,
                    i % 2 ? '2026-09-20T00:00:00Z' : '2026-09-01T00:00:00Z'
                );
            }
        }
        addMessage(Private, '2026-09-20T00:00:00Z', { toUserId: UserId });
        addMessage(Private, '2026-09-21T00:00:00Z', { toUserId: OtherUserId });
    }

    function makeClient(properties = {}) {
        const props = Object.assign(
            {
                message_conf_tag: 'local',
                message_area_tag: 'general',
            },
            properties
        );
        return {
            term: {},
            acs: {
                hasMessageConfRead: conf => !conf.locked,
                hasMessageAreaRead: area => !area.secret,
            },
            user: {
                userId: UserId,
                username: 'anne',
                properties: props,
                isAuthenticated: () => true,
                getProperty: name => props[name],
                setProperty: (name, value) => {
                    props[name] = value;
                },
            },
        };
    }

    const code = (client, c) => {
        const value = mci.getPredefinedMCIValue(client, c);
        assert.equal(typeof value, 'string', `${c} answered`);
        return parseInt(value, 10);
    };

    const stats = (client, areaTags) => {
        let result;
        MessageArea.getMessageAreaStats(client.user, areaTags, (err, s) => {
            assert.ifError(err);
            result = s;
        });
        return result;
    };

    const sumNew = (client, areaTags) =>
        Object.values(stats(client, areaTags)).reduce((n, s) => n + s.newCount, 0);

    const markRead = (client, areaTag) =>
        MessageArea.markMessageAreaRead(client.user, areaTag, err => assert.ifError(err));

    describe('values', () => {
        for (const [name, properties] of Object.entries({
            'no floor': {},
            'a floor': { newscan_min_timestamp: Floor },
        })) {
            it(`NA and AT are the current area's newCount and total, with ${name}`, () => {
                const client = makeClient(properties);
                const s = stats(client, ['fido_tech']);
                client.user.properties.message_area_tag = 'fido_tech';
                assert.equal(code(client, 'NA'), s.fido_tech.newCount);
                assert.equal(code(client, 'AT'), s.fido_tech.total);
                assert.equal(code(client, 'AT'), 5);
                assert.equal(code(client, 'NA'), name === 'a floor' ? 4 : 5);
            });

            it(`NC sums the conference's readable areas, hidden ones included, with ${name}`, () => {
                const client = makeClient(properties);
                const expected = sumNew(client, ['general', 'fido_tech', 'tucked']);
                assert.equal(code(client, 'NC'), expected);
                assert.equal(code(client, 'NC'), name === 'a floor' ? 2 + 4 + 1 : 10);
            });

            it(`NS sums every area new_scan would scan, with ${name}`, () => {
                const client = makeClient(properties);
                //  private mail, the hidden conference and the hidden area too;
                //  not the secret area or the locked conference
                const expected = sumNew(client, [
                    Private,
                    'general',
                    'fido_tech',
                    'tucked',
                    'far',
                ]);
                assert.equal(code(client, 'NS'), expected);
                assert.equal(
                    code(client, 'NS'),
                    name === 'a floor' ? 1 + 2 + 4 + 1 + 5 : 1 + 3 + 5 + 2 + 6
                );
            });
        }

        it('NS is narrowed to the new scan selection', () => {
            const client = makeClient({
                newscan_area_tags: JSON.stringify(['fido_tech', 'far', 'secret']),
            });
            //  secret is selected but not readable
            assert.equal(code(client, 'NS'), sumNew(client, ['fido_tech', 'far']));
            assert.equal(code(client, 'NS'), 11);
        });

        it('NS scans everything for an empty or unreadable selection', () => {
            for (const selection of ['[]', 'not json', '']) {
                const client = makeClient({ newscan_area_tags: selection });
                assert.equal(code(client, 'NS'), 17, `selection ${selection}`);
            }
        });

        it('counts 0 for a current area or conference the caller cannot read', () => {
            const client = makeClient({
                message_area_tag: 'secret',
                message_conf_tag: 'locked',
            });
            assert.equal(code(client, 'NA'), 0);
            assert.equal(code(client, 'AT'), 0);
            assert.equal(code(client, 'NC'), 0);
        });

        it('counts 0 for a current area that is no longer configured, or none', () => {
            for (const tag of ['gone_away', undefined]) {
                const client = makeClient({
                    message_area_tag: tag,
                    message_conf_tag: tag,
                });
                assert.equal(code(client, 'NA'), 0);
                assert.equal(code(client, 'AT'), 0);
                assert.equal(code(client, 'NC'), 0);
            }
        });

        it('answers the first read, not the one after it', () => {
            const client = makeClient();
            assert.equal(code(client, 'NA'), 3);
            assert.equal(code(client, 'NP'), 1);
        });
    });

    describe('refreshing', () => {
        it('recounts at once when the current area changes', () => {
            const client = makeClient();
            assert.equal(code(client, 'NA'), 3);
            assert.equal(code(client, 'AT'), 3);
            client.user.properties.message_area_tag = 'fido_tech';
            assert.equal(code(client, 'NA'), 5);
            assert.equal(code(client, 'AT'), 5);
        });

        it('recounts at once when the current conference changes', () => {
            const client = makeClient();
            assert.equal(code(client, 'NC'), 10);
            client.user.properties.message_conf_tag = 'elsewhere';
            assert.equal(code(client, 'NC'), 6);
        });

        it('recounts at once when a lastread pointer moves', () => {
            const client = makeClient();
            assert.equal(code(client, 'NA'), 3);
            assert.equal(code(client, 'NC'), 10);
            assert.equal(code(client, 'NS'), 17);
            markRead(client, 'general');
            assert.equal(code(client, 'NA'), 0);
            assert.equal(code(client, 'AT'), 3);
            assert.equal(code(client, 'NC'), 7);
            assert.equal(code(client, 'NS'), 14);
        });

        it('recounts NP at once when private mail is read', () => {
            const client = makeClient();
            assert.equal(code(client, 'NP'), 1);
            markRead(client, Private);
            assert.equal(code(client, 'NP'), 0);
        });

        it('recounts at once when the new scan floor or selection changes', () => {
            const client = makeClient();
            assert.equal(code(client, 'NS'), 17);
            client.user.properties.newscan_min_timestamp = Floor;
            assert.equal(code(client, 'NS'), 13);
            client.user.properties.newscan_area_tags = JSON.stringify(['general']);
            assert.equal(code(client, 'NS'), 2);
        });

        it('serves new posts from the cache until it expires', () => {
            const client = makeClient();
            assert.equal(code(client, 'NA'), 3);
            assert.equal(code(client, 'NS'), 17);

            addMessage('general', '2026-11-18T00:00:00Z');
            now += 9 * 1000;
            assert.equal(code(client, 'NA'), 3, 'inside the window');
            assert.equal(code(client, 'NS'), 17, 'inside the window');

            now += 1000;
            assert.equal(code(client, 'NA'), 4, 'after it');
            assert.equal(code(client, 'AT'), 4, 'after it');
            assert.equal(code(client, 'NS'), 18, 'after it');
        });

        it("does not recount for another user's pointer", () => {
            const client = makeClient();
            assert.equal(code(client, 'NA'), 3);
            addMessage('general', '2026-11-18T00:00:00Z');
            MessageArea.updateMessageAreaLastReadId(OtherUserId, 'general', 100, err =>
                assert.ifError(err)
            );
            assert.equal(code(client, 'NA'), 3);
        });
    });
});
