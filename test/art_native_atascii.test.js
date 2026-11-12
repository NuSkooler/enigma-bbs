'use strict';

//
//  Native ATASCII art (.ata) through core/art.js and core/theme.js (#593):
//  loading, type selection for ANSI, PETSCII and ATASCII sessions, display
//  on a real ClientTerminal, and the plain text other sessions get.
//
//  The rules that matter most: an ANSI or PETSCII session is never given an
//  .ata file, an ATASCII session never a .seq, and what anyone is given on a
//  board without .ata files is exactly what they were given before.
//
const { strict: assert } = require('assert');
const fs = require('fs');
const async = require('async');
const os = require('os');
const paths = require('path');
const iconv = require('iconv-lite');

const configModule = require('../core/config.js');
const UserProps = require('../core/user_property.js');
const { Controls, INVERSE_BIT } = require('../core/term/atascii/charset.js');
const { atasciiArtToText } = require('../core/term/atascii/art_parser.js');
const { ClientTerminal } = require('../core/client_term.js');
const { selectClientEmulation } = require('../core/term/select.js');
const { AtasciiScreen } = require('./term_atascii_screens.js');
const { PetsciiScreen } = require('./term_petscii_screens.js');

const C = Controls;
const text = s => [...Buffer.from(s, 'latin1')];
const inv = s => text(s).map(b => b | INVERSE_BIT);

//  the real one, whatever a test leaves behind
const REAL_RANDOM = Math.random;

//  Late bound: art.js captures config.js's |get| at require time
let art;
let theme;

const quietLog = {
    trace() {},
    debug() {},
    info() {},
    warn() {},
    error() {},
    fatal() {},
    child() {
        return quietLog;
    },
};

function makeOutput() {
    const written = [];
    return {
        writable: true,
        written,
        write(data, cb) {
            written.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
            if (cb) {
                cb(null);
            }
        },
    };
}

const wire = output => Buffer.concat(output.written);

//  every session made by a test, disconnected after it (no timer left behind)
const sessions = [];

function makeClient(term, themeId) {
    const client = {
        term,
        log: quietLog,
        user: { properties: {}, isAuthenticated: () => false },
        currentThemeConfig: { get: () => ({ info: { name: 'N/A' } }) },
    };
    if (themeId) {
        client.user.properties[UserProps.ThemeId] = themeId;
    }
    Object.defineProperty(client, 'currentTheme', {
        get: () => client.currentThemeConfig.get(),
        set: tc => {
            client.currentThemeConfig = tc;
        },
    });
    sessions.push(term);
    return client;
}

function ansiClient(encoding, themeId) {
    const output = makeOutput();
    const term = new ClientTerminal(output);
    term.outputEncoding = encoding;
    term.termWidth = 80;
    term.termHeight = 25;
    const client = makeClient(term, themeId);
    client.output = output;
    return client;
}

//  a session selected into |emulation| by listener, screen size settled
function emulatedClient(emulation, cols, rows) {
    const output = makeOutput();
    const term = new ClientTerminal(output);
    const client = makeClient(term);
    selectClientEmulation(client, {
        firstMenu: 'telnetConnected',
        listener: { name: emulation, emulation },
    });
    term.termWidth = cols;
    term.termHeight = rows;
    term.emulation.probes.forEach(probe => probe.run(client, () => {}));
    client.output = output;
    return client;
}

const atasciiClient = () => emulatedClient('atascii', 40, 24);
const petsciiClient = () => emulatedClient('petscii', 40, 25);

//  A SAUCE record (128 bytes) with |numComments| comment lines, |width| TInfo1
function sauceRecord(numComments, width = 0) {
    const rec = Buffer.alloc(128, 0x20);
    rec.write('SAUCE00', 0, 'latin1');
    rec[94] = 1; //  DataType character
    rec.writeUInt16LE(width, 96);
    rec[104] = numComments;
    return rec;
}

const SAMPLE = Buffer.from([C.clear, ...text('Hi'), C.eol, 0xa0, 0x1a]);

describe('art: native ATASCII (.ata)', function () {
    let tmp;

    before(function () {
        art = require('../core/art.js');
        tmp = fs.mkdtempSync(paths.join(os.tmpdir(), 'enig-art-ata-'));
    });

    afterEach(function () {
        sessions.splice(0).forEach(term => term.disconnect());
    });

    after(function () {
        Math.random = REAL_RANDOM;
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    function dir(name, files) {
        const d = paths.join(tmp, name);
        fs.mkdirSync(d, { recursive: true });
        Object.entries(files).forEach(([f, data]) =>
            fs.writeFileSync(paths.join(d, f), data)
        );
        return d;
    }

    describe('loading', function () {
        let d;
        before(function () {
            d = dir('load', {
                'PLAIN.ata': SAMPLE,
                'SAUCED.ata': Buffer.concat([
                    SAMPLE,
                    Buffer.from([0x1a]),
                    Buffer.from('COMNT', 'latin1'),
                    Buffer.alloc(64, 0x41),
                    sauceRecord(1),
                ]),
                'SAUCENC.ata': Buffer.concat([
                    SAMPLE,
                    Buffer.from([0x1a]),
                    sauceRecord(0),
                ]),
                'WIDE.ata': Buffer.concat([
                    Buffer.from(Array(41).fill(0x41)),
                    Buffer.from([0x1a]),
                    sauceRecord(0, 80),
                ]),
                'PADDED.ata': Buffer.concat([SAMPLE, Buffer.alloc(5, 0x1a)]),
                'PLAIN.ans': 'abc\r\n',
            });
        });

        const load = (name, options, cb) =>
            art.getArt(name, Object.assign({ basePath: d }, options), cb);

        it('raw bytes for a caller that shows native art', done => {
            load('PLAIN.ata', { acceptNative: true }, (err, info) => {
                assert.ifError(err);
                assert.deepEqual(info.data, SAMPLE);
                assert.deepEqual(info.native, { emulation: 'atascii' });
                assert.equal(info.sauce, undefined);
                return done();
            });
        });

        it('encodedAs means nothing for .ata; a native encodedAs on an ANSI type is ignored', done => {
            load('PLAIN.ata', { acceptNative: true, encodedAs: 'cp437' }, (err, info) => {
                assert.ifError(err);
                assert.deepEqual(info.native, { emulation: 'atascii' });
                load('PLAIN.ans', { encodedAs: 'atascii' }, (err, info) => {
                    assert.ifError(err);
                    assert.equal(info.data, 'abc\r\n');
                    load('PLAIN.ans', { encodedAs: 'ATASCII' }, (err, info) => {
                        assert.ifError(err);
                        assert.equal(info.data, 'abc\r\n');
                        return done();
                    });
                });
            });
        });

        it('a SAUCE record, its comments and the one EOF before it are stripped', done => {
            load('SAUCED.ata', { acceptNative: true, readSauce: true }, (err, info) => {
                assert.ifError(err);
                //  SAMPLE's own final 0x1A (a glyph) is kept
                assert.deepEqual(info.data, SAMPLE);
                load('SAUCENC.ata', { acceptNative: true }, (err, info) => {
                    assert.ifError(err);
                    assert.deepEqual(info.data, SAMPLE);
                    return done();
                });
            });
        });

        it('trailing 0x1A without SAUCE is art (a glyph), not padding', done => {
            load('PADDED.ata', { acceptNative: true }, (err, info) => {
                assert.ifError(err);
                assert.equal(info.data.length, SAMPLE.length + 5);
                return done();
            });
        });

        it("SAUCE's width is the width of the plain text", done => {
            load('WIDE.ata', { acceptNative: true }, (err, info) => {
                assert.ifError(err);
                assert.deepEqual(info.native, { emulation: 'atascii', artWidth: 80 });
                load('WIDE.ata', {}, (err, info) => {
                    assert.ifError(err);
                    assert.equal(info.data, 'A'.repeat(41));
                    return done();
                });
            });
        });

        it('plain text for a caller that does not show native art', done => {
            load('SAUCED.ata', {}, (err, info) => {
                assert.ifError(err);
                assert.equal(typeof info.data, 'string');
                assert.equal(info.native, undefined);
                assert.equal(info.data, atasciiArtToText(SAMPLE));
                assert.equal(info.data, 'Hi\r\n \u2514');
                return done();
            });
        });
    });

    describe('selection', function () {
        const ATA_FILES = [
            'MATRIX.ata',
            'ONLYATA.ata',
            'RAND3.ata',
            'VAR1.ata',
            'SEQATA.ata',
        ];
        const SEQ_FILES = ['MATRIX.seq', 'ONLYSEQ.seq', 'SEQATA.seq', 'RAND5.seq'];
        const OTHER_FILES = [
            'MATRIX.ans',
            'MATRIX.utf8ans',
            'ONLYANS.ans',
            'MIXED.ans',
            'MIXED.asc',
            'RAND1.ans',
            'RAND2.ans',
            'RAND4.utf8ans',
            'VAR1.ans',
            'VAR2.ans',
            'VAR1.utf8ans',
        ];
        const NAMES = [
            'MATRIX',
            'ONLYATA',
            'ONLYSEQ',
            'SEQATA',
            'ONLYANS',
            'MIXED',
            'VAR1',
            'RAND',
            'VAR',
        ];
        let withAta;
        let withoutAta;
        let ansiOnly;

        before(function () {
            const files = list =>
                Object.fromEntries(
                    list.map(f => [
                        f,
                        f.endsWith('.ata') || f.endsWith('.seq') ? SAMPLE : `${f}\r\n`,
                    ])
                );
            withAta = dir('with', files([...OTHER_FILES, ...SEQ_FILES, ...ATA_FILES]));
            withoutAta = dir('without', files([...OTHER_FILES, ...SEQ_FILES]));
            ansiOnly = dir('ansionly', files(OTHER_FILES));
        });

        function pick(basePath, name, options, cb) {
            const opts = Object.assign({ basePath, random: false }, options);
            art.getArt(name, opts, (err, info) => {
                if (err) {
                    return cb(
                        null,
                        err.message.includes('No matching art') ? 'none' : err
                    );
                }
                return cb(null, paths.basename(info.fromPath));
            });
        }

        //  every slot of a random pool, by stepping Math.random()
        function pickAllRandom(basePath, name, options, cb) {
            const samples = 24;
            const seen = new Set();
            let i = 0;
            const next = () => {
                if (i >= samples) {
                    return cb(null, [...seen].sort());
                }
                const value = (i + 0.5) / samples;
                i += 1;
                Math.random = () => value;
                pick(
                    basePath,
                    name,
                    Object.assign({}, options, { random: true }),
                    (err, f) => {
                        Math.random = REAL_RANDOM;
                        seen.add(f);
                        return next();
                    }
                );
            };
            next();
        }

        //  |name| picked from |dirA| with |clientA| and from |dirB| with |clientB|,
        //  plainly and in random mode; one name at a time (Math.random is global)
        function compare(dirA, clientA, dirB, clientB, options, check, done) {
            async.eachSeries(
                NAMES,
                (name, next) => {
                    const a = Object.assign({ client: clientA }, options);
                    const b = Object.assign({ client: clientB }, options);
                    pick(dirA, name, a, (e, fa) => {
                        pick(dirB, name, b, (e, fb) => {
                            check(name, [fa], [fb]);
                            pickAllRandom(dirA, name, a, (e, ra) => {
                                pickAllRandom(dirB, name, b, (e, rb) => {
                                    check(`${name} (random)`, ra, rb);
                                    return next();
                                });
                            });
                        });
                    });
                },
                done
            );
        }

        const sameAndNever = ext => (what, a, b) => {
            assert.deepEqual(a, b, what);
            assert.ok(
                a.every(f => !String(f).endsWith(ext)),
                `${what}: ${a}`
            );
        };

        const otherSessions = {
            'no client': () => undefined,
            'client without a term': () => ({}),
            'stand-in cp437 term': () => ({ term: { outputEncoding: 'cp437' } }),
            'stand-in utf8 term': () => ({ term: { outputEncoding: 'utf8' } }),
            'CP437 terminal': () => ansiClient('cp437'),
            'UTF-8 terminal': () => ansiClient('utf8'),
            'PETSCII terminal': () => petsciiClient(),
        };

        Object.entries(otherSessions).forEach(([desc, mkClient]) => {
            [false, true].forEach(acceptNative => {
                it(`${desc}${acceptNative ? ', native accepted' : ''}: same file as without any .ata, never an .ata`, done => {
                    const client = mkClient();
                    compare(
                        withAta,
                        client,
                        withoutAta,
                        client,
                        { acceptNative },
                        sameAndNever('.ata'),
                        done
                    );
                });
            });
        });

        it('an .ata-only name does not exist for ANSI and PETSCII sessions', done => {
            async.eachSeries(
                [ansiClient('cp437'), ansiClient('utf8'), petsciiClient()],
                (client, next) =>
                    pick(withAta, 'ONLYATA', { client, acceptNative: true }, (e, f) => {
                        assert.equal(f, 'none');
                        return next();
                    }),
                done
            );
        });

        it('ATASCII prefers .ata when native art is accepted, and never gets .seq', done => {
            const client = atasciiClient();
            const want = {
                MATRIX: 'MATRIX.ata',
                ONLYATA: 'ONLYATA.ata',
                SEQATA: 'SEQATA.ata',
                ONLYSEQ: 'none',
                ONLYANS: 'ONLYANS.ans',
                MIXED: 'MIXED.ans',
                VAR1: 'VAR1.ata',
            };
            async.eachSeries(
                Object.keys(want),
                (name, next) =>
                    pick(withAta, name, { client, acceptNative: true }, (e, f) => {
                        assert.equal(f, want[name], name);
                        return next();
                    }),
                err => {
                    assert.ifError(err);
                    pickAllRandom(
                        withAta,
                        'RAND',
                        { client, acceptNative: true },
                        (e, all) => {
                            assert.deepEqual(all, ['RAND3.ata']);
                            return done();
                        }
                    );
                }
            );
        });

        //  the policy ATASCII had before .ata existed, as an explicit override
        function masterAtasciiClient() {
            const client = atasciiClient();
            client.term.artTypes = { preferred: [], last: ['.utf8ans'] };
            return client;
        }

        [false, true].forEach(acceptNative => {
            it(`ATASCII${acceptNative ? ', native accepted' : ''}, no .ata files: exactly the choice of before, never a .seq`, done => {
                compare(
                    withoutAta,
                    atasciiClient(),
                    withoutAta,
                    masterAtasciiClient(),
                    { acceptNative },
                    sameAndNever('.seq'),
                    () =>
                        compare(
                            ansiOnly,
                            atasciiClient(),
                            ansiOnly,
                            masterAtasciiClient(),
                            { acceptNative },
                            sameAndNever('.seq'),
                            done
                        )
                );
            });
        });

        it('ATASCII without native accepted: the same as without any .ata', done => {
            const client = atasciiClient();
            compare(withAta, client, withoutAta, client, {}, sameAndNever('.ata'), done);
        });
    });

    describe('theme art lookup steps', function () {
        let previousConfig;

        function installThemes(themes) {
            const { ThemeManager } = theme;
            const realInit = ThemeManager.prototype.init;
            ThemeManager.prototype.init = function (cb) {
                Object.entries(themes).forEach(([themeId, info]) => {
                    const raw = { info: Object.assign({ name: themeId }, info) };
                    const fin = { info: Object.assign({}, raw.info, { themeId }) };
                    const tc = { getRaw: () => raw, get: () => fin };
                    this.loadedThemeConfigs.set(themeId, tc);
                    this.availableThemes.set(themeId, tc);
                });
                return cb(null);
            };
            try {
                ThemeManager.create(err => assert.ifError(err));
            } finally {
                ThemeManager.prototype.init = realInit;
            }
        }

        before(function () {
            dir('themes/ansi_one', { 'STEP.ata': SAMPLE, 'BOTH.ans': 'a\r\n' });
            dir('themes/pet_one', { 'BOTH.seq': SAMPLE, 'BOTH.ata': SAMPLE });
            dir('themes/ata_one', {
                'ASTEP.ata': SAMPLE,
                'BOTH.ata': SAMPLE,
                'BOTH.seq': SAMPLE,
                'BOTH.ans': 'x\r\n',
            });
            const artDir = dir('general', {
                'STEP.ata': SAMPLE,
                'STEP.ans': 's\r\n',
                'ATAONLY.ata': SAMPLE,
                'SEQONLY.seq': SAMPLE,
                'GEN.ans': 'g\r\n',
            });
            const config = {
                debug: { assertsEnabled: false },
                menus: { cls: false },
                general: { boardName: 'Test' },
                paths: { themes: paths.join(tmp, 'themes'), art: artDir },
                theme: {
                    default: 'ansi_one',
                    preLogin: 'ansi_one',
                    emulations: {
                        petscii: { default: 'pet_one' },
                        atascii: { default: 'ata_one' },
                    },
                },
            };
            previousConfig = configModule.get;
            configModule.get = () => config;
            theme = require('../core/theme.js');
            installThemes({
                ansi_one: {},
                pet_one: { emulation: 'petscii' },
                ata_one: { emulation: 'atascii' },
            });
        });

        after(function () {
            configModule.get = previousConfig;
        });

        function lookup(client, name, extra, cb) {
            theme.getThemeArt(
                Object.assign({ client, name, acceptNative: true }, extra),
                (err, info) => {
                    if (err) {
                        return cb('none');
                    }
                    return cb(paths.relative(tmp, info.fromPath));
                }
            );
        }

        it('ANSI session: theme, default theme and general art never yield .ata', done => {
            const client = ansiClient('cp437', 'ansi_one');
            theme.setClientTheme(client, 'ansi_one');
            lookup(client, 'STEP', {}, f => {
                assert.equal(f, 'general/STEP.ans');
                lookup(client, 'ATAONLY', {}, f => {
                    assert.equal(f, 'none');
                    lookup(client, 'BOTH', { themeId: 'ata_one' }, f => {
                        assert.equal(f, 'themes/ata_one/BOTH.ans');
                        lookup(client, 'ASTEP', { themeId: 'ata_one' }, f => {
                            assert.equal(f, 'none');
                            return done();
                        });
                    });
                });
            });
        });

        it('PETSCII session: .seq from its theme, never .ata', done => {
            const client = petsciiClient();
            theme.setClientTheme(client, undefined);
            assert.equal(client.currentTheme.info.themeId, 'pet_one');
            lookup(client, 'BOTH', {}, f => {
                assert.equal(f, 'themes/pet_one/BOTH.seq');
                lookup(client, 'ATAONLY', {}, f => {
                    assert.equal(f, 'none');
                    lookup(client, 'STEP', {}, f => {
                        assert.equal(f, 'general/STEP.ans');
                        return done();
                    });
                });
            });
        });

        it('ATASCII session: its theme first, .ata preferred, ANSI as the fallback, never .seq', done => {
            const client = atasciiClient();
            theme.setClientTheme(client, undefined);
            assert.equal(client.currentTheme.info.themeId, 'ata_one');
            lookup(client, 'BOTH', {}, f => {
                assert.equal(f, 'themes/ata_one/BOTH.ata');
                lookup(client, 'STEP', {}, f => {
                    assert.equal(f, 'general/STEP.ata');
                    lookup(client, 'GEN', {}, f => {
                        assert.equal(f, 'general/GEN.ans');
                        lookup(client, 'SEQONLY', {}, f => {
                            assert.equal(f, 'none');
                            lookup(client, 'BOTH', { acceptNative: false }, f => {
                                assert.equal(f, 'themes/ata_one/BOTH.ans');
                                return done();
                            });
                        });
                    });
                });
            });
        });
    });

    describe('display', function () {
        //  "Name: %ET1" / blank / an inverse "Pass: %et2 " bar
        const ART = Buffer.from([
            C.clear,
            ...text('Name: '),
            ...text('%ET1'),
            C.eol,
            C.eol,
            ...inv('Pass: '),
            ...inv('%et2'),
            ...inv(' '),
            C.eol,
        ]);
        const NATIVE = { emulation: 'atascii' };
        const expectedWire = () => {
            const w = Buffer.from(ART);
            w.fill(0x20, 7, 11);
            w.fill(0xa0, 19, 23);
            return w;
        };

        const row = (screen, r) =>
            [...Array(screen.cols).keys()]
                .map(c => screen.actual(r, c).ch)
                .join('')
                .trimEnd();

        it('an ATASCII session gets the bytes as they are, MCI codes blanked; a view lands at its code', done => {
            const client = atasciiClient();
            art.display(client, ART, { native: NATIVE }, (err, mciMap, extraInfo) => {
                assert.ifError(err);
                assert.deepEqual([...wire(client.output)], [...expectedWire()]);
                assert.deepEqual(Object.keys(mciMap).sort(), ['ET1', 'ET2']);
                assert.deepEqual(mciMap.ET1.position, [1, 7]);
                assert.deepEqual(mciMap.ET2.position, [3, 7]);
                assert.equal(mciMap.ET1.SGR, '\x1b[0m');
                assert.equal(mciMap.ET2.SGR, '\x1b[0;7m');
                assert.deepEqual(extraInfo, { height: 3 });

                //  a view at an MCI position lands there, in the art's inverse state
                const p = mciMap.ET2.position;
                client.term.write(`${mciMap.ET2.SGR}\x1b[${p[0]};${p[1]}Hsecret`);
                const q = mciMap.ET1.position;
                client.term.write(`${mciMap.ET1.SGR}\x1b[${q[0]};${q[1]}Hbob`);
                const screen = new AtasciiScreen(40, 24);
                screen.write(wire(client.output));
                assert.equal(row(screen, 0), 'Name: bob');
                assert.equal(row(screen, 2), 'Pass: secret');
                assert.deepEqual(screen.actual(2, 6), { ch: 's', inverse: true });
                assert.deepEqual(screen.actual(2, 0), { ch: 'P', inverse: true });
                assert.deepEqual(screen.actual(0, 7), { ch: 'o', inverse: false });
                return done();
            });
        });

        it('through theme.displayPreparedArt(), with a baud rate', done => {
            theme = theme || require('../core/theme.js');
            const client = atasciiClient();
            theme.displayPreparedArt(
                { client, baudRate: 10000000 },
                { data: ART, native: NATIVE },
                (err, artData) => {
                    assert.ifError(err);
                    assert.deepEqual([...wire(client.output)], [...expectedWire()]);
                    assert.deepEqual(artData.mciMap.ET2.position, [3, 7]);
                    return done();
                }
            );
        });

        it('position unknown (after a door) and art without CLEAR: a CLEAR goes first', done => {
            const client = atasciiClient();
            client.term.write('\x1b[2Jhello');
            client.term.passThroughWrite(Buffer.from('door output'));
            client.output.written.length = 0;
            const noClear = ART.slice(1);
            art.display(client, noClear, { native: NATIVE }, (err, mciMap) => {
                assert.ifError(err);
                const out = wire(client.output);
                assert.equal(out[0], C.clear);
                assert.deepEqual([...out.slice(1)], [...expectedWire().slice(1)]);
                assert.deepEqual(mciMap.ET1.position, [1, 7]);
                return done();
            });
        });

        it('DELETE / INSERT CHARACTER and LINE move the MCI positions with the screen', done => {
            const client = atasciiClient();
            const edits = Buffer.from([
                C.clear,
                ...text('ab%ET1'),
                ...Array(6).fill(C.cursorLeft),
                C.deleteChar, //  'b%ET1' moves left a cell
                C.eol,
                ...text('xy%VM1'),
                ...Array(4).fill(C.cursorLeft),
                C.insertChar, //  the code moves right a cell
                C.eol,
                ...text('%XY1'),
                C.eol,
                ...text('%TL1'),
                C.cursorUp,
                C.deleteLine, //  the %XY1 row goes, %TL1 moves up
                C.cursorUp,
                C.cursorUp,
                C.insertLine, //  rows from the top move down
            ]);
            art.display(client, edits, { native: NATIVE }, (err, mciMap) => {
                assert.ifError(err);
                assert.deepEqual(Object.keys(mciMap).sort(), ['ET1', 'TL1', 'VM1']);
                assert.deepEqual(mciMap.ET1.position, [2, 2]);
                assert.deepEqual(mciMap.VM1.position, [3, 4]);
                assert.deepEqual(mciMap.TL1.position, [4, 1]);
                const screen = new AtasciiScreen(40, 24, { native: true });
                screen.write(wire(client.output));
                assert.equal(row(screen, 1), 'b');
                assert.equal(row(screen, 2), 'xy');
                assert.equal(row(screen, 3), '');
                return done();
            });
        });

        it('native and translated writes in one batch keep their order', () => {
            const client = atasciiClient();
            const term = client.term;
            term.beginWrite();
            term.write('\x1b[2J');
            term.nativeWrite(Buffer.from([...text('ab'), C.eol, ...inv('cd')]));
            term.write('\x1b[1;2HX');
            term.nativeWrite(Buffer.from([C.eol, C.eol, ...text('e')]));
            term.write('Y');
            term.commitWrite();
            const screen = new AtasciiScreen(40, 24);
            screen.write(wire(client.output));
            assert.equal(row(screen, 0), 'aX');
            assert.equal(row(screen, 1), 'cd');
            assert.equal(row(screen, 2), 'eY');
            assert.equal(screen.actual(1, 0).inverse, true);
        });

        const otherSessions = {
            'ANSI (cp437)': () => ansiClient('cp437'),
            'ANSI (utf8)': () => ansiClient('utf8'),
        };
        Object.entries(otherSessions).forEach(([desc, mkClient]) => {
            it(`an ${desc} session handed .ata art gets text, never ATASCII bytes`, done => {
                const client = mkClient();
                art.display(client, ART, { native: NATIVE }, (err, mciMap) => {
                    assert.ifError(err);
                    const out = wire(client.output);
                    [C.eol, 0xa0, 0xd0, 0xe1].forEach(b =>
                        assert.ok(!out.includes(b), `byte 0x${b.toString(16)}`)
                    );
                    assert.ok(!out.toString('latin1').includes('}'));
                    assert.ok(out.toString('latin1').includes('Name: '));
                    assert.ok(out.toString('latin1').includes('Pass: '));
                    //  the ANSI parser finds the upper case code only
                    assert.deepEqual(Object.keys(mciMap), ['ET1']);
                    assert.deepEqual(mciMap.ET1.position, [1, 7]);
                    assert.equal(client.term.canWriteNative(), false);
                    return done();
                });
            });
        });

        it('a PETSCII session handed .ata art gets text, translated to PETSCII', done => {
            const client = petsciiClient();
            client.term.write('\x1b[2J');
            art.display(client, ART, { native: NATIVE }, err => {
                assert.ifError(err);
                assert.equal(client.term.canWriteNative(), true); //  PETSCII's own, not .ata
                const screen = new PetsciiScreen(40, 25);
                screen.write(wire(client.output));
                const prow = r =>
                    [...Array(40).keys()]
                        .map(c => screen.actual(r, c).ch)
                        .join('')
                        .trimEnd();
                assert.equal(prow(0), 'Name:');
                assert.equal(prow(2), 'Pass: %et2');
                return done();
            });
        });

        it('an explicit NAME.ata for an ANSI session is text, loaded either way', done => {
            const d = dir('explicit', { 'ART.ata': ART });
            const client = ansiClient('cp437');
            art.getArt(
                'ART.ata',
                { basePath: d, client, acceptNative: true },
                (err, info) => {
                    assert.ifError(err);
                    assert.deepEqual(info.native, NATIVE);
                    art.display(client, info.data, { native: info.native }, err => {
                        assert.ifError(err);
                        const viaNative = wire(client.output);
                        const plain = ansiClient('cp437');
                        art.getArt(
                            'ART.ata',
                            { basePath: d, client: plain },
                            (err, info) => {
                                assert.ifError(err);
                                assert.equal(typeof info.data, 'string');
                                art.display(plain, info.data, {}, err => {
                                    assert.ifError(err);
                                    assert.deepEqual(wire(plain.output), viaNative);
                                    return done();
                                });
                            }
                        );
                    });
                }
            );
        });
    });

    //
    //  ANSI art shown to an ATASCII session, pinned byte for byte. The expected
    //  values were produced by core/art.js on origin/master 207a9aab, before
    //  .ata existed: the translated fallback must not change.
    //
    describe('ANSI art for an ATASCII session, pinned', function () {
        const PIN_ART =
            '\x1b[0m\x1b[2J\x1b[1;34m\u2554\u2550\u2557 Name: %ET1\r\n\x1b[0;33mPass: \x1b[5C%ET2(4)\r\n' +
            '\x1b[7m%VM1\x1b[0m end\r\n\x1aSAUCE';
        const PIN_WIRE =
            '7d111205204e616d653a20202020209b506173733a201f1f1f1f1f202020202020209ba0a0a0a020656e649b';
        const PIN_MCI = {
            ET1: {
                position: [1, 11],
                args: [],
                SGR: '\x1b[0;1;34m',
                code: 'ET',
                id: 1,
            },
            ET2: {
                position: [2, 12],
                args: ['4'],
                SGR: '\x1b[0;33m',
                code: 'ET',
                id: 2,
            },
            VM1: {
                position: [3, 1],
                args: [],
                SGR: '\x1b[0;7;33m',
                code: 'VM',
                id: 1,
            },
        };

        let d;
        before(function () {
            d = dir('pin', {
                'PIN.ans': iconv.encode(PIN_ART, 'cp437'),
                'PIN.utf8ans': 'nope',
            });
        });

        const check = (client, err, mciMap, extra) => {
            assert.ifError(err);
            assert.equal(wire(client.output).toString('hex'), PIN_WIRE);
            assert.deepEqual(JSON.parse(JSON.stringify(mciMap)), PIN_MCI);
            assert.deepEqual(extra, { height: 3 });
        };

        [0, 10000000].forEach(baudRate => {
            it(`a string of ANSI art, baud rate ${baudRate}`, done => {
                const client = atasciiClient();
                art.display(client, PIN_ART, { baudRate }, (err, mciMap, extra) => {
                    check(client, err, mciMap, extra);
                    return done();
                });
            });

            it(`an ANSI file picked by name (no .ata beside it), baud rate ${baudRate}`, done => {
                const client = atasciiClient();
                art.getArt(
                    'PIN',
                    {
                        basePath: d,
                        client,
                        acceptNative: true,
                        readSauce: true,
                        random: false,
                    },
                    (err, info) => {
                        assert.ifError(err);
                        assert.equal(paths.basename(info.fromPath), 'PIN.ans');
                        assert.equal(info.native, undefined);
                        art.display(
                            client,
                            info.data,
                            { baudRate, sauce: info.sauce },
                            (err, mciMap, extra) => {
                                check(client, err, mciMap, extra);
                                return done();
                            }
                        );
                    }
                );
            });
        });
    });
});
