'use strict';

//
//  Native PETSCII art (.seq) through core/art.js and core/theme.js (#593):
//  loading, type selection for ANSI and PETSCII sessions, and display.
//
//  The rule that matters most: an ANSI session is never given a .seq file,
//  and what it is given is exactly what it was given before .seq existed.
//
const { strict: assert } = require('assert');
const fs = require('fs');
const async = require('async');
const os = require('os');
const paths = require('path');

const configModule = require('../core/config.js');
const UserProps = require('../core/user_property.js');
const { Controls, Colors, encode } = require('../core/term/petscii/charset.js');
const { petsciiArtToText } = require('../core/term/petscii/art_parser.js');
const { ClientTerminal } = require('../core/client_term.js');
const { selectClientEmulation } = require('../core/term/select.js');
const { PetsciiScreen } = require('./term_petscii_screens.js');

const C = Controls;
const lower = s => [...encode(s, 'lower')];

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

//  a Client with a real ClientTerminal, a user and the currentTheme accessor
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

function petsciiClient(themeId) {
    const output = makeOutput();
    const term = new ClientTerminal(output);
    const client = makeClient(term, themeId);
    selectClientEmulation(client, {
        firstMenu: 'telnetConnected',
        listener: { name: 'c64', emulation: 'petscii' },
    });
    term.termWidth = 40;
    term.termHeight = 25;
    term.emulation.probes.forEach(probe => probe.run(client, () => {}));
    client.output = output;
    return client;
}

//  A SAUCE record (128 bytes) with |numComments| comment lines
function sauceRecord(numComments) {
    const rec = Buffer.alloc(128, 0x20);
    rec.write('SAUCE00', 0, 'latin1');
    rec[94] = 0; //  DataType none
    rec[104] = numComments;
    return rec;
}

const SAMPLE = Buffer.from([C.clear, Colors.red, ...lower('Hi'), C.return, 0xa0]);

describe('art: native PETSCII (.seq)', function () {
    let tmp;

    before(function () {
        art = require('../core/art.js');
        tmp = fs.mkdtempSync(paths.join(os.tmpdir(), 'enig-art-seq-'));
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
            const comment = Buffer.alloc(64, 0x41);
            d = dir('load', {
                'PLAIN.seq': SAMPLE,
                'SAUCED.seq': Buffer.concat([
                    SAMPLE,
                    Buffer.from([0x1a]),
                    Buffer.from('COMNT', 'latin1'),
                    comment,
                    sauceRecord(1),
                ]),
                'SAUCENC.seq': Buffer.concat([
                    SAMPLE,
                    Buffer.from([0x1a]),
                    sauceRecord(0),
                ]),
                'PADDED.seq': Buffer.concat([SAMPLE, Buffer.alloc(77, 0x1a)]),
                'INNER.seq': Buffer.from([0x41, 0x1a, 0x42]),
                'PLAIN.ans': 'abc\r\n',
            });
        });

        const load = (name, options, cb) =>
            art.getArt(name, Object.assign({ basePath: d }, options), cb);

        it('raw bytes and the default character set for a caller that shows native art', done => {
            load('PLAIN.seq', { acceptNative: true }, (err, info) => {
                assert.ifError(err);
                assert.deepEqual(info.data, SAMPLE);
                assert.deepEqual(info.native, { emulation: 'petscii', charset: 'lower' });
                assert.equal(info.sauce, undefined);
                return done();
            });
        });

        it('encodedAs picks the character set; other names are ignored', done => {
            const cases = [
                ['petscii_upper', 'upper'],
                ['PETSCII_UPPER', 'upper'],
                ['petscii_lower', 'lower'],
                ['petscii', 'lower'],
                ['cp437', 'lower'],
                [undefined, 'lower'],
            ];
            let n = 0;
            cases.forEach(([encodedAs, charset]) => {
                load('PLAIN.seq', { acceptNative: true, encodedAs }, (err, info) => {
                    assert.ifError(err);
                    assert.equal(info.native.charset, charset, String(encodedAs));
                    if (++n === cases.length) {
                        return done();
                    }
                });
            });
        });

        it('a SAUCE record, its comments and the EOF before it are stripped', done => {
            load('SAUCED.seq', { acceptNative: true, readSauce: true }, (err, info) => {
                assert.ifError(err);
                assert.deepEqual(info.data, SAMPLE);
                load('SAUCENC.seq', { acceptNative: true }, (err, info) => {
                    assert.ifError(err);
                    assert.deepEqual(info.data, SAMPLE);
                    return done();
                });
            });
        });

        it('trailing 0x1A padding is stripped; one inside the art is kept', done => {
            load('PADDED.seq', { acceptNative: true }, (err, info) => {
                assert.ifError(err);
                assert.deepEqual(info.data, SAMPLE);
                load('INNER.seq', { acceptNative: true }, (err, info) => {
                    assert.ifError(err);
                    assert.deepEqual([...info.data], [0x41, 0x1a, 0x42]);
                    return done();
                });
            });
        });

        it('plain text for a caller that does not show native art', done => {
            load('SAUCED.seq', {}, (err, info) => {
                assert.ifError(err);
                assert.equal(typeof info.data, 'string');
                assert.equal(info.native, undefined);
                assert.equal(info.data, petsciiArtToText(SAMPLE));
                assert.equal(info.data, 'Hi\r\n ');
                return done();
            });
        });

        it('a native encodedAs on an ANSI type is ignored, not fatal', done => {
            load('PLAIN.ans', { encodedAs: 'petscii_upper' }, (err, info) => {
                assert.ifError(err);
                assert.equal(info.data, 'abc\r\n');
                return done();
            });
        });
    });

    describe('selection', function () {
        const SEQ_FILES = ['MATRIX.seq', 'ONLYSEQ.seq', 'RAND3.seq', 'VAR1.seq'];
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
        let withSeq;
        let withoutSeq;

        before(function () {
            const files = list =>
                Object.fromEntries(
                    list.map(f => [f, f.endsWith('.seq') ? SAMPLE : `${f}\r\n`])
                );
            withSeq = dir('with', files([...OTHER_FILES, ...SEQ_FILES]));
            withoutSeq = dir('without', files(OTHER_FILES));
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
            const realRandom = REAL_RANDOM;
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
                        Math.random = realRandom;
                        seen.add(f);
                        return next();
                    }
                );
            };
            next();
        }

        const NAMES = ['MATRIX', 'ONLYSEQ', 'ONLYANS', 'MIXED', 'VAR1', 'RAND', 'VAR'];
        const ansiSessions = {
            'no client': () => undefined,
            'client without a term': () => ({}),
            'stand-in cp437 term': () => ({ term: { outputEncoding: 'cp437' } }),
            'stand-in utf8 term': () => ({ term: { outputEncoding: 'utf8' } }),
            'CP437 terminal': () => ansiClient('cp437'),
            'UTF-8 terminal': () => ansiClient('utf8'),
        };

        //  one name at a time: pickAllRandom() stubs the global Math.random
        function compareDirs(client, options, check, done) {
            async.eachSeries(
                NAMES,
                (name, next) => {
                    const opts = Object.assign({ client }, options);
                    pick(withSeq, name, opts, (e, a) => {
                        pick(withoutSeq, name, opts, (e, b) => {
                            check(name, [a], [b]);
                            pickAllRandom(withSeq, name, opts, (e, ra) => {
                                pickAllRandom(withoutSeq, name, opts, (e, rb) => {
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

        const sameAndNoSeq = (what, a, b) => {
            assert.deepEqual(a, b, what);
            assert.ok(
                a.every(f => !String(f).endsWith('.seq')),
                what
            );
        };

        Object.entries(ansiSessions).forEach(([desc, mkClient]) => {
            [false, true].forEach(acceptNative => {
                it(`${desc}${acceptNative ? ', native accepted' : ''}: same file as without any .seq, never a .seq`, done => {
                    compareDirs(mkClient(), { acceptNative }, sameAndNoSeq, done);
                });
            });
        });

        it('a .seq-only name does not exist for an ANSI session', done => {
            pick(
                withSeq,
                'ONLYSEQ',
                { client: ansiClient('cp437'), acceptNative: true },
                (e, f) => {
                    assert.equal(f, 'none');
                    return done();
                }
            );
        });

        it('PETSCII prefers .seq when native art is accepted', done => {
            const client = petsciiClient();
            pick(withSeq, 'MATRIX', { client, acceptNative: true }, (e, f) => {
                assert.equal(f, 'MATRIX.seq');
                pick(withSeq, 'ONLYSEQ', { client, acceptNative: true }, (e, f) => {
                    assert.equal(f, 'ONLYSEQ.seq');
                    pickAllRandom(
                        withSeq,
                        'RAND',
                        { client, acceptNative: true },
                        (e, all) => {
                            assert.deepEqual(all, ['RAND3.seq']);
                            return done();
                        }
                    );
                });
            });
        });

        it('PETSCII falls back to ANSI types, translated, as before', done => {
            const client = petsciiClient();
            pick(withSeq, 'ONLYANS', { client, acceptNative: true }, (e, f) => {
                assert.equal(f, 'ONLYANS.ans');
                pick(withSeq, 'MIXED', { client, acceptNative: true }, (e, f) => {
                    assert.equal(f, 'MIXED.ans');
                    return done();
                });
            });
        });

        it('PETSCII without native accepted: exactly the ANSI choice of before', done => {
            compareDirs(petsciiClient(), {}, sameAndNoSeq, done);
        });
    });

    describe('theme art lookup steps', function () {
        let themesDir;
        let artDir;
        let previousConfig;
        let config;

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
            themesDir = paths.join(tmp, 'themes');
            dir('themes/ansi_one', { 'STEP.seq': SAMPLE, 'BOTH.ans': 'a\r\n' });
            dir('themes/pet_one', {
                'PSTEP.seq': SAMPLE,
                'BOTH.seq': SAMPLE,
                'BOTH.ans': 'p\r\n',
            });
            artDir = dir('general', {
                'STEP.seq': SAMPLE,
                'STEP.ans': 's\r\n',
                'SEQONLY.seq': SAMPLE,
                'GEN.ans': 'g\r\n',
            });
            config = {
                debug: { assertsEnabled: false },
                menus: { cls: false },
                general: { boardName: 'Test' },
                paths: { themes: themesDir, art: artDir },
                theme: {
                    default: 'ansi_one',
                    preLogin: 'ansi_one',
                    emulations: { petscii: { default: 'pet_one' } },
                },
            };
            previousConfig = configModule.get;
            configModule.get = () => config;
            theme = require('../core/theme.js');
            installThemes({ ansi_one: {}, pet_one: { emulation: 'petscii' } });
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

        it('ANSI session: theme, default theme and general art never yield .seq', done => {
            const client = ansiClient('cp437', 'ansi_one');
            theme.setClientTheme(client, 'ansi_one');
            lookup(client, 'STEP', {}, f => {
                assert.equal(f, 'general/STEP.ans');
                lookup(client, 'SEQONLY', {}, f => {
                    assert.equal(f, 'none');
                    lookup(client, 'BOTH', {}, f => {
                        assert.equal(f, 'themes/ansi_one/BOTH.ans');
                        return done();
                    });
                });
            });
        });

        it('ANSI session with a forced PETSCII theme id: still no .seq', done => {
            const client = ansiClient('utf8', 'ansi_one');
            theme.setClientTheme(client, 'ansi_one');
            lookup(client, 'PSTEP', { themeId: 'pet_one' }, f => {
                assert.equal(f, 'none');
                lookup(client, 'BOTH', { themeId: 'pet_one' }, f => {
                    assert.equal(f, 'themes/pet_one/BOTH.ans');
                    return done();
                });
            });
        });

        it('PETSCII session: its theme first, .seq preferred, ANSI as the fallback', done => {
            const client = petsciiClient();
            theme.setClientTheme(client, undefined);
            assert.equal(client.currentTheme.info.themeId, 'pet_one');
            lookup(client, 'BOTH', {}, f => {
                assert.equal(f, 'themes/pet_one/BOTH.seq');
                lookup(client, 'STEP', {}, f => {
                    assert.equal(f, 'general/STEP.seq');
                    lookup(client, 'GEN', {}, f => {
                        assert.equal(f, 'general/GEN.ans');
                        lookup(client, 'BOTH', { acceptNative: false }, f => {
                            assert.equal(f, 'themes/pet_one/BOTH.ans');
                            return done();
                        });
                    });
                });
            });
        });
    });

    describe('display', function () {
        //  "Name: %ET1" / blank / "Pass: %ET2", two colours
        const ART = Buffer.from([
            C.clear,
            Colors.red,
            ...lower('Name: '),
            ...lower('%et1'),
            C.return,
            C.return,
            Colors.lightBlue,
            ...lower('Pass: '),
            ...[0x25, 0xc5, 0xd4, 0x32], //  %ET2 typed shifted
            C.return,
        ]);
        const NATIVE = { emulation: 'petscii', charset: 'lower' };
        const expectedWire = () => {
            const w = Buffer.from(ART);
            [8, 21].forEach(at => w.fill(0x20, at, at + 4));
            return w;
        };

        it('a PETSCII session gets the bytes as they are, MCI codes blanked', done => {
            const client = petsciiClient();
            art.display(client, ART, { native: NATIVE }, (err, mciMap, extraInfo) => {
                assert.ifError(err);
                assert.deepEqual(
                    [...wire(client.output)],
                    [C.charsetLower, ...expectedWire()]
                );
                assert.deepEqual(Object.keys(mciMap).sort(), ['ET1', 'ET2']);
                assert.deepEqual(mciMap.ET1.position, [1, 7]);
                assert.deepEqual(mciMap.ET2.position, [3, 7]);
                assert.equal(mciMap.ET1.SGR, '\x1b[0;31m');
                assert.equal(mciMap.ET2.SGR, '\x1b[0;1;34m');
                assert.deepEqual(extraInfo, { height: 3 });

                //  a view at an MCI position lands there, in the art's colour
                const screen = new PetsciiScreen(40, 25);
                const p = mciMap.ET2.position;
                client.term.write(`${mciMap.ET2.SGR}\x1b[${p[0]};${p[1]}Hsecret`);
                screen.write(wire(client.output));
                const row = r =>
                    [...Array(40).keys()].map(c => screen.actual(r, c).ch).join('');
                assert.equal(row(0).trimEnd(), 'Name:');
                assert.equal(row(2).trimEnd(), 'Pass: secret');
                assert.equal(screen.actual(2, 6).color, Colors.lightBlue);
                assert.equal(screen.actual(0, 0).color, Colors.red);
                return done();
            });
        });

        it('through theme.displayPreparedArt(), with a baud rate', done => {
            theme = theme || require('../core/theme.js');
            const client = petsciiClient();
            theme.displayPreparedArt(
                { client, baudRate: 10000000 },
                { data: ART, native: NATIVE },
                (err, artData) => {
                    assert.ifError(err);
                    assert.deepEqual(
                        [...wire(client.output)],
                        [C.charsetLower, ...expectedWire()]
                    );
                    assert.deepEqual(artData.mciMap.ET1.position, [1, 7]);
                    return done();
                }
            );
        });

        it('upper/graphics art: the set byte goes first and stays', done => {
            const client = petsciiClient();
            client.term.write('x');
            client.output.written.length = 0;
            art.display(
                client,
                Buffer.from([0xb0, 0xae]),
                { native: { emulation: 'petscii', charset: 'upper' } },
                err => {
                    assert.ifError(err);
                    assert.deepEqual(
                        [...wire(client.output)],
                        [C.charsetUpper, 0xb0, 0xae]
                    );
                    assert.equal(
                        client.term.emulation.outputTranslator.state().activeCharset,
                        'upper'
                    );
                    return done();
                }
            );
        });

        ['cp437', 'utf8'].forEach(encoding => {
            it(`an ANSI (${encoding}) session handed .seq art gets text, never PETSCII bytes`, done => {
                const client = ansiClient(encoding);
                art.display(client, ART, { native: NATIVE }, (err, mciMap) => {
                    assert.ifError(err);
                    const out = wire(client.output);
                    [C.clear, C.charsetLower, Colors.red, Colors.lightBlue, 0xc5].forEach(
                        b => assert.ok(!out.includes(b), `byte 0x${b.toString(16)}`)
                    );
                    assert.ok(out.toString('latin1').includes('Name: '));
                    //  the ANSI parser finds the upper case code only
                    assert.deepEqual(Object.keys(mciMap), ['ET2']);
                    assert.deepEqual(mciMap.ET2.position, [3, 7]);
                    assert.equal(client.term.canWriteNative(), false);
                    return done();
                });
            });
        });
    });
});
