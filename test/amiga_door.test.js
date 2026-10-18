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
const {
    normalizeConfig,
    shouldPersist,
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

class FakeWorker extends EventEmitter {
    constructor() {
        super();
        this.posted = [];
        this.terminated = false;
    }
    postMessage(msg) {
        this.posted.push(msg);
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
        assert.deepEqual(c.persistOn, ['ok', 'carrier']); //  doorType xim
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

    it('defaults persistOn by door type; an explicit list always wins', () => {
        assert.deepEqual(config({ doorType: 'xim' }).persistOn, ['ok', 'carrier']);
        assert.deepEqual(config({ doorType: 'cli' }).persistOn, ['ok']);
        assert.deepEqual(config({ doorType: 'aim', door: 'SYS:S/game.rexx' }).persistOn, [
            'ok',
        ]);
        assert.deepEqual(
            config({ doorType: 'tim', door: 'BBS:Doors/MSE/MSE' }).persistOn,
            ['ok']
        );
        assert.deepEqual(
            config({ doorType: 'cnetrexx', door: 'PFILES:Badlibs/badlibs' }).persistOn,
            ['ok']
        );
        assert.deepEqual(
            config({ doorType: 'cli', persistOn: ['ok', 'carrier'] }).persistOn,
            ['ok', 'carrier']
        );
        assert.deepEqual(config({ doorType: 'xim', persistOn: ['ok'] }).persistOn, [
            'ok',
        ]);
    });

    it('takes persistOn as a status or a list of statuses', () => {
        assert.deepEqual(config({ persistOn: 'carrier' }).persistOn, ['carrier']);
        assert.deepEqual(config({ persistOn: ['ok', 'carrier'] }).persistOn, [
            'ok',
            'carrier',
        ]);
        assert.ok(
            problemsOf({ persistOn: ['ok', 'hangup'] }).some(p => p.includes('persistOn'))
        );
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
                nodemax: 2,
                frobnicate: true,
                _comment: 'ignored',
                cls: true, //  MenuModule's
                menuFlags: [],
            })
        );
        assert.deepEqual(problems, []);
        assert.deepEqual(warnings, [
            'unknown key "persistOnn"; did you mean "persistOn"?',
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
            //  a ROM supplied by the sysop may be a stock AROS build
            const { warnings } = normalizeConfig(Object.assign({}, BASE, { image, rom }));
            assert.equal(warnings.length, 1);
            assert.match(
                warnings[0],
                /4096 KB.*if this ROM is a stock AROS build.*2032 KB.*enigma-vamiga 0\.1\.2/
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
    const stat = { mtimeMs: 1000, size: 4096 };
    const machine = config();

    it('keys on image, mtime, size, ROMs and machine', () => {
        const k = SnapshotCache.keyFor('/doors/a.hdf', stat, machine);
        assert.equal(k, SnapshotCache.keyFor('/doors/../doors/a.hdf', stat, machine));
        assert.notEqual(k, SnapshotCache.keyFor('/doors/b.hdf', stat, machine));
        assert.notEqual(
            k,
            SnapshotCache.keyFor('/doors/a.hdf', { mtimeMs: 1001, size: 4096 }, machine)
        );
        assert.notEqual(
            k,
            SnapshotCache.keyFor('/doors/a.hdf', { mtimeMs: 1000, size: 8192 }, machine)
        );
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
                SnapshotCache.keyFor('/doors/a.hdf', stat, other),
                JSON.stringify(change)
            );
        }
        //  things a booted machine does not depend on
        const same = Object.assign({}, machine, { font: 'none', log: true, nodeMax: 9 });
        assert.equal(k, SnapshotCache.keyFor('/doors/a.hdf', stat, same));
    });

    it('stores a shared copy and hands it back', () => {
        const cache = new SnapshotCache();
        const key = SnapshotCache.keyFor('/doors/a.hdf', stat, machine);
        const stored = cache.set(key, Buffer.from([1, 2, 3]));
        assert.ok(stored.buffer instanceof SharedArrayBuffer);
        assert.deepEqual([...cache.get(key)], [1, 2, 3]);
        assert.equal(cache.get('nope'), undefined);
        assert.deepEqual(cache.meta(key), {});
        cache.set(key, Buffer.from([4]), { serialHandshake: true });
        assert.deepEqual(cache.meta(key), { serialHandshake: true });
        assert.equal(cache.meta('nope'), undefined);
    });

    it('evicts the least recently used past maxEntries', () => {
        const cache = new SnapshotCache({ maxEntries: 2 });
        const keys = ['a', 'b', 'c'].map(n =>
            SnapshotCache.keyFor(`/doors/${n}.hdf`, stat, machine)
        );
        cache.set(keys[0], Buffer.from([0]));
        cache.set(keys[1], Buffer.from([1]));
        cache.get(keys[0]); //  a is now more recent than b
        cache.set(keys[2], Buffer.from([2]));
        assert.equal(cache.size, 2);
        assert.ok(cache.get(keys[0]));
        assert.equal(cache.get(keys[1]), undefined);
        assert.ok(cache.get(keys[2]));
    });

    it('invalidates every snapshot of one image', () => {
        const cache = new SnapshotCache();
        const a1 = SnapshotCache.keyFor('/doors/a.hdf', stat, machine);
        const a2 = SnapshotCache.keyFor(
            '/doors/a.hdf',
            stat,
            Object.assign({}, machine, { cpu: '68000' })
        );
        const b = SnapshotCache.keyFor('/doors/b.hdf', stat, machine);
        [a1, a2, b].forEach(k => cache.set(k, Buffer.from([9])));
        assert.equal(cache.invalidateImage('/doors/./a.hdf'), 2);
        assert.equal(cache.size, 1);
        assert.ok(cache.get(b));
    });

    it('caches nothing with maxEntries 0', () => {
        const cache = new SnapshotCache({ maxEntries: 0 });
        assert.equal(
            cache.set(SnapshotCache.keyFor('/a', stat, machine), Buffer.from([1])),
            null
        );
        assert.equal(cache.size, 0);
    });
});

// ─── exit / persist decision ──────────────────────────────────────────────────

describe('amiga_door persist decision', () => {
    it('persists on ok, and on a carrier exit the door made itself, by default', () => {
        const c = config();
        assert.deepEqual(c.persistOn, ['ok', 'carrier']);
        assert.equal(shouldPersist(c, 'ok'), true);
        assert.equal(shouldPersist(c, 'ok', { rc: '-1' }), true);
        assert.equal(shouldPersist(c, 'carrier', { rc: '0' }), true);
        for (const status of ['timeout', 'break', 'error', undefined]) {
            assert.equal(shouldPersist(c, status, { rc: '0' }), false, String(status));
        }
    });

    it('does not persist a CLI, ARexx, Paragon or C-Net door on a hangup by default', () => {
        for (const extra of [
            { doorType: 'cli' },
            { doorType: 'aim', door: 'SYS:S/g.rexx' },
            { doorType: 'tim', door: 'BBS:Doors/MSE/MSE' },
            { doorType: 'cnetrexx', door: 'PFILES:Badlibs/badlibs' },
        ]) {
            const c = config(extra);
            assert.equal(shouldPersist(c, 'ok', { rc: '0' }), true);
            assert.equal(shouldPersist(c, 'carrier', { rc: '0' }), false);
        }
        const widened = config({ doorType: 'cli', persistOn: ['ok', 'carrier'] });
        assert.equal(shouldPersist(widened, 'carrier', { rc: '0' }), true);
    });

    it('counts only a plain integer rc as the door ending by itself', () => {
        const c = config();
        const cases = [
            [{ rc: '0' }, true],
            [{ rc: '5' }, true],
            [{ rc: '-2' }, true],
            [{ rc: 0 }, true],
            [{ rc: '-1' }, false],
            [{ rc: -1 }, false],
            [{ rc: '' }, false],
            [{ rc: ' ' }, false],
            [{ rc: null }, false],
            [{ rc: '1.5' }, false],
            [{ rc: '0x10' }, false],
            [{ rc: '5 ' }, false],
            [{ rc: 'x' }, false],
            [{}, false],
            [undefined, false],
        ];
        for (const [keys, expected] of cases) {
            assert.equal(
                shouldPersist(c, 'carrier', keys),
                expected,
                JSON.stringify(keys)
            );
        }
    });

    it('does not persist a carrier exit unless the door ended by itself', () => {
        const c = config();
        assert.equal(shouldPersist(c, 'carrier', { rc: '5' }), true);
        assert.equal(shouldPersist(c, 'carrier', { rc: '-1' }), false);
        assert.equal(shouldPersist(c, 'carrier', { rc: -1 }), false);
        assert.equal(shouldPersist(c, 'carrier', {}), false);
        assert.equal(shouldPersist(c, 'carrier'), false);
        assert.equal(shouldPersist(c, 'carrier', { rc: 'x' }), false);
    });

    it('never persists with persist: false', () => {
        assert.equal(shouldPersist(config({ persist: false }), 'ok'), false);
    });

    it('widens with persistOn', () => {
        const c = config({ persistOn: ['ok', 'timeout', 'break'] });
        assert.equal(shouldPersist(c, 'carrier', { rc: '0' }), false);
        assert.equal(shouldPersist(c, 'timeout', { rc: '0' }), true);
        assert.equal(shouldPersist(c, 'timeout', { rc: '-1' }), false);
        assert.equal(shouldPersist(c, 'break', { rc: '0' }), true);
        assert.equal(shouldPersist(c, 'break'), false);
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

    it('X status=ok persists, then drops the image snapshots when chunks changed', async () => {
        const image = path.join(os.tmpdir(), `amiga_door_test_${process.pid}.hdf`);
        const s = makeSession({ image });
        s.cache.set(
            SnapshotCache.keyFor(image, { mtimeMs: 1, size: 1 }, s.session.config),
            Buffer.from([1])
        );
        const link = new HostLink({ helloSeen: true });

        deliver(
            s.worker,
            workerMessages(
                link,
                Buffer.concat([
                    protocol.encode('L', { door: BASE.door, pid: 0 }),
                    Buffer.from('Bye!\r\n'),
                    protocol.encode('X', { status: 'ok', reg: 0, cmds: 17, wrote: 1 }),
                ])
            )
        );

        //  the persist request goes out through the image lock
        await new Promise(r => setImmediate(r));
        const persist = s.worker.sent('persist');
        assert.equal(persist.length, 1);
        assert.equal(persist[0].path, image);
        assert.equal(s.worker.terminated, false, 'not before the disk is written');

        s.worker.emit('message', { type: 'persisted', chunks: 2, bytes: 131072, ms: 3 });
        const result = await s.done;
        assert.equal(result.status, 'ok');
        assert.equal(result.persisted, true);
        assert.equal(result.chunks, 2);
        assert.equal(s.cache.size, 0, 'snapshot dropped');
        assert.ok(s.worker.terminated);
    });

    it('X status=ok with no changed chunks keeps the snapshot', async () => {
        const s = makeSession();
        s.cache.set(
            SnapshotCache.keyFor(BASE.image, { mtimeMs: 1, size: 1 }, s.session.config),
            Buffer.from([1])
        );
        deliver(s.worker, [{ type: 'exit', status: 'ok', keys: { status: 'ok' } }]);
        await new Promise(r => setImmediate(r));
        s.worker.emit('message', { type: 'persisted', chunks: 0, bytes: 0, ms: 1 });
        await s.done;
        assert.equal(s.cache.size, 1);
    });

    it('asks for the persist through a temporary file beside the image', async () => {
        const s = makeSession();
        deliver(s.worker, [{ type: 'exit', status: 'ok', keys: { status: 'ok' } }]);
        await new Promise(r => setImmediate(r));
        const [persist] = s.worker.sent('persist');
        assert.equal(persist.path, BASE.image);
        assert.equal(path.dirname(persist.tmp), path.dirname(BASE.image));
        assert.notEqual(persist.tmp, BASE.image);
        s.worker.emit('message', { type: 'persisted', chunks: 0, bytes: 0, ms: 1 });
        await s.done;
    });

    it('a slow persist ends the session but never stops the worker mid-write', async () => {
        const s = makeSession({}, { timeouts: { persist: 10, persistAbandon: 5000 } });
        const closed = new Promise(r => s.session.once('closed', r));
        deliver(s.worker, [{ type: 'exit', status: 'ok', keys: { status: 'ok' } }]);
        const result = await s.done;
        assert.equal(result.persisted, false);
        assert.match(result.error, /persist did not finish/);
        assert.equal(s.worker.terminated, false, 'still writing');

        s.worker.emit('message', { type: 'persisted', chunks: 1, bytes: 512, ms: 50 });
        await closed;
        assert.ok(s.worker.terminated);
    });

    it('gives up on a persist that never finishes and removes its copy', async () => {
        const image = path.join(os.tmpdir(), `amiga_door_abandon_${process.pid}.hdf`);
        fs.writeFileSync(image, Buffer.alloc(16));
        try {
            const s = makeSession(
                { image },
                { timeouts: { persist: 5, persistAbandon: 20 } }
            );
            const closed = new Promise(r => s.session.once('closed', r));
            deliver(s.worker, [{ type: 'exit', status: 'ok', keys: { status: 'ok' } }]);
            await new Promise(r => setImmediate(r));
            const [persist] = s.worker.sent('persist');
            fs.writeFileSync(persist.tmp, 'half'); //  the worker got this far
            await s.done;
            assert.equal(s.worker.terminated, false);
            await closed;
            assert.ok(s.worker.terminated);
            await new Promise(r => setTimeout(r, 20));
            assert.equal(fs.existsSync(persist.tmp), false);
            assert.equal(fs.readFileSync(image).length, 16);
        } finally {
            fs.rmSync(image, { force: true });
        }
    });

    it('a worker that dies mid-persist is not waited for', async () => {
        const s = makeSession({}, { timeouts: { persistAbandon: 60000 } });
        const closed = new Promise(r => s.session.once('closed', r));
        deliver(s.worker, [{ type: 'exit', status: 'ok', keys: { status: 'ok' } }]);
        await new Promise(r => setImmediate(r));
        s.worker.emit('exit', 1);
        const result = await s.done;
        assert.match(result.error, /exited unexpectedly/);
        await closed;
    });

    it('a persist refused because the image changed drops its snapshots', async () => {
        const s = makeSession();
        s.cache.set(
            SnapshotCache.keyFor(BASE.image, { mtimeMs: 1, size: 1 }, s.session.config),
            Buffer.from([1])
        );
        deliver(s.worker, [{ type: 'exit', status: 'ok', keys: { status: 'ok' } }]);
        await new Promise(r => setImmediate(r));
        s.worker.emit('message', {
            type: 'persisted',
            chunks: 0,
            bytes: 0,
            ms: 1,
            refused: 'the image changed during the session',
        });
        const result = await s.done;
        assert.equal(result.persisted, false);
        assert.match(result.refused, /changed/);
        assert.equal(s.cache.size, 0);
        assert.ok(
            s.client.log.lines.some(
                l => 'warn' === l.level && /NOT persisted/.test(l.msg)
            )
        );
    });

    it('a cut-short exit that persists nothing keeps the image snapshots', async () => {
        const s = makeSession();
        s.cache.set(
            SnapshotCache.keyFor(BASE.image, { mtimeMs: 1, size: 1 }, s.session.config),
            Buffer.from([1])
        );
        deliver(
            s.worker,
            workerMessages(
                new HostLink({ helloSeen: true }),
                protocol.encode('X', { status: 'carrier', rc: '-1' })
            )
        );
        const result = await s.done;
        assert.equal(result.persisted, false);
        assert.equal(s.cache.size, 1);
        assert.ok(
            s.client.log.lines.some(l => /NOT persisted/.test(l.msg)),
            'the cut-short exit is still logged'
        );
    });

    it('a late error from a finished worker is swallowed', async () => {
        const s = makeSession();
        s.session.disconnect('hangup');
        await s.done;
        assert.doesNotThrow(() => s.worker.emit('error', new Error('late')));
    });

    for (const status of ['carrier', 'timeout', 'break', 'error']) {
        it(`X status=${status} does not persist`, async () => {
            const s = makeSession();
            deliver(
                s.worker,
                workerMessages(
                    new HostLink({ helloSeen: true }),
                    protocol.encode('X', { status })
                )
            );
            const result = await s.done;
            assert.equal(result.status, status);
            assert.equal(result.persisted, false);
            assert.equal(s.worker.sent('persist').length, 0);
            assert.ok(s.worker.terminated);
        });
    }

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
        assert.equal(result.persisted, false);
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

    it('a hangup persists what a door saved when it ended by itself', async () => {
        const s = makeSession({}, { timeouts: { exitAfterDisconnect: 5000 } });
        s.session.disconnect('hangup');
        //  the shim's X comes back well within the grace
        deliver(s.worker, [
            {
                type: 'exit',
                status: 'carrier',
                keys: { status: 'carrier', rc: '0' },
            },
        ]);
        await new Promise(r => setImmediate(r));
        assert.equal(s.worker.sent('persist').length, 1);
        s.worker.emit('message', { type: 'persisted', chunks: 1, bytes: 512, ms: 3 });
        const result = await s.done;
        assert.equal(result.status, 'carrier');
        assert.equal(result.reason, 'hangup');
        assert.equal(result.persisted, true);
    });

    it('a hangup does not persist a door the shim gave up on (rc -1)', async () => {
        const s = makeSession({}, { timeouts: { exitAfterDisconnect: 5000 } });
        s.session.disconnect('hangup');
        deliver(s.worker, [
            {
                type: 'exit',
                status: 'carrier',
                keys: { status: 'carrier', rc: '-1' },
            },
        ]);
        const result = await s.done;
        assert.equal(s.worker.sent('persist').length, 0);
        assert.equal(result.status, 'carrier');
        assert.equal(result.persisted, false);
    });

    it('drops the worker when no X follows d', async () => {
        const s = makeSession();
        s.session.disconnect('break');
        const result = await s.done;
        assert.equal(result.reason, 'break');
        assert.equal(result.status, undefined);
        assert.equal(result.persisted, false);
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

    it('caches the snapshot a booting worker posts', async () => {
        const s = makeSession(
            {},
            {
                cacheKey: SnapshotCache.keyFor(
                    BASE.image,
                    { mtimeMs: 5, size: 5 },
                    config()
                ),
            }
        );
        s.worker.emit('message', {
            type: 'snapshot',
            snapshot: new Uint8Array([7, 7]),
            ms: 40,
            serialHandshake: true,
        });
        assert.equal(s.cache.size, 1);
        //  the RTS/CTS setting goes with it, for the workers that restore it
        assert.deepEqual(s.cache.meta(s.session.cacheKey), { serialHandshake: true });
        s.session.disconnect('hangup');
        await s.done;
    });

    it('a fatal worker error ends the session without persisting', async () => {
        const s = makeSession();
        s.worker.emit('message', {
            type: 'error',
            message: 'The emulated CPU halted',
            code: 'CPU_HALT',
            fatal: true,
        });
        const result = await s.done;
        assert.equal(result.code, 'CPU_HALT');
        assert.equal(result.persisted, false);
        assert.ok(s.worker.terminated);
    });

    it('cleans up its listeners', async () => {
        const s = makeSession();
        s.session.disconnect('hangup');
        await s.done;
        assert.equal(s.client.listenerCount('time up'), 0);
        assert.equal(s.client.term.output.listenerCount('data'), 0);
        assert.equal(s.worker.listenerCount('message'), 0);
    });
});

function Events() {
    return require('../core/events.js');
}

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

        //  a door that never persists is not held up
        const readOnly = makeModule({ name: 'Viewer', image, persist: false });
        assert.equal(await startModule(readOnly), 'ran');
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
