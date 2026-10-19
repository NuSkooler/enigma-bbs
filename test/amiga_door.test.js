'use strict';

const { strict: assert } = require('assert');
const { EventEmitter } = require('events');
const os = require('os');
const fs = require('fs');
const path = require('path');

//  No emulator anywhere in here: the worker is faked, and the shim's side of
//  the link is built with protocol.js.
const protocol = require('../core/amiga_door/protocol.js');
const {
    HostLink,
    AmigaConsoleTranslator,
    amigaCsiToAnsi,
} = require('../core/amiga_door/host_link.js');
const { SnapshotCache } = require('../core/amiga_door/snapshot_cache.js');
const { _test } = require('../core/amiga_door/amiga_door.js');
const { checkPackage, versionAtLeast } = require('../core/amiga_door/vamiga_package.js');
const {
    normalizeConfig,
    PersistOnIgnored,
    persistOnWarned,
    buildSessionKeys,
    cnetAccount,
    expandDoorArgs,
    quoteArg,
    userText,
    commandLength,
    isLatin1,
    AmigaDoorSession,
    activeImages,
    activeDoorInstances,
    MaxDoorMinutes,
} = _test;
const AmigaDoorModule = require('../core/amiga_door/amiga_door.js').getModule;

//  Whatever enigma-vamiga is installed (package.json may still pin 0.1.x), the
//  module under test runs as on 0.2.0; the version gate has tests of its own
const VAMIGA_OK = { version: '0.2.0', problem: null };
_test.vamigaPackage = VAMIGA_OK;

// ─── helpers ──────────────────────────────────────────────────────────────────

const BASE = {
    name: 'XIMTest',
    image: '/doors/ximtest.hdf',
    door: 'BBS:Doors/XIMTest/XIMTest',
};

const config = extra => {
    const { config: c, problems } = normalizeConfig(Object.assign({}, BASE, extra));
    assert.deepEqual(problems, []);
    return c;
};

const problemsOf = extra => normalizeConfig(Object.assign({}, BASE, extra)).problems;

const quietLog = () => {
    const lines = [];
    const at = level => (obj, msg) => lines.push({ level, obj, msg });
    return {
        lines,
        trace: at('trace'),
        debug: at('debug'),
        info: at('info'),
        warn: at('warn'),
        error: at('error'),
        fatal: at('fatal'),
        child() {
            return this;
        },
    };
};

function fakeClient() {
    const client = new EventEmitter();
    client.log = quietLog();
    client.session = { uniqueId: 'session-1' };
    client.node = 3;

    const output = new EventEmitter();
    output.writableLength = 0;
    client.term = {
        output,
        termWidth: 80,
        termHeight: 25,
        outputEncoding: 'cp437',
        written: [],
        raw: [],
        write(s) {
            this.written.push(s);
        },
        rawWrite(b) {
            this.raw.push(Buffer.from(b));
        },
    };
    return client;
}

//
//  A worker as the session sees it. Asked to 'stop', it answers as
//  amiga_worker.js does: 'synced' (|syncReply|), then exits; with |autoStop|
//  false a test plays that part itself.
//
class FakeWorker extends EventEmitter {
    constructor() {
        super();
        this.posted = [];
        this.terminated = false;
        this.autoStop = true;
        this.syncReply = { writes: 0, bytes: 0, sessionWrites: 0, ms: 1 };
    }
    postMessage(msg) {
        this.posted.push(msg);
        if ('stop' === msg.type && this.autoStop) {
            setImmediate(() => {
                this.emit('message', Object.assign({ type: 'synced' }, this.syncReply));
                this.emit('exit', 0);
            });
        }
    }
    terminate() {
        this.terminated = true;
    }
    sent(type) {
        return this.posted.filter(m => m.type === type);
    }
    frames(type) {
        return this.posted
            .filter(m => 'frame' === m.type && m.frame.type === type)
            .map(m => m.frame);
    }
}

//
//  What amiga_worker.js makes of the shim's bytes: door data as 'output',
//  X as 'exit', every other frame as 'frame'.
//
function workerMessages(link, bytes) {
    const msgs = [];
    for (const e of link.push(bytes)) {
        if (e.data) {
            msgs.push({ type: 'output', data: e.data });
        } else if ('X' === e.frame.type) {
            msgs.push({ type: 'exit', status: e.frame.keys.status, keys: e.frame.keys });
        } else {
            msgs.push({
                type: 'frame',
                frame: { type: e.frame.type, keys: e.frame.keys },
            });
        }
    }
    return msgs;
}

function makeSession(extraConfig, options = {}) {
    const client = fakeClient();
    const worker = new FakeWorker();
    const cache = new SnapshotCache({ maxEntries: 4 });
    const session = new AmigaDoorSession(
        Object.assign(
            {
                client,
                config: config(extraConfig),
                worker,
                cacheKey: 'k',
                cache,
                sessionKeys: { timeleft: 60, rows: 25, cols: 80 },
                rawOutput: false,
                timeouts: { exitAfterDisconnect: 30 },
            },
            options
        )
    );
    const done = new Promise(resolve => session.once('done', resolve));
    session.start();
    //  the worker says it has sent `s`
    worker.emit('message', { type: 'ready', restored: true, ms: 60, restoreMs: 35 });
    return { client, worker, cache, session, done };
}

const deliver = (worker, msgs) => msgs.forEach(m => worker.emit('message', m));

//
//  The menu module with the parts that need a live system stubbed: runDoor()
//  (the emulator), pausePrompt() and prevMenu(). |outcome| settles with 'ran'
//  or 'refused' when initSequence() is through.
//
function makeModule(extraConfig, client = fakeClient()) {
    client.menuStack = { prev: () => {} };
    const m = new AmigaDoorModule({
        menuConfig: { config: Object.assign({}, BASE, extraConfig) },
        client,
    });
    m.outcome = new Promise(resolve => {
        m.runDoor = () => resolve('ran');
        m.prevMenu = () => resolve('refused');
    });
    m.pausePrompt = (position, cb) => (cb || position)();
    return m;
}

const startModule = m => {
    m.initSequence();
    return m.outcome;
};

// ─── config ───────────────────────────────────────────────────────────────────

describe('amiga_door config', () => {
    it('requires name, image and door', () => {
        const { problems } = normalizeConfig({});
        for (const key of ['name', 'image', 'door']) {
            assert.ok(
                problems.some(p => p.includes(`"${key}" is required`)),
                `no problem reported for ${key}: ${problems}`
            );
        }
    });

    it('fills in the documented defaults', () => {
        const c = config();
        assert.equal(c.cpu, '68EC020');
        assert.equal(c.chipKb, 512);
        assert.equal(c.slowKb, 512);
        assert.equal(c.fastKb, 8192);
        assert.equal(c.overclock, 1);
        assert.equal(c.baud, 115200);
        assert.equal(c.nodeMax, 0);
        assert.equal(c.encoding, 'latin1');
        assert.equal(c.font, 'topaz');
        assert.equal(c.persist, true);
        assert.equal(c.persistOn, undefined, 'retired');
        assert.equal(c.sharedState, false);
        assert.equal(c.log, false);
        assert.equal(c.warpBootSeconds, 30);
        assert.equal(c.regTimeoutSeconds, 30);
        assert.equal(c.crlf, true);
        assert.equal(c.disconnectGraceSeconds, 35);
        assert.equal(c.doorType, 'xim');
        assert.equal(c.consoleMode, 'cooked');
    });

    it('takes doorType xim or cli, and consoleMode only with cli', () => {
        assert.equal(config({ doorType: 'cli' }).doorType, 'cli');
        assert.equal(config({ doorType: 'cli', consoleMode: 'raw' }).consoleMode, 'raw');
        assert.ok(
            problemsOf({ doorType: 'paragon' }).some(p => p.includes('"doorType"'))
        );
        assert.ok(
            problemsOf({ doorType: 'cli', consoleMode: 'line' }).some(p =>
                p.includes('"consoleMode"')
            )
        );
        assert.ok(
            problemsOf({ consoleMode: 'raw' }).some(p =>
                p.includes('doorType "cli" only')
            )
        );
    });

    it('takes doorType aim with the script as an absolute Amiga path', () => {
        const c = config({ doorType: 'aim', door: 'BBS:Doors/KickBox.Rexx' });
        assert.equal(c.doorType, 'aim');
        assert.deepEqual(
            problemsOf({ doorType: 'aim', door: 'DOORS:OMN/Death/Death.rexx' }),
            []
        );
        for (const door of [
            'Doors/KickBox.Rexx', //  relative
            'BBS:Doors/Kick Box.Rexx', //  a blank splits RX's command line
            'BBS:Doors/"x".rexx',
            'BBS:Doors/x.rexx;Delete SYS:#?',
            'BBS:Doors/', //  a directory
            'BBS:',
        ]) {
            assert.ok(
                problemsOf({ doorType: 'aim', door }).some(p =>
                    p.includes('doorType "aim" must be the script')
                ),
                `no problem reported for ${door}`
            );
        }
        //  XIM and CLI doors keep their looser rule
        assert.deepEqual(problemsOf({ door: 'BBS:Doors/a b' }), []);
        for (const doorType of ['xim', 'cli']) {
            for (const door of [
                'BBS:Doors/"x"',
                'BBS:Doors/x*N',
                'BBS:Doors/`x`',
                'BBS:Doors/$x',
                'BBS:Doors/x;y',
                'BBS:Doors/x>y',
                'BBS:Doors/x|y',
            ]) {
                assert.ok(
                    problemsOf({ doorType, door }).some(p =>
                        p.includes('shell characters')
                    ),
                    `${doorType}: no problem reported for ${door}`
                );
            }
        }
        for (const key of ['door', 'doorDir', 'mainline', 'doorArgs']) {
            assert.ok(
                problemsOf({ [key]: 'BBS:Doors/a\x07b' }).some(p =>
                    p.includes('control')
                ),
                key
            );
            assert.ok(
                problemsOf({ [key]: 'BBS:Doors/\x9bx' }).some(p => p.includes('control')),
                `${key}: C1`
            );
            assert.ok(
                problemsOf({ [key]: 'BBS:Doors/雪' }).some(p => p.includes('Latin-1')),
                `${key}: not Latin-1`
            );
        }
        assert.ok(
            problemsOf({
                doorType: 'aim',
                door: 'BBS:Doors/KickBox.Rexx',
                consoleMode: 'raw',
            }).some(p => p.includes('doorType "cli" only'))
        );
    });

    it('takes doorType tim (Paragon) with the door path quoted, as XIM', () => {
        const c = config({ doorType: 'tim', door: 'BBS:Doors/MSE/MSE' });
        assert.equal(c.doorType, 'tim');
        assert.deepEqual(
            problemsOf({ doorType: 'tim', door: 'BBS:Doors/Land of VEX/x' }),
            []
        );
        for (const door of ['BBS:Doors/"x"', 'BBS:Doors/x;y', 'BBS:Doors/`x`']) {
            assert.ok(
                problemsOf({ doorType: 'tim', door }).some(p =>
                    p.includes('shell characters')
                ),
                `no problem reported for ${door}`
            );
        }
        assert.ok(
            problemsOf({ doorType: 'tim', consoleMode: 'raw' }).some(p =>
                p.includes('doorType "cli" only')
            )
        );
    });

    it('takes doorType cnetrexx (C-Net ARexx) with the script as an absolute Amiga path', () => {
        const c = config({ doorType: 'cnetrexx', door: 'PFILES:Badlibs/badlibs' });
        assert.equal(c.doorType, 'cnetrexx');
        assert.deepEqual(
            problemsOf({
                doorType: 'cnetrexx',
                door: 'PFILES:Badlibs/badlibs',
                panicGraceSeconds: 0,
                wordWrap: false,
                assigns: { PFILES: 'BBS:PFiles' },
            }),
            []
        );
        for (const door of [
            'Badlibs/badlibs', //  relative
            'PFILES:Bad Libs/badlibs', //  a blank ends the script's name
            'PFILES:x;y',
            'PFILES:',
        ]) {
            assert.ok(
                problemsOf({ doorType: 'cnetrexx', door }).some(p =>
                    p.includes('doorType "cnetrexx" must be the script')
                ),
                `no problem reported for ${door}`
            );
        }
        for (const v of [-1, 26, 2.5, '10']) {
            assert.ok(
                problemsOf({
                    doorType: 'cnetrexx',
                    door: 'PFILES:x',
                    panicGraceSeconds: v,
                }).some(p => p.includes('"panicGraceSeconds" must be')),
                `panicGraceSeconds ${v}`
            );
        }
        assert.ok(
            problemsOf({ doorType: 'cnetrexx', door: 'PFILES:x', wordWrap: 'no' }).some(
                p => p.includes('"wordWrap" must be')
            )
        );
        for (const doorType of ['xim', 'aim', 'tim', 'cli']) {
            for (const [key, value] of [
                ['panicGraceSeconds', 5],
                ['wordWrap', false],
            ]) {
                assert.ok(
                    problemsOf({ doorType, door: 'BBS:x', [key]: value }).some(p =>
                        p.includes(`"${key}" applies to doorType "cnetrexx" only`)
                    ),
                    `${doorType} ${key}`
                );
            }
        }
        const { warnings } = normalizeConfig(
            Object.assign({}, BASE, {
                doorType: 'cnetrexx',
                door: 'PFILES:x',
                panicGraceSeconds: 3,
                wordWrap: true,
            })
        );
        assert.deepEqual(warnings, [], 'panicGraceSeconds and wordWrap are known keys');
    });

    it('takes assigns and env as NAME: value objects the shim can hold', () => {
        const { problems, warnings } = normalizeConfig(
            Object.assign({}, BASE, {
                doorType: 'tim',
                assigns: { 'MSE:': 'BBS:Doors/MSE', T: 'RAM:' },
                env: { MSE: '', 'Opts.1': 'FAST TIME' },
            })
        );
        assert.deepEqual(problems, []);
        assert.deepEqual(warnings, [], 'assigns and env are known keys');
        //  any door type may use them
        assert.deepEqual(problemsOf({ assigns: { MSE: 'BBS:Doors/MSE' } }), []);

        const bad = [
            [{ assigns: 'MSE=BBS:Doors/MSE' }, '"assigns" must be an object'],
            [{ env: ['MSE'] }, '"env" must be an object'],
            [{ assigns: { 'M S': 'BBS:' } }, 'name "M S"'],
            [{ assigns: { 'a/b': 'BBS:' } }, 'name "a/b"'],
            [{ env: { 'X:': 'y' } }, 'name "X:"'],
            [{ env: { 'A=B': 'y' } }, 'name "A=B"'],
            [{ assigns: { MSE: '' } }, '"assigns.MSE" must be an Amiga path'],
            [{ assigns: { MSE: 'BBS:a;b' } }, '"assigns.MSE"'],
            [{ env: { MSE: 'x\ny' } }, '"env.MSE"'],
            [{ env: { MSE: 'x\x07' } }, '"env.MSE"'],
            [{ env: { MSE: 7 } }, '"env.MSE"'],
            [{ env: { MSE: '雪' } }, '"env.MSE"'],
            [{ env: { A: 'x'.repeat(200) } }, 'the shim takes 199'],
        ];
        for (const [extra, want] of bad) {
            assert.ok(
                problemsOf(extra).some(p => p.includes(want)),
                `${JSON.stringify(extra)}: ${problemsOf(extra)}`
            );
        }
    });

    it('knows the doorArgs placeholders', () => {
        assert.deepEqual(
            problemsOf({
                doorArgs: '{name} ACCESS {level} TIMELEFT {timeleft} NODE {node}',
            }),
            []
        );
        assert.ok(
            problemsOf({ doorArgs: '{name} {realname}' }).some(
                p => p.includes('"doorArgs"') && p.includes('{realname}')
            )
        );
    });

    it('refuses a CPU the core does not have', () => {
        assert.ok(problemsOf({ cpu: '68030' }).some(p => p.includes('"cpu"')));
        assert.deepEqual(problemsOf({ cpu: '68ec020' }), []);
        assert.equal(config({ cpu: 68000 }).cpu, '68000');
    });

    it('bounds fast RAM at 8 MB in 64 KB steps', () => {
        assert.ok(problemsOf({ fastKb: 16384 }).some(p => p.includes('"fastKb"')));
        assert.ok(problemsOf({ fastKb: 100 }).some(p => p.includes('"fastKb"')));
        assert.deepEqual(problemsOf({ fastKb: 0 }), []);
        assert.deepEqual(problemsOf({ fastKb: 8192 }), []);
    });

    it('checks chip and slow RAM and overclock', () => {
        assert.ok(problemsOf({ chipKb: 4096 }).some(p => p.includes('"chipKb"')));
        assert.ok(problemsOf({ slowKb: 100 }).some(p => p.includes('"slowKb"')));
        assert.ok(problemsOf({ overclock: 17 }).some(p => p.includes('"overclock"')));
    });

    it('takes baud from the usual line rates only', () => {
        for (const baud of [9600, 19200, 38400, 57600, 115200, 230400]) {
            assert.equal(config({ baud }).baud, baud);
        }
        assert.equal(config({ baud: 57600, overclock: 2 }).baud, 57600);
        for (const baud of [0, 300, 11520, 38400.5, 460800, '38400', null, true]) {
            assert.ok(
                problemsOf({ baud }).some(p =>
                    p.includes(
                        '"baud" must be one of 9600, 19200, 38400, 57600, 115200, 230400'
                    )
                ),
                `no problem reported for ${JSON.stringify(baud)}`
            );
        }
        assert.deepEqual(
            normalizeConfig(Object.assign({ baud: 38400 }, BASE)).warnings,
            []
        );
    });

    it('wants 1 MB of RAM with the AROS ROM, not with a Kickstart', () => {
        const small = { chipKb: 512, slowKb: 0, fastKb: 0 };
        assert.ok(problemsOf(small).some(p => p.includes('1 MB')));
        assert.deepEqual(problemsOf(Object.assign({ rom: '/roms/kick.rom' }, small)), []);
    });

    it('sharedState makes nodeMax 1 only when nodeMax is unset', () => {
        assert.equal(config({ sharedState: true }).nodeMax, 1);
        assert.equal(config({ sharedState: true, nodeMax: 3 }).nodeMax, 3);
        assert.equal(config({ sharedState: true, nodeMax: 0 }).nodeMax, 0);
        assert.equal(config({ sharedState: false }).nodeMax, 0);
    });

    it('accepts and ignores persistOn, whatever it says, with a warning', () => {
        for (const persistOn of [['ok', 'carrier'], 'ok', ['ok', 'hangup'], 42]) {
            const {
                config: c,
                problems,
                warnings,
            } = normalizeConfig(Object.assign({}, BASE, { persistOn }));
            assert.deepEqual(problems, [], JSON.stringify(persistOn));
            assert.deepEqual(warnings, [PersistOnIgnored]);
            assert.equal(c.persistOn, undefined);
            assert.equal(c.persist, true);
        }
        assert.match(
            PersistOnIgnored,
            /persistOn.*ignored since 0\.6\.0.*as the door makes them/
        );
        assert.deepEqual(normalizeConfig(BASE).warnings, []);
    });

    it('wants an .hdf image, after symlinks', () => {
        assert.deepEqual(problemsOf({ image: '/doors/x.HDF' }), []);
        for (const image of ['/doors/x.img', '/doors/x.hdz', '/doors/x']) {
            assert.ok(
                problemsOf({ image }).some(p => /"image" must be an \.hdf file/.test(p)),
                image
            );
        }
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amiga_door_ext_'));
        try {
            const real = path.join(dir, 'real.img');
            fs.writeFileSync(real, Buffer.alloc(512));
            const link = path.join(dir, 'door.hdf');
            fs.symlinkSync(real, link);
            assert.ok(
                problemsOf({ image: link }).some(p => p.includes('.hdf')),
                'the emulator goes by the real name'
            );
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('translates Amiga console controls by default for Latin-1 only', () => {
        assert.equal(config().amigaConsole, true);
        assert.equal(config({ encoding: 'ISO-8859-1' }).amigaConsole, true);
        assert.equal(config({ encoding: 'cp437' }).amigaConsole, false);
        assert.equal(
            config({ encoding: 'cp437', amigaConsole: true }).amigaConsole,
            true
        );
        assert.equal(config({ amigaConsole: false }).amigaConsole, false);
        assert.ok(
            problemsOf({ amigaConsole: 'yes' }).some(p => p.includes('"amigaConsole"'))
        );
    });

    it('checks font and encoding', () => {
        assert.deepEqual(problemsOf({ font: 'none' }), []);
        assert.deepEqual(problemsOf({ font: 'Amiga Topaz 2+' }), []);
        assert.ok(problemsOf({ font: 'comic sans' }).some(p => p.includes('"font"')));
        assert.ok(
            problemsOf({ encoding: 'klingon' }).some(p => p.includes('"encoding"'))
        );
    });

    it('keeps line breaks out of what goes into the s frame', () => {
        assert.ok(problemsOf({ mainline: 'G\nX' }).some(p => p.includes('"mainline"')));
    });

    it('warns about keys nothing reads, with a likely meaning', () => {
        const { problems, warnings } = normalizeConfig(
            Object.assign({}, BASE, {
                persistOnn: ['ok', 'carrier'],
                persistt: true,
                nodemax: 2,
                frobnicate: true,
                _comment: 'ignored',
                cls: true, //  MenuModule's
                menuFlags: [],
            })
        );
        assert.deepEqual(problems, []);
        assert.deepEqual(warnings, [
            //  never a retired key as the likely meaning
            'unknown key "persistOnn"',
            'unknown key "persistt"; did you mean "persist"?',
            'unknown key "nodemax"; did you mean "nodeMax"?',
            'unknown key "frobnicate"',
        ]);
        assert.deepEqual(normalizeConfig(BASE).warnings, []);
    });

    it('warns about an image over 2032 KB only for a custom ROM', () => {
        const image = path.join(os.tmpdir(), `amiga_door_big_${process.pid}.hdf`);
        try {
            fs.writeFileSync(image, '');
            fs.truncateSync(image, 4066 * 512);
            const rom = '/x/aros-rom.bin';
            //  the limit itself is fine, with either ROM
            for (const extra of [{}, { rom }]) {
                assert.deepEqual(
                    normalizeConfig(Object.assign({}, BASE, { image }, extra)).warnings,
                    []
                );
            }
            fs.truncateSync(image, 4 * 1024 * 1024);
            //  the bundled ROM carries the FFS fix: never a warning
            assert.deepEqual(
                normalizeConfig(Object.assign({}, BASE, { image })).warnings,
                []
            );
            //  a ROM supplied by the sysop may be an AROS build without the fix
            const { warnings } = normalizeConfig(Object.assign({}, BASE, { image, rom }));
            assert.equal(warnings.length, 1);
            assert.match(
                warnings[0],
                /4096 KB.*if this ROM is an AROS build from before 2026-10-19.*2032 KB.*enigma-vamiga 0\.1\.2/
            );
        } finally {
            fs.rmSync(image, { force: true });
        }
    });

    it('reports every problem at once', () => {
        const { problems } = normalizeConfig(
            Object.assign({}, BASE, { cpu: 'z80', fastKb: 9999, crlf: 'yes' })
        );
        assert.equal(problems.length, 3, problems.join('; '));
    });
});

// ─── Amiga console translation ────────────────────────────────────────────────

describe('amiga_door Amiga console translation', () => {
    const t = () => new AmigaConsoleTranslator();
    const latin1 = s => Buffer.from(s, 'latin1');

    it('turns a form feed into clear screen and home', () => {
        const out = t().push(latin1('ab\x0ccd'));
        assert.strictEqual(out.toString('latin1'), 'ab\x1b[2J\x1b[Hcd');
    });

    it('maps the Amiga cursor off and on sequences', () => {
        const tr = t();
        assert.strictEqual(tr.push(latin1('\x1b[0 p')).toString('latin1'), '\x1b[?25l');
        assert.strictEqual(tr.push(latin1('\x1b[1 p')).toString('latin1'), '\x1b[?25h');
        assert.strictEqual(tr.push(latin1('\x1b[ p')).toString('latin1'), '\x1b[?25h');
    });

    it('translates the single-byte CSI and leaves other sequences alone', () => {
        const out = t().push(
            Buffer.from([
                0x9b, 0x31, 0x6d, 0x41, 0x1b, 0x5b, 0x32, 0x36, 0x3b, 0x30, 0x48,
            ])
        );
        assert.strictEqual(out.toString('latin1'), '\x1b[1mA\x1b[26;0H');
    });

    it('resets without touching the font', () => {
        assert.strictEqual(
            t().push(latin1('x\x1bcy')).toString('latin1'),
            'x\x1b[0m\x1b[2J\x1b[Hy'
        );
    });

    it('holds a sequence split across chunks and emits it whole', () => {
        const tr = t();
        assert.strictEqual(tr.push(latin1('A\x1b[0')).toString('latin1'), 'A');
        assert.strictEqual(tr.push(latin1(' ')).toString('latin1'), '');
        assert.strictEqual(tr.push(latin1('pB')).toString('latin1'), '\x1b[?25lB');
        assert.strictEqual(tr.flush().length, 0);
    });

    it('passes an unfinished sequence through on flush', () => {
        const tr = t();
        tr.push(latin1('\x1b[3'));
        assert.strictEqual(tr.flush().toString('latin1'), '\x1b[3');
        assert.strictEqual(tr.flush().length, 0);
    });

    it('gives up on a sequence that grows past any real one', () => {
        const out = t().push(latin1('\x1b[' + '1;'.repeat(20) + 'X'));
        assert.ok(out.length > 0);
        assert.ok(out.toString('latin1').startsWith('\x1b[1;1;'));
    });

    it('moves cursor positions past the screen onto its last row and column', () => {
        const tr = new AmigaConsoleTranslator({ rows: 25, cols: 80 });
        assert.strictEqual(
            tr.push(latin1('\x1b[26;0H')).toString('latin1'),
            '\x1b[25;0H'
        );
        assert.strictEqual(
            tr.push(latin1('\x1b[27;81f')).toString('latin1'),
            '\x1b[25;80f'
        );
        assert.strictEqual(tr.push(latin1('\x1b[32d')).toString('latin1'), '\x1b[25d');
        assert.strictEqual(
            tr.push(latin1('\x1b[24;80H')).toString('latin1'),
            '\x1b[24;80H'
        );
        assert.strictEqual(tr.push(latin1('\x1b[H')).toString('latin1'), '\x1b[H');
    });

    it('follows a resize and clamps nothing while the size is unknown', () => {
        const tr = new AmigaConsoleTranslator();
        assert.strictEqual(
            tr.push(latin1('\x1b[40;1H')).toString('latin1'),
            '\x1b[40;1H'
        );
        tr.setSize(30, 100);
        assert.strictEqual(
            tr.push(latin1('\x1b[40;1H')).toString('latin1'),
            '\x1b[30;1H'
        );
        assert.strictEqual(
            tr.push(latin1('\x1b[29;120H')).toString('latin1'),
            '\x1b[29;100H'
        );
    });

    it('keeps Latin-1 text bytes untouched', () => {
        const bytes = Buffer.from([0xe9, 0xb7, 0xa4, 0x0d, 0x0a]);
        assert.deepStrictEqual(t().push(bytes), bytes);
    });
});

// ─── 0x9B ─────────────────────────────────────────────────────────────────────

describe('amiga_door 0x9B translation', () => {
    it('turns the Amiga CSI into ESC [', () => {
        const out = amigaCsiToAnsi(
            Buffer.from([0x9b, 0x31, 0x6d, 0x41, 0x9b, 0x30, 0x6d])
        );
        assert.equal(out.toString('latin1'), '\x1b[1mA\x1b[0m');
    });

    it('returns the same buffer when there is nothing to do', () => {
        const buf = Buffer.from('\x1b[1mplain\xe9', 'latin1');
        assert.equal(amigaCsiToAnsi(buf), buf);
    });

    it('leaves the rest of Latin-1 alone', () => {
        const out = amigaCsiToAnsi(Buffer.from([0xe9, 0x9b, 0x9c, 0x9a]));
        assert.deepEqual([...out], [0xe9, 0x1b, 0x5b, 0x9c, 0x9a]);
    });

    it('knows Latin-1 by its names', () => {
        for (const name of ['latin1', 'ISO-8859-1', 'iso8859-1', 'binary']) {
            assert.ok(isLatin1(name), name);
        }
        assert.ok(!isLatin1('cp437'));
    });
});

// ─── host link ────────────────────────────────────────────────────────────────

describe('amiga_door host link', () => {
    const hello = protocol.encode('H', { version: 1, shim: 'axshim 1.0' });
    const ready = protocol.encode('R');

    it('skips the ROM boot noise up to the hello frame', () => {
        const link = new HostLink();
        const noise = Buffer.from('ROMInfo: 1MiB ROM detected\r\nromtaginit done\r\n');
        const events = link.push(Buffer.concat([noise, hello, ready]));
        assert.deepEqual(
            events.map(e => e.frame && e.frame.type),
            ['H', 'R']
        );
        assert.equal(link.discarded, noise.length);
        assert.equal(link.hello.shim, 'axshim 1.0');
    });

    it('finds a hello split across chunks, RS last', () => {
        const link = new HostLink();
        const all = Buffer.concat([Buffer.from('noise'), hello, ready]);
        const cut = 'noise'.length + 1; //  right after the RS
        assert.deepEqual(link.push(all.subarray(0, cut)), []);
        const events = link.push(all.subarray(cut));
        assert.deepEqual(
            events.map(e => e.frame.type),
            ['H', 'R']
        );
    });

    it('decodes door data once past the hello', () => {
        const link = new HostLink();
        link.push(Buffer.concat([hello, ready]));
        const events = link.push(Buffer.from([0x41, 0x1e, 0x1e, 0x42]));
        assert.equal(events.length, 1);
        assert.deepEqual([...events[0].data], [0x41, 0x1e, 0x42]);
    });

    it('a restored link starts decoding at once', () => {
        const link = new HostLink({ helloSeen: true });
        const events = link.push(protocol.encode('L', { door: 'x', pid: 0 }));
        assert.equal(events[0].frame.type, 'L');
    });
});

// ─── snapshot cache ───────────────────────────────────────────────────────────

describe('amiga_door snapshot cache', () => {
    const stat = { mtimeMs: 1000, size: 4096, ino: 77, dev: 3 };
    const machine = config();

    it('keys on image, ROMs, machine and the enigma-vamiga version', () => {
        const k = SnapshotCache.keyFor('/doors/a.hdf', machine, '0.2.0');
        assert.equal(k, SnapshotCache.keyFor('/doors/../doors/a.hdf', machine, '0.2.0'));
        assert.notEqual(k, SnapshotCache.keyFor('/doors/b.hdf', machine, '0.2.0'));
        assert.notEqual(k, SnapshotCache.keyFor('/doors/a.hdf', machine, '0.2.1'));
        for (const change of [
            { cpu: '68000' },
            { chipKb: 1024 },
            { slowKb: 0 },
            { fastKb: 4096 },
            { overclock: 2 },
            { rom: '/roms/kick.rom' },
            { extRom: '/roms/ext.rom' },
        ]) {
            const other = Object.assign({}, machine, change);
            assert.notEqual(
                k,
                SnapshotCache.keyFor('/doors/a.hdf', other, '0.2.0'),
                JSON.stringify(change)
            );
        }
        //  things a booted machine does not depend on
        const same = Object.assign({}, machine, { font: 'none', log: true, nodeMax: 9 });
        assert.equal(k, SnapshotCache.keyFor('/doors/a.hdf', same, '0.2.0'));
    });

    it('stores a shared copy and hands it back while the image is unchanged', () => {
        const cache = new SnapshotCache();
        const key = SnapshotCache.keyFor('/doors/a.hdf', machine);
        const stored = cache.set(key, Buffer.from([1, 2, 3]), {}, stat);
        assert.ok(stored.buffer instanceof SharedArrayBuffer);
        const hit = cache.lookup(key, Object.assign({ atimeMs: 5 }, stat));
        assert.deepEqual([...hit.snapshot], [1, 2, 3]);
        assert.deepEqual(hit.meta, {});
        assert.equal(cache.lookup('nope', stat), null);
        assert.equal(cache.meta('nope'), undefined);
        cache.set(key, Buffer.from([4]), { serialHandshake: true }, stat);
        assert.deepEqual(cache.lookup(key, stat).meta, { serialHandshake: true });
    });

    it('drops an entry once the image is not the file it was taken with', () => {
        const key = SnapshotCache.keyFor('/doors/a.hdf', machine);
        for (const change of [
            { mtimeMs: 1001 },
            { size: 8192 },
            { ino: 78 },
            { dev: 4 },
        ]) {
            const cache = new SnapshotCache();
            cache.set(key, Buffer.from([1]), {}, stat);
            const now = Object.assign({}, stat, change);
            const miss = cache.lookup(key, now);
            assert.equal(miss.stale, true, JSON.stringify(change));
            assert.deepEqual(miss.was, stat);
            assert.equal(cache.size, 0, 'dropped');
            assert.equal(cache.lookup(key, now), null);
        }
    });

    it('keeps no snapshot it cannot check against its image', () => {
        const cache = new SnapshotCache();
        const key = SnapshotCache.keyFor('/doors/a.hdf', machine);
        assert.equal(cache.set(key, Buffer.from([1])), null);
        assert.equal(cache.size, 0);
    });

    it('evicts the least recently used past maxEntries', () => {
        const cache = new SnapshotCache({ maxEntries: 2 });
        const keys = ['a', 'b', 'c'].map(n =>
            SnapshotCache.keyFor(`/doors/${n}.hdf`, machine)
        );
        cache.set(keys[0], Buffer.from([0]), {}, stat);
        cache.set(keys[1], Buffer.from([1]), {}, stat);
        cache.lookup(keys[0], stat); //  a is now more recent than b
        cache.set(keys[2], Buffer.from([2]), {}, stat);
        assert.equal(cache.size, 2);
        assert.ok(cache.lookup(keys[0], stat));
        assert.equal(cache.lookup(keys[1], stat), null);
        assert.ok(cache.lookup(keys[2], stat));
    });

    it('invalidates every snapshot of one image, or drops one entry', () => {
        const cache = new SnapshotCache();
        const a1 = SnapshotCache.keyFor('/doors/a.hdf', machine);
        const a2 = SnapshotCache.keyFor(
            '/doors/a.hdf',
            Object.assign({}, machine, { cpu: '68000' })
        );
        const b = SnapshotCache.keyFor('/doors/b.hdf', machine);
        [a1, a2, b].forEach(k => cache.set(k, Buffer.from([9]), {}, stat));
        assert.equal(cache.invalidateImage('/doors/./a.hdf'), 2);
        assert.equal(cache.size, 1);
        assert.ok(cache.lookup(b, stat));
        assert.equal(cache.drop(b), true);
        assert.equal(cache.drop(b), false);
        assert.equal(cache.size, 0);
    });

    it('caches nothing with maxEntries 0', () => {
        const cache = new SnapshotCache({ maxEntries: 0 });
        assert.equal(
            cache.set(SnapshotCache.keyFor('/a', machine), Buffer.from([1]), {}, stat),
            null
        );
        assert.equal(cache.size, 0);
    });
});

// ─── enigma-vamiga version ────────────────────────────────────────────────────

describe('amiga_door enigma-vamiga version', () => {
    class Current {
        hdfSync() {}
        setWriteThrough() {}
    }
    class Old {
        persistHdf() {}
    }
    const pkg = (VAmiga, version) => () => ({ pkg: { VAmiga }, version });

    it('compares major.minor.patch, a prerelease counting as its version', () => {
        assert.ok(versionAtLeast('0.2.0', '0.2.0'));
        assert.ok(versionAtLeast('0.2.0-dev', '0.2.0'));
        assert.ok(versionAtLeast('0.10.0', '0.2.0'));
        assert.ok(versionAtLeast('1.0.0', '0.2.0'));
        assert.ok(!versionAtLeast('0.1.3', '0.2.0'));
        assert.ok(!versionAtLeast('0.1.99', '0.2.0'));
        assert.ok(!versionAtLeast(undefined, '0.2.0'));
        assert.ok(!versionAtLeast('junk', '0.2.0'));
    });

    it('accepts 0.2.0 and later with a file-backed disk', () => {
        assert.deepEqual(checkPackage(pkg(Current, '0.2.0-dev')), {
            version: '0.2.0-dev',
            problem: null,
        });
        assert.equal(checkPackage(pkg(Current, '0.3.1')).problem, null);
    });

    it('refuses 0.1.x, or a package without the file-backed disk, naming both versions', () => {
        const old = checkPackage(pkg(Old, '0.1.3'));
        assert.equal(old.version, '0.1.3');
        assert.match(
            old.problem,
            /enigma-vamiga 0\.1\.3 is installed.*need 0\.2\.0 or later/
        );
        assert.match(checkPackage(pkg(Old, '0.2.0')).problem, /0\.2\.0 is installed/);
        assert.match(checkPackage(pkg(Current, '0.1.9')).problem, /0\.1\.9 is installed/);
        const missing = checkPackage(() => {
            throw new Error("Cannot find module 'enigma-vamiga'");
        });
        assert.equal(missing.version, null);
        assert.match(missing.problem, /0\.2\.0 or later is required.*Cannot find module/);
    });

    it('refuses to start a door on an old package, saying why in the log', async () => {
        _test.vamigaPackage = checkPackage(pkg(Old, '0.1.3'));
        try {
            const m = makeModule({});
            assert.equal(await startModule(m), 'refused');
            assert.match(m.client.term.written.join(''), /XIMTest could not be run/);
            const line = m.client.log.lines.find(
                l => 'Could not start Amiga door' === l.msg
            );
            assert.match(line.obj.error, /0\.1\.3 is installed.*0\.2\.0 or later/);
            assert.equal(activeImages.size, 0, 'nothing held');
        } finally {
            _test.vamigaPackage = VAMIGA_OK;
        }
    });
});

// ─── persistOn (retired) ──────────────────────────────────────────────────────

describe('amiga_door persistOn', () => {
    afterEach(() => persistOnWarned.clear());

    it('warns once per door that persistOn does nothing, and runs the door', async () => {
        const warnings = m =>
            m.client.log.lines.filter(
                l => 'warn' === l.level && l.msg.includes('"persistOn" is ignored')
            );
        const name = 'OldMenu';
        //  checkFiles refuses the missing image; the warning comes before it
        const first = makeModule({ name, persistOn: ['ok'] });
        await startModule(first);
        assert.equal(warnings(first).length, 1);
        const again = makeModule({ name, persistOn: ['ok'] });
        await startModule(again);
        assert.equal(warnings(again).length, 0, 'once per door');
        const other = makeModule({ name: 'Another', persistOn: ['ok'] });
        await startModule(other);
        assert.equal(warnings(other).length, 1);
    });
});

// ─── session (frame handling) ─────────────────────────────────────────────────

describe('amiga_door session', () => {
    const warned = (client, re) =>
        client.log.lines.filter(l => 'warn' === l.level && re.test(l.msg));

    it("logs the line rate the shim confirms, and warns when it is not the config's", async () => {
        const link = new HostLink({ helloSeen: true });
        const ok = makeSession({ baud: 38400 });
        deliver(
            ok.worker,
            workerMessages(
                link,
                Buffer.concat([
                    protocol.encode('H', { version: 1, shim: 'axshim 1.5', baud: 38400 }),
                    protocol.encode('L', { door: BASE.door, pid: 0 }),
                ])
            )
        );
        assert.deepEqual(warned(ok.client, /line rate|baud/), []);
        const launched = ok.client.log.lines.find(l => 'Amiga door launched' === l.msg);
        assert.equal(launched.obj.baud, '38400');

        const other = makeSession({ baud: 38400 });
        deliver(
            other.worker,
            workerMessages(
                new HostLink({ helloSeen: true }),
                protocol.encode('H', { version: 1, shim: 'axshim 1.5', baud: 115200 })
            )
        );
        assert.equal(warned(other.client, /another line rate/).length, 1);

        ok.session.disconnect('hangup');
        other.session.disconnect('hangup');
        await Promise.all([ok.done, other.done]);
    });

    it('warns when baud is set and the shim never confirms a rate (axshim 1.4)', async () => {
        const old = makeSession({ baud: 38400 });
        const launch = protocol.encode('L', { door: BASE.door, pid: 0 });
        deliver(old.worker, workerMessages(new HostLink({ helloSeen: true }), launch));
        assert.equal(warned(old.client, /predates 1\.5/).length, 1);

        //  the default rate is what an old shim runs at anyway: nothing to say
        const plain = makeSession();
        deliver(plain.worker, workerMessages(new HostLink({ helloSeen: true }), launch));
        assert.deepEqual(warned(plain.client, /predates/), []);

        old.session.disconnect('hangup');
        plain.session.disconnect('hangup');
        await Promise.all([old.done, plain.done]);
    });

    it('ignores the boot hello: only an H after `s` is the session rate', async () => {
        const client = fakeClient();
        const worker = new FakeWorker();
        const session = new AmigaDoorSession({
            client,
            config: config({ baud: 57600 }),
            worker,
            cacheKey: 'k',
            cache: new SnapshotCache({ maxEntries: 4 }),
            sessionKeys: { timeleft: 60, rows: 25, cols: 80 },
            rawOutput: false,
            timeouts: { exitAfterDisconnect: 30 },
        });
        const done = new Promise(resolve => session.once('done', resolve));
        session.start();
        //  booting: the shim listens at 38400 between sessions
        deliver(worker, [
            {
                type: 'frame',
                frame: { type: 'H', keys: { shim: 'axshim 1.5', baud: '38400' } },
            },
            { type: 'ready', restored: false, ms: 900, restoreMs: null },
            {
                type: 'frame',
                frame: { type: 'H', keys: { shim: 'axshim 1.5', baud: '57600' } },
            },
        ]);
        assert.deepEqual(warned(client, /line rate|baud/), []);
        session.disconnect('hangup');
        await done;
    });

    it('warns once when the worker says the input queue is full', async () => {
        const s = makeSession();
        deliver(s.worker, [{ type: 'inputFull', limit: 1048576 }]);
        const w = warned(s.client, /input queue is full/);
        assert.equal(w.length, 1);
        assert.equal(w[0].obj.limit, 1048576);
        s.session.disconnect('hangup');
        await s.done;
    });

    it('writes door output with 0x9B translated, transcoded or raw', async () => {
        const link = new HostLink({ helloSeen: true });
        const bytes = Buffer.from([0x9b, 0x31, 0x6d, 0xe9, 0x0d, 0x0a]);

        const t = makeSession();
        deliver(t.worker, workerMessages(link, bytes));
        assert.equal(t.client.term.written.join(''), '\x1b[1mé\r\n');

        const r = makeSession({}, { rawOutput: true });
        deliver(r.worker, workerMessages(new HostLink({ helloSeen: true }), bytes));
        assert.deepEqual(
            [...Buffer.concat(r.client.term.raw)],
            [0x1b, 0x5b, 0x31, 0x6d, 0xe9, 0x0d, 0x0a]
        );

        t.session.disconnect('hangup');
        r.session.disconnect('hangup');
        await Promise.all([t.done, r.done]);
    });

    it("leaves a CP437 door's bytes alone: no Amiga console translation", async () => {
        const bytes = Buffer.from([
            0x9b, 0x31, 0x6d, 0x0c, 0x41, 0x1b, 0x5b, 0x32, 0x36, 0x48,
        ]);
        const c = makeSession({ encoding: 'cp437', font: 'none' });
        assert.equal(c.session.config.amigaConsole, false);
        deliver(c.worker, [{ type: 'output', data: bytes }]);
        assert.equal(c.client.term.written.join(''), '¢1m\fA\x1b[26H');

        //  unless asked for
        const forced = makeSession({
            encoding: 'cp437',
            font: 'none',
            amigaConsole: true,
        });
        deliver(forced.worker, [{ type: 'output', data: bytes }]);
        assert.equal(
            forced.client.term.written.join(''),
            '\x1b[1m\x1b[2J\x1b[HA\x1b[25H'
        );

        c.session.disconnect('hangup');
        forced.session.disconnect('hangup');
        await Promise.all([c.done, forced.done]);
    });

    it('decodes a multibyte character split across two chunks', async () => {
        const s = makeSession({ encoding: 'utf8', font: 'none' });
        deliver(s.worker, [
            { type: 'output', data: Buffer.from([0x41, 0xc3]) },
            { type: 'output', data: Buffer.from([0xa9, 0x42]) },
        ]);
        assert.equal(s.client.term.written.join(''), 'AéB');
        s.session.disconnect('hangup');
        await s.done;
    });

    //  A cached snapshot of BASE.image, as onSnapshot() would store one
    const cacheSnapshot = s => {
        const key = SnapshotCache.keyFor(BASE.image, s.session.config, '0.2.0');
        s.cache.set(key, Buffer.from([1]), {}, { size: 1, mtimeMs: 1, ino: 1, dev: 1 });
        return key;
    };
    const closedOf = s => new Promise(r => s.session.once('closed', r));
    const logged = (s, re, level) =>
        s.client.log.lines.find(l => re.test(l.msg) && (!level || level === l.level));

    for (const status of ['ok', 'carrier', 'timeout', 'break', 'error']) {
        it(`X status=${status} ends the session, then the worker syncs the image and stops`, async () => {
            const s = makeSession();
            s.worker.autoStop = false;
            const closed = closedOf(s);
            deliver(
                s.worker,
                workerMessages(
                    new HostLink({ helloSeen: true }),
                    protocol.encode('X', { status, rc: '0', wrote: 1 })
                )
            );
            const result = await s.done;
            assert.equal(result.status, status);
            assert.equal(result.keys.wrote, '1');
            assert.equal(result.persisted, undefined, 'nothing to decide');
            assert.equal(s.worker.sent('stop').length, 1, 'whatever the status');
            assert.equal(s.worker.terminated, false, 'not before it has synced');

            s.worker.emit('message', {
                type: 'synced',
                writes: 3,
                bytes: 12288,
                sessionWrites: 3,
                ms: 4,
            });
            s.worker.emit('exit', 0);
            await closed;
            assert.ok(s.worker.terminated);
            const line = logged(s, /^Amiga door disk synced$/, 'info');
            assert.equal(line.obj.writes, 3);
            assert.equal(line.obj.bytes, 12288);
        });
    }

    it('a session that wrote drops the image snapshots; one that did not keeps them', async () => {
        const wrote = makeSession();
        cacheSnapshot(wrote);
        wrote.worker.syncReply = { writes: 2, bytes: 8192, sessionWrites: 2, ms: 3 };
        const closedWrote = closedOf(wrote);
        deliver(wrote.worker, [{ type: 'exit', status: 'ok', keys: { status: 'ok' } }]);
        await closedWrote;
        assert.equal(wrote.cache.size, 0);
        assert.equal(logged(wrote, /disk synced/).obj.snapshotsDropped, 1);

        //  writes before the session (a boot's) are in the snapshot already
        const idle = makeSession();
        cacheSnapshot(idle);
        idle.worker.syncReply = { writes: 1, bytes: 4096, sessionWrites: 0, ms: 1 };
        const closedIdle = closedOf(idle);
        deliver(idle.worker, [{ type: 'exit', status: 'ok', keys: { status: 'ok' } }]);
        await closedIdle;
        assert.equal(idle.cache.size, 1);
    });

    it('says when a door left its disk alone', async () => {
        const s = makeSession();
        const closed = closedOf(s);
        deliver(s.worker, [{ type: 'exit', status: 'ok', keys: { status: 'ok' } }]);
        await closed;
        assert.ok(logged(s, /left its disk unchanged/, 'info'));
    });

    it('logs a failed sync as such, and still frees the image', async () => {
        const s = makeSession();
        s.worker.syncReply = {
            writes: 1,
            bytes: 4096,
            sessionWrites: 1,
            ms: 2,
            error: 'EIO: i/o error, fsync',
            code: 'EIO',
        };
        const closed = closedOf(s);
        deliver(s.worker, [{ type: 'exit', status: 'ok', keys: { status: 'ok' } }]);
        await closed;
        const line = logged(s, /disk sync FAILED: EIO/, 'warn');
        assert.ok(line);
        assert.equal(line.obj.code, 'EIO');
        assert.ok(s.worker.terminated);
    });

    it('with persist: false nothing is synced and the snapshots stay', async () => {
        const s = makeSession({ persist: false });
        cacheSnapshot(s);
        s.worker.syncReply = { skipped: true };
        const closed = closedOf(s);
        deliver(s.worker, [{ type: 'exit', status: 'ok', keys: { status: 'ok' } }]);
        await closed;
        assert.equal(s.cache.size, 1);
        assert.ok(logged(s, /not synced: persist is off/));
    });

    it('terminates a worker that does not stop within timeouts.stop', async () => {
        const s = makeSession({}, { timeouts: { exitAfterDisconnect: 30, stop: 10 } });
        cacheSnapshot(s);
        s.worker.autoStop = false;
        const closed = closedOf(s);
        deliver(s.worker, [{ type: 'exit', status: 'ok', keys: { status: 'ok' } }]);
        await s.done;
        assert.equal(s.worker.terminated, false);
        await closed;
        assert.ok(s.worker.terminated);
        assert.ok(logged(s, /did not stop within 10 ms/, 'warn'));
        assert.equal(s.cache.size, 0, 'whether it wrote is unknown');
    });

    it('a worker that is gone is not asked to stop', async () => {
        const s = makeSession();
        const closed = closedOf(s);
        s.worker.emit('exit', 1);
        const result = await s.done;
        assert.match(result.error, /exited unexpectedly/);
        await closed;
        assert.equal(s.worker.sent('stop').length, 0);
    });

    it('drops a snapshot the emulator refused', async () => {
        const key = SnapshotCache.keyFor(BASE.image, config(), '0.2.0');
        const s = makeSession({}, { cacheKey: key });
        cacheSnapshot(s);
        deliver(s.worker, [
            {
                type: 'snapshotRefused',
                message: 'Snapshot was created with an older version of vAmiga',
            },
        ]);
        assert.equal(s.cache.size, 0);
        const line = logged(s, /snapshot refused/, 'debug');
        assert.match(line.obj.reason, /older version/);
        assert.equal(line.obj.dropped, true);
        s.session.disconnect('hangup');
        await s.done;
    });

    it('a late error from a finished worker is swallowed', async () => {
        const s = makeSession();
        s.session.disconnect('hangup');
        await s.done;
        assert.doesNotThrow(() => s.worker.emit('error', new Error('late')));
    });

    it('a hangup sends d reason=hangup and waits for X status=carrier', async () => {
        const s = makeSession({}, { timeouts: { exitAfterDisconnect: 5000 } });
        Events().emit(Events().getSystemEvents().ClientDisconnected, {
            client: s.client,
        });
        assert.deepEqual(s.worker.frames('d'), [
            { type: 'd', keys: { reason: 'hangup' } },
        ]);

        //  keystrokes and door output after d go nowhere
        s.client.term.output.emit('data', Buffer.from('x'));
        assert.equal(s.worker.sent('input').length, 0);
        deliver(s.worker, [{ type: 'output', data: Buffer.from('late') }]);
        assert.equal(s.client.term.written.length, 0);

        deliver(s.worker, [
            { type: 'exit', status: 'carrier', keys: { status: 'carrier' } },
        ]);
        const result = await s.done;
        assert.equal(result.status, 'carrier');
        assert.equal(result.reason, 'hangup');
    });

    it('another session disconnecting is not ours', async () => {
        const s = makeSession();
        Events().emit(Events().getSystemEvents().ClientDisconnected, {
            client: { session: { uniqueId: 'someone-else' } },
        });
        assert.equal(s.worker.frames('d').length, 0);
        s.session.disconnect('hangup');
        await s.done;
    });

    it('waits disconnectGraceSeconds (35 s by default) for X after d', () => {
        const c = config();
        const session = new AmigaDoorSession({
            client: fakeClient(),
            config: c,
            worker: new FakeWorker(),
            sessionKeys: null,
        });
        assert.equal(session.timeouts.exitAfterDisconnect, 35000);
        const longer = new AmigaDoorSession({
            client: fakeClient(),
            config: config({ disconnectGraceSeconds: 90 }),
            worker: new FakeWorker(),
            sessionKeys: null,
        });
        assert.equal(longer.timeouts.exitAfterDisconnect, 90000);
        assert.ok(
            problemsOf({ disconnectGraceSeconds: 0 }).some(p =>
                p.includes('"disconnectGraceSeconds"')
            )
        );
    });

    for (const rc of ['0', '-1']) {
        it(`a hangup leaves the door its grace, then syncs what it wrote (rc ${rc})`, async () => {
            const s = makeSession({}, { timeouts: { exitAfterDisconnect: 5000 } });
            const closed = closedOf(s);
            s.session.disconnect('hangup');
            assert.equal(s.worker.sent('stop').length, 0, 'the door may still be saving');
            //  the shim's X comes back within the grace; a door it gave up on
            //  (rc -1) is synced all the same: its writes are in the image
            deliver(s.worker, [
                { type: 'exit', status: 'carrier', keys: { status: 'carrier', rc } },
            ]);
            const result = await s.done;
            assert.equal(result.status, 'carrier');
            assert.equal(result.reason, 'hangup');
            assert.equal(s.worker.sent('stop').length, 1);
            await closed;
            assert.ok(s.worker.terminated);
        });
    }

    it('drops the worker, after a sync, when no X follows d', async () => {
        const s = makeSession();
        const closed = closedOf(s);
        s.session.disconnect('break');
        const result = await s.done;
        assert.equal(result.reason, 'break');
        assert.equal(result.status, undefined);
        assert.equal(s.worker.sent('stop').length, 1);
        await closed;
        assert.ok(s.worker.terminated);
    });

    it("ENiGMA's time-up sends d reason=timeup", async () => {
        const s = makeSession();
        s.client.emit('time up');
        assert.deepEqual(s.worker.frames('d'), [
            { type: 'd', keys: { reason: 'timeup' } },
        ]);
        await s.done;
    });

    it('passes caller input through and refuses the editor', async () => {
        const s = makeSession();
        s.client.term.output.emit('data', Buffer.from('q'));
        assert.deepEqual(
            s.worker.sent('input').map(m => m.data.toString()),
            ['q']
        );

        deliver(
            s.worker,
            workerMessages(
                new HostLink({ helloSeen: true }),
                protocol.encode('E', { file: 'T:msg' })
            )
        );
        assert.deepEqual(s.worker.frames('e'), [
            { type: 'e', keys: { status: 'refused' } },
        ]);

        s.session.disconnect('hangup');
        await s.done;
    });

    it('sends w on a resize and t when the budget changes', async () => {
        const s = makeSession();
        s.client.term.termWidth = 132;
        const sizes = [];
        const setSize = s.session.translator.setSize;
        s.session.translator.setSize = (rows, cols) => {
            sizes.push([rows, cols]);
            return setSize.call(s.session.translator, rows, cols);
        };
        s.session.checkResize();
        s.session.checkResize(); //  once per change
        assert.deepEqual(sizes, [[25, 132]], 'the translator learns the new size');
        assert.deepEqual(s.worker.frames('w'), [
            { type: 'w', keys: { rows: 25, cols: 132 } },
        ]);

        s.session.lastTimeLeft = 61; //  pretend the budget moved
        const UserTime = require('../core/user_time.js');
        const saved = UserTime.getTimeLeftMinutes;
        UserTime.getTimeLeftMinutes = () => 12;
        try {
            s.session.checkTimeLeft();
            s.session.checkTimeLeft();
        } finally {
            UserTime.getTimeLeftMinutes = saved;
        }
        assert.deepEqual(s.worker.frames('t'), [{ type: 't', keys: { timeleft: 12 } }]);

        s.session.disconnect('hangup');
        await s.done;
    });

    it('caches the snapshot a booting worker posts, with its image stat', async () => {
        const key = SnapshotCache.keyFor(BASE.image, config(), '0.2.0');
        const stat = { size: 5, mtimeMs: 5, ino: 5, dev: 5 };
        const s = makeSession({}, { cacheKey: key });
        s.worker.emit('message', {
            type: 'snapshot',
            snapshot: new Uint8Array([7, 7]),
            ms: 40,
            serialHandshake: true,
            stat,
        });
        assert.equal(s.cache.size, 1);
        //  the RTS/CTS setting goes with it, for the workers that restore it
        const hit = s.cache.lookup(key, stat);
        assert.deepEqual(hit.meta, { serialHandshake: true });
        assert.deepEqual([...hit.snapshot], [7, 7]);
        assert.ok(logged(s, /^Amiga door snapshot cached$/));

        //  without a stat there is nothing to check a restore against
        const bare = makeSession({}, { cacheKey: key });
        bare.cache.clear();
        bare.worker.emit('message', {
            type: 'snapshot',
            snapshot: new Uint8Array([7]),
            ms: 40,
        });
        assert.equal(bare.cache.size, 0);
        assert.ok(logged(bare, /not cached \(no stat/));

        s.session.disconnect('hangup');
        bare.session.disconnect('hangup');
        await Promise.all([s.done, bare.done]);
    });

    it('a fatal worker error ends the session; the worker still syncs', async () => {
        const s = makeSession();
        const closed = closedOf(s);
        s.worker.emit('message', {
            type: 'error',
            message: 'The emulated CPU halted',
            code: 'CPU_HALT',
            fatal: true,
        });
        const result = await s.done;
        assert.equal(result.code, 'CPU_HALT');
        assert.equal(s.worker.sent('stop').length, 1);
        await closed;
        assert.ok(s.worker.terminated);
    });

    it('cleans up its listeners', async () => {
        const s = makeSession();
        const closed = closedOf(s);
        s.session.disconnect('hangup');
        await s.done;
        assert.equal(s.client.listenerCount('time up'), 0);
        assert.equal(s.client.term.output.listenerCount('data'), 0);
        //  the worker's, once it has synced and gone
        await closed;
        assert.equal(s.worker.listenerCount('message'), 0);
        assert.equal(s.worker.listenerCount('exit'), 0);
    });
});

function Events() {
    return require('../core/events.js');
}

// ─── server shutdown ──────────────────────────────────────────────────────────

describe('amiga_door server shutdown', function () {
    this.timeout(10000);
    const { Worker } = require('worker_threads');
    const { shutdown } = require('../core/amiga_door/amiga_door.js');
    const HARNESS = path.join(__dirname, 'fixtures/amiga_worker/harness.js');
    let dir;

    beforeEach(() => {
        _test.runningSessions.clear(); //  whatever earlier tests left closing
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amiga_door_shutdown_'));
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    //  A session on a real worker thread (amiga_worker.js on the fake
    //  enigma-vamiga), restored and running
    async function realSession() {
        const image = path.join(dir, 'door.hdf');
        fs.writeFileSync(image, Buffer.alloc(8192));
        const worker = new Worker(HARNESS, {
            workerData: {
                module: null,
                snapshot: new Uint8Array([1]),
                image,
                persist: true,
                machine: {},
                warpBootSeconds: 0,
                session: { version: 1, door: 'BBS:Doors/X/x', node: 1 },
            },
        });
        const client = fakeClient();
        const session = new AmigaDoorSession({
            client,
            config: config({ image }),
            worker,
            sessionKeys: { timeleft: 60, rows: 25, cols: 80 },
            rawOutput: false,
        });
        const ready = new Promise(r =>
            worker.on('message', m => 'ready' === m.type && r())
        );
        session.start();
        await ready;
        return { session, worker, client };
    }

    it('stops a running door, which syncs, and logs it within the bound', async () => {
        const { session, worker } = await realSession();
        //  what the guest's file system still buffers: written when it settles
        worker.postMessage({
            type: 'fake',
            cmd: 'settleWrite',
            offset: 512,
            data: new Uint8Array(512).fill(0x5a),
        });
        const exited = new Promise(r => worker.once('exit', r));
        const log = quietLog();
        const t0 = Date.now();
        await new Promise(r => shutdown(r, { timeoutMs: 3000, log }));
        const ms = Date.now() - t0;
        assert.ok(ms < 3000, `took ${ms} ms`);
        await exited;
        assert.ok(session.finished && session.closeDone);
        assert.equal(_test.runningSessions.size, 0);
        const line = log.lines.find(l => /^Amiga doors at shutdown/.test(l.msg));
        assert.equal(line.level, 'info');
        assert.match(line.msg, /1 synced, 0 not/);
        assert.deepEqual(line.obj.synced, [{ name: BASE.name, node: 3, writes: 1 }]);
        assert.deepEqual(line.obj.notSynced, []);
        const image = fs.readFileSync(path.join(dir, 'door.hdf'));
        assert.ok(
            image.subarray(512, 1024).every(b => 0x5a === b),
            'in the image'
        );
    });

    it('does not wait past the bound for a worker that never answers', async () => {
        const stuck = makeSession();
        stuck.worker.autoStop = false; //  gets stop, never says synced or exits
        const answering = makeSession();
        answering.worker.syncReply = { writes: 2, bytes: 8192, sessionWrites: 2, ms: 1 };
        const log = quietLog();
        const t0 = Date.now();
        await new Promise(r => shutdown(r, { timeoutMs: 150, log }));
        const ms = Date.now() - t0;
        assert.ok(ms >= 140 && ms < 1000, `took ${ms} ms`);
        assert.equal(stuck.worker.sent('stop').length, 1, 'it was asked');
        const line = log.lines.find(l => /^Amiga doors at shutdown/.test(l.msg));
        assert.equal(line.level, 'warn');
        assert.match(line.msg, /1 synced, 1 not/);
        assert.deepEqual(line.obj.synced, [{ name: BASE.name, node: 3, writes: 2 }]);
        assert.deepEqual(line.obj.notSynced, [
            { name: BASE.name, node: 3, why: 'no answer' },
        ]);
        await Promise.all([stuck.done, answering.done]);
        assert.equal((await stuck.done).reason, 'shutdown');
        //  let the stuck one go
        stuck.worker.emit('exit', 0);
    });

    it('calls back at once with nothing running', async () => {
        const log = quietLog();
        await new Promise(r => shutdown(r, { log }));
        assert.equal(log.lines.length, 0);
    });
});

// ─── one persisting session per image ─────────────────────────────────────────

describe('amiga_door image lock', () => {
    let dir;
    let image;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amiga_door_lock_'));
        image = path.join(dir, 'door.hdf');
        fs.writeFileSync(image, Buffer.alloc(16));
    });

    afterEach(() => {
        activeImages.clear();
        for (const k of Object.keys(activeDoorInstances)) {
            delete activeDoorInstances[k];
        }
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('refuses a second persisting session on the same image, of any door', async () => {
        const first = makeModule({ image });
        assert.equal(await startModule(first), 'ran');

        const same = makeModule({ image });
        assert.equal(await startModule(same), 'refused');
        assert.match(same.client.term.written.join(''), /Too many active instances/);

        //  another door, the same file by another name
        const other = makeModule({
            name: 'OtherDoor',
            image: path.join(dir, '.', 'door.hdf'),
        });
        assert.equal(await startModule(other), 'refused');
        assert.equal(activeDoorInstances.OtherDoor || 0, 0, 'no slot kept');

        //  nor does a door that never persists: the image changes under it
        const readOnly = makeModule({ name: 'Viewer', image, persist: false });
        assert.equal(await startModule(readOnly), 'refused');
        assert.match(readOnly.client.term.written.join(''), /Too many active instances/);
        assert.ok(
            readOnly.client.log.lines.some(l =>
                /in use by a session that writes it/.test(l.msg)
            )
        );
    });

    it('lets any number of non-persisting sessions share an image', async () => {
        const viewers = [];
        for (let i = 0; i < 3; i++) {
            const v = makeModule({
                name: i ? `Viewer${i}` : 'Viewer',
                image,
                persist: false,
            });
            assert.equal(await startModule(v), 'ran', `viewer ${i}`);
            viewers.push(v);
        }
        //  the same door twice too: nodeMax 0 is unlimited
        const again = makeModule({ name: 'Viewer', image, persist: false });
        assert.equal(await startModule(again), 'ran');
        viewers.push(again);
        const held = activeImages.get(fs.realpathSync(image));
        assert.equal(held.exclusive, null);
        assert.equal(held.shared.size, 4);

        //  as each leaves its hold goes; the image is free once all have
        for (const v of viewers.slice(0, -1)) {
            v.leave();
        }
        assert.equal(activeImages.get(fs.realpathSync(image)).shared.size, 1);
        viewers[viewers.length - 1].leave();
        assert.equal(activeImages.size, 0);
    });

    it('refuses a persisting session while non-persisting ones are in, and lets it in after', async () => {
        const viewer = makeModule({ name: 'Viewer', image, persist: false });
        assert.equal(await startModule(viewer), 'ran');

        const writer = makeModule({ image });
        const theme = require('../core/theme.js');
        const saved = theme.displayThemeArt;
        let shown;
        theme.displayThemeArt = (opts, cb) => {
            shown = opts.name;
            cb();
        };
        try {
            const busy = makeModule({ image, tooManyArt: 'DOORMANY' });
            assert.equal(await startModule(busy), 'refused');
            assert.equal(shown, 'DOORMANY', 'the usual busy path');
        } finally {
            theme.displayThemeArt = saved;
        }
        assert.equal(await startModule(writer), 'refused');
        assert.ok(
            writer.client.log.lines.some(
                l =>
                    /in use by another session/.test(l.msg) &&
                    1 === l.obj.heldBy.shared.length
            )
        );

        viewer.leave();
        assert.equal(await startModule(makeModule({ image })), 'ran');
    });

    it('keeps sharedState doors at one session (nodeMax 1) as before', async () => {
        const one = makeModule({ image, persist: false, sharedState: true });
        assert.equal(await startModule(one), 'ran');
        const two = makeModule({ image, persist: false, sharedState: true });
        assert.equal(await startModule(two), 'refused');
        assert.ok(
            two.client.log.lines.some(l => /Too many active instances/.test(l.msg))
        );
    });

    it('follows a symlink to the image', async () => {
        const link = path.join(dir, 'link.hdf');
        fs.symlinkSync(image, link);
        assert.equal(await startModule(makeModule({ image })), 'ran');
        assert.equal(
            await startModule(makeModule({ name: 'B', image: link })),
            'refused'
        );
    });

    it('lets separate images run side by side', async () => {
        const second = path.join(dir, 'other.hdf');
        fs.writeFileSync(second, Buffer.alloc(16));
        assert.equal(await startModule(makeModule({ image })), 'ran');
        assert.equal(await startModule(makeModule({ image: second })), 'ran');
    });

    it('shows tooManyArt for a busy image as for nodeMax', async () => {
        assert.equal(await startModule(makeModule({ image })), 'ran');
        const m = makeModule({ image, tooManyArt: 'DOORMANY' });
        const theme = require('../core/theme.js');
        const saved = theme.displayThemeArt;
        let shown;
        theme.displayThemeArt = (opts, cb) => {
            shown = opts.name;
            cb();
        };
        try {
            assert.equal(await startModule(m), 'refused');
        } finally {
            theme.displayThemeArt = saved;
        }
        assert.equal(shown, 'DOORMANY');
    });

    it('holds the slot and the image until the session is over, not until leave()', async () => {
        const m = makeModule({ image });
        assert.equal(await startModule(m), 'ran');
        const s = makeSession({ image }, { client: m.client });
        m._attachSession(s.session, null);
        const closed = new Promise(r => s.session.once('closed', r));
        m.autoNextMenu = () => {};

        m.leave(); //  the caller hung up: d goes out, the door is still running
        assert.deepEqual(s.worker.frames('d'), [
            { type: 'd', keys: { reason: 'hangup' } },
        ]);
        assert.equal(activeDoorInstances[BASE.name], 1);
        assert.equal(await startModule(makeModule({ image })), 'refused');

        deliver(s.worker, [
            { type: 'exit', status: 'carrier', keys: { status: 'carrier' } },
        ]);
        await s.done;
        assert.equal(activeDoorInstances[BASE.name], 0, 'slot freed on done');
        await closed;
        assert.equal(activeImages.size, 0, 'image freed once the worker is gone');
        assert.equal(await startModule(makeModule({ image })), 'ran');
    });

    it('time-up puts the font and scroll region back before the next menu', async () => {
        const m = makeModule({ image });
        assert.equal(await startModule(m), 'ran');
        m.client.term.syncTermFontsEnabled = true;
        m._switchFont();
        assert.ok(m.fontSwitched);
        const s = makeSession({ image }, { client: m.client });
        m._attachSession(s.session, null);
        m.client.term.raw = [];

        //  ENiGMA's time-up: the session sends d, then the menu stack moves
        //  the caller to timeUpLogoff and calls leave()
        m.client.timeUpEmitted = true;
        m.client.emit('time up');
        assert.deepEqual(s.worker.frames('d'), [
            { type: 'd', keys: { reason: 'timeup' } },
        ]);
        m.leave();
        const raw = Buffer.concat(m.client.term.raw).toString('latin1');
        assert.ok(
            raw.includes('\x1b[0;0 D'),
            `font not restored: ${JSON.stringify(raw)}`
        );
        assert.ok(raw.includes('\x1b[r'), 'scroll region not reset');

        //  the door's X later on writes nothing more to the caller
        m.client.term.raw = [];
        deliver(s.worker, [
            { type: 'exit', status: 'timeout', keys: { status: 'timeout' } },
        ]);
        await s.done;
        assert.equal(m.client.term.raw.length, 0);
    });

    //  Something throws after the worker exists: the worker is stopped, and
    //  the slot and the image hold are released exactly once.
    for (const stage of ['font', 'constructor', 'start']) {
        it(`a startup failure (${stage}) stops the worker and frees the slot and image`, async () => {
            const m = makeModule({ image });
            assert.equal(await startModule(m), 'ran');
            assert.equal(activeImages.size, 1);
            assert.equal(activeDoorInstances[BASE.name], 1);
            delete m.runDoor; //  the real one, with its seams below
            m.client.user = {
                userId: 1,
                getProperty: () => undefined,
                getPropertyAsNumber: () => 0,
                getSanitizedName: () => 'Handle',
                getLegacySecurityLevel: () => 30,
                isAuthenticated: () => false,
                isRoot: () => false,
                isGroupMember: () => false,
            };

            const worker = new FakeWorker();
            let terminated = 0;
            worker.terminate = () => {
                terminated++;
                worker.terminated = true;
            };
            m._compiledModule = async () => ({});
            m._newWorker = () => worker;
            const realStart = AmigaDoorSession.prototype.start;
            if ('font' === stage) {
                m._switchFont = () => {
                    throw new Error('font boom');
                };
            } else if ('constructor' === stage) {
                m._attachSession = () => {
                    throw new Error('constructor boom');
                };
            } else {
                AmigaDoorSession.prototype.start = () => {
                    throw new Error('start boom');
                };
            }

            const ended = new Promise(resolve => {
                m.autoNextMenu = resolve;
            });
            try {
                m.runDoor();
                await ended;
            } finally {
                AmigaDoorSession.prototype.start = realStart;
            }

            assert.equal(terminated, 1, 'worker stopped once');
            assert.equal(activeImages.size, 0, 'image released');
            assert.equal(activeDoorInstances[BASE.name], 0, 'slot released');
            assert.ok(
                m.client.log.lines.some(
                    l =>
                        'warn' === l.level &&
                        /cannot start the emulator/.test(l.obj.error)
                )
            );
            assert.equal(m.session, null);
            assert.equal(worker.listenerCount('message'), 0);
        });
    }

    it('a normal exit restores the screen once and flushes held output', async () => {
        const m = makeModule({ image });
        assert.equal(await startModule(m), 'ran');
        m.client.term.syncTermFontsEnabled = true;
        m._switchFont();
        const s = makeSession(
            { image, persist: false },
            { client: m.client, rawOutput: true }
        );
        m._attachSession(s.session, null);
        let next = 0;
        m.autoNextMenu = () => ++next;
        //  a sequence the door never finished
        deliver(s.worker, [{ type: 'output', data: Buffer.from('\x1b[3', 'latin1') }]);
        m.client.term.raw = [];
        deliver(s.worker, [{ type: 'exit', status: 'ok', keys: { status: 'ok' } }]);
        await s.done;
        const raw = Buffer.concat(m.client.term.raw).toString('latin1');
        assert.ok(raw.startsWith('\x1b[3'), 'held output flushed first');
        assert.equal(raw.split('\x1b[0;0 D').length, 2, 'font restored once');
        assert.equal(next, 1);
        m.leave(); //  the menu stack moving on
        assert.equal(
            Buffer.concat(m.client.term.raw).toString('latin1').split('\x1b[0;0 D')
                .length,
            2
        );
    });

    it('tells the caller when the door cannot be run, and the log why', async () => {
        const missing = makeModule({ image: path.join(dir, 'nope.hdf') });
        assert.equal(await startModule(missing), 'refused');
        assert.match(missing.client.term.written.join(''), /XIMTest could not be run/);
        assert.ok(
            missing.client.log.lines.some(
                l => 'warn' === l.level && /image not found/.test(l.obj.error)
            )
        );

        const bad = makeModule({ image, cpu: 'z80' });
        assert.equal(await startModule(bad), 'refused');
        assert.match(bad.client.term.written.join(''), /could not be run/);
        assert.equal(activeImages.size, 0, 'nothing held');

        const nameless = makeModule({ image, name: undefined });
        assert.equal(await startModule(nameless), 'refused');
        assert.match(nameless.client.term.written.join(''), /This door could not be run/);

        //  a busy door says so, and only that
        assert.equal(await startModule(makeModule({ image })), 'ran');
        const busy = makeModule({ image });
        assert.equal(await startModule(busy), 'refused');
        assert.doesNotMatch(busy.client.term.written.join(''), /could not be run/);
    });

    it('runs a C-Net ARexx door only for a logged-in user', async () => {
        const cnet = { image, doorType: 'cnetrexx', door: 'PFILES:Badlibs/badlibs' };
        const user = (userId, authenticated) => ({
            userId,
            isAuthenticated: () => authenticated,
        });

        for (const u of [undefined, user(0, false), user(7, false), user(0, true)]) {
            const client = fakeClient();
            client.user = u;
            const m = makeModule(cnet, client);
            assert.equal(await startModule(m), 'refused');
            assert.match(m.client.term.written.join(''), /XIMTest could not be run/);
            assert.ok(
                m.client.log.lines.some(
                    l => 'warn' === l.level && /needs a logged-in user/.test(l.msg)
                ),
                'the log says why'
            );
            assert.equal(activeImages.size, 0, 'nothing held');
        }

        const client = fakeClient();
        client.user = user(7, true);
        const m = makeModule(cnet, client);
        assert.equal(await startModule(m), 'ran');
        m.leave();

        //  other door types do not ask
        assert.equal(await startModule(makeModule({ image })), 'ran');
    });

    it('leave() before any session frees both at once', async () => {
        const m = makeModule({ image });
        assert.equal(await startModule(m), 'ran');
        assert.equal(activeDoorInstances[BASE.name], 1);
        m.leave();
        assert.equal(activeDoorInstances[BASE.name], 0);
        assert.equal(activeImages.size, 0);
    });
});

// ─── user block ───────────────────────────────────────────────────────────────

describe('amiga_door session keys', () => {
    function stubClient() {
        const props = {
            location: 'Over There',
            login_count: '42',
            post_count: '7',
            ul_total_count: '1',
            dl_total_count: '2',
            ul_total_bytes: '1024',
            dl_total_bytes: '2048',
            previous_login_timestamp: '2026-10-15T12:00:00Z',
        };
        return {
            node: 2,
            term: { termHeight: 30, termWidth: 100 },
            user: {
                userId: 1,
                getProperty: k => props[k],
                getPropertyAsNumber: k => parseInt(props[k], 10),
                getSanitizedName: type => ('real' === type ? 'Real Name' : 'Handle'),
                getLegacySecurityLevel: () => 30,
                isAuthenticated: () => false, //  unlimited time
                isRoot: () => false,
                isGroupMember: () => false,
            },
        };
    }

    it('builds the s frame from the user and the door config', () => {
        const keys = buildSessionKeys(
            stubClient(),
            config({
                mainline: 'G',
                doorStack: 65536,
                timezoneMinutes: 120,
                log: true,
                crlf: false,
            })
        );
        assert.equal(keys.version, 1);
        assert.equal(keys.door, BASE.door);
        assert.equal(keys.stack, 65536);
        assert.equal(keys.node, 2);
        assert.equal(keys.name, 'Handle');
        assert.equal(keys.realname, 'Real Name');
        assert.equal(keys.location, 'Over There');
        assert.equal(keys.level, 30);
        assert.equal(keys.calls, 42);
        assert.equal(keys.posts, 7);
        assert.equal(keys.ulbytes, 1024);
        assert.equal(keys.laston, Date.parse('2026-10-15T12:00:00Z') / 1000);
        assert.equal(keys.rows, 30);
        assert.equal(keys.cols, 100);
        assert.equal(keys.mainline, 'G');
        assert.equal(keys.tz, 120);
        assert.equal(keys.log, 1);
        assert.equal(keys.crlf, 0);
        assert.equal(keys.regtimeout, 30);
        assert.equal(keys.baud, 115200, 'the default rate goes out too');
        assert.equal(buildSessionKeys(stubClient(), config({ baud: 38400 })).baud, 38400);
        //  unlimited clamps to the drop-file ceiling rather than a sentinel
        assert.equal(keys.timeleft, MaxDoorMinutes);
        assert.equal(keys.timelimit, MaxDoorMinutes);
        //  and the whole thing encodes
        assert.ok(protocol.encode('s', keys).length > 4);
    });

    it('makes user and system strings one line of Latin-1', () => {
        assert.equal(userText('Over\r\nThere\x9b[2J雪'), 'Over  There [2J?');
        assert.equal(userText('Zoe\u0301'), 'Zoé', 'composed before transcoding');
        assert.equal(userText(undefined), '');
        assert.equal(userText('x'.repeat(300)).length, 199);

        const client = stubClient();
        const props = { location: 'Line one\nLine two\x1b[31m' };
        client.user.getProperty = k => props[k];
        client.user.getSanitizedName = type =>
            'real' === type ? 'Ré\u0301al' : 'H\x07andle 🙂';
        const keys = buildSessionKeys(client, config());
        assert.equal(keys.location, 'Line one Line two [31m');
        assert.equal(keys.name, 'H andle ?');
        //  and the frame encodes (a line break would throw)
        const payload = protocol.parseKeys(protocol.encode('s', keys).subarray(4));
        assert.equal(payload.location, keys.location);
    });

    it('defaults tz to the host offset and mainline to empty', () => {
        const keys = buildSessionKeys(stubClient(), config());
        assert.equal(keys.tz, -new Date().getTimezoneOffset());
        assert.equal(keys.mainline, '');
        assert.equal(keys.stack, undefined); //  left to the shim
    });

    it('says type=xim and no console mode for an XIM door', () => {
        const keys = buildSessionKeys(stubClient(), config({ doorArgs: '-x' }));
        assert.equal(keys.type, 'xim');
        assert.equal(keys.console, undefined);
        assert.equal(keys.args, '-x');
        assert.ok(!protocol.encode('s', keys).toString('latin1').includes('console='));
    });

    it('a CLI door gets type=cli, its console mode and doorArgs filled in', () => {
        const keys = buildSessionKeys(
            stubClient(),
            config({
                doorType: 'cli',
                consoleMode: 'raw',
                doorArgs: '{name} ACCESS {level} TIMELEFT {timeleft} NODE {node}',
            })
        );
        assert.equal(keys.type, 'cli');
        assert.equal(keys.console, 'raw');
        assert.equal(keys.args, `"Handle" ACCESS 30 TIMELEFT ${MaxDoorMinutes} NODE 2`);
        const payload = protocol.parseKeys(
            protocol.encode('s', keys).subarray(4) //  RS type len_hi len_lo
        );
        assert.equal(payload.type, 'cli');
        assert.equal(payload.console, 'raw');
        assert.equal(payload.args, keys.args);
        assert.equal(payload.door, BASE.door);
    });

    it('an ARexx door gets type=aim, the whole user block and no console mode', () => {
        const keys = buildSessionKeys(
            stubClient(),
            config({
                doorType: 'aim',
                door: 'BBS:Doors/KickBox.Rexx',
                doorArgs: '{level}',
            })
        );
        assert.equal(keys.type, 'aim');
        assert.equal(keys.console, undefined);
        assert.equal(keys.door, 'BBS:Doors/KickBox.Rexx');
        assert.equal(keys.args, '30'); //  after the node number, as for XIM
        //  the script asks the host for user data (GETUSER), so the block is there
        assert.equal(keys.name, 'Handle');
        assert.equal(keys.node, 2);
        assert.equal(keys.level, 30);
        const payload = protocol.parseKeys(protocol.encode('s', keys).subarray(4));
        assert.equal(payload.type, 'aim');
        assert.ok(!('console' in payload));
    });

    it('a Paragon door gets type=tim, the user block, args after the line, assign and env', () => {
        const keys = buildSessionKeys(
            stubClient(),
            config({
                doorType: 'tim',
                door: 'BBS:Doors/MSE/MSE',
                doorArgs: '{level}',
                assigns: { 'MSE:': 'BBS:Doors/MSE', T: 'RAM:' },
                env: { MSE: '', OPTS: 'FAST TIME' },
            })
        );
        assert.equal(keys.type, 'tim');
        assert.equal(keys.console, undefined);
        assert.equal(keys.args, '30');
        //  the door asks for user numbers and strings, so the block is there
        assert.equal(keys.name, 'Handle');
        assert.equal(keys.node, 2); //  the shim takes its last digit
        assert.equal(keys.assign, 'MSE=BBS:Doors/MSE;T=RAM:');
        assert.equal(keys.env, 'MSE=;OPTS=FAST TIME');
        const payload = protocol.parseKeys(protocol.encode('s', keys).subarray(4));
        assert.equal(payload.type, 'tim');
        assert.equal(payload.assign, 'MSE=BBS:Doors/MSE;T=RAM:');
        assert.equal(payload.env, 'MSE=;OPTS=FAST TIME');

        //  without them, no keys at all (the shim then changes nothing)
        const plain = buildSessionKeys(stubClient(), config({ doorType: 'tim' }));
        assert.equal(plain.assign, undefined);
        assert.equal(plain.env, undefined);
        const text = protocol.encode('s', plain).toString('latin1');
        assert.ok(!text.includes('assign=') && !text.includes('env='));
    });

    it('a C-Net ARexx door gets type=cnetrexx, the user block, its account and options', () => {
        const keys = buildSessionKeys(
            stubClient(),
            config({
                doorType: 'cnetrexx',
                door: 'PFILES:Badlibs/badlibs',
                doorArgs: '{level}',
                panicGraceSeconds: 0,
                wordWrap: false,
            })
        );
        assert.equal(keys.type, 'cnetrexx');
        assert.equal(keys.console, undefined);
        assert.equal(keys.args, '30'); //  the script's own arguments, no port number
        assert.equal(keys.name, 'Handle');
        assert.equal(keys.node, 2); //  the shim makes CNETREXX1 of it
        assert.equal(keys.account, 1);
        assert.equal(keys.panicgrace, 0);
        assert.equal(keys.wrap, 0);
        const payload = protocol.parseKeys(protocol.encode('s', keys).subarray(4));
        assert.equal(payload.type, 'cnetrexx');
        assert.equal(payload.account, '1');
        assert.equal(payload.panicgrace, '0');
        assert.equal(payload.wrap, '0');

        //  defaults are the shim's: no keys
        const plain = buildSessionKeys(
            stubClient(),
            config({ doorType: 'cnetrexx', door: 'PFILES:x' })
        );
        assert.equal(plain.panicgrace, undefined);
        assert.equal(plain.wrap, undefined);
        assert.equal(plain.account, 1);
        //  any other user is their own account; no ID is no account
        const other = stubClient();
        other.user.userId = 7;
        assert.equal(
            buildSessionKeys(other, config({ doorType: 'cnetrexx', door: 'PFILES:x' }))
                .account,
            7
        );
        other.user.userId = 0;
        assert.throws(
            () =>
                buildSessionKeys(
                    other,
                    config({ doorType: 'cnetrexx', door: 'PFILES:x' })
                ),
            /no C-Net account number for user ID 0/
        );
        assert.equal(cnetAccount({ userId: 1 }), 1);
        for (const u of [undefined, { userId: 0 }, { userId: -2 }, { userId: '5' }]) {
            assert.equal(cnetAccount(u), null);
        }
        //  and the other door types do not get them
        const xim = buildSessionKeys(stubClient(), config({}));
        assert.equal(xim.account, undefined);
        assert.equal(xim.panicgrace, undefined);
        assert.equal(xim.wrap, undefined);
    });

    it("a C-Net ARexx door's command line is door[ args]", () => {
        const c = config({ doorType: 'cnetrexx', door: 'PFILES:x' });
        assert.equal(commandLength(c, '', 12), 'PFILES:x'.length);
        assert.equal(commandLength(c, 'ab', 12345), 'PFILES:x ab'.length);
    });

    it('a Paragon door\'s command line is "door" <one digit>[ args]', () => {
        const c = config({ doorType: 'tim', door: 'BBS:x' });
        assert.equal(commandLength(c, '', 12), '"BBS:x" 2'.length);
        assert.equal(commandLength(c, 'ab', 12345), '"BBS:x" 5 ab'.length);
    });

    it('a CLI door defaults to the cooked console', () => {
        const keys = buildSessionKeys(stubClient(), config({ doorType: 'cli' }));
        assert.equal(keys.console, 'cooked');
        assert.equal(keys.args, undefined);
    });

    it('keeps the Amiga shell out of {name}', () => {
        //  quoting, the escape char, command and variable substitution, comments,
        //  redirection, pipes, control bytes; one argument, so no ReadArgs keywords
        assert.equal(
            quoteArg('Joe "x" *N `rm` $v; >f <g |h\x07'),
            '"Joe _x_ _N _rm_ _v_ _f _g _h_"'
        );
        assert.equal(quoteArg('Joe ACCESS 255'), '"Joe ACCESS 255"');
        assert.equal(quoteArg('Zoë 雪'), '"Zoë ?"');
        const client = stubClient();
        client.user.getSanitizedName = () => 'Bob`Delete SYS:#?`';
        assert.equal(
            expandDoorArgs('{name} {name}', { client, timeLeft: 5 }),
            '"Bob_Delete SYS:#?_" "Bob_Delete SYS:#?_"'
        );
        assert.equal(
            expandDoorArgs('{timeleft}m {other}', { client, timeLeft: 5 }),
            '5m {other}'
        );
    });

    it('cuts a long {name} inside its quotes to fit the shim', () => {
        const client = stubClient();
        client.user.getSanitizedName = () => 'N'.repeat(300);
        const keys = buildSessionKeys(
            client,
            config({ doorType: 'cli', doorArgs: `{name} ${'x'.repeat(100)} {node}` })
        );
        assert.ok(keys.args.length <= 199, keys.args.length);
        assert.ok(keys.args.endsWith(`${'x'.repeat(100)} 2`), 'the rest is whole');
        assert.match(keys.args, /^"N+" x/);
        assert.equal(keys.args.split('"').length, 3, 'quotes balanced');

        //  the whole command line counts too: "door" args for a CLI door
        const door = `BBS:Doors/${'d'.repeat(150)}`;
        const tight = buildSessionKeys(
            client,
            config({ doorType: 'cli', door, doorArgs: '{name}' })
        );
        assert.ok(commandLength(config({ doorType: 'cli', door }), tight.args, 2) <= 299);
        assert.match(tight.args, /^"N+"$/);

        //  two names share the room
        const two = buildSessionKeys(
            client,
            config({ doorType: 'cli', doorArgs: '{name} {name}' })
        );
        assert.ok(two.args.length <= 199);
        assert.equal(two.args.split('"').length, 5);
    });

    it('refuses door and doorArgs the shim cannot hold', () => {
        assert.ok(
            problemsOf({ doorType: 'cli', doorArgs: 'x'.repeat(250) }).some(p =>
                p.includes('command line of at least')
            )
        );
        const door = `BBS:Doors/${'d'.repeat(180)}`;
        assert.deepEqual(problemsOf({ door }), []);
        assert.ok(
            problemsOf({ door, doorArgs: 'y'.repeat(110) }).some(p =>
                p.includes('the shim takes 299')
            )
        );
        assert.ok(
            problemsOf({ door: `BBS:${'d'.repeat(200)}` }).some(p =>
                p.includes('longer than the shim')
            )
        );
        //  a placeholder counts at its widest
        assert.deepEqual(problemsOf({ doorArgs: `${'z'.repeat(170)} {timeleft}` }), []);
        assert.ok(problemsOf({ doorArgs: `${'z'.repeat(190)} {name}` }).length > 0);
    });
});

// ─── module loads ─────────────────────────────────────────────────────────────

describe('amiga_door module', () => {
    it('is reachable as a menu module and its worker is inert in the main thread', () => {
        const mod = require('../core/amiga_door/amiga_door.js');
        assert.equal(typeof mod.getModule, 'function');
        assert.equal(mod.moduleInfo.name, 'AmigaDoor');
        //  module_util requires every core/*/*.js; the worker must not run here
        assert.doesNotThrow(() => require('../core/amiga_door/amiga_worker.js'));
        assert.ok(
            fs.existsSync(path.join(__dirname, '../core/amiga_door/amiga_worker.js'))
        );
    });
});
