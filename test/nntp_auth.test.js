'use strict';

const { strict: assert } = require('assert');

describe('NNTP authentication', function () {
    let NNTPServer;
    let User;
    let origFactor1;

    const logStub = () => {
        const calls = [];
        const l = {};
        for (const lvl of ['trace', 'debug', 'info', 'warn', 'error', 'fatal']) {
            l[lvl] = (obj, msg) => calls.push({ lvl, obj, msg });
        }
        l.calls = calls;
        return l;
    };

    before(function () {
        //  lazy: loading nntp.js pulls in config/db modules. Evict first so
        //  nntp.js and this test share one User class whatever ran before us.
        for (const m of ['../core/servers/content/nntp.js', '../core/user.js']) {
            delete require.cache[require.resolve(m)];
        }
        NNTPServer = require('../core/servers/content/nntp.js').NNTPServer;
        User = require('../core/user.js');
        origFactor1 = User.prototype.authenticateFactor1;
    });

    after(function () {
        for (const m of ['../core/servers/content/nntp.js', '../core/user.js']) {
            delete require.cache[require.resolve(m)];
        }
    });

    afterEach(function () {
        User.prototype.authenticateFactor1 = origFactor1;
    });

    const makeServer = () => {
        const log = logStub();
        return {
            log,
            _address: NNTPServer.prototype._address,
            _authenticate: NNTPServer.prototype._authenticate,
        };
    };

    const makeSession = () => ({
        authinfo_user: 'someone',
        authinfo_pass: 'secret',
        in_stream: { remoteAddress: '127.0.0.1' },
    });

    const stubFactor1 = (err, authenticated) => {
        User.prototype.authenticateFactor1 = function (info, cb) {
            this.authenticated = authenticated;
            return cb(err);
        };
    };

    it('accepts a user who passed factor 1 and needs no second factor', async function () {
        stubFactor1(null, true);
        const server = makeServer();
        const session = makeSession();
        assert.equal(await server._authenticate(session), true);
        assert.ok(session.authUser);
    });

    it('refuses login for an account with 2-factor authentication enabled', async function () {
        stubFactor1(null, false);
        const server = makeServer();
        const session = makeSession();
        assert.equal(await server._authenticate(session), false);
        assert.equal(session.authUser, undefined);
        const info = server.log.calls.find(
            c => c.lvl === 'info' && /2-factor/.test(c.msg)
        );
        assert.ok(info, 'operator-facing reason is logged');
    });

    it('refuses login when factor 1 fails', async function () {
        stubFactor1(new Error('bad password'), false);
        const server = makeServer();
        const session = makeSession();
        assert.equal(await server._authenticate(session), false);
        assert.equal(session.authUser, undefined);
    });
});
