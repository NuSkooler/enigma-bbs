'use strict';

const { strict: assert } = require('assert');
const os = require('os');
const fs = require('fs');
const paths = require('path');
const moment = require('moment');

const configModule = require('../core/config.js');
const TEST_CONFIG = {
    debug: { assertsEnabled: false },
    menus: { cls: false },
    general: { boardName: 'ENiGMA½ BBS' },
    users: {},
    fileBase: { estimatedTransferCps: 1000 }, //  round numbers for the maths
};

const UserProps = require('../core/user_property.js');
const ACS = require('../core/acs.js');

//
//  file_transfer.js is a MenuModule, so constructing one drags in the whole
//  menu system. The two things under test -- sizing the send queue and
//  deciding whether it fits -- only need |client|, |sendQueue| and
//  |pausePrompt|, so they are exercised against the prototype directly.
//
const FileTransferModule = require('../core/file_transfer.js').getModule;

function makeClient(opts = {}) {
    const props = Object.assign({}, opts.properties);
    const user = {
        userId: 1,
        groups: opts.groups || ['users'],
        properties: props,
        isAuthenticated: () => true,
        isRoot: () => true === opts.root,
        isGroupMember(names) {
            if (!Array.isArray(names)) {
                names = [names];
            }
            return names.some(n => this.groups.includes(n));
        },
        getProperty: n => props[n],
        getPropertyAsNumber: n => parseInt(props[n], 10),
        persistProperty: (n, v) => {
            props[n] = v;
        },
    };

    const client = {
        user,
        node: 1,
        written: [],
        term: { write: t => client.written.push(t) },
        log: { info() {}, warn() {}, debug() {}, trace() {}, error() {} },
    };
    client.acs = new ACS({ client, user });
    return client;
}

//  a bare object wearing the module's two methods
function makeTransfer(client, sendQueue) {
    return {
        client,
        sendQueue,
        paused: 0,
        pausePrompt(cb) {
            this.paused += 1;
            return cb(null);
        },
        sendQueueByteSize: FileTransferModule.prototype.sendQueueByteSize,
        checkSendTimeRemaining: FileTransferModule.prototype.checkSendTimeRemaining,
    };
}

function budgeted(allowed, used, opts = {}) {
    TEST_CONFIG.users = { timeLimits: [{ minutesPerDay: allowed }] };
    return makeClient(
        Object.assign(
            {
                properties: {
                    [UserProps.TimeUsedTodayMinutes]: used,
                    [UserProps.TimeUsedTodayDate]: moment().format('YYYY-MM-DD'),
                },
            },
            opts
        )
    );
}

const check = transfer =>
    new Promise(resolve => transfer.checkSendTimeRemaining(err => resolve(err)));

//  ---------------------------------------------------------------------------

//
//  The other half: an upload must not cost the caller anything.
//
describe('Uploads are free', () => {
    const { Client } = require('../core/client.js');

    //  a real Client, for the real begin/endFreeTime semantics
    function makeUploader(recvImpl) {
        const client = new Client();
        return {
            client,
            recvFiles: recvImpl,
            recvFilesFreeOfCharge: FileTransferModule.prototype.recvFilesFreeOfCharge,
        };
    }

    it('holds free time open for the whole receive', done => {
        let depthDuring;
        const transfer = makeUploader(cb => {
            depthDuring = transfer.client.freeTimeDepth;
            return cb(null);
        });

        transfer.recvFilesFreeOfCharge(err => {
            assert.equal(err, null);
            assert.equal(depthDuring, 1, 'billing must be off during the receive');
            assert.equal(transfer.client.freeTimeDepth, 0, 'and back on after');
            done();
        });
    });

    //  leaving the depth raised would make the rest of the session free
    it('releases free time when the receive fails', done => {
        const transfer = makeUploader(cb => cb(new Error('transfer blew up')));

        transfer.recvFilesFreeOfCharge(err => {
            assert.match(err.message, /blew up/);
            assert.equal(transfer.client.freeTimeDepth, 0);
            done();
        });
    });

    //
    //  recvFiles() can throw rather than call back -- a menu that names a
    //  protocol and a recvFileName that do not go together reaches
    //  prepAndBuildRecvArgs() with no args to map over. A depth left raised
    //  bills the rest of the session nothing.
    //
    it('releases free time when the receive throws instead of calling back', () => {
        const transfer = makeUploader(() => {
            throw new TypeError("Cannot read properties of undefined (reading 'map')");
        });

        assert.throws(() => transfer.recvFilesFreeOfCharge(() => {}), /map/);
        assert.equal(transfer.client.freeTimeDepth, 0);
    });

    //  a handler that calls back twice must not release somebody else's depth
    it('releases free time exactly once', done => {
        let cbCount = 0;
        const transfer = makeUploader(cb => {
            cb(null);
            cb(null);
        });

        transfer.client.beginFreeTime(); //  something outer, already free
        transfer.recvFilesFreeOfCharge(() => {
            cbCount += 1;
            if (2 === cbCount) {
                assert.equal(
                    transfer.client.freeTimeDepth,
                    1,
                    'the outer depth must survive'
                );
                done();
            }
        });
    });

    it('passes the receive error back to the caller', done => {
        const transfer = makeUploader(cb => cb(new Error('nope')));
        transfer.recvFilesFreeOfCharge(err => {
            assert.ok(err);
            done();
        });
    });

    //
    //  A depth rather than a boolean, so a free upload nested inside
    //  something else already free does not un-free it on the inner end.
    //
    describe('Client free time depth', () => {
        it('nests', () => {
            const client = new Client();
            assert.equal(client.freeTimeDepth, 0);
            client.beginFreeTime();
            client.beginFreeTime();
            client.endFreeTime();
            assert.equal(client.freeTimeDepth, 1, 'still free after the inner end');
            client.endFreeTime();
            assert.equal(client.freeTimeDepth, 0);
        });

        it('floors at zero rather than going negative', () => {
            const client = new Client();
            client.endFreeTime();
            client.endFreeTime();
            assert.equal(client.freeTimeDepth, 0);
            client.beginFreeTime();
            assert.equal(client.freeTimeDepth, 1, 'one begin is still one begin');
        });
    });
});

describe('Downloads are checked against the time budget', () => {
    let previousConfig;
    let tempFile;

    before(() => {
        previousConfig = configModule._pushTestConfig(TEST_CONFIG);
        tempFile = paths.join(os.tmpdir(), `enigma_xfer_time_${Date.now()}`);
        fs.writeFileSync(tempFile, Buffer.alloc(120000)); //  120s at 1000 cps
    });

    after(() => {
        configModule._popTestConfig(previousConfig);
        try {
            fs.unlinkSync(tempFile);
        } catch (e) {
            /* nothing to do */
        }
    });

    afterEach(() => {
        TEST_CONFIG.users = {};
        TEST_CONFIG.fileBase = { estimatedTransferCps: 1000 };
    });

    it('allows a download that fits', async () => {
        const client = budgeted(60, 0); //  60 left
        //  600,000 bytes at 1000 cps = 10 minutes
        const err = await check(makeTransfer(client, [{ byteSize: 600000 }]));
        assert.equal(err, null);
        assert.equal(client.written.length, 0);
    });

    it('refuses a download that does not fit, and says what it needs', async () => {
        const client = budgeted(60, 58); //  2 left
        const transfer = makeTransfer(client, [{ byteSize: 600000 }]); //  10 min
        const err = await check(transfer);
        assert.ok(err, 'must refuse');
        assert.match(err.message, /time remaining/i);
        assert.equal(transfer.paused, 1, 'the user gets to read it');
        const said = client.written.join('');
        assert.match(said, /10 minute/);
        assert.match(said, /you have 2/);
    });

    it('sums a batch rather than judging file by file', async () => {
        const client = budgeted(60, 55); //  5 left
        //  three files of 4 minutes each: each fits, the batch does not
        const queue = [{ byteSize: 240000 }, { byteSize: 240000 }, { byteSize: 240000 }];
        assert.ok(await check(makeTransfer(client, queue)));
    });

    it('compares >=, so a download that exactly fits is allowed', async () => {
        const client = budgeted(60, 50); //  10 left
        assert.equal(await check(makeTransfer(client, [{ byteSize: 600000 }])), null);
    });

    //  the check exists to protect metered users; nobody else should notice it
    it('never checks a user with no limit', async () => {
        const client = makeClient();
        const err = await check(makeTransfer(client, [{ byteSize: 999999999 }]));
        assert.equal(err, null);
    });

    it('never checks an exempt user', async () => {
        const client = budgeted(60, 59, { groups: ['users', 'sysops'] });
        const err = await check(makeTransfer(client, [{ byteSize: 999999999 }]));
        assert.equal(err, null);
    });

    it('is disabled by an estimatedTransferCps of 0', async () => {
        TEST_CONFIG.fileBase = { estimatedTransferCps: 0 };
        const client = budgeted(60, 59);
        assert.equal(await check(makeTransfer(client, [{ byteSize: 999999999 }])), null);
    });

    it('is disabled when the rate is not configured at all', async () => {
        TEST_CONFIG.fileBase = {};
        const client = budgeted(60, 59);
        assert.equal(await check(makeTransfer(client, [{ byteSize: 999999999 }])), null);
    });

    describe('sizing the queue', () => {
        it('stats an item that carries no byteSize', done => {
            const transfer = makeTransfer(makeClient(), [{ path: tempFile }]);
            transfer.sendQueueByteSize(total => {
                assert.equal(total, 120000);
                done();
            });
        });

        it('mixes stated sizes and stat-ed ones', done => {
            const transfer = makeTransfer(makeClient(), [
                { byteSize: 1000 },
                { path: tempFile },
            ]);
            transfer.sendQueueByteSize(total => {
                assert.equal(total, 121000);
                done();
            });
        });

        //  forgiving: a queue we cannot size must not refuse the transfer
        it('lets a download through when nothing can be sized', async () => {
            const client = budgeted(60, 59); //  1 left
            const transfer = makeTransfer(client, [
                { path: paths.join(os.tmpdir(), 'enigma_does_not_exist_xyz') },
            ]);
            assert.equal(await check(transfer), null);
        });
    });
});
