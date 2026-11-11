'use strict';

//
//  ANSI art display pinned byte for byte (#593). The expected values were
//  produced by core/art.js as it was before native PETSCII art (.seq) was
//  added (origin/master 43f1e147): native art must not change a single byte
//  an ANSI session is sent, nor any MCI position, with or without a baud rate.
//
const { strict: assert } = require('assert');

const { ClientTerminal } = require('../core/client_term.js');

//  SGR, clear, CP437 box glyphs, MCI codes with an id and arguments, a cursor
//  move, reverse, CRLF, and an EOF + SAUCE tail that must not be shown
const ART =
    '\x1b[0m\x1b[2J\x1b[1;34m\u2554\u2550\u2557 Name: %ET1\r\n\x1b[0;33mPass: \x1b[5C%ET2(4)\r\n' +
    '\x1b[7m%VM1\x1b[0m end\r\n\x1aSAUCE';

const EXPECTED = {
    'cp437/0': {
        err: null,
        wire: '1b5b306d1b5b324a1b5b313b33346dc9cdbb204e616d653a201b5b313b33346d202020200d0a1b5b303b33336d506173733a201b5b35431b5b303b33336d202020202020200d0a1b5b376d1b5b373b33336d202020201b5b306d20656e640d0a',
        mciMap: {
            ET1: {
                position: [1, 11],
                args: [],
                SGR: '\u001b[0;1;34m',
                code: 'ET',
                id: 1,
            },
            ET2: {
                position: [2, 12],
                args: ['4'],
                SGR: '\u001b[0;33m',
                code: 'ET',
                id: 2,
            },
            VM1: {
                position: [3, 1],
                args: [],
                SGR: '\u001b[0;7;33m',
                code: 'VM',
                id: 1,
            },
        },
        extra: {
            height: 3,
        },
    },
    'cp437/10000000': {
        err: null,
        wire: '1b5b306d1b5b324a1b5b313b33346dc9cdbb204e616d653a201b5b313b33346d202020200d0a1b5b303b33336d506173733a201b5b35431b5b303b33336d202020202020200d0a1b5b376d1b5b373b33336d202020201b5b306d20656e640d0a',
        mciMap: {
            ET1: {
                position: [1, 11],
                args: [],
                SGR: '\u001b[0;1;34m',
                code: 'ET',
                id: 1,
            },
            ET2: {
                position: [2, 12],
                args: ['4'],
                SGR: '\u001b[0;33m',
                code: 'ET',
                id: 2,
            },
            VM1: {
                position: [3, 1],
                args: [],
                SGR: '\u001b[0;7;33m',
                code: 'VM',
                id: 1,
            },
        },
        extra: {
            height: 3,
        },
    },
    'utf8/0': {
        err: null,
        wire: '1b5b306d1b5b324a1b5b313b33346de29594e29590e29597204e616d653a201b5b313b33346d202020200d0a1b5b303b33336d506173733a201b5b35431b5b303b33336d202020202020200d0a1b5b376d1b5b373b33336d202020201b5b306d20656e640d0a',
        mciMap: {
            ET1: {
                position: [1, 11],
                args: [],
                SGR: '\u001b[0;1;34m',
                code: 'ET',
                id: 1,
            },
            ET2: {
                position: [2, 12],
                args: ['4'],
                SGR: '\u001b[0;33m',
                code: 'ET',
                id: 2,
            },
            VM1: {
                position: [3, 1],
                args: [],
                SGR: '\u001b[0;7;33m',
                code: 'VM',
                id: 1,
            },
        },
        extra: {
            height: 3,
        },
    },
    'utf8/10000000': {
        err: null,
        wire: '1b5b306d1b5b324a1b5b313b33346de29594e29590e29597204e616d653a201b5b313b33346d202020200d0a1b5b303b33336d506173733a201b5b35431b5b303b33336d202020202020200d0a1b5b376d1b5b373b33336d202020201b5b306d20656e640d0a',
        mciMap: {
            ET1: {
                position: [1, 11],
                args: [],
                SGR: '\u001b[0;1;34m',
                code: 'ET',
                id: 1,
            },
            ET2: {
                position: [2, 12],
                args: ['4'],
                SGR: '\u001b[0;33m',
                code: 'ET',
                id: 2,
            },
            VM1: {
                position: [3, 1],
                args: [],
                SGR: '\u001b[0;7;33m',
                code: 'VM',
                id: 1,
            },
        },
        extra: {
            height: 3,
        },
    },
};

describe('ANSI art display, pinned (#593)', function () {
    let art;
    before(function () {
        //  lazily: art.js captures config.js's |get| at require time
        art = require('../core/art.js');
    });

    Object.keys(EXPECTED).forEach(key => {
        const [encoding, baud] = key.split('/');
        it(`${encoding} terminal, baud rate ${baud}`, done => {
            const written = [];
            const term = new ClientTerminal({
                writable: true,
                write(data, cb) {
                    written.push(Buffer.from(data));
                    if (cb) {
                        cb(null);
                    }
                },
            });
            term.outputEncoding = encoding;
            term.termWidth = 80;
            term.termHeight = 25;
            art.display(
                { term },
                ART,
                { baudRate: Number(baud) },
                (err, mciMap, extra) => {
                    const expected = EXPECTED[key];
                    assert.equal(err ? err.message : null, expected.err);
                    assert.equal(Buffer.concat(written).toString('hex'), expected.wire);
                    assert.deepEqual(JSON.parse(JSON.stringify(mciMap)), expected.mciMap);
                    assert.deepEqual(extra, expected.extra);
                    return done();
                }
            );
        });
    });
});
