'use strict';

//
//  RIPscrip art (.rip, #989): which file a session gets, how the ANSI escape
//  parser takes RIP command lines in .rip art, how .rip art reaches the
//  terminal (unfiltered, MCI codes still placed), who may show it, and the
//  "kill mouse fields" sent when a session leaves a .rip screen.
//
//  The rule that matters most: a session without the RIP layer gets exactly
//  what it got before the type existed, .rip files in the art directories
//  or not (MASTER_PINS).
//
const { strict: assert } = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const paths = require('path');

const configModule = require('../core/config.js');
const UserProps = require('../core/user_property.js');
const { ClientTerminal } = require('../core/client_term.js');
const { ANSIEscapeParser } = require('../core/ansi_escape_parser.js');
const { attachRipLayer } = require('../core/term/select.js');
const Rip = require('../core/term/rip');

//  Late bound: art.js captures config.js's |get| at require time
let art;

const latin1 = b => Buffer.from(b).toString('latin1');
const bytes = s => Buffer.from(s, 'latin1');
const REAL_RANDOM = Math.random;

const quietLog = {
    trace() {},
    debug() {},
    info() {},
    warn() {},
    error() {},
    fatal() {},
    level: () => 100,
    child() {
        return quietLog;
    },
};

//  A ClientTerminal and what reached its socket; |rip| attaches the layer as
//  a TTYPE 'RIP' caller gets it
function session({ encoding = 'cp437', rip = false, rows = 25 } = {}) {
    const wire = [];
    const term = new ClientTerminal({
        writable: true,
        write(data, cb) {
            wire.push('string' === typeof data ? bytes(data) : Buffer.from(data));
            if (cb) {
                cb(null);
            }
        },
    });
    term.outputEncoding = encoding;
    term.termWidth = 80;
    term.termHeight = rows;
    const client = {
        term,
        log: quietLog,
        user: { properties: {}, isAuthenticated: () => false },
        currentThemeConfig: { get: () => ({ info: { name: 'N/A' } }) },
    };
    Object.defineProperty(client, 'currentTheme', {
        get: () => client.currentThemeConfig.get(),
        set: tc => {
            client.currentThemeConfig = tc;
        },
    });
    if (rip) {
        attachRipLayer(client, { source: 'termType' });
    }
    return {
        term,
        client,
        wire,
        sent: () => latin1(Buffer.concat(wire)),
        clear: () => {
            wire.length = 0;
        },
    };
}

//  setTimeout() replaced by a queue the test runs by hand
function fakeTimers() {
    const real = global.setTimeout;
    const queue = [];
    global.setTimeout = fn => {
        queue.push(fn);
        return { unref() {} };
    };
    return {
        queue,
        tick() {
            queue.shift()();
        },
        runAll() {
            while (queue.length > 0) {
                this.tick();
            }
        },
        restore() {
            global.setTimeout = real;
        },
    };
}

//  A SAUCE record (128 bytes): Character / RIP script, 80 x 43
function sauceRecord() {
    const rec = Buffer.alloc(128, 0x20);
    rec.write('SAUCE00', 0, 'latin1');
    rec.writeUInt32LE(0, 90);
    rec[94] = 1; //  Character
    rec[95] = 3; //  RIP script
    rec.writeUInt16LE(80, 96);
    rec.writeUInt16LE(43, 98);
    rec[104] = 0;
    rec[105] = 0;
    return rec;
}

//
//  MASTER IDENTITY
//  ---------------
//  The scenarios below were run against origin/master 3a68a444 (before the
//  type existed) for sessions without the RIP layer: no client, ANSI CP437,
//  ANSI UTF-8; random selection on and off; with |acceptRip| and without
//  (master ignores it). MASTER_PINS holds, per scenario, a hash of what
//  getArt() picked and read (file, data, keys) or what display() sent and
//  found (wire, MCI map, height).
//
const SAUCE_TAIL = '\x1a' + 'SAUCE00' + 'T'.repeat(121);

const PIN_FILES = {
    'FOO.ans': 'FOO ans %TL1\r\n',
    'FOO.rip': '!|1K|e\r\nFOO rip %TL1\r\n',
    'BAR.rip': '!|1K\r\nBAR rip only\r\n',
    'BAZ.asc': 'BAZ asc\r\n',
    'BAZ.rip': '!|e\r\nBAZ rip\r\n',
    'RAND1.ans': 'RAND1 ans\r\n',
    'RAND2.ans': 'RAND2 ans\r\n',
    'RAND2.rip': '!|e\r\nRAND2 rip\r\n',
    'RAND3.rip': '!|e\r\nRAND3 rip\r\n',
    'RIPONLY1.rip': '!|e\r\nRIPONLY1\r\n',
    'RIPONLY2.rip': '!|e\r\nRIPONLY2\r\n',
    'UTF.utf8ans': 'UTF utf8ans é\r\n',
    'UTF.rip': '!|e\r\nUTF rip\r\n',
    'SAUCED.rip': '!|1K\r\nSauced \xc9\xcd\xbb\r\n' + SAUCE_TAIL,
    'LF.rip': '!|1K\\\nmore\nLF text %TL1\n',
};

const PIN_SELECTIONS = [
    { name: 'FOO' },
    { name: 'FOO', options: { acceptRip: true } },
    { name: 'FOO', options: { acceptRip: true, acceptNative: true } },
    { name: 'BAR' },
    { name: 'BAR', options: { acceptRip: true } },
    { name: 'BAZ', options: { acceptRip: true } },
    { name: 'RAND', options: { acceptRip: true } },
    { name: 'RAND' },
    { name: 'RIPONLY', options: { acceptRip: true } },
    { name: 'UTF', options: { acceptRip: true } },
    { name: 'FOO.rip' },
    { name: 'FOO.rip', options: { acceptRip: true } },
    { name: 'SAUCED.rip', options: { acceptRip: true } },
    { name: 'LF.rip', options: { acceptRip: true } },
    { name: 'FOO', options: { types: ['.rip', '.ans'], acceptRip: true } },
];

const PIN_DISPLAYS = {
    ripmix:
        '\x1b[0m\x1b[2J!|1K|e\r\n!|1U0000000010101010aaa\\\r\nmore|1K\r\nHello %TL1 there\r\n' +
        '\x01|1K\r\n%ET2(4)\r\nmid !|x %TL3\r\n\x1b[0m!|y\r\n',
    lfonly: '!|1K\nText %TL1\n!|e\\\nx\nend\n',
    long: '!|' + 'A'.repeat(200) + '\r\n%TL1 after\r\n',
};

const MASTER_PINS = {
    'FOO|none|false|{}': '955a0313c7fa141a4480f4d39ec5097f',
    'FOO|none|true|{}': '955a0313c7fa141a4480f4d39ec5097f',
    'FOO|cp437|false|{}': '955a0313c7fa141a4480f4d39ec5097f',
    'FOO|cp437|true|{}': '955a0313c7fa141a4480f4d39ec5097f',
    'FOO|utf8|false|{}': '955a0313c7fa141a4480f4d39ec5097f',
    'FOO|utf8|true|{}': '955a0313c7fa141a4480f4d39ec5097f',
    'FOO|none|false|{"acceptRip":true}': '955a0313c7fa141a4480f4d39ec5097f',
    'FOO|none|true|{"acceptRip":true}': '955a0313c7fa141a4480f4d39ec5097f',
    'FOO|cp437|false|{"acceptRip":true}': '955a0313c7fa141a4480f4d39ec5097f',
    'FOO|cp437|true|{"acceptRip":true}': '955a0313c7fa141a4480f4d39ec5097f',
    'FOO|utf8|false|{"acceptRip":true}': '955a0313c7fa141a4480f4d39ec5097f',
    'FOO|utf8|true|{"acceptRip":true}': '955a0313c7fa141a4480f4d39ec5097f',
    'FOO|none|false|{"acceptRip":true,"acceptNative":true}':
        '955a0313c7fa141a4480f4d39ec5097f',
    'FOO|none|true|{"acceptRip":true,"acceptNative":true}':
        '955a0313c7fa141a4480f4d39ec5097f',
    'FOO|cp437|false|{"acceptRip":true,"acceptNative":true}':
        '955a0313c7fa141a4480f4d39ec5097f',
    'FOO|cp437|true|{"acceptRip":true,"acceptNative":true}':
        '955a0313c7fa141a4480f4d39ec5097f',
    'FOO|utf8|false|{"acceptRip":true,"acceptNative":true}':
        '955a0313c7fa141a4480f4d39ec5097f',
    'FOO|utf8|true|{"acceptRip":true,"acceptNative":true}':
        '955a0313c7fa141a4480f4d39ec5097f',
    'BAR|none|false|{}': '36c347c55e15699c357e48770e26a3da',
    'BAR|none|true|{}': '36c347c55e15699c357e48770e26a3da',
    'BAR|cp437|false|{}': '36c347c55e15699c357e48770e26a3da',
    'BAR|cp437|true|{}': '36c347c55e15699c357e48770e26a3da',
    'BAR|utf8|false|{}': '36c347c55e15699c357e48770e26a3da',
    'BAR|utf8|true|{}': '36c347c55e15699c357e48770e26a3da',
    'BAR|none|false|{"acceptRip":true}': '36c347c55e15699c357e48770e26a3da',
    'BAR|none|true|{"acceptRip":true}': '36c347c55e15699c357e48770e26a3da',
    'BAR|cp437|false|{"acceptRip":true}': '36c347c55e15699c357e48770e26a3da',
    'BAR|cp437|true|{"acceptRip":true}': '36c347c55e15699c357e48770e26a3da',
    'BAR|utf8|false|{"acceptRip":true}': '36c347c55e15699c357e48770e26a3da',
    'BAR|utf8|true|{"acceptRip":true}': '36c347c55e15699c357e48770e26a3da',
    'BAZ|none|false|{"acceptRip":true}': 'e40b778fb795e64f40bb063ec6fc29dc',
    'BAZ|none|true|{"acceptRip":true}': 'e40b778fb795e64f40bb063ec6fc29dc',
    'BAZ|cp437|false|{"acceptRip":true}': 'e40b778fb795e64f40bb063ec6fc29dc',
    'BAZ|cp437|true|{"acceptRip":true}': 'e40b778fb795e64f40bb063ec6fc29dc',
    'BAZ|utf8|false|{"acceptRip":true}': 'e40b778fb795e64f40bb063ec6fc29dc',
    'BAZ|utf8|true|{"acceptRip":true}': 'e40b778fb795e64f40bb063ec6fc29dc',
    'RAND|none|false|{"acceptRip":true}': '0ca732019a840edefbb5026054517754',
    'RAND|none|true|{"acceptRip":true}': 'b864e8ad12e6e94e0a3695d5382883b3',
    'RAND|cp437|false|{"acceptRip":true}': '0ca732019a840edefbb5026054517754',
    'RAND|cp437|true|{"acceptRip":true}': 'b864e8ad12e6e94e0a3695d5382883b3',
    'RAND|utf8|false|{"acceptRip":true}': '0ca732019a840edefbb5026054517754',
    'RAND|utf8|true|{"acceptRip":true}': 'b864e8ad12e6e94e0a3695d5382883b3',
    'RAND|none|false|{}': '0ca732019a840edefbb5026054517754',
    'RAND|none|true|{}': 'b864e8ad12e6e94e0a3695d5382883b3',
    'RAND|cp437|false|{}': '0ca732019a840edefbb5026054517754',
    'RAND|cp437|true|{}': 'b864e8ad12e6e94e0a3695d5382883b3',
    'RAND|utf8|false|{}': '0ca732019a840edefbb5026054517754',
    'RAND|utf8|true|{}': 'b864e8ad12e6e94e0a3695d5382883b3',
    'RIPONLY|none|false|{"acceptRip":true}': '52237382d3175e36eab2c9b1ca385823',
    'RIPONLY|none|true|{"acceptRip":true}': '52237382d3175e36eab2c9b1ca385823',
    'RIPONLY|cp437|false|{"acceptRip":true}': '52237382d3175e36eab2c9b1ca385823',
    'RIPONLY|cp437|true|{"acceptRip":true}': '52237382d3175e36eab2c9b1ca385823',
    'RIPONLY|utf8|false|{"acceptRip":true}': '52237382d3175e36eab2c9b1ca385823',
    'RIPONLY|utf8|true|{"acceptRip":true}': '52237382d3175e36eab2c9b1ca385823',
    'UTF|none|false|{"acceptRip":true}': 'dcbd6847e38be0c74e866ac9a013b817',
    'UTF|none|true|{"acceptRip":true}': 'dcbd6847e38be0c74e866ac9a013b817',
    'UTF|cp437|false|{"acceptRip":true}': 'dcbd6847e38be0c74e866ac9a013b817',
    'UTF|cp437|true|{"acceptRip":true}': 'dcbd6847e38be0c74e866ac9a013b817',
    'UTF|utf8|false|{"acceptRip":true}': 'dcbd6847e38be0c74e866ac9a013b817',
    'UTF|utf8|true|{"acceptRip":true}': 'dcbd6847e38be0c74e866ac9a013b817',
    'FOO.rip|none|false|{}': 'bf235767e3b6f59f07365b99c13adac0',
    'FOO.rip|none|true|{}': 'bf235767e3b6f59f07365b99c13adac0',
    'FOO.rip|cp437|false|{}': 'bf235767e3b6f59f07365b99c13adac0',
    'FOO.rip|cp437|true|{}': 'bf235767e3b6f59f07365b99c13adac0',
    'FOO.rip|utf8|false|{}': 'bf235767e3b6f59f07365b99c13adac0',
    'FOO.rip|utf8|true|{}': 'bf235767e3b6f59f07365b99c13adac0',
    'FOO.rip|none|false|{"acceptRip":true}': 'bf235767e3b6f59f07365b99c13adac0',
    'FOO.rip|none|true|{"acceptRip":true}': 'bf235767e3b6f59f07365b99c13adac0',
    'FOO.rip|cp437|false|{"acceptRip":true}': 'bf235767e3b6f59f07365b99c13adac0',
    'FOO.rip|cp437|true|{"acceptRip":true}': 'bf235767e3b6f59f07365b99c13adac0',
    'FOO.rip|utf8|false|{"acceptRip":true}': 'bf235767e3b6f59f07365b99c13adac0',
    'FOO.rip|utf8|true|{"acceptRip":true}': 'bf235767e3b6f59f07365b99c13adac0',
    'SAUCED.rip|none|false|{"acceptRip":true}': '4a3580b1843d4990a88d11aa34eb0f45',
    'SAUCED.rip|none|true|{"acceptRip":true}': '4a3580b1843d4990a88d11aa34eb0f45',
    'SAUCED.rip|cp437|false|{"acceptRip":true}': '4a3580b1843d4990a88d11aa34eb0f45',
    'SAUCED.rip|cp437|true|{"acceptRip":true}': '4a3580b1843d4990a88d11aa34eb0f45',
    'SAUCED.rip|utf8|false|{"acceptRip":true}': '4a3580b1843d4990a88d11aa34eb0f45',
    'SAUCED.rip|utf8|true|{"acceptRip":true}': '4a3580b1843d4990a88d11aa34eb0f45',
    'LF.rip|none|false|{"acceptRip":true}': 'fe43f1b5bcacbd0cd5468e11d8b4a184',
    'LF.rip|none|true|{"acceptRip":true}': 'fe43f1b5bcacbd0cd5468e11d8b4a184',
    'LF.rip|cp437|false|{"acceptRip":true}': 'fe43f1b5bcacbd0cd5468e11d8b4a184',
    'LF.rip|cp437|true|{"acceptRip":true}': 'fe43f1b5bcacbd0cd5468e11d8b4a184',
    'LF.rip|utf8|false|{"acceptRip":true}': 'fe43f1b5bcacbd0cd5468e11d8b4a184',
    'LF.rip|utf8|true|{"acceptRip":true}': 'fe43f1b5bcacbd0cd5468e11d8b4a184',
    'FOO|none|false|{"types":[".rip",".ans"],"acceptRip":true}':
        'bf235767e3b6f59f07365b99c13adac0',
    'FOO|none|true|{"types":[".rip",".ans"],"acceptRip":true}':
        '402e54d68aedf8b57896cbdfaca4e138',
    'FOO|cp437|false|{"types":[".rip",".ans"],"acceptRip":true}':
        'bf235767e3b6f59f07365b99c13adac0',
    'FOO|cp437|true|{"types":[".rip",".ans"],"acceptRip":true}':
        '402e54d68aedf8b57896cbdfaca4e138',
    'FOO|utf8|false|{"types":[".rip",".ans"],"acceptRip":true}':
        'bf235767e3b6f59f07365b99c13adac0',
    'FOO|utf8|true|{"types":[".rip",".ans"],"acceptRip":true}':
        '402e54d68aedf8b57896cbdfaca4e138',
    'display|ripmix|cp437|0': '0663a512def440c23ae98ff5711e89e2',
    'display|ripmix|cp437|9600000': '0663a512def440c23ae98ff5711e89e2',
    'display|ripmix|utf8|0': '0663a512def440c23ae98ff5711e89e2',
    'display|ripmix|utf8|9600000': '0663a512def440c23ae98ff5711e89e2',
    'display|lfonly|cp437|0': '73a829867783972526a14a72c10f7b7a',
    'display|lfonly|cp437|9600000': '73a829867783972526a14a72c10f7b7a',
    'display|lfonly|utf8|0': '73a829867783972526a14a72c10f7b7a',
    'display|lfonly|utf8|9600000': '73a829867783972526a14a72c10f7b7a',
    'display|long|cp437|0': '5154e0a15354383edbae9f8133ed5e6a',
    'display|long|cp437|9600000': '5154e0a15354383edbae9f8133ed5e6a',
    'display|long|utf8|0': '5154e0a15354383edbae9f8133ed5e6a',
    'display|long|utf8|9600000': '5154e0a15354383edbae9f8133ed5e6a',
};

const pinHash = value =>
    crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);

//  Every scenario, for |makeClient(encoding)| sessions: { key: result }
async function runPinCorpus(dir, makeClient) {
    const out = {};
    for (const sel of PIN_SELECTIONS) {
        for (const enc of ['none', 'cp437', 'utf8']) {
            for (const random of [false, true]) {
                const key = `${sel.name}|${enc}|${random}|${JSON.stringify(
                    sel.options || {}
                )}`;
                const picks = new Set();
                for (let i = 0; i < 12; ++i) {
                    Math.random = () => (i + 0.5) / 12;
                    const client = 'none' === enc ? undefined : makeClient(enc);
                    const opts = Object.assign(
                        { basePath: dir, random, client, readSauce: true },
                        sel.options || {}
                    );
                    //  eslint-disable-next-line no-await-in-loop
                    const r = await new Promise(resolve =>
                        art.getArt(sel.name, opts, (err, info) =>
                            resolve(
                                err
                                    ? { err: err.message }
                                    : {
                                          file: paths.basename(info.fromPath),
                                          data: Buffer.from(info.data, 'utf8').toString(
                                              'hex'
                                          ),
                                          sauce: Boolean(info.sauce),
                                          keys: Object.keys(info).sort(),
                                      }
                            )
                        )
                    );
                    picks.add(JSON.stringify(r));
                }
                Math.random = REAL_RANDOM;
                out[key] = [...picks].sort();
            }
        }
    }

    for (const [name, artText] of Object.entries(PIN_DISPLAYS)) {
        for (const enc of ['cp437', 'utf8']) {
            for (const baud of [0, 9600000]) {
                const key = `display|${name}|${enc}|${baud}`;
                const client = makeClient(enc);
                const wire = [];
                client.term.output.write = (data, cb) => {
                    wire.push(Buffer.from(data));
                    if (cb) {
                        cb(null);
                    }
                };
                //  eslint-disable-next-line no-await-in-loop
                out[key] = await new Promise(resolve =>
                    art.display(
                        client,
                        artText,
                        { baudRate: baud },
                        (err, mciMap, extra) =>
                            resolve({
                                err: err ? err.message : null,
                                wire: Buffer.concat(wire).toString('hex'),
                                mciMap: JSON.parse(JSON.stringify(mciMap)),
                                extra,
                            })
                    )
                );
            }
        }
    }
    return out;
}

//  getArt() as a promise: the file picked (or 'none'), its data, its mark
function pick(name, options) {
    return new Promise(resolve =>
        art.getArt(name, Object.assign({ random: false }, options), (err, info) =>
            resolve(
                err
                    ? { file: 'none' }
                    : {
                          file: paths.basename(info.fromPath),
                          data: info.data,
                          rip: info.rip,
                          sauce: info.sauce,
                      }
            )
        )
    );
}

//  every file random selection can pick for |name|, sorted
async function pickAllRandom(name, options) {
    const seen = new Set();
    try {
        for (let i = 0; i < 24; ++i) {
            Math.random = () => (i + 0.5) / 24;
            //  eslint-disable-next-line no-await-in-loop
            const r = await pick(name, Object.assign({}, options, { random: true }));
            seen.add(r.file);
        }
    } finally {
        Math.random = REAL_RANDOM;
    }
    return [...seen].sort();
}

//  display() as a promise
function show(client, data, options = {}) {
    return new Promise(resolve =>
        art.display(client, data, options, (err, mciMap, extra) =>
            resolve({ err, mciMap, extra })
        )
    );
}

//  The parser's events for |text|, |ripCommands| on or off
function parseEvents(text, options = {}) {
    const parser = new ANSIEscapeParser(
        Object.assign({ mciReplaceChar: ' ', termWidth: 80, termHeight: 25 }, options)
    );
    const events = [];
    ['literal', 'control', 'rip'].forEach(name =>
        parser.on(name, data => events.push([name, data]))
    );
    parser.on('mci', info =>
        events.push(['mci', info.mci + (info.id || ''), info.position])
    );
    parser.on('complete', () => events.push(['complete', parser.row, parser.column]));
    parser.reset(text);
    parser.parse();
    return events;
}

describe('RIPscrip art (.rip, #989)', function () {
    let tmp;
    let pinDir;

    before(function () {
        art = require('../core/art.js');
        tmp = fs.mkdtempSync(paths.join(os.tmpdir(), 'enig-art-rip-'));
        pinDir = paths.join(tmp, 'pins');
        fs.mkdirSync(pinDir);
        Object.entries(PIN_FILES).forEach(([f, data]) =>
            fs.writeFileSync(paths.join(pinDir, f), bytes(data))
        );
    });

    after(function () {
        Math.random = REAL_RANDOM;
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    describe('a session without the RIP layer gets what origin/master gave it', function () {
        let results;
        before(async function () {
            this.timeout(20000);
            results = await runPinCorpus(
                pinDir,
                enc => session({ encoding: enc }).client
            );
        });

        it('every scenario, byte for byte', function () {
            const differ = Object.keys(MASTER_PINS).filter(
                key => pinHash(results[key]) !== MASTER_PINS[key]
            );
            assert.deepEqual(differ, []);
        });

        it('the corpus covers every case pinned, and only those', function () {
            assert.deepEqual(
                Object.keys(results).sort(),
                Object.keys(MASTER_PINS).sort()
            );
        });

        it('a RIP session would not: the pins tell the two apart', async function () {
            this.timeout(20000);
            const rip = await runPinCorpus(
                pinDir,
                enc => session({ encoding: enc, rip: true }).client
            );
            assert.notEqual(
                pinHash(rip['FOO|cp437|false|{"acceptRip":true}']),
                MASTER_PINS['FOO|cp437|false|{"acceptRip":true}']
            );
        });
    });

    describe('type selection', function () {
        const ripClient = (encoding = 'cp437') => session({ encoding, rip: true }).client;
        const ansiClient = (encoding = 'cp437') => session({ encoding }).client;
        const base = client => ({ basePath: pinDir, client, readSauce: true });

        it('the layer prefers .rip; only the base decides what is allowed', function () {
            const { term } = session({ rip: true });
            const types = term.emulation.artTypes(term);
            assert.deepEqual(types.preferred, [['.rip']]);
            assert.equal(types.allowed, undefined);
            assert.equal(Rip.ART_TYPE, '.rip');
        });

        it('a RIP session asked for FOO gets FOO.rip, marked as RIP art', async function () {
            const r = await pick(
                'FOO',
                Object.assign(base(ripClient()), { acceptRip: true })
            );
            assert.equal(r.file, 'FOO.rip');
            assert.equal(typeof r.rip, 'symbol');
            assert.equal(r.data, '!|1K|e\r\nFOO rip %TL1\r\n');
        });

        it('.rip ranks ahead of every other type, .utf8ans for a UTF-8 terminal too', async function () {
            const baz = await pick(
                'BAZ',
                Object.assign(base(ripClient()), { acceptRip: true })
            );
            assert.equal(baz.file, 'BAZ.rip');
            const utf = await pick(
                'UTF',
                Object.assign(base(ripClient('utf8')), { acceptRip: true })
            );
            assert.equal(utf.file, 'UTF.rip');
        });

        it('no .rip: what an ANSI session would get', async function () {
            const dir = paths.join(tmp, 'fallback');
            fs.mkdirSync(dir);
            fs.writeFileSync(paths.join(dir, 'MENU.ans'), 'ans\r\n');
            fs.writeFileSync(paths.join(dir, 'MENU.asc'), 'asc\r\n');
            const options = client => ({ basePath: dir, client, acceptRip: true });
            const rip = await pick('MENU', options(ripClient()));
            const ansi = await pick('MENU', options(ansiClient()));
            assert.equal(rip.file, ansi.file);
            assert.equal(rip.rip, undefined);
        });

        it('a caller that does not show RIP art never gets a .rip it did not name', async function () {
            const foo = await pick('FOO', base(ripClient()));
            assert.equal(foo.file, 'FOO.ans');
            assert.equal(foo.rip, undefined);
            const bar = await pick('BAR', base(ripClient()));
            assert.equal(bar.file, 'none');
        });

        it('an ANSI session never gets a .rip it did not name, acceptRip or not', async function () {
            for (const acceptRip of [false, true]) {
                //  eslint-disable-next-line no-await-in-loop
                const bar = await pick(
                    'BAR',
                    Object.assign(base(ansiClient()), { acceptRip })
                );
                assert.equal(bar.file, 'none');
                //  eslint-disable-next-line no-await-in-loop
                const foo = await pick(
                    'FOO',
                    Object.assign(base(ansiClient()), { acceptRip })
                );
                assert.equal(foo.file, 'FOO.ans');
            }
            const none = await pick('BAR', { basePath: pinDir, acceptRip: true });
            assert.equal(none.file, 'none');
        });

        it('random selection: a RIP session picks among the .rip variants only', async function () {
            const options = client => Object.assign(base(client), { acceptRip: true });
            assert.deepEqual(await pickAllRandom('RAND', options(ripClient())), [
                'RAND2.rip',
                'RAND3.rip',
            ]);
            assert.deepEqual(await pickAllRandom('RAND', options(ansiClient())), [
                'RAND1.ans',
                'RAND2.ans',
            ]);
            assert.deepEqual(await pickAllRandom('RAND', base(ripClient())), [
                'RAND1.ans',
                'RAND2.ans',
            ]);
            assert.deepEqual(await pickAllRandom('RIPONLY', options(ripClient())), [
                'RIPONLY1.rip',
                'RIPONLY2.rip',
            ]);
            assert.deepEqual(await pickAllRandom('RIPONLY', options(ansiClient())), [
                'none',
            ]);
        });

        it('a .rip named outright: RIP art for a RIP session, text as before for others', async function () {
            const rip = await pick(
                'FOO.rip',
                Object.assign(base(ripClient()), { acceptRip: true })
            );
            assert.equal(typeof rip.rip, 'symbol');
            const ansi = await pick(
                'FOO.rip',
                Object.assign(base(ansiClient()), { acceptRip: true })
            );
            assert.equal(ansi.file, 'FOO.rip');
            assert.equal(ansi.rip, undefined);
        });

        it('RIP art is read as CP437, up to its EOF, with its SAUCE record', async function () {
            const dir = paths.join(tmp, 'sauce');
            fs.mkdirSync(dir);
            fs.writeFileSync(
                paths.join(dir, 'S.rip'),
                Buffer.concat([
                    bytes('!|1K\r\n\xc9\xcd\xbb %TL1\r\n'),
                    Buffer.from([0x1a]),
                    sauceRecord(),
                ])
            );
            const options = client => ({
                basePath: dir,
                client,
                acceptRip: true,
                readSauce: true,
            });
            const rip = await pick('S', options(ripClient()));
            assert.equal(rip.data, '!|1K\r\n╔═╗ %TL1\r\n');
            assert.equal(rip.sauce.Character.fileType, 'RIP script');
            //  a caller not showing it as RIP: as before (UTF-8, no EOF)
            const text = await pick('S.rip', options(ansiClient()));
            assert.ok(text.data.includes('SAUCE00'));
        });

        it('bare LF line ends become CR LF, as in other art', async function () {
            const r = await pick(
                'LF.rip',
                Object.assign(base(ripClient()), { acceptRip: true })
            );
            assert.equal(r.data, '!|1K\\\r\nmore\r\nLF text %TL1\r\n');
        });
    });

    describe('the parser: RIP command lines in .rip art', function () {
        it('a command line is passed on whole and takes no room', function () {
            const events = parseEvents('!|1K|e\r\nHi %TL1\r\n', { ripCommands: true });
            assert.deepEqual(events.slice(0, 3), [
                ['rip', '!|1K|e\r\n'],
                ['literal', 'Hi '],
                ['mci', 'TL1', [1, 4]],
            ]);
        });

        it('CR LF, LF, CR and the end of the art each end a command, kept exactly', function () {
            for (const end of ['\r\n', '\n', '\r', '']) {
                const text = `!|e${end}`;
                const events = parseEvents(text, { ripCommands: true });
                assert.deepEqual(events, [
                    ['rip', text],
                    ['complete', 1, 1],
                ]);
            }
        });

        it('a line break after an odd number of backslashes carries the command on', function () {
            const cases = [
                ['!|1U0\\\r\nmore\r\nX', '!|1U0\\\r\nmore\r\n', 'X'],
                ['!|1U0\\\nmore\nX', '!|1U0\\\nmore\n', 'X'],
                ['!|1U0\\\\\r\nX', '!|1U0\\\\\r\n', 'X'],
                ['!|1U0\\\\\\\r\na\\\nb\r\nX', '!|1U0\\\\\\\r\na\\\nb\r\n', 'X'],
                ['!|T\\|x\r\nX', '!|T\\|x\r\n', 'X'],
            ];
            for (const [text, command, rest] of cases) {
                const events = parseEvents(text, { ripCommands: true });
                assert.deepEqual(events[0], ['rip', command], JSON.stringify(text));
                assert.deepEqual(events[1], ['literal', rest], JSON.stringify(text));
            }
        });

        it('a command ending in a lone backslash at the end of the art is still a command', function () {
            for (const text of ['!|1K\\', '!|1K\\\\', 'a\r\n!|1U0\\']) {
                const events = parseEvents(text, { ripCommands: true });
                const command = text.slice(text.indexOf('!'));
                assert.deepEqual(
                    events.filter(([e]) => 'rip' === e),
                    [['rip', command]],
                    JSON.stringify(text)
                );
                assert.ok(
                    !events.some(([e, d]) => 'literal' === e && d.includes('!|')),
                    JSON.stringify(text)
                );
            }
            //  with the option off it is text, as ever
            const off = parseEvents('!|1K\\');
            assert.ok(!off.some(([e]) => 'rip' === e));
        });

        it('0x01 | and 0x02 | at the start of a line are commands too', function () {
            const events = parseEvents('\x01|1K\r\n\x02|e\r\n%TL1', {
                ripCommands: true,
            });
            assert.deepEqual(events.slice(0, 3), [
                ['rip', '\x01|1K\r\n'],
                ['rip', '\x02|e\r\n'],
                ['mci', 'TL1', [1, 1]],
            ]);
        });

        it('only at the start of a line: mid-line, or after a sequence, it is text', function () {
            const midLine = parseEvents('ab !|x\r\n', { ripCommands: true });
            assert.ok(!midLine.some(([e]) => 'rip' === e));
            const afterSgr = parseEvents('\x1b[0m!|x\r\n', { ripCommands: true });
            assert.ok(!afterSgr.some(([e]) => 'rip' === e));
            const afterText = parseEvents('text\r\n!|x\r\n%TL1', { ripCommands: true });
            assert.deepEqual(
                afterText.find(([e]) => 'mci' === e),
                ['mci', 'TL1', [2, 1]]
            );
        });

        it('a long command is never wrapped or broken', function () {
            const command = '!|' + 'A'.repeat(300) + '\r\n';
            const events = parseEvents(command + 'x%TL1', {
                ripCommands: true,
                termWidth: 80,
                artWidth: 40,
            });
            assert.deepEqual(events[0], ['rip', command]);
            assert.deepEqual(events[2], ['mci', 'TL1', [1, 2]]);
        });

        it('MCI codes, ESC and pipe codes inside a command are part of it', function () {
            const command = '!|1U00|%TL1 \x1b[1m |07 ^M\r\n';
            const events = parseEvents(command, { ripCommands: true });
            assert.deepEqual(events, [
                ['rip', command],
                ['complete', 1, 1],
            ]);
        });

        it('every byte of the art comes out once, in order', function () {
            const text =
                '\x1b[2J!|1K\r\n!|1U\\\nx\r\nab\x1b[1;5H !|no\r\n\x01|y\nz\r\n!|end';
            const events = parseEvents(text, { ripCommands: true, mciReplaceChar: '' });
            const out = events
                .filter(([e]) => 'literal' === e || 'control' === e || 'rip' === e)
                .map(([, d]) => d)
                .join('');
            assert.equal(out, text);
        });

        it('without ripCommands, the same text parses as it always did', function () {
            const text = '!|1K\r\nHi %TL1\r\n';
            const off = parseEvents(text);
            assert.ok(!off.some(([e]) => 'rip' === e));
            assert.deepEqual(
                off.find(([e]) => 'mci' === e),
                ['mci', 'TL1', [2, 4]]
            );
            assert.deepEqual(parseEvents(text, { ripCommands: false }), off);
        });

        it('the trailing line feed rule still applies to the last text line', function () {
            const text = '!|e\r\n\x1b[25;1H!|no\r\n';
            const out = parseEvents(text, { ripCommands: true })
                .filter(([e]) => 'literal' === e || 'control' === e || 'rip' === e)
                .map(([, d]) => d)
                .join('');
            //  the last line is on the bottom row: its line feed would scroll
            assert.equal(out, text.slice(0, -1));
        });
    });

    describe('display', function () {
        //  a button, a backslash continuation, an introducer mid-text, MCI codes
        const RIP_ART =
            '!|1K|e\r\n!|1U0000000010101010<>A<>a^M\\\r\n|1B00\r\n' +
            '\x1b[1;33mName: %TL1\r\nKeys: !|x \x01|y %TL2\r\n';

        //  RIP_ART as the wire should carry it to a RIP caller
        const RIP_WIRE =
            '\r!|1K|e\r\n!|1U0000000010101010<>A<>a^M\\\r\n|1B00\r\n' +
            '\x1b[1;33mName: \x1b[1;33m    \r\nKeys: !|x \x01|y \x1b[1;33m    \r\n';

        async function ripArtInfo(text) {
            const dir = fs.mkdtempSync(paths.join(tmp, 'disp-'));
            fs.writeFileSync(paths.join(dir, 'D.rip'), bytes(text));
            const s = session({ rip: true });
            const info = await pick('D', {
                basePath: dir,
                client: s.client,
                acceptRip: true,
            });
            return { s, info };
        }

        it('a RIP session gets .rip art unfiltered, MCI codes still placed', async function () {
            const { s, info } = await ripArtInfo(RIP_ART);
            const { err, mciMap, extra } = await show(s.client, info.data, {
                rip: info.rip,
            });
            assert.ifError(err);
            assert.equal(s.sent(), RIP_WIRE);
            assert.deepEqual(mciMap.TL1.position, [1, 7]);
            assert.deepEqual(mciMap.TL2.position, [2, 15]);
            assert.deepEqual(extra, { height: 2 });
        });

        it('command lines go out as CP437 bytes, whatever the session encoding', async function () {
            const text = '!|T\x80\xe9\xff\r\nab\xe9\r\n';
            for (const encoding of ['cp437', 'utf8']) {
                const dir = fs.mkdtempSync(paths.join(tmp, 'hi-'));
                fs.writeFileSync(paths.join(dir, 'H.rip'), bytes(text));
                const s = session({ rip: true, encoding });
                // eslint-disable-next-line no-await-in-loop
                const info = await pick('H', {
                    basePath: dir,
                    client: s.client,
                    acceptRip: true,
                });
                // eslint-disable-next-line no-await-in-loop
                const { err } = await show(s.client, info.data, { rip: info.rip });
                assert.ifError(err);
                const wire = Buffer.concat(s.wire);
                //  the command: its original bytes, in either session
                assert.ok(
                    wire.includes(
                        Buffer.from([0x21, 0x7c, 0x54, 0x80, 0xe9, 0xff, 0x0d, 0x0a])
                    ),
                    encoding
                );
                //  text parts keep the session's encoding (0xE9 is theta in CP437)
                const textBytes = Buffer.from('ab\xe9', 'latin1');
                assert.ok(
                    'utf8' === encoding
                        ? wire.includes(Buffer.from('ab\u0398', 'utf8'))
                        : wire.includes(textBytes),
                    encoding
                );
            }
        });

        it('what ENiGMA writes after the art is filtered again', async function () {
            const { s, info } = await ripArtInfo(RIP_ART);
            await show(s.client, info.data, { rip: info.rip });
            s.clear();
            s.term.write('!|1K \x01|x');
            assert.equal(s.sent(), '!\x00|1K *|x');
        });

        it('a command the art leaves open is ended before filtered text', async function () {
            const { s, info } = await ripArtInfo('!|1K');
            await show(s.client, info.data, { rip: info.rip });
            s.term.write('hi');
            assert.equal(s.sent(), '\r!|1K\r\nhi');
        });

        it('no CR in front of art that starts with text', async function () {
            const { s, info } = await ripArtInfo('text\r\n!|e\r\n');
            await show(s.client, info.data, { rip: info.rip });
            assert.equal(s.sent(), 'text\r\n!|e\r\n');
        });

        it('only the mark opens the RIP path: anything else is shown filtered', async function () {
            const { info } = await ripArtInfo(RIP_ART);
            for (const fake of [true, 'rip', { rip: true }, Symbol('trusted .rip art')]) {
                const s = session({ rip: true });
                //  eslint-disable-next-line no-await-in-loop
                await show(s.client, info.data, { rip: fake });
                assert.ok(!s.sent().includes('!|'), String(fake.toString()));
                assert.ok(s.sent().includes('!\x00|'));
            }
        });

        it('a session without the layer shows marked art as text, as it would unmarked', async function () {
            const { info } = await ripArtInfo(RIP_ART);
            const marked = session();
            const plain = session();
            const a = await show(marked.client, info.data, { rip: info.rip });
            const b = await show(plain.client, info.data, {});
            assert.equal(marked.sent(), plain.sent());
            assert.deepEqual(a.mciMap, b.mciMap);
            assert.equal(marked.term.emulation.layers.size, 0);
        });

        it('UTF-8 RIP session: commands as they are, text as UTF-8', async function () {
            const dir = fs.mkdtempSync(paths.join(tmp, 'utf-'));
            fs.writeFileSync(paths.join(dir, 'U.rip'), bytes('!|e\r\n\xc9 %TL1\r\n'));
            const s = session({ rip: true, encoding: 'utf8' });
            const info = await pick('U', {
                basePath: dir,
                client: s.client,
                acceptRip: true,
            });
            await show(s.client, info.data, { rip: info.rip });
            assert.equal(
                s.sent(),
                latin1(Buffer.from('\r!|e\r\n╔ \x1b[0m    \r\n', 'utf8'))
            );
        });

        describe('with baud emulation', function () {
            let timers;
            beforeEach(function () {
                timers = fakeTimers();
            });
            afterEach(function () {
                timers.restore();
            });

            it('the same bytes, dripped, unfiltered', async function () {
                const { s, info } = await ripArtInfo(RIP_ART);
                const done = show(s.client, info.data, { rip: info.rip, baudRate: 2400 });
                assert.ok(s.wire.length >= 1);
                assert.ok(s.wire[0].length < RIP_WIRE.length);
                timers.runAll();
                const { err, mciMap } = await done;
                assert.ifError(err);
                assert.equal(s.sent(), RIP_WIRE);
                assert.ok(s.wire.length > 2);
                assert.deepEqual(mciMap.TL2.position, [2, 15]);
            });

            it('a write landing between two pieces is filtered, in wire order', async function () {
                const { s, info } = await ripArtInfo('!|1U00\\\r\nAAAA\r\n');
                const done = show(s.client, info.data, { rip: info.rip, baudRate: 300 });
                //  30 bytes a second: one byte every 16ms tick; '\r!' sent
                assert.equal(s.sent(), '\r');
                timers.tick();
                assert.equal(s.sent(), '\r!');
                s.term.write('|x');
                timers.runAll();
                await done;
                assert.equal(s.sent(), '\r!\x00|x|1U00\\\r\nAAAA\r\n');
            });

            it('ripDripWrite without the layer is dripWrite', function () {
                const a = session();
                const b = session();
                let doneA = false;
                let doneB = false;
                a.term.ripDripWrite(bytes('!|1K\r\nabc'), 300, () => {
                    doneA = true;
                });
                b.term.dripWrite(bytes('!|1K\r\nabc'), 300, () => {
                    doneB = true;
                });
                timers.runAll();
                assert.ok(doneA && doneB);
                assert.deepEqual(a.wire, b.wire);
            });
        });
    });

    describe('leaving a RIP screen: kill mouse fields', function () {
        const KILL = '\r\n!|1K\r\n';

        //  (that this form works on a real terminal was verified by hand on
        //  SyncTERM and IcyTerm; nothing here can check that)
        it('is the kill command, never a reset or a text window', function () {
            //  RIP_KILL_MOUSE_FIELDS is what the tests below expect on the wire
            assert.equal(Rip.RIP_KILL_MOUSE_FIELDS, KILL);
            //  SyncTERM 1.10 loses input to a reset or a text window
            assert.ok(!/!\|\*|!\|w/.test(Rip.RIP_KILL_MOUSE_FIELDS));
        });

        it('sent once, unfiltered, after .rip art was shown', async function () {
            const dir = fs.mkdtempSync(paths.join(tmp, 'kill-'));
            fs.writeFileSync(paths.join(dir, 'K.rip'), bytes('!|1U00\r\n'));
            const s = session({ rip: true });
            const info = await pick('K', {
                basePath: dir,
                client: s.client,
                acceptRip: true,
            });
            await show(s.client, info.data, { rip: info.rip });
            s.clear();
            s.term.leaveRipScreen();
            assert.equal(s.sent(), KILL);
            s.term.leaveRipScreen();
            assert.equal(s.sent(), KILL);
        });

        describe('the mark that a RIP screen was shown', function () {
            const marked = s => s.term.emulation.layers.get('rip').mouseFieldsShown;

            async function ripArt(text) {
                const dir = fs.mkdtempSync(paths.join(tmp, 'mark-'));
                fs.writeFileSync(paths.join(dir, 'M.rip'), bytes(text));
                const s = session({ rip: true });
                const info = await pick('M', {
                    basePath: dir,
                    client: s.client,
                    acceptRip: true,
                });
                return { s, info };
            }

            it('is set when the first command is sent, not when the display completes', async function () {
                //  ESC 7 makes the parser throw after the command went out
                const { s, info } = await ripArt('!|1K\r\n\x1b7');
                assert.equal(marked(s), false);
                assert.throws(() =>
                    art.display(s.client, info.data, { rip: info.rip }, () => {})
                );
                assert.ok(s.sent().includes('!|1K'));
                assert.equal(marked(s), true);
                s.clear();
                s.term.leaveRipScreen();
                assert.equal(s.sent(), KILL);
            });

            //  a terminal can run a command the parser took as text (mid-line
            //  on SyncTERM 1.10), so being shown as RIP is what counts
            it('is set by anything shown as RIP, command line found or not', async function () {
                for (const text of [
                    'just text\r\n',
                    '\x1b[2J!|1M00\r\n',
                    '\x1b[0m!|1M00\r\n',
                    'hello \x01|1M00\r\n',
                ]) {
                    const { s, info } = await ripArt(text);
                    await show(s.client, info.data, { rip: info.rip });
                    assert.equal(marked(s), true, JSON.stringify(text));
                }
            });

            it('a RangeError thrown by the callback is not taken for a parse error', async function () {
                const { s, info } = await ripArt('hi\r\n!|1K\r\n');
                let calls = 0;
                assert.throws(
                    () =>
                        art.display(s.client, info.data, { rip: info.rip }, () => {
                            calls += 1;
                            throw new RangeError('from the callback');
                        }),
                    /from the callback/
                );
                assert.equal(calls, 1);
            });

            it('a command line too long to parse: an error, once, and no throw', function (done) {
                ripArt('!|' + 'a'.repeat(9 * 1024 * 1024)).then(({ s, info }) => {
                    let calls = 0;
                    art.display(s.client, info.data, { rip: info.rip }, err => {
                        calls += 1;
                        assert.ok(err);
                        assert.equal(marked(s), true);
                        setImmediate(() => {
                            assert.equal(calls, 1);
                            done();
                        });
                    });
                }, done);
            });

            describe('with baud emulation', function () {
                let timers;
                beforeEach(function () {
                    timers = fakeTimers();
                });
                afterEach(function () {
                    timers.restore();
                });

                it('is set as soon as the first piece is sent', async function () {
                    const { s, info } = await ripArt('!|1U00\\\r\nAAAA\r\n');
                    const done = show(s.client, info.data, {
                        rip: info.rip,
                        baudRate: 300,
                    });
                    assert.equal(marked(s), true); //  the first piece went out
                    timers.runAll();
                    await done;
                    assert.equal(marked(s), true);
                });

                it('a menu change in the middle of the drip cannot leave it off', async function () {
                    const { s, info } = await ripArt('!|1U00\\\r\nAAAA\r\n');
                    const done = show(s.client, info.data, {
                        rip: info.rip,
                        baudRate: 300,
                    });
                    timers.tick();
                    s.term.leaveRipScreen(); //  clears the mark
                    assert.equal(marked(s), false);
                    timers.tick(); //  a later piece of the art goes out
                    assert.equal(marked(s), true);
                    timers.runAll();
                    await done;
                    s.clear();
                    s.term.leaveRipScreen();
                    assert.equal(s.sent(), KILL);
                });

                it('an interrupted drip that sent a command still gets the kill', async function () {
                    const { s, info } = await ripArt('!|1U00\\\r\nAAAA\r\n');
                    show(s.client, info.data, { rip: info.rip, baudRate: 300 });
                    timers.tick();
                    s.term.output = { writable: false, write() {} };
                    assert.equal(marked(s), true);
                });

                it('art with no RIP in it, dripped as RIP: marked all the same', async function () {
                    const { s, info } = await ripArt('just text\r\n');
                    const done = show(s.client, info.data, {
                        rip: info.rip,
                        baudRate: 300,
                    });
                    timers.runAll();
                    await done;
                    assert.equal(marked(s), true);
                });
            });
        });

        it('nothing when no .rip was shown, ANSI art or not', async function () {
            const s = session({ rip: true });
            await show(s.client, '\x1b[2JHello %TL1\r\n', {});
            s.clear();
            s.term.leaveRipScreen();
            assert.equal(s.sent(), '');
        });

        it('a session without the layer is sent nothing, ever', async function () {
            const s = session();
            s.term.ripScreenShown();
            s.term.leaveRipScreen();
            await show(s.client, '!|1K\r\n', { rip: 'anything' });
            s.clear();
            let called = false;
            s.term.leaveRipScreen(() => {
                called = true;
            });
            assert.equal(s.sent(), '');
            assert.ok(called);
        });

        it('inside a batch it keeps its place', async function () {
            const s = session({ rip: true });
            s.term.ripScreenShown();
            s.term.beginWrite();
            s.term.rawWrite('a');
            s.term.leaveRipScreen();
            s.term.rawWrite('|b');
            s.term.commitWrite();
            assert.equal(s.sent(), 'a' + KILL + '|b');
        });

        describe('the menu stack sends it before the next menu is entered', function () {
            let MenuStack;
            let menuUtil;
            let realLoadMenu;
            const stackPath = require.resolve('../core/menu_stack.js');

            before(function () {
                //  a MenuStack whose loadMenu() is a stub; the module cache is
                //  left as it was found
                menuUtil = require('../core/menu_util.js');
                realLoadMenu = menuUtil.loadMenu;
                const cached = require.cache[stackPath];
                delete require.cache[stackPath];
                menuUtil.loadMenu = (opts, cb) => cb(null, makeMenu(opts.name));
                try {
                    MenuStack = require('../core/menu_stack.js');
                } finally {
                    menuUtil.loadMenu = realLoadMenu;
                    if (cached) {
                        require.cache[stackPath] = cached;
                    } else {
                        delete require.cache[stackPath];
                    }
                }
            });

            let order;
            function makeMenu(name) {
                return {
                    menuConfig: { config: { menuFlags: [] } },
                    enter() {
                        order.push(`enter ${name}`);
                    },
                    leave() {
                        order.push(`leave ${name}`);
                    },
                    getSaveState() {},
                    getMenuResult() {},
                };
            }

            function stackClient(rip) {
                const s = session({ rip });
                s.client.acs = { hasMenuModuleAccess: () => true };
                s.client.menuStack = new MenuStack(s.client);
                const write = s.term.output.write;
                s.term.output.write = (data, cb) => {
                    order.push(`wire ${JSON.stringify(latin1(Buffer.from(data)))}`);
                    return write(data, cb);
                };
                return s;
            }

            it('after a .rip screen: leave, kill, then enter', function (done) {
                order = [];
                const s = stackClient(true);
                s.client.menuStack.goto('one', err => {
                    assert.ifError(err);
                    s.term.ripScreenShown();
                    s.client.menuStack.goto('two', err => {
                        assert.ifError(err);
                        assert.deepEqual(order, [
                            'enter one',
                            'leave one',
                            `wire ${JSON.stringify(KILL)}`,
                            'enter two',
                        ]);
                        return done();
                    });
                });
            });

            it('back to the previous menu too', function (done) {
                order = [];
                const s = stackClient(true);
                s.client.menuStack.goto('one', () => {
                    s.client.menuStack.goto('two', () => {
                        s.term.ripScreenShown();
                        order = [];
                        s.client.menuStack.prev(err => {
                            assert.ifError(err);
                            assert.deepEqual(order, [
                                'leave two',
                                `wire ${JSON.stringify(KILL)}`,
                                'enter one',
                            ]);
                            return done();
                        });
                    });
                });
            });

            it('without the RIP layer: not a byte', function (done) {
                order = [];
                const s = stackClient(false);
                s.client.menuStack.goto('one', () => {
                    s.term.ripScreenShown();
                    s.client.menuStack.goto('two', () => {
                        assert.deepEqual(order, ['enter one', 'leave one', 'enter two']);
                        assert.equal(s.sent(), '');
                        return done();
                    });
                });
            });
        });
    });

    describe('who may show RIP art', function () {
        let previousConfig;
        let theme;
        let themesDir;
        let artDir;

        before(function () {
            themesDir = paths.join(tmp, 'themes');
            fs.mkdirSync(paths.join(themesDir, 'ansi_one'), { recursive: true });
            fs.writeFileSync(
                paths.join(themesDir, 'ansi_one', 'TM.rip'),
                '!|1K\r\nT\r\n'
            );
            fs.writeFileSync(paths.join(themesDir, 'ansi_one', 'TM.ans'), 'ans\r\n');
            artDir = paths.join(tmp, 'general');
            fs.mkdirSync(artDir);
            fs.writeFileSync(paths.join(artDir, 'GEN.rip'), '!|e\r\nG\r\n');
            const config = {
                debug: { assertsEnabled: false },
                menus: { cls: false },
                general: { boardName: 'Test' },
                paths: { themes: themesDir, art: artDir },
                theme: { default: 'ansi_one', preLogin: 'ansi_one' },
            };
            previousConfig = configModule.get;
            configModule.get = () => config;
            theme = require('../core/theme.js');
            const { ThemeManager } = theme;
            const realInit = ThemeManager.prototype.init;
            ThemeManager.prototype.init = function (cb) {
                const raw = { info: { name: 'ansi_one' } };
                const fin = { info: { name: 'ansi_one', themeId: 'ansi_one' } };
                const tc = { getRaw: () => raw, get: () => fin };
                this.loadedThemeConfigs.set('ansi_one', tc);
                this.availableThemes.set('ansi_one', tc);
                return cb(null);
            };
            try {
                ThemeManager.create(err => assert.ifError(err));
            } finally {
                ThemeManager.prototype.init = realInit;
            }
        });

        after(function () {
            configModule.get = previousConfig;
        });

        function ripSessionWithTheme() {
            const s = session({ rip: true });
            s.client.user.properties[UserProps.ThemeId] = 'ansi_one';
            theme.setClientTheme(s.client, 'ansi_one');
            return s;
        }

        function themeArt(client, name, extra) {
            return new Promise(resolve =>
                theme.getThemeArt(Object.assign({ client, name }, extra), (err, info) =>
                    resolve(err ? { file: 'none' } : info)
                )
            );
        }

        it('theme art and general art, from displayThemeArt(): RIP', function (done) {
            const s = ripSessionWithTheme();
            theme.displayThemeArt({ client: s.client, name: 'TM' }, (err, artData) => {
                assert.ifError(err);
                assert.equal(paths.basename(artData.artInfo.fromPath), 'TM.rip');
                assert.equal(s.sent(), '\r!|1K\r\nT\r\n');
                s.clear();
                theme.displayThemeArt({ client: s.client, name: 'GEN' }, err => {
                    assert.ifError(err);
                    assert.equal(s.sent(), '\r!|e\r\nG\r\n');
                    return done();
                });
            });
        });

        it('a caller saying the name may come from a user: never RIP', function (done) {
            const s = ripSessionWithTheme();
            theme.displayThemeArt(
                { client: s.client, name: 'TM', acceptRip: false },
                (err, artData) => {
                    assert.ifError(err);
                    assert.equal(paths.basename(artData.artInfo.fromPath), 'TM.ans');
                    theme.displayThemeArt(
                        { client: s.client, name: 'TM.rip', acceptRip: false },
                        (err, artData) => {
                            assert.ifError(err);
                            assert.equal(artData.artInfo.rip, undefined);
                            assert.ok(!s.sent().includes('!|'));
                            return done();
                        }
                    );
                }
            );
        });

        describe('a name holding a path: never RIP, in any lookup', function () {
            let upDir;
            before(function () {
                //  a place outside the art directories, as an uploads dir is
                upDir = paths.join(tmp, 'uploads');
                fs.mkdirSync(upDir, { recursive: true });
                fs.writeFileSync(paths.join(upDir, 'evil.rip'), '!|1K\r\nEVIL\r\n');
            });

            it('an absolute name', async function () {
                const s = ripSessionWithTheme();
                for (const name of [
                    paths.join(themesDir, 'ansi_one', 'TM'),
                    paths.join(themesDir, 'ansi_one', 'TM.rip'),
                    paths.join(upDir, 'evil.rip'),
                ]) {
                    // eslint-disable-next-line no-await-in-loop
                    const info = await themeArt(s.client, name, { acceptRip: true });
                    assert.notEqual(info.file, 'none', name);
                    assert.equal(info.rip, undefined, name);
                }
                const abs = await themeArt(
                    s.client,
                    paths.join(themesDir, 'ansi_one', 'TM'),
                    { acceptRip: true }
                );
                assert.equal(paths.basename(abs.fromPath), 'TM.ans');
            });

            it('a relative name that resolves in the first lookup', async function () {
                const s = ripSessionWithTheme();
                const rel = paths.relative(
                    paths.join(__dirname, '..'),
                    paths.join(upDir, 'evil.rip')
                );
                const info = await themeArt(s.client, rel, { acceptRip: true });
                assert.equal(paths.basename(info.fromPath), 'evil.rip');
                assert.equal(info.rip, undefined);
            });

            it('a ../ name that only resolves in a later lookup: not trusted, filtered', async function () {
                const s = ripSessionWithTheme();
                //  misses the first lookup (relative to the BBS dir); found
                //  from the theme's directory
                const name = '../../uploads/evil.rip';
                const missing = paths.join(__dirname, '..', name);
                assert.ok(!fs.existsSync(missing));
                assert.equal(
                    paths.resolve(themesDir, 'ansi_one', name),
                    paths.join(upDir, 'evil.rip')
                );
                const info = await themeArt(s.client, name, { acceptRip: true });
                assert.equal(paths.basename(info.fromPath), 'evil.rip');
                assert.equal(info.rip, undefined);

                //  and through displayThemeArt(), which asks for RIP itself
                s.clear();
                await new Promise(resolve =>
                    theme.displayThemeArt({ client: s.client, name }, (err, data) => {
                        assert.ifError(err);
                        assert.equal(data.artInfo.rip, undefined);
                        resolve();
                    })
                );
                const wire = s.sent();
                assert.ok(wire.includes('EVIL'));
                //  the filter broke the command up: nothing reads as one
                assert.ok(!wire.includes('!|1K'));
            });

            it('getArt() itself refuses to mark such a name trusted', async function () {
                const s = ripSessionWithTheme();
                const info = await pick(paths.join(upDir, 'evil'), {
                    basePath: upDir,
                    client: s.client,
                    acceptRip: true,
                    types: ['.rip'],
                });
                assert.equal(info.file, 'evil.rip');
                assert.equal(info.rip, undefined);
                const direct = await pick(paths.join(upDir, 'evil.rip'), {
                    basePath: upDir,
                    client: s.client,
                    acceptRip: true,
                });
                assert.equal(direct.rip, undefined);
                //  a bare name from a base path is the legitimate case
                const bare = await pick('evil.rip', {
                    basePath: upDir,
                    client: s.client,
                    acceptRip: true,
                });
                assert.ok(bare.rip);
            });
        });

        it('lookups that do not display (achievements, node messages): no RIP', async function () {
            const s = ripSessionWithTheme();
            const info = await themeArt(s.client, 'TM', {});
            assert.equal(paths.basename(info.fromPath), 'TM.ans');
            const gen = await themeArt(s.client, 'GEN', {});
            assert.equal(gen.file, 'none');
        });

        it("show_art takes extraArgs names as possibly a user's", function () {
            const src = fs.readFileSync(require.resolve('../core/show_art.js'), 'utf8');
            const extraArgs = src.slice(
                src.indexOf('showByExtraArgs('),
                src.indexOf('showBySequence(')
            );
            assert.ok(/acceptRip: false/.test(extraArgs));
        });
    });
});
