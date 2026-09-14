'use strict';

const { strict: assert } = require('assert');
const { EventEmitter } = require('events');

//
//  door_party.js and goldmine.js reach for ssh2/rlogin and door_util at load
//  time, and initSequence() would otherwise dial a live service.  Patch
//  Module._load scoped to requires originating from those two modules -- the
//  approach sys_event_user_log.test.js takes -- so the connection sequence can
//  be run against fakes and the tag each module records observed.  Other test
//  files are unaffected.
//
const Module = require('module');
const _originalLoad = Module._load;

//  Every trackDoorRunBegin() the modules under test make.
const doorRunsBegun = [];

const doorUtilStub = {
    trackDoorRunBegin: (client, doorTag) => {
        doorRunsBegun.push({ client, doorTag });
        return { client, doorTag };
    },
    trackDoorRunEnd: () => {},
};

//  Just enough of ssh2's Client for DoorParty: connect() reports ready and
//  forwardOut() hands back a stream that swallows whatever is written to it.
class FakeSSHClient extends EventEmitter {
    forwardOut(srcIp, srcPort, dstHost, dstPort, cb) {
        const stream = new EventEmitter();
        stream.write = () => {};
        return cb(null, stream);
    }

    connect() {
        this.emit('ready');
    }

    end() {
        this.emit('close');
    }
}

//  ...and of the rlogin package for gOLD mINE.
class FakeRLogin extends EventEmitter {
    constructor(options) {
        super();
        this.options = options;
    }

    connect() {
        this.emit('connect', true);
    }

    send() {}
}

const STUBS = {
    door_party: {
        './door_util.js': doorUtilStub,
        ssh2: { Client: FakeSSHClient },
    },
    goldmine: {
        './door_util': doorUtilStub,
        rlogin: FakeRLogin,
    },
};

Module._load = function (request, parent, isMain) {
    const filename = (parent && parent.filename) || '';
    const stubbed = Object.keys(STUBS).find(name => filename.includes(name));
    if (stubbed && Object.prototype.hasOwnProperty.call(STUBS[stubbed], request)) {
        return STUBS[stubbed][request];
    }
    return _originalLoad(request, parent, isMain);
};

//  Drop any cached copy so the requires below actually run with the stubs in
//  place -- another test file may have pulled these in already -- then drop
//  them again so nothing else inherits a stubbed copy.
const modulePaths = ['../core/door_party.js', '../core/goldmine.js'].map(p =>
    require.resolve(p)
);
modulePaths.forEach(p => delete require.cache[p]);

const doorPartyModule = require('../core/door_party.js');
const goldmineModule = require('../core/goldmine.js');

Module._load = _originalLoad;
modulePaths.forEach(p => delete require.cache[p]);

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeClient() {
    const output = new EventEmitter();
    output.pipe = () => {};
    output.unpipe = () => {};
    output.resume = () => {};

    const client = new EventEmitter();
    client.term = {
        termType: 'ansi',
        termWidth: 80,
        termHeight: 25,
        write: () => {},
        rawWrite: () => {},
        output,
    };
    client.user = {
        username: 'testuser',
        getSanitizedName: () => 'testuser',
    };
    client.log = {
        info: () => {},
        warn: () => {},
        debug: () => {},
        trace: () => {},
    };
    client.currentTheme = { prompts: {} };
    return client;
}

//  initSequence() runs through async.series; give it a couple of turns of the
//  loop to reach the connection callbacks before asserting.
function settle() {
    return new Promise(resolve => setImmediate(() => setImmediate(resolve)));
}

function runModule(module, menuName, config) {
    const instance = new module.getModule({
        menuName,
        menuConfig: { config },
        client: makeClient(),
    });

    //  the sequence ends by going back to the previous menu, which needs a
    //  real menu stack we do not have here
    instance.prevMenu = () => {};
    instance.initSequence();

    return settle();
}

function runDoorParty() {
    return runModule(doorPartyModule, 'doorPartyTest', {
        username: 'testuser',
        password: 'secret',
        bbsTag: 'XA',
    });
}

function runGoldmine(configPatch = {}) {
    return runModule(
        goldmineModule,
        'goldmineTest',
        Object.assign({ bbsTag: '[XA]' }, configPatch)
    );
}

function tagsRecorded() {
    return doorRunsBegun.map(run => run.doorTag);
}

// ─── tests ───────────────────────────────────────────────────────────────────

describe('door run tagging', function () {
    beforeEach(() => {
        doorRunsBegun.length = 0;
    });

    describe('DoorParty', function () {
        it('records the run against the service', async () => {
            await runDoorParty();
            assert.deepEqual(tagsRecorded(), ['doorparty']);
        });

        it('names the client the run belongs to', async () => {
            await runDoorParty();
            assert.equal(doorRunsBegun.length, 1);
            assert.equal(doorRunsBegun[0].client.user.username, 'testuser');
        });
    });

    describe('gOLD mINE', function () {
        it('records the run against the service', async () => {
            await runGoldmine();
            assert.deepEqual(tagsRecorded(), ['goldmine']);
        });

        it('names the game when the menu launches one directly', async () => {
            await runGoldmine({ directDoorCode: 'LORD' });
            assert.deepEqual(tagsRecorded(), ['goldmine_LORD']);
        });

        it('falls back to the service when directDoorCode is empty', async () => {
            await runGoldmine({ directDoorCode: '' });
            assert.deepEqual(tagsRecorded(), ['goldmine']);
        });

        it('falls back to the service when directDoorCode is not a string', async () => {
            await runGoldmine({ directDoorCode: 1234 });
            assert.deepEqual(tagsRecorded(), ['goldmine']);
        });
    });
});
