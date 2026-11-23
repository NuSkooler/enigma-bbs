'use strict';

//
//  SSH public key authentication, through a real ssh2 handshake against the
//  SSH server's authentication handler, userLogin() and User (on an in-memory
//  user database).
//
//  A publickey request without a signature only asks whether a key would do:
//  it is answered from the stored key alone, with none of a login's side
//  effects. A request with a signature is a login only once the signature has
//  been verified with the offered key, and that key is the user's.
//

const { strict: assert } = require('assert');
const Module = require('module');
const Database = require('better-sqlite3');
const _ = require('lodash');
const ssh2 = require('ssh2');

const configModule = require('../core/config.js');
const configDefault = require('../core/config_default.js');
const dbModule = require('../core/database.js');
const Events = require('../core/events.js');

//
//  These capture the user database, Config or their siblings at first
//  require, so they are loaded fresh against this file's database and config,
//  and put back afterwards: other test files keep the copies they have.
//
const FreshPaths = [
    '../core/user_group.js',
    '../core/user.js',
    '../core/user_login.js',
    '../core/servers/login/ssh.js',
].map(p => require.resolve(p));
const UserLoginPath = FreshPaths[2];

function makeLog() {
    const entries = [];
    const log = { entries, fields: {}, child: () => log };
    ['trace', 'debug', 'info', 'warn', 'error', 'fatal'].forEach(level => {
        log[level] = (obj, msg) => {
            entries.push({ level, obj, msg: 'string' === typeof obj ? obj : msg });
            return true;
        };
    });
    return log;
}

//  what a login does, recorded instead of done (see userLoginStubs)
const statCalls = [];
const themeCalls = [];
const clientConnections = [];

const recordStat =
    name =>
    (...args) => {
        statCalls.push(name);
        const cb = args[args.length - 1];
        if ('function' === typeof cb) {
            return cb(null);
        }
    };

//  userLogin()'s collaborators, other than User
const userLoginStubs = {
    './theme.js': { setClientTheme: () => themeCalls.push('setClientTheme') },
    './client_connections.js': { clientConnections },
    './logger.js': { log: { child: () => makeLog() } },
    './message_area.js': {
        getMessageConferenceByTag: () => ({}),
        getMessageAreaByTag: () => ({}),
        getSuitableMessageConfAndAreaTags: () => [],
    },
    './file_base_area.js': {
        getFileAreaByTag: () => ({}),
        getDefaultFileAreaTag: () => '',
    },
    './stat_log.js': {
        setUserStat: recordStat('setUserStat'),
        incrementUserStat: recordStat('incrementUserStat'),
        incrementSystemStat: recordStat('incrementSystemStat'),
        incrementNonPersistentSystemStat: recordStat('incrementNonPersistentSystemStat'),
        setNonPersistentSystemStat: recordStat('setNonPersistentSystemStat'),
        appendSystemLogEntry: recordStat('appendSystemLogEntry'),
        now: new Date().toISOString(),
        KeepType: { Max: 'max' },
    },
};

const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));

describe('SSH public key authentication', function () {
    this.timeout(15000);

    let saved;
    let previousConfig;
    let config;
    let db;
    let User;
    let UserProps;
    let ssh;
    let server;
    let port;
    let serverClients;
    const emitted = [];

    before(done => {
        config = _.merge(configDefault(), {
            debug: { assertsEnabled: false },
            menus: { cls: false },
            users: {
                failedLogin: { disconnect: 0, lockAccount: 0 },
            },
            loginServers: { ssh: { loginTimeoutSeconds: 0 } },
        });
        previousConfig = configModule._pushTestConfig(config);

        db = new Database(':memory:');
        db.exec(`
            CREATE TABLE user (
                id          INTEGER PRIMARY KEY,
                user_name   VARCHAR NOT NULL,
                UNIQUE(user_name)
            );
            CREATE TABLE user_property (
                user_id     INTEGER NOT NULL,
                prop_name   VARCHAR NOT NULL,
                prop_value  VARCHAR,
                UNIQUE(user_id, prop_name)
            );
            CREATE TABLE user_group_member (
                group_name  VARCHAR NOT NULL,
                user_id     INTEGER NOT NULL,
                UNIQUE(group_name, user_id)
            );
        `);

        saved = {
            modules: FreshPaths.map(p => require.cache[p]),
            userDb: dbModule.dbs.user,
            emit: Events.emit,
        };
        dbModule.dbs.user = db;
        FreshPaths.forEach(p => delete require.cache[p]);

        //  the login event, and the stat increment events a failed login makes
        Events.emit = (name, payload) => {
            emitted.push({ name, payload });
            return true;
        };

        const originalLoad = Module._load;
        Module._load = function (request, parent, isMain) {
            if (
                parent &&
                parent.filename === UserLoginPath &&
                Object.prototype.hasOwnProperty.call(userLoginStubs, request)
            ) {
                return userLoginStubs[request];
            }
            return originalLoad(request, parent, isMain);
        };
        try {
            require(FreshPaths[0]);
            User = require(FreshPaths[1]);
            require(FreshPaths[2]);
            ssh = require(FreshPaths[3]);
        } finally {
            Module._load = originalLoad;
        }
        UserProps = require('../core/user_property.js');

        serverClients = [];
        server = new ssh2.Server({
            hostKeys: [ssh2.utils.generateKeyPairSync('ed25519').private],
        });
        server.on('connection', (conn, info) => {
            const client = new ssh.SSHClient(conn, info);
            client.log = makeLog();
            client.session = { id: 1, uniqueId: `session-${serverClients.length}` };
            //  the fresh User, on this file's database
            client.user = new User();
            client.acs = {
                hasMessageConfRead: () => true,
                hasMessageAreaRead: () => true,
                hasFileAreaRead: () => true,
            };
            client.on('end', () => client.end());
            serverClients.push(client);
        });
        server.listen(0, '127.0.0.1', () => {
            port = server.address().port;
            return done();
        });
    });

    after(done => {
        serverClients.forEach(c => c.end());
        FreshPaths.forEach((p, i) => {
            if (saved.modules[i]) {
                require.cache[p] = saved.modules[i];
            } else {
                delete require.cache[p];
            }
        });
        dbModule.dbs.user = saved.userDb;
        Events.emit = saved.emit;
        configModule._popTestConfig(previousConfig);
        server.close(() => {
            db.close();
            return done();
        });
    });

    beforeEach(() => {
        statCalls.length = 0;
        themeCalls.length = 0;
        emitted.length = 0;
        clientConnections.length = 0;
    });

    let userSeq = 0;

    //  a user with |keyType|'s key registered (none: no key), and |props|
    function addUser({ keyType = 'ed25519', bits, props = {} } = {}) {
        const username = `pkuser${++userSeq}`;
        const keys =
            'none' === keyType
                ? null
                : ssh2.utils.generateKeyPairSync(keyType, bits ? { bits } : {});
        const info = db.prepare('INSERT INTO user (user_name) VALUES (?)').run(username);
        const userId = info.lastInsertRowid;
        const allProps = Object.assign(
            { [UserProps.AccountStatus]: String(User.AccountStatus.active) },
            keys ? { [UserProps.SSHPubKey]: keys.public } : {},
            props
        );
        const stmt = db.prepare(
            'INSERT INTO user_property (user_id, prop_name, prop_value) VALUES (?, ?, ?)'
        );
        _.each(allProps, (value, name) => stmt.run(userId, name, value));
        db.prepare(
            'INSERT INTO user_group_member (group_name, user_id) VALUES (?, ?)'
        ).run('users', userId);
        return {
            username,
            userId: Number(userId),
            key: keys && ssh2.utils.parseKey(keys.private),
        };
    }

    function getProp(userId, name) {
        const row = db
            .prepare(
                'SELECT prop_value FROM user_property WHERE user_id = ? AND prop_name = ?'
            )
            .get(userId, name);
        return row ? row.prop_value : undefined;
    }

    //
    //  Connect as |username| with |key| (a parsed private key), and see how
    //  far it gets. |mode|:
    //
    //  - 'normal': as ssh2's client does it, a query, then a signed request
    //  - 'junkNoQuery': no query; a signed request with a junk signature
    //  - 'junkAfterQuery': a query, then a signed request with a junk signature
    //  - 'signedNoQuery': no query; a signed request with a good signature
    //  - 'queryOnly': a query, and a disconnect once it is answered
    //
    //  |algo|: [ key algorithm, hash ] to put in the request and sign with.
    //  |offer|: a key whose public half goes in the request instead of |key|'s
    //  (|key| still signs). |junk|: the junk signature.
    //
    function connect({
        username,
        key,
        mode = 'normal',
        algo,
        offer,
        junk = Buffer.alloc(64, 0x41),
    }) {
        const result = { ready: false, pkOk: false, signedSent: false };
        const sshClient = new ssh2.Client();
        let authAsked = false;

        const patchProtocol = proto => {
            const authPK = proto.authPK.bind(proto);
            proto.authPK = (user, pubKey, keyAlgo, cbSign) => {
                if ('function' === typeof keyAlgo) {
                    cbSign = keyAlgo;
                    keyAlgo = undefined;
                }

                let hash;
                if (algo) {
                    [keyAlgo, hash] = algo;
                }
                if (offer) {
                    pubKey = offer;
                }
                const sign = (buf, cb) => cb(key.sign(buf, hash));
                const junkSign = (buf, cb) => cb(junk);

                if (cbSign) {
                    //  the query was answered PK_OK
                    result.pkOk = true;
                    if ('queryOnly' === mode) {
                        return sshClient.end();
                    }
                    result.signedSent = true;
                    return authPK(
                        user,
                        pubKey,
                        keyAlgo,
                        'junkAfterQuery' === mode
                            ? junkSign
                            : algo || offer
                              ? sign
                              : cbSign
                    );
                }

                switch (mode) {
                    case 'junkNoQuery':
                        result.signedSent = true;
                        return authPK(user, pubKey, keyAlgo, junkSign);
                    case 'signedNoQuery':
                        result.signedSent = true;
                        return authPK(user, pubKey, keyAlgo, sign);
                    default:
                        return authPK(user, pubKey, keyAlgo);
                }
            };
        };

        return new Promise(resolve => {
            const startedAt = Date.now();
            let done = false;
            const finish = () => {
                if (done) {
                    return;
                }
                done = true;
                result.elapsedMs = Date.now() - startedAt;
                result.serverClient = serverClients[serverClients.length - 1];
                return resolve(result);
            };
            sshClient.on('ready', () => {
                result.ready = true;
                sshClient.end();
            });
            sshClient.on('error', err => (result.error = err.message));
            sshClient.on('close', finish);
            sshClient.connect({
                host: '127.0.0.1',
                port,
                username,
                readyTimeout: 10000,
                authHandler: (methodsLeft, partial, cb) => {
                    if (authAsked) {
                        return cb(false);
                    }
                    authAsked = true;
                    patchProtocol(sshClient._protocol);
                    return cb({ type: 'publickey', username, key });
                },
            });
        });
    }

    const loginEvents = () =>
        emitted.filter(e => e.name === Events.getSystemEvents().UserLogin);

    function assertLoggedIn(result, user) {
        assert.equal(result.ready, true, `logged in (${result.error})`);
        assert.equal(result.serverClient.user.userId, user.userId);
        assert.equal(result.serverClient.user.isAuthenticated(), true);
        assert.equal(loginEvents().length, 1, 'one login event');
        assert.ok(statCalls.includes('incrementSystemStat'), 'the login is recorded');
    }

    function assertNoLogin(result) {
        assert.equal(result.ready, false, 'not logged in');
        assert.equal(result.serverClient.user.isAuthenticated(), false);
        assert.equal(result.serverClient.user.userId, 0);
        assert.equal(loginEvents().length, 0, 'no login event');
        assert.deepEqual(statCalls, [], 'no login recorded');
        assert.deepEqual(themeCalls, [], 'no theme set');
    }

    //  what userLogin() logged for a refused login, if anything
    const failedLoginReasons = result =>
        result.serverClient.log.entries
            .filter(e => 'warn' === e.level && /Failed login attempt/.test(e.msg))
            .map(e => e.obj.reason);

    describe('a signature that does not verify', () => {
        it('is refused when the client did not ask about the key first', async () => {
            const user = addUser();
            const result = await connect({ ...user, mode: 'junkNoQuery' });
            assert.equal(result.signedSent, true);
            assertNoLogin(result);
        });

        it('is refused after the key was accepted in a query', async () => {
            const user = addUser();
            const result = await connect({ ...user, mode: 'junkAfterQuery' });
            assert.equal(result.pkOk, true, 'the query is answered PK_OK');
            assert.equal(result.signedSent, true);
            assertNoLogin(result);
        });

        it('is refused slowly, as before', async () => {
            const user = addUser();
            const result = await connect({ ...user, mode: 'junkNoQuery' });
            assert.ok(result.elapsedMs >= 1900, `${result.elapsedMs}ms`);
        });

        it('says nothing about the account it was for', async () => {
            const user = addUser({
                props: { [UserProps.AccountStatus]: String(User.AccountStatus.disabled) },
            });
            const result = await connect({ ...user, mode: 'junkNoQuery' });
            assertNoLogin(result);
            assert.deepEqual(failedLoginReasons(result), []);
        });
    });

    describe('a good signature with the registered key', () => {
        it('logs in with an ed25519 key', async () => {
            const user = addUser();
            const result = await connect(user);
            assert.equal(result.pkOk, true);
            assertLoggedIn(result, user);
        });

        [256, 384, 521].forEach(bits => {
            it(`logs in with an ECDSA P-${bits} key`, async () => {
                const user = addUser({ keyType: 'ecdsa', bits });
                assertLoggedIn(await connect(user), user);
            });
        });

        [
            ['rsa-sha2-256', 'sha256'],
            ['rsa-sha2-512', 'sha512'],
            ['ssh-rsa', 'sha1'],
        ].forEach(algo => {
            it(`logs in with an RSA key signing with ${algo[0]}`, async () => {
                const user = addUser({ keyType: 'rsa', bits: 2048 });
                const result = await connect({ ...user, algo });
                assert.equal(result.pkOk, true);
                assertLoggedIn(result, user);
            });
        });

        it('logs in without asking about the key first', async () => {
            const user = addUser();
            const result = await connect({ ...user, mode: 'signedNoQuery' });
            assert.equal(result.pkOk, false, 'no query was made');
            assertLoggedIn(result, user);
        });

        it('clears failed login attempts once logged in', async () => {
            const user = addUser({ props: { [UserProps.FailedLoginAttempts]: '2' } });
            assertLoggedIn(await connect(user), user);
            assert.equal(getProp(user.userId, UserProps.FailedLoginAttempts), undefined);
        });
    });

    describe('a key that is not registered', () => {
        it('is refused in a query', async () => {
            const user = addUser();
            const other = ssh2.utils.parseKey(
                ssh2.utils.generateKeyPairSync('ed25519').private
            );
            const result = await connect({ ...user, key: other, mode: 'queryOnly' });
            assert.equal(result.pkOk, false);
            assertNoLogin(result);
            //  a failed login, as before
            assert.equal(getProp(user.userId, UserProps.FailedLoginAttempts), '1');
        });

        it('is refused with a good signature made with it', async () => {
            const user = addUser();
            const other = ssh2.utils.parseKey(
                ssh2.utils.generateKeyPairSync('ed25519').private
            );
            const result = await connect({ ...user, key: other, mode: 'signedNoQuery' });
            assertNoLogin(result);
        });

        it('is refused for a user with no key', async () => {
            const user = addUser({ keyType: 'none' });
            const key = ssh2.utils.parseKey(
                ssh2.utils.generateKeyPairSync('ed25519').private
            );
            assertNoLogin(await connect({ ...user, key }));
        });

        it('is refused, not thrown on, when an RSA key of another size', async () => {
            const user = addUser({ keyType: 'rsa', bits: 2048 });
            const other = ssh2.utils.parseKey(
                ssh2.utils.generateKeyPairSync('rsa', { bits: 3072 }).private
            );
            const result = await connect({ ...user, key: other, mode: 'queryOnly' });
            assert.equal(result.pkOk, false);
            assertNoLogin(result);
            //  an ordinary refusal, not a dropped connection
            assert.match(String(result.error), /authentication methods failed/);
            assert.equal(getProp(user.userId, UserProps.FailedLoginAttempts), '1');
        });

        it('is refused for a user that does not exist', async () => {
            const key = ssh2.utils.parseKey(
                ssh2.utils.generateKeyPairSync('ed25519').private
            );
            const result = await connect({ username: 'nobody', key, mode: 'queryOnly' });
            assert.equal(result.pkOk, false);
            assertNoLogin(result);
        });
    });

    describe('a query alone', () => {
        it('is answered PK_OK with none of a login side effects', async () => {
            const user = addUser({ props: { [UserProps.FailedLoginAttempts]: '2' } });
            const result = await connect({ ...user, mode: 'queryOnly' });
            assert.equal(result.pkOk, true);
            await tick(50);
            assertNoLogin(result);
            //  not reset, as a login would
            assert.equal(getProp(user.userId, UserProps.FailedLoginAttempts), '2');
            assert.equal(getProp(user.userId, UserProps.LastLoginTs), undefined);
        });

        it('does not unlock a locked account due for auto unlock', async () => {
            const lockedTs = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
            const user = addUser({
                props: {
                    [UserProps.AccountStatus]: String(User.AccountStatus.locked),
                    [UserProps.AccountLockedTs]: lockedTs,
                    [UserProps.AccountLockedPrevStatus]: String(
                        User.AccountStatus.active
                    ),
                },
            });
            const result = await connect({ ...user, mode: 'queryOnly' });
            assert.equal(result.pkOk, true);
            await tick(50);
            assertNoLogin(result);
            assert.equal(
                getProp(user.userId, UserProps.AccountStatus),
                String(User.AccountStatus.locked)
            );
        });
    });

    describe('account status', () => {
        const statuses = [
            ['disabled', /Account disabled/],
            ['inactive', /Account inactive/],
            ['locked', /Account is locked/],
        ];

        statuses.forEach(([status, reason]) => {
            it(`a ${status} account is not looked at in a query`, async () => {
                const user = addUser({
                    props: {
                        [UserProps.AccountStatus]: String(User.AccountStatus[status]),
                        [UserProps.AccountLockedTs]: new Date().toISOString(),
                    },
                });
                const result = await connect({ ...user, mode: 'queryOnly' });
                assert.equal(result.pkOk, true);
                assertNoLogin(result);
                assert.deepEqual(failedLoginReasons(result), []);
            });

            it(`a ${status} account is refused after a good signature`, async () => {
                const user = addUser({
                    props: {
                        [UserProps.AccountStatus]: String(User.AccountStatus[status]),
                        [UserProps.AccountLockedTs]: new Date().toISOString(),
                    },
                });
                const result = await connect(user);
                assert.equal(result.pkOk, true);
                assertNoLogin(result);
                const reasons = failedLoginReasons(result);
                assert.equal(reasons.length, 1, JSON.stringify(reasons));
                assert.match(reasons[0], reason);
            });
        });

        it('a user already logged in is refused after a good signature, not in a query', async () => {
            const user = addUser();
            clientConnections.push({ user: { userId: user.userId }, node: 2 });

            const query = await connect({ ...user, mode: 'queryOnly' });
            assert.equal(query.pkOk, true);
            assertNoLogin(query);

            const login = await connect(user);
            assert.equal(login.ready, false);
            assert.ok(
                login.serverClient.log.entries.some(e => /already logged in/.test(e.msg)),
                'refused as already logged in'
            );
            assert.equal(loginEvents().length, 0);
        });
    });

    const newKey = (type = 'ed25519', bits) =>
        ssh2.utils.parseKey(
            ssh2.utils.generateKeyPairSync(type, bits ? { bits } : {}).private
        );

    describe('a good signature made with another key', () => {
        it('is refused with the user key offered and no query', async () => {
            const user = addUser();
            const result = await connect({
                username: user.username,
                key: newKey(),
                offer: user.key,
                mode: 'signedNoQuery',
            });
            assert.equal(result.signedSent, true);
            assertNoLogin(result);
        });

        it('is refused with the user key offered after a query', async () => {
            const user = addUser();
            const result = await connect({
                username: user.username,
                key: newKey(),
                offer: user.key,
            });
            assert.equal(result.pkOk, true, 'the user key is answered PK_OK');
            assert.equal(result.signedSent, true);
            assertNoLogin(result);
        });

        it('is refused for an RSA key offered with another RSA key signing', async () => {
            const user = addUser({ keyType: 'rsa', bits: 2048 });
            const result = await connect({
                username: user.username,
                key: newKey('rsa', 2048),
                offer: user.key,
                algo: ['rsa-sha2-256', 'sha256'],
            });
            assert.equal(result.pkOk, true);
            assertNoLogin(result);
        });
    });

    describe('a junk signature for other key types', () => {
        [
            ['RSA', { keyType: 'rsa', bits: 2048 }, Buffer.alloc(256, 0x41)],
            ['RSA (short)', { keyType: 'rsa', bits: 2048 }, Buffer.alloc(64, 0x41)],
            //  ssh2 itself ends the connection for this one: junk does not
            //  decode as an ECDSA signature
            ['ECDSA', { keyType: 'ecdsa', bits: 256 }, Buffer.alloc(64, 0x41)],
        ].forEach(([label, keyOpts, junk]) => {
            it(`is refused for a registered ${label} key, without a query`, async () => {
                const user = addUser(keyOpts);
                const result = await connect({ ...user, mode: 'junkNoQuery', junk });
                assert.equal(result.signedSent, true);
                assertNoLogin(result);
            });

            it(`is refused for a registered ${label} key, after a query`, async () => {
                const user = addUser(keyOpts);
                const algo =
                    'rsa' === keyOpts.keyType ? ['rsa-sha2-256', 'sha256'] : undefined;
                const result = await connect({
                    ...user,
                    mode: 'junkAfterQuery',
                    junk,
                    algo,
                });
                assert.equal(result.pkOk, true);
                assertNoLogin(result);
            });
        });
    });

    describe('an RSA signature made with another hash than the request names', () => {
        [
            ['rsa-sha2-512', 'sha256'],
            ['rsa-sha2-256', 'sha512'],
            ['rsa-sha2-256', 'sha1'],
            ['ssh-rsa', 'sha256'],
        ].forEach(algo => {
            it(`is refused: ${algo[0]} named, signed with ${algo[1]}`, async () => {
                const user = addUser({ keyType: 'rsa', bits: 2048 });
                const result = await connect({ ...user, algo, mode: 'signedNoQuery' });
                assert.equal(result.signedSent, true);
                assertNoLogin(result);
            });
        });
    });

    describe('a key blob that is not what the request says', () => {
        it('is refused when the request names another key type', async () => {
            //  the user's ECDSA key, in a request that says ssh-ed25519
            const user = addUser({ keyType: 'ecdsa', bits: 256 });
            const result = await connect({
                ...user,
                algo: ['ssh-ed25519', undefined],
                mode: 'signedNoQuery',
            });
            assert.equal(result.signedSent, true);
            assertNoLogin(result);
        });
    });

    describe('failedLogin.disconnect', () => {
        let savedDisconnect;
        before(() => {
            savedDisconnect = config.users.failedLogin.disconnect;
            config.users.failedLogin.disconnect = 3;
        });
        after(() => {
            config.users.failedLogin.disconnect = savedDisconnect;
        });

        //  as a client (an ssh-agent, say) offering several keys in turn does
        function connectWithKeys(username, keys) {
            return new Promise(resolve => {
                const result = { ready: false };
                const sshClient = new ssh2.Client();
                sshClient.on('ready', () => {
                    result.ready = true;
                    sshClient.end();
                });
                sshClient.on('error', err => (result.error = err.message));
                sshClient.on('close', () => {
                    result.serverClient = serverClients[serverClients.length - 1];
                    return resolve(result);
                });
                sshClient.connect({
                    host: '127.0.0.1',
                    port,
                    username,
                    readyTimeout: 10000,
                    authHandler: keys.map(key => ({ type: 'publickey', username, key })),
                });
            });
        }

        it('with 3, two keys that are not registered and then the right one logs in', async () => {
            const user = addUser();
            const result = await connectWithKeys(user.username, [
                newKey(),
                newKey(),
                user.key,
            ]);
            assertLoggedIn(result, user);
            //  a login clears them
            assert.equal(getProp(user.userId, UserProps.FailedLoginAttempts), undefined);
        });

        it('with 3, three keys that are not registered end the connection first', async () => {
            const user = addUser();
            const result = await connectWithKeys(user.username, [
                newKey(),
                newKey(),
                newKey(),
                user.key,
            ]);
            assertNoLogin(result);
            assert.equal(getProp(user.userId, UserProps.FailedLoginAttempts), '3');
        });
    });

    describe('SSHClient.isPubKeyBlobFor()', () => {
        const blobWith = (algo, rest) => {
            const name = Buffer.from(algo);
            const len = Buffer.alloc(4);
            len.writeUInt32BE(name.length);
            return Buffer.concat([len, name, rest]);
        };

        [
            ['ssh-ed25519', () => newKey()],
            ['ecdsa-sha2-nistp256', () => newKey('ecdsa', 256)],
            ['ecdsa-sha2-nistp384', () => newKey('ecdsa', 384)],
            ['ecdsa-sha2-nistp521', () => newKey('ecdsa', 521)],
            ['ssh-rsa', () => newKey('rsa', 2048)],
        ].forEach(([algo, make]) => {
            it(`is true for a ${algo} key`, () => {
                const key = make();
                assert.equal(key.type, algo);
                assert.equal(
                    ssh.SSHClient.isPubKeyBlobFor(key.getPublicSSH(), algo),
                    true
                );
            });
        });

        it('is false for a blob of another key type', () => {
            const blob = newKey('ecdsa', 256).getPublicSSH();
            assert.equal(ssh.SSHClient.isPubKeyBlobFor(blob, 'ssh-ed25519'), false);
            assert.equal(
                ssh.SSHClient.isPubKeyBlobFor(blob, 'ecdsa-sha2-nistp384'),
                false
            );
        });

        it('is false for malformed blobs', () => {
            const isFor = ssh.SSHClient.isPubKeyBlobFor;
            assert.equal(isFor(Buffer.alloc(0), 'ssh-ed25519'), false);
            assert.equal(isFor(Buffer.from([0, 0, 0]), 'ssh-ed25519'), false);
            //  a length past the end
            assert.equal(isFor(Buffer.from([0, 0, 0, 0xff, 0x73]), 'ssh-ed25519'), false);
            //  the type and nothing after it
            assert.equal(
                isFor(blobWith('ssh-ed25519', Buffer.alloc(0)), 'ssh-ed25519'),
                false
            );
            //  a text format
            const pem = Buffer.from(
                `-----BEGIN OPENSSH PRIVATE KEY-----\n${'A'.repeat(34000)}\n` +
                    '-----END OPENSSH PRIVATE KEY-----'
            );
            assert.equal(isFor(pem, 'ssh-ed25519'), false);
            assert.equal(
                isFor(blobWith('ssh-ed25519', Buffer.alloc(8)), undefined),
                false
            );
            assert.equal(isFor('ssh-ed25519', 'ssh-ed25519'), false);
        });

        it('is false, quickly, for an oversized blob that is otherwise well formed', () => {
            const big = blobWith('ssh-ed25519', Buffer.alloc(64 * 1024, 0x41));
            const startedAt = process.hrtime.bigint();
            assert.equal(ssh.SSHClient.isPubKeyBlobFor(big, 'ssh-ed25519'), false);
            const ctx = {
                key: { algo: 'ssh-ed25519', data: big },
                blob: big,
                signature: big,
            };
            assert.equal(ssh.SSHClient.isValidPubKeySignature(ctx), false);
            const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
            assert.ok(ms < 20, `${ms}ms`);
        });

        it('keeps garbage away from the key parser', () => {
            const parseKey = ssh2.utils.parseKey;
            let parsed = 0;
            ssh2.utils.parseKey = (...args) => {
                parsed += 1;
                return parseKey(...args);
            };
            try {
                [
                    Buffer.from('-----BEGIN RSA PRIVATE KEY-----\n' + 'A'.repeat(34000)),
                    blobWith('ssh-rsa', Buffer.alloc(32, 0x41)),
                    blobWith('ssh-ed25519', Buffer.alloc(20 * 1024, 0x41)),
                ].forEach(data => {
                    const ctx = {
                        key: { algo: 'ssh-ed25519', data },
                        blob: Buffer.alloc(8),
                        signature: Buffer.alloc(64),
                    };
                    assert.equal(ssh.SSHClient.isValidPubKeySignature(ctx), false);
                });
            } finally {
                ssh2.utils.parseKey = parseKey;
            }
            assert.equal(parsed, 0);
        });
    });

    describe('SSHClient.isValidPubKeySignature()', () => {
        const keys = ssh2.utils.generateKeyPairSync('ed25519');
        const priv = ssh2.utils.parseKey(keys.private);
        const blob = Buffer.from('session id and request');
        const ctxFor = (signature, extra = {}) =>
            Object.assign(
                {
                    key: { algo: 'ssh-ed25519', data: priv.getPublicSSH() },
                    blob,
                    signature,
                },
                extra
            );

        it('is true for a good signature', () => {
            assert.equal(
                ssh.SSHClient.isValidPubKeySignature(ctxFor(priv.sign(blob))),
                true
            );
        });

        it('is false where verify() returns an Error, not false', () => {
            const ctx = ctxFor(priv.sign(blob), { hashAlgo: 'no-such-hash' });
            //  ed25519 ignores the hash; an RSA key does not
            const rsa = ssh2.utils.parseKey(
                ssh2.utils.generateKeyPairSync('rsa', { bits: 2048 }).private
            );
            ctx.key = { algo: 'ssh-rsa', data: rsa.getPublicSSH() };
            ctx.signature = rsa.sign(blob, 'sha256');
            assert.ok(rsa.verify(blob, ctx.signature, ctx.hashAlgo) instanceof Error);
            assert.equal(ssh.SSHClient.isValidPubKeySignature(ctx), false);
        });

        it('is false for a key that is not what the request says it is', () => {
            const ctx = ctxFor(priv.sign(blob));
            ctx.key.algo = 'ssh-rsa';
            assert.equal(ssh.SSHClient.isValidPubKeySignature(ctx), false);
        });

        it('is false for missing or malformed parts', () => {
            const good = priv.sign(blob);
            assert.equal(ssh.SSHClient.isValidPubKeySignature(ctxFor(undefined)), false);
            assert.equal(
                ssh.SSHClient.isValidPubKeySignature(ctxFor(good, { blob: undefined })),
                false
            );
            assert.equal(
                ssh.SSHClient.isValidPubKeySignature(
                    ctxFor(good, { key: { algo: 'ssh-ed25519', data: Buffer.from('x') } })
                ),
                false
            );
            assert.equal(ssh.SSHClient.isValidPubKeySignature({}), false);
        });
    });
});
