'use strict';

//
//  The caller's current message area at login (#1141). postLoginPrep() moves
//  a caller out of a conf / area they cannot read; an area that is not
//  configured (removed, its conference removed, or none stored at all) now
//  counts as one they cannot read, so they land in a suitable area instead
//  of a current area every check refuses.
//
//  Also getSuitableMessageConfAndAreaTags(), which picks that area: its
//  any-conference fallback threw a TypeError.
//

const { strict: assert } = require('assert');
const Module = require('module');

const configModule = require('../core/config.js');
const configDefault = require('../core/config_default.js');
const UserProps = require('../core/user_property.js');
const { WellKnownConfTags } = require('../core/message_const.js');

const defaultConfs = configDefault().messageConferences;

//  the defaults first, as a board's merged config has them
const withDefaultConfs = confs =>
    Object.assign(
        {
            [WellKnownConfTags.SystemInternal]:
                defaultConfs[WellKnownConfTags.SystemInternal],
            [WellKnownConfTags.ActivityPubInternal]:
                defaultConfs[WellKnownConfTags.ActivityPubInternal],
        },
        confs
    );

const sysopsOnly = { read: 'GM[sysops]', write: 'GM[sysops]' };

//
//  Passes every check except a sysops-only one, and the ActivityPub
//  conference's (AE1: ActivityPub enabled for the user, off by default)
//  unless |apEnabled|.
//
const makeAcs = ({ apEnabled = false } = {}) => {
    const allow = obj => {
        const read = (obj && obj.acs && obj.acs.read) || '';
        return !/sysops/.test(read) && (apEnabled || !/AE1/.test(read));
    };
    return {
        hasMessageConfRead: allow,
        hasMessageAreaRead: allow,
        hasMessageConfWrite: allow,
        hasMessageAreaWrite: allow,
        hasFileAreaRead: () => true,
    };
};

function makeLog() {
    const log = { fields: {}, child: () => log };
    ['trace', 'debug', 'info', 'warn', 'error', 'fatal'].forEach(level => {
        log[level] = () => true;
    });
    return log;
}

describe('the current message area at login (#1141)', function () {
    let previousGet;
    let messageArea;
    let config;

    before(() => {
        previousGet = configModule._pushTestConfig({});
        configModule.get = () => config;
        messageArea = require('../core/message_area.js');
    });
    after(() => {
        configModule._popTestConfig(previousGet);
    });

    describe('getSuitableMessageConfAndAreaTags() falling back to any conference', () => {
        beforeEach(() => {
            config = {
                debug: { assertsEnabled: false },
                messageConferences: withDefaultConfs({
                    //  the default conference has nothing this caller can read
                    main: {
                        name: 'Main',
                        default: true,
                        areas: { locked: { name: 'Locked', acs: sysopsOnly } },
                    },
                    other: {
                        name: 'Other',
                        areas: { open: { name: 'Open' } },
                    },
                }),
            };
        });

        it('does not throw, and skips the well-known areas before it', () => {
            assert.deepEqual(
                messageArea.getSuitableMessageConfAndAreaTags({
                    acs: makeAcs({ apEnabled: true }),
                }),
                ['other', 'open']
            );
        });

        it('answers no area when only well-known areas are readable', () => {
            config.messageConferences.other.areas.open.acs = sysopsOnly;
            assert.deepEqual(
                messageArea.getSuitableMessageConfAndAreaTags({
                    acs: makeAcs({ apEnabled: true }),
                }),
                ['main', '']
            );
        });
    });

    describe('getDefaultMessageConferenceTag() with no conference marked default', () => {
        beforeEach(() => {
            config = {
                debug: { assertsEnabled: false },
                messageConferences: withDefaultConfs({
                    local: { name: 'Local', areas: { general: { name: 'General' } } },
                }),
            };
        });

        it('a caller with ActivityPub on gets the board conference, not the hidden ActivityPub one', () => {
            const acs = makeAcs({ apEnabled: true });
            assert.equal(messageArea.getDefaultMessageConferenceTag({ acs }), 'local');
            assert.deepEqual(messageArea.getSuitableMessageConfAndAreaTags({ acs }), [
                'local',
                'general',
            ]);
        });

        it('a hidden conference is still used when it is the only one readable', () => {
            config.messageConferences.local.acs = sysopsOnly;
            assert.equal(
                messageArea.getDefaultMessageConferenceTag({
                    acs: makeAcs({ apEnabled: true }),
                }),
                WellKnownConfTags.ActivityPubInternal
            );
        });

        it('a caller with ActivityPub off gets the board conference, as before', () => {
            assert.equal(
                messageArea.getDefaultMessageConferenceTag({ acs: makeAcs() }),
                'local'
            );
        });
    });

    describe('postLoginPrep() through userLogin()', () => {
        let userLogin;
        const loginModulePath = require.resolve('../core/user_login.js');

        //  everything but message_area.js, which is the real one
        const STUBS = {
            './theme.js': { setClientTheme: () => {} },
            './client_connections.js': { clientConnections: [] },
            './logger.js': { log: { child: () => makeLog() } },
            './events.js': {
                getSystemEvents: () => ({ UserLogin: 'user login' }),
                emit: () => {},
            },
            './user.js': { AuthFactor1Types: { Password: 'password' } },
            './file_base_area.js': {
                getFileAreaByTag: () => ({}),
                getDefaultFileAreaTag: () => '',
            },
            './config.js': {
                get: () => ({
                    users: { badUserNames: [], failedLogin: { disconnect: 3 } },
                }),
            },
        };

        before(() => {
            const originalLoad = Module._load;
            Module._load = function (request, parent, isMain) {
                const fromLoginModule =
                    parent && parent.filename && parent.filename === loginModulePath;
                if (
                    fromLoginModule &&
                    Object.prototype.hasOwnProperty.call(STUBS, request)
                ) {
                    return STUBS[request];
                }
                return originalLoad(request, parent, isMain);
            };

            const savedCacheEntry = require.cache[loginModulePath];
            delete require.cache[loginModulePath];
            try {
                userLogin = require('../core/user_login.js').userLogin;
            } finally {
                Module._load = originalLoad;
                if (savedCacheEntry) {
                    require.cache[loginModulePath] = savedCacheEntry;
                } else {
                    delete require.cache[loginModulePath];
                }
            }
        });

        beforeEach(() => {
            config = {
                debug: { assertsEnabled: false },
                messageConferences: withDefaultConfs({
                    local: {
                        name: 'Local',
                        default: true,
                        areas: {
                            local_general: { name: 'General', default: true },
                            local_chat: { name: 'Chat' },
                        },
                    },
                }),
            };
        });

        //
        //  |stored| is the caller's stored properties. Not authenticated at
        //  the end of factor 1 (a 2FA user), so recordLogin() stays out of it.
        //
        function login(stored) {
            const writes = [];
            const properties = Object.assign({}, stored);
            const client = {
                clientEnded: false,
                log: makeLog(),
                session: { uniqueId: 'session-1' },
                remoteAddress: '192.0.2.20',
                acs: makeAcs(),
            };
            client.user = {
                userId: 0,
                properties,
                getProperty: name => properties[name],
                persistProperties: (props, cb) => {
                    writes.push(props);
                    Object.assign(properties, props);
                    return cb(null);
                },
                authenticateFactor1: (authInfo, cb) => {
                    client.user.userId = 42;
                    client.user.username = 'somebody';
                    return setImmediate(() => cb(null));
                },
            };

            return new Promise((resolve, reject) =>
                userLogin(client, 'somebody', 'secret', err =>
                    err
                        ? reject(err)
                        : resolve({
                              writes,
                              confTag: properties[UserProps.MessageConfTag],
                              areaTag: properties[UserProps.MessageAreaTag],
                          })
                )
            );
        }

        const stored = (confTag, areaTag) => ({
            [UserProps.MessageConfTag]: confTag,
            [UserProps.MessageAreaTag]: areaTag,
        });

        it('leaves a configured, readable area alone, with no write', async () => {
            const result = await login(stored('local', 'local_chat'));
            assert.deepEqual(result.writes, []);
            assert.equal(result.areaTag, 'local_chat');
        });

        it('moves a caller out of an area removed from the config', async () => {
            const result = await login(stored('local', 'gone_area'));
            assert.equal(result.writes.length, 1);
            assert.equal(result.confTag, 'local');
            assert.equal(result.areaTag, 'local_general');
        });

        it('moves a caller out of an area whose conference was removed', async () => {
            const result = await login(stored('gone_conf', 'gone_area'));
            assert.equal(result.confTag, 'local');
            assert.equal(result.areaTag, 'local_general');
        });

        it('moves a caller out of an area they cannot read, as before', async () => {
            config.messageConferences.local.areas.local_chat.acs = sysopsOnly;
            const result = await login(stored('local', 'local_chat'));
            assert.equal(result.areaTag, 'local_general');
        });

        it('gives a caller with no area stored ("") a suitable one', async () => {
            const result = await login(stored('', ''));
            assert.equal(result.confTag, 'local');
            assert.equal(result.areaTag, 'local_general');
        });

        it('gives a caller with no area property at all a suitable one', async () => {
            const result = await login({});
            assert.equal(result.confTag, 'local');
            assert.equal(result.areaTag, 'local_general');
        });

        it('leaves a caller with no area at "" when there is nothing to read', async () => {
            config.messageConferences.local.acs = sysopsOnly;
            const result = await login(stored('', ''));
            assert.equal(result.confTag, '');
            assert.equal(result.areaTag, '');
            assert.deepEqual(result.writes, [], 'wrote the same values again');
        });
    });
});
