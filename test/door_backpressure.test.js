'use strict';

const { strict: assert } = require('assert');
const { EventEmitter } = require('events');

const Door = require('../core/door.js');

//
//  Door output backpressure: with more than |high| bytes waiting to go to the
//  caller, core/door.js stops reading the door (pty or socket) and starts again
//  under |low|. These drive the Door methods directly with a fake client, a
//  fake output stream whose backlog the test sets, and a fake door source that
//  counts pause()/resume().
//
//  door.js captures config.js's |get| when first required, and which config
//  that is depends on test load order -- so the settings tests go through
//  Door.parseBackpressureSettings() rather than through Config().
//
const POLL_WAIT_MS = 150; //  a few of door.js's 50ms resume polls

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function makeSource() {
    const source = new EventEmitter();
    source.pauses = 0;
    source.resumes = 0;
    source.pause = () => (source.pauses += 1);
    source.resume = () => (source.resumes += 1);
    return source;
}

function makeDoor({ io = 'stdio', high = 100, low = 20, sharedRawSocket = false } = {}) {
    const output = { writableLength: 0 };
    const rawSocket = sharedRawSocket ? output : { writableLength: 0 };
    const logged = { info: [], warn: [], debug: [] };

    const client = {
        term: { output, write: () => {} },
        rawSocket,
        log: {
            info: (obj, msg) => logged.info.push({ obj, msg }),
            warn: (obj, msg) => logged.warn.push({ obj, msg }),
            debug: (obj, msg) => logged.debug.push({ obj, msg }),
        },
    };

    const door = new Door(client);
    door.io = io;
    door.encoding = 'cp437';
    door.backpressure = { high, low };

    const source = makeSource();
    if ('socket' === io) {
        door.doorSockConn = source;
    } else {
        door.doorPty = source;
    }

    return { door, output, rawSocket, source, logged };
}

describe('Door output backpressure', () => {
    let door;

    afterEach(() => {
        //  never leave a resume poll running between tests
        if (door) {
            door.stopOutputBackpressure();
            door = null;
        }
    });

    it('leaves the door alone while the backlog is under the high mark', () => {
        const t = makeDoor();
        door = t.door;

        t.output.writableLength = 99;
        door.doorDataHandler(Buffer.from('hello'));

        assert.equal(t.source.pauses, 0);
        assert.equal(door.outputPausedAt, 0);
    });

    it('pauses the door once the backlog reaches the high mark', () => {
        const t = makeDoor();
        door = t.door;

        t.output.writableLength = 100;
        door.doorDataHandler(Buffer.from('frame'));

        assert.equal(t.source.pauses, 1);
        assert.ok(door.outputPausedAt > 0);
        assert.equal(door.outputStats.pauses, 1);
    });

    it('does not pause again or start a second poll while already paused', () => {
        const t = makeDoor();
        door = t.door;

        t.output.writableLength = 500;
        door.doorDataHandler(Buffer.from('a'));
        const timer = door.outputResumeTimer;
        door.doorDataHandler(Buffer.from('b'));
        door.doorDataHandler(Buffer.from('c'));

        assert.equal(t.source.pauses, 1);
        assert.equal(door.outputResumeTimer, timer);
    });

    it('stays paused while the backlog is above the low mark', async () => {
        const t = makeDoor();
        door = t.door;

        t.output.writableLength = 500;
        door.doorDataHandler(Buffer.from('a'));
        t.output.writableLength = 21;
        await wait(POLL_WAIT_MS);

        assert.equal(t.source.resumes, 0);
        assert.ok(door.outputPausedAt > 0);
    });

    it('resumes once the backlog drains to the low mark', async () => {
        const t = makeDoor();
        door = t.door;

        t.output.writableLength = 500;
        door.doorDataHandler(Buffer.from('a'));
        t.output.writableLength = 20;
        await wait(POLL_WAIT_MS);

        assert.equal(t.source.resumes, 1);
        assert.equal(door.outputPausedAt, 0);
        assert.equal(door.outputResumeTimer, undefined);
    });

    it('can pause again after resuming', async () => {
        const t = makeDoor();
        door = t.door;

        t.output.writableLength = 500;
        door.doorDataHandler(Buffer.from('a'));
        t.output.writableLength = 0;
        await wait(POLL_WAIT_MS);
        t.output.writableLength = 500;
        door.doorDataHandler(Buffer.from('b'));

        assert.equal(t.source.pauses, 2);
        assert.equal(t.source.resumes, 1);
        assert.equal(door.outputStats.pauses, 2);
    });

    it('counts what the TCP socket underneath is holding', () => {
        const t = makeDoor();
        door = t.door;

        t.output.writableLength = 60;
        t.rawSocket.writableLength = 40;
        door.doorDataHandler(Buffer.from('a'));

        assert.equal(t.source.pauses, 1);
        assert.equal(door.outputStats.maxBacklog, 100);
    });

    it('does not count the backlog twice when the socket is the output', () => {
        const t = makeDoor({ sharedRawSocket: true });
        door = t.door;

        t.output.writableLength = 60;
        door.doorDataHandler(Buffer.from('a'));

        assert.equal(t.source.pauses, 0);
        assert.equal(door.outputBacklog(), 60);
    });

    it('treats a caller that has gone as caught up', async () => {
        const t = makeDoor();
        door = t.door;

        t.output.writableLength = 500;
        door.doorDataHandler(Buffer.from('a'));
        door.client.term.output = null;
        door.client.rawSocket = null;
        await wait(POLL_WAIT_MS);

        assert.equal(t.source.resumes, 1);
    });

    it('pauses the socket, not a pty, for an io: socket door', () => {
        const t = makeDoor({ io: 'socket' });
        door = t.door;

        t.output.writableLength = 100;
        door.doorDataHandler(Buffer.from('a'));

        assert.equal(t.source.pauses, 1);
    });

    it('does nothing with no door source to pause yet', () => {
        const t = makeDoor({ io: 'socket' });
        door = t.door;
        delete door.doorSockConn;

        t.output.writableLength = 500;
        door.doorDataHandler(Buffer.from('a'));

        assert.equal(door.outputPausedAt, 0);
        assert.equal(door.outputResumeTimer, undefined);
    });

    it('does nothing when throttling is off', () => {
        const t = makeDoor();
        door = t.door;
        door.backpressure = null;

        t.output.writableLength = 1 << 30;
        door.doorDataHandler(Buffer.from('a'));

        assert.equal(t.source.pauses, 0);
    });

    it('resumes a paused door and logs one summary when the door stops', () => {
        const t = makeDoor();
        door = t.door;

        t.output.writableLength = 500;
        door.doorDataHandler(Buffer.from('a'));
        door.stopOutputBackpressure();
        door.stopOutputBackpressure(); //  exit handler and restoreIo() both call it

        assert.equal(t.source.resumes, 1);
        assert.equal(door.outputResumeTimer, undefined);

        const summaries = t.logged.info.filter(
            l => 'Door output backpressure summary' === l.msg
        );
        assert.equal(summaries.length, 1);
        assert.equal(summaries[0].obj.pauses, 1);
        assert.equal(summaries[0].obj.maxBacklog, 500);
        assert.equal(summaries[0].obj.high, 100);
    });

    it('logs no summary when throttling is off', () => {
        const t = makeDoor();
        door = t.door;
        door.backpressure = null;

        door.stopOutputBackpressure();

        assert.equal(t.logged.info.length, 0);
    });
});

describe('Door output backpressure settings', () => {
    const settingsFor = outputBackpressure => {
        const t = makeDoor();
        return {
            settings: Door.parseBackpressureSettings(
                outputBackpressure,
                t.door.client.log
            ),
            logged: t.logged,
        };
    };

    it('is off when there are no settings', () => {
        assert.equal(settingsFor(undefined).settings, null);
    });

    it('is off when disabled', () => {
        const { settings } = settingsFor({
            enabled: false,
            highWaterBytes: 100,
            lowWaterBytes: 10,
        });
        assert.equal(settings, null);
    });

    it('reads the high and low marks', () => {
        const { settings } = settingsFor({
            enabled: true,
            highWaterBytes: 262144,
            lowWaterBytes: 65536,
        });
        assert.deepEqual(settings, { high: 262144, low: 65536 });
    });

    it('is off, with a warning, when low is not below high', () => {
        const { settings, logged } = settingsFor({
            enabled: true,
            highWaterBytes: 100,
            lowWaterBytes: 100,
        });
        assert.equal(settings, null);
        assert.equal(logged.warn.length, 1);
    });

    it('is off, with a warning, when high is missing', () => {
        const { settings, logged } = settingsFor({ enabled: true, lowWaterBytes: 10 });
        assert.equal(settings, null);
        assert.equal(logged.warn.length, 1);
    });
});
