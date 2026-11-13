'use strict';

//
//  The RIPscrip output filter (#989): what a RIP session is sent, what is
//  left alone, and proof that a session without the RIP layer is sent
//  exactly what origin/master sent it.
//
const { strict: assert } = require('assert');
const { EventEmitter } = require('events');
const crypto = require('crypto');

const { ClientTerminal } = require('../core/client_term.js');
const Term = require('../core/term');
const Rip = require('../core/term/rip');
const {
    INTRODUCER_BREAK,
    INTRODUCER_REPLACEMENT,
    COMMAND_LINE_END,
    MAX_HELD,
    createRipOutputFilter,
} = require('../core/term/rip/output_filter.js');
const { attachRipLayer } = require('../core/term/select.js');

const bytes = s => Buffer.from(s, 'latin1');
const latin1 = b => Buffer.from(b).toString('latin1');

//  A filter that has already sent one ordinary byte, so a leading '|' is not
//  taken as possibly following an introducer
function warmFilter() {
    const f = createRipOutputFilter();
    f.filter(bytes('x'));
    return f;
}

const filterAll = (chunks, f = warmFilter()) =>
    latin1(Buffer.concat(chunks.map(c => f.filter(bytes(c)))));

//  A RIP session: a real ClientTerminal with the layer attached, as a TTYPE
//  'RIP' caller gets it, and what reached its socket
function ripSession({ encoding = 'cp437' } = {}) {
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
    term.termHeight = 25;
    const client = { term, log: { info() {}, debug() {}, warn() {} } };
    attachRipLayer(client, { source: 'termType' });
    return { term, client, wire, sent: () => latin1(Buffer.concat(wire)) };
}

//  setTimeout() replaced by a queue the test runs by hand, so that a drip's
//  pieces go out exactly when the test says. restore() puts it back.
function fakeTimers() {
    const real = global.setTimeout;
    const queue = [];
    global.setTimeout = (fn, ms) => {
        queue.push({ fn, ms });
        return { unref() {} };
    };
    return {
        queue,
        tick() {
            const next = queue.shift();
            next.fn();
            return next;
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

//
//  Master identity: the corpus below goes through every write path of a
//  session without the RIP layer (ANSI CP437, ANSI UTF-8, PETSCII, ATASCII).
//  MASTER_PINS holds, per case, a hash of what reached the socket on
//  origin/master b8f708e1 (each socket write: a string as it is, or a
//  Buffer's bytes and whether it was the very Buffer the caller passed).
//  writeDoorOutput() is pinned to master's write() and writeUnfilteredRip()
//  to master's rawWrite(), which are what those callers used there.
//

//  Text: RIP attack strings, CP437 glyphs (U+263A/B become 0x01/0x02 in
//  CP437), UTF-8 text, pipe codes, CR/LF, a bit of art
const TEXT = [
    'Hello, world!\n',
    '!|1K\r\n!|c0F|B0000A0A0\r\n',
    'abc !|* mid-line, and \u263A|* and \u263B|1Q00000000\n',
    'raw \x01|* and \x02|* bytes, ESC[1! \x1b[1! ESC[! \x1b[!_ \x1b[0! \x1b[2!x\n',
    '\x1b[0m\x1b[2J\x1b[1;34m\u2554\u2550\u2557 \u2591\u2592\u2593\u2588 caf\u00E9 \u2620 na\u00EFve\r\n',
    '|04red |15white!|07 back |00\n',
    'split !',
    '|start of the next write and \x1b[',
    '1!x end\n',
];

//  Bytes: every byte value, then the attack strings as bytes
const ALL_BYTES = Buffer.from([...Array(256).keys()]);
const BYTES = [
    ALL_BYTES,
    Buffer.from('!|1K\r\n\x01|*\x02|*\x1b[1!\x1b[!_ !', 'latin1'),
    Buffer.from('|after a split\x1b[0m', 'latin1'),
];

const SESSIONS = [
    { name: 'ansi/cp437', emulation: 'ansi', encoding: 'cp437' },
    { name: 'ansi/utf8', emulation: 'ansi', encoding: 'utf8' },
    { name: 'petscii', emulation: 'petscii' },
    { name: 'atascii', emulation: 'atascii' },
];

function makeTerm(ClientTerminal, Term, session) {
    const calls = [];
    const term = new ClientTerminal({
        writable: true,
        write(data, cb) {
            calls.push(data);
            if (cb) {
                cb(null);
            }
        },
    });
    if ('ansi' !== session.emulation) {
        term.emulation = Term.createEmulation(session.emulation);
        term.outputEncoding = term.emulation.encoding;
    } else {
        term.outputEncoding = session.encoding;
    }
    term.termWidth = 80;
    term.termHeight = 25;
    return { term, calls };
}

//  What reached the socket: strings as they are, Buffers as hex, and whether
//  a Buffer is the very object a caller handed in
function record(calls, inputs) {
    return calls.map(d =>
        'string' === typeof d
            ? { s: d }
            : { b: Buffer.from(d).toString('hex'), same: inputs.includes(d) }
    );
}

const tryCall = fn => {
    try {
        fn();
        return null;
    } catch (e) {
        return e.message;
    }
};

//
//  Every write path, for every session. |opts.master| names the calls that
//  exist on origin/master: writeDoorOutput() is write() there, and
//  writeUnfilteredRip() is rawWrite().
//
async function runCorpus(ClientTerminal, Term, opts = {}) {
    const doorWrite = (term, s, lf) =>
        opts.master ? term.write(s, lf) : term.writeDoorOutput(s, lf);
    const unfilteredRip = (term, d) =>
        opts.master ? term.rawWrite(d) : term.writeUnfilteredRip(d);

    const paths = {
        write: term => TEXT.forEach(s => term.write(s)),
        writeNoLf: term => TEXT.forEach(s => term.write(s, false)),
        rawWriteString: term => TEXT.forEach(s => term.rawWrite(s)),
        rawWriteBytes: term => BYTES.forEach(b => term.rawWrite(b)),
        pipeWrite: term => TEXT.forEach(s => term.pipeWrite(s)),
        passThroughWrite: term => BYTES.forEach(b => term.passThroughWrite(b)),
        nativeWrite: term => BYTES.map(b => tryCall(() => term.nativeWrite(b))),
        doorOutput: term => TEXT.forEach(s => doorWrite(term, s)),
        doorOutputNoLf: term => TEXT.forEach(s => doorWrite(term, s, false)),
        unfilteredRip: term => BYTES.forEach(b => unfilteredRip(term, b)),
        batch: term => {
            term.beginWrite();
            TEXT.slice(0, 3).forEach(s => term.write(s));
            term.rawWrite(BYTES[1]);
            term.beginWrite();
            term.passThroughWrite(BYTES[1]);
            term.write(TEXT[6]);
            term.commitWrite();
            if (term.canWriteNative()) {
                term.nativeWrite(BYTES[2]);
            }
            term.rawWrite(BYTES[2]);
            TEXT.slice(3).forEach(s => term.pipeWrite(s));
            unfilteredRip(term, BYTES[1]);
            term.commitWrite();
        },
    };

    const asyncPaths = {
        dripWrite: (term, done) =>
            term.dripWrite(
                Buffer.concat([...BYTES, Buffer.from(TEXT.join(''))]),
                1e9,
                done
            ),
        nativeDripWrite: (term, done) =>
            term.nativeDripWrite(BYTES[1], {}, 1e9, err => done(err && err.message)),
    };

    const result = {};
    for (const session of SESSIONS) {
        for (const [name, run] of Object.entries(paths)) {
            const { term, calls } = makeTerm(ClientTerminal, Term, session);
            const ret = run(term);
            result[`${session.name} ${name}`] = {
                ret: ret === undefined ? null : ret,
                wire: record(calls, BYTES),
            };
        }
        for (const [name, run] of Object.entries(asyncPaths)) {
            const { term, calls } = makeTerm(ClientTerminal, Term, session);
            const ret = await new Promise(resolve => run(term, resolve));
            result[`${session.name} ${name}`] = {
                ret: ret === undefined ? null : ret,
                wire: record(calls, BYTES),
            };
        }
        if ('ansi' === session.emulation) {
            const { term, calls } = makeTerm(ClientTerminal, Term, session);
            const client = new EventEmitter();
            client.term = term;
            client.log = { info() {}, debug() {}, warn() {} };
            const basic = term.emulation.probes.find(p => 'basicPrepWork' === p.name);
            await new Promise(resolve => basic.run(client, resolve));
            result[`${session.name} probe`] = { ret: null, wire: record(calls, BYTES) };
        }
    }
    return result;
}

const MASTER_PINS = {
    'ansi/cp437 write': 'bf25ffa520d04653a32ff161ad6ed032',
    'ansi/cp437 writeNoLf': '5d439ccbc944a0e75e46eeefd8f366b4',
    'ansi/cp437 rawWriteString': '555614bd78dcd682d1083f36c8f7ad74',
    'ansi/cp437 rawWriteBytes': '3767c2b281ee1335ff131ee1a995370c',
    'ansi/cp437 pipeWrite': '2a9f9beaa05a7970de4150d39e002ad1',
    'ansi/cp437 passThroughWrite': '3767c2b281ee1335ff131ee1a995370c',
    'ansi/cp437 nativeWrite': 'f81be824662652846d9048595edb287f',
    'ansi/cp437 doorOutput': 'bf25ffa520d04653a32ff161ad6ed032',
    'ansi/cp437 doorOutputNoLf': '5d439ccbc944a0e75e46eeefd8f366b4',
    'ansi/cp437 unfilteredRip': '3767c2b281ee1335ff131ee1a995370c',
    'ansi/cp437 batch': '016e903761c5bc5e88a453cd219343f8',
    'ansi/cp437 dripWrite': '53b15fbaf5d6963ef6fbe5fae950fcc2',
    'ansi/cp437 nativeDripWrite': '8f733ebf6d38ec371b1f3593fe9ac845',
    'ansi/cp437 probe': '9e1a10aa728ba5bef9d8ad648f68468a',
    'ansi/utf8 write': '13a5a6991fad882990e6e52186ecd090',
    'ansi/utf8 writeNoLf': 'cbc4d37837178401b2b5b1093bc98b8a',
    'ansi/utf8 rawWriteString': '555614bd78dcd682d1083f36c8f7ad74',
    'ansi/utf8 rawWriteBytes': '3767c2b281ee1335ff131ee1a995370c',
    'ansi/utf8 pipeWrite': 'e3d3f912412f98e055c677b36d6cda14',
    'ansi/utf8 passThroughWrite': '3767c2b281ee1335ff131ee1a995370c',
    'ansi/utf8 nativeWrite': 'f81be824662652846d9048595edb287f',
    'ansi/utf8 doorOutput': '13a5a6991fad882990e6e52186ecd090',
    'ansi/utf8 doorOutputNoLf': 'cbc4d37837178401b2b5b1093bc98b8a',
    'ansi/utf8 unfilteredRip': '3767c2b281ee1335ff131ee1a995370c',
    'ansi/utf8 batch': '71cdb2515e5b426f7763aa5e129aeadd',
    'ansi/utf8 dripWrite': '53b15fbaf5d6963ef6fbe5fae950fcc2',
    'ansi/utf8 nativeDripWrite': '8f733ebf6d38ec371b1f3593fe9ac845',
    'ansi/utf8 probe': '9e1a10aa728ba5bef9d8ad648f68468a',
    'petscii write': '3d07189ea7e71697bbd0206586c01f8f',
    'petscii writeNoLf': 'aed0fe8fd1a6093f2bc4910b0ee44e86',
    'petscii rawWriteString': 'aed0fe8fd1a6093f2bc4910b0ee44e86',
    'petscii rawWriteBytes': '60ada766ce40016b2aae7f72f43e269c',
    'petscii pipeWrite': 'b98ba073dbd11e6e314ca042fa03a2fe',
    'petscii passThroughWrite': '3767c2b281ee1335ff131ee1a995370c',
    'petscii nativeWrite': '0495496335238609739613d62f73e9fa',
    'petscii doorOutput': '3d07189ea7e71697bbd0206586c01f8f',
    'petscii doorOutputNoLf': 'aed0fe8fd1a6093f2bc4910b0ee44e86',
    'petscii unfilteredRip': '60ada766ce40016b2aae7f72f43e269c',
    'petscii batch': 'b228a8f125d0d10b15bc3fccce740a55',
    'petscii dripWrite': '6645bd27f3217fdf6f32f892b427f693',
    'petscii nativeDripWrite': '2e3d74e1d1e6dd14dc8854abc50ef9e5',
    'atascii write': '77aeb8f23a39ea6d3caabfa94e29e969',
    'atascii writeNoLf': '0ebf542e19bb3df7ef633d18f9172c73',
    'atascii rawWriteString': '0ebf542e19bb3df7ef633d18f9172c73',
    'atascii rawWriteBytes': '5c034ee66949c343284914ef56455705',
    'atascii pipeWrite': '8f66b5072985507415ba53102d6fd365',
    'atascii passThroughWrite': '3767c2b281ee1335ff131ee1a995370c',
    'atascii nativeWrite': '0b394de7de39d66e81ec87d9cd658300',
    'atascii doorOutput': '77aeb8f23a39ea6d3caabfa94e29e969',
    'atascii doorOutputNoLf': '0ebf542e19bb3df7ef633d18f9172c73',
    'atascii unfilteredRip': '5c034ee66949c343284914ef56455705',
    'atascii batch': '86fa005894c22ced7de584be9727c3b7',
    'atascii dripWrite': 'e4dd98a4da1eec5319a39de4b6828ee3',
    'atascii nativeDripWrite': '5bc4295abf9c14969659954c0946a7a5',
};

const pinHash = value =>
    crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);

//
//  The documented changes, applied to a whole wire at once: a reference for
//  the fuzz, written apart from the filter. |segments| are { bytes, filtered }
//  in wire order. Returns the wire, which bytes came from filtered writes,
//  and each filtered segment's place in the wire.
//
const isIntroducer = b => 0x21 === b || 0x01 === b || 0x02 === b;

function csiOpenAtEnd(wire, end = wire.length) {
    let i = end - 1;
    const isControl = b => (b < 0x20 && 0x1b !== b) || 0x7f === b;
    while (
        i >= 0 &&
        ((wire[i] >= 0x30 && wire[i] <= 0x39) || 0x3b === wire[i] || isControl(wire[i]))
    ) {
        --i;
    }
    if (i < 0 || 0x5b !== wire[i]) {
        return false;
    }
    --i;
    while (i >= 0 && isControl(wire[i])) {
        --i;
    }
    return i >= 0 && 0x1b === wire[i];
}

function ripCommandOpen(wire) {
    let open = false;
    let backslashes = 0;
    for (let i = 0; i < wire.length; ++i) {
        const b = wire[i];
        if (!open) {
            open = 0x7c === b && i > 0 && isIntroducer(wire[i - 1]);
            backslashes = 0;
        } else if (0x5c === b) {
            ++backslashes;
        } else if (0x0d === b) {
            if (backslashes & 1) {
                --backslashes;
            } else {
                open = false;
            }
        } else if (0x0a !== b) {
            backslashes = 0;
        }
    }
    return open ? { oddBackslashes: Boolean(backslashes & 1) } : null;
}

const isRunByte = b => 0x1b === b || 0x5b === b || 0x3b === b || (b >= 0x30 && b <= 0x39);
const isParam = b => 0x3b === b || (b >= 0x30 && b <= 0x39);

//  does the wire end in an open ESC (controls aside)?
function escOpenAtEnd(wire) {
    let i = wire.length - 1;
    while (i >= 0 && ((wire[i] < 0x20 && 0x1b !== wire[i]) || 0x7f === wire[i])) {
        --i;
    }
    return i >= 0 && 0x1b === wire[i];
}

function referenceWire(rawSegments) {
    //  filtered writes straight after one another are one stream
    const segments = [];
    for (const seg of rawSegments) {
        if (!seg.filtered && 0 === seg.bytes.length) {
            continue; //  an empty unfiltered write changes nothing
        }
        const last = segments[segments.length - 1];
        if (seg.filtered && last && last.filtered) {
            last.bytes = last.bytes.concat(seg.bytes);
        } else {
            segments.push({ bytes: [...seg.bytes], filtered: seg.filtered });
        }
    }

    const wire = [];
    const fromFilter = [];
    const placed = [];
    const push = (b, filtered) => {
        wire.push(b);
        fromFilter.push(filtered);
    };
    for (const { bytes: input, filtered } of segments) {
        if (!filtered) {
            //  a | after a ! the filter sent gets a NUL in front
            const last = wire.length - 1;
            if (
                input.length > 0 &&
                0x7c === input[0] &&
                last >= 0 &&
                0x21 === wire[last] &&
                fromFilter[last]
            ) {
                push(0x00, true);
            }
            input.forEach(b => push(b, false));
            continue;
        }
        if (0 === input.length) {
            continue; //  an empty write sends nothing
        }
        const start = wire.length;
        const removed = [];
        const open = ripCommandOpen(wire);
        if (open) {
            if (open.oddBackslashes) {
                push(0x00, true);
            }
            push(0x0d, true);
            push(0x0a, true);
        }
        let i = 0;
        while (i < input.length) {
            const b = input[i];
            const paramsOpen = csiOpenAtEnd(wire);
            const escOpen = !paramsOpen && escOpenAtEnd(wire);
            if (0x1b === b || (escOpen && 0x5b === b) || (paramsOpen && isParam(b))) {
                //  a run that starts or carries on ESC [ params
                let state = 0x1b === b ? 'esc' : 'params';
                const continues = c =>
                    ('esc' === state && 0x5b === c) || ('params' === state && isParam(c));
                let k = i + 1;
                while (k < input.length && continues(input[k]) && k - i < MAX_HELD) {
                    state = 'params';
                    ++k;
                }
                if (k === input.length) {
                    removed.push([i, k]); //  held, then dropped or never sent
                    break;
                }
                if (continues(input[k]) || 0x1b === input[k]) {
                    //  too long, or cut off by ESC: dropped; input[k] is
                    //  judged afresh
                    removed.push([i, k]);
                    i = k;
                    continue;
                }
                if ('params' === state && 0x21 === input[k]) {
                    removed.push([i, k + 1]);
                    i = k + 1;
                    continue;
                }
                for (let r = i; r < k; ++r) {
                    push(input[r], true);
                }
                i = k;
                continue;
            }
            ++i;
            if (0x21 === b && paramsOpen) {
                removed.push([i - 1, i]);
                continue;
            }
            if (0x01 === b || 0x02 === b) {
                push(0x2a, true);
                continue;
            }
            if (
                0x7c === b &&
                (0 === wire.length || isIntroducer(wire[wire.length - 1]))
            ) {
                push(0x00, true);
            }
            push(b, true);
        }
        placed.push({ input, start, end: wire.length, closed: Boolean(open), removed });
    }
    return { wire, fromFilter, placed };
}

//
//  Undo a filtered segment: walk its input against its output allowing only
//  the documented changes; each removed range must have a documented shape.
//  Returns an error string, or null.
//
function undoFiltered(wire, { input, start, end, closed, removed }) {
    const singleBang = new Set();
    const skip = new Set();
    for (const [a, b] of removed) {
        const seg = input.slice(a, b);
        const isBang = 1 === seg.length && 0x21 === seg[0];
        const isSequence =
            seg.length >= 2 &&
            0x21 === seg[seg.length - 1] &&
            seg.slice(0, -1).every(isRunByte);
        const isTail = b === input.length && seg.every(isRunByte);
        const isCut = b < input.length && 0x1b === input[b] && seg.every(isRunByte);
        const isTooLong = MAX_HELD === seg.length && seg.every(isRunByte);
        if (!isBang && !isSequence && !isTail && !isCut && !isTooLong) {
            return `removed ${JSON.stringify(seg)} at ${a} has no documented shape`;
        }
        if (isBang) {
            singleBang.add(a);
        }
        for (let k = a; k < b; ++k) {
            skip.add(k);
        }
    }
    let j = start;
    if (closed) {
        if (0x00 === wire[j] && 0x0d === wire[j + 1]) {
            ++j;
        }
        if (0x0d !== wire[j] || 0x0a !== wire[j + 1]) {
            return 'missing command line end';
        }
        j += 2;
    }
    for (let i = 0; i < input.length; ++i) {
        const b = input[i];
        if (singleBang.has(i) && !csiOpenAtEnd(wire, j)) {
            return `'!' at ${i} removed outside ESC [ params`;
        }
        if (skip.has(i)) {
            continue;
        }
        if (0x01 === b || 0x02 === b) {
            if (0x2a !== wire[j]) {
                return `0x0${b} at ${i} not replaced`;
            }
            ++j;
        } else if (j < end && wire[j] === b) {
            ++j;
        } else if (0x7c === b && 0x00 === wire[j] && 0x7c === wire[j + 1]) {
            j += 2;
        } else {
            return `input byte ${b} at ${i} does not match wire byte ${wire[j]}`;
        }
    }
    return j === end ? null : `${end - j} extra bytes`;
}

//  mulberry32
function prng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

describe('RIPscrip output filter (#989)', () => {
    describe('the filter', () => {
        it('names its break, its replacement and its command line end', () => {
            assert.equal(INTRODUCER_BREAK, 0x00);
            assert.equal(INTRODUCER_REPLACEMENT, 0x2a);
            assert.deepEqual([...COMMAND_LINE_END], [0x0d, 0x0a]);
        });

        it('puts a NUL between every introducer and |, wherever it is', () => {
            assert.equal(filterAll(['!|1K\r\n']), '!\x00|1K\r\n');
            assert.equal(filterAll(['abc !|*']), 'abc !\x00|*');
            assert.equal(filterAll(['!!|']), '!!\x00|');
            assert.equal(filterAll(['!|!|']), '!\x00|!\x00|');
            assert.equal(
                filterAll(['\x1b[0m!|c0F|B0000A0A0']),
                '\x1b[0m!\x00|c0F|B0000A0A0'
            );
        });

        it('the NUL it adds is always followed by |, never by !', () => {
            const out = filterAll(['!|!|!!||!x|!\x01|\x02|']);
            for (let i = 0; i < out.length; ++i) {
                if ('\x00' === out[i]) {
                    assert.equal(out[i + 1], '|');
                }
            }
        });

        it('replaces 0x01 and 0x02 one for one', () => {
            assert.equal(filterAll(['a\x01|*b\x02|1Q']), 'a*|*b*|1Q');
            assert.equal(filterAll(['\x01\x02']), '**');
        });

        it('removes ESC [ <digits and ;> ! whole, and nothing else', () => {
            assert.equal(filterAll(['\x1b[1!x']), 'x');
            assert.equal(filterAll(['ESC \x1b[1! end']), 'ESC  end');
            assert.equal(filterAll(['\x1b[!_']), '_');
            assert.equal(filterAll(['\x1b[0!\x1b[2!']), '');
            assert.equal(filterAll(['\x1b[16!text!']), 'text!');
            assert.equal(filterAll(['\x1b[10;1;2!']), '');
            //  not RIP sequences
            assert.equal(
                filterAll(['\x1b[?1! \x1b[1 ! \x1b[1m! \x1b!']),
                '\x1b[?1! \x1b[1 ! \x1b[1m! \x1b!'
            );
            //  removing it never joins a ! and a | on the wire
            assert.equal(filterAll(['!\x1b[!|']), '!\x00|');
            //  nor two halves of another one: ESC [ 1 cut off by an ESC is
            //  dropped, never left open on the wire
            assert.equal(filterAll(['\x1b[1\x1b[!!x']), '!x');
        });

        it('a control byte inside the sequence: only the ! is removed', () => {
            assert.equal(filterAll(['\x1b[1\r!x']), '\x1b[1\rx');
        });

        it('holds a possible start of one back until the next write shows what it is', () => {
            const f = warmFilter();
            assert.equal(latin1(f.filter(bytes('text \x1b[1'))), 'text ');
            assert.equal(f.state.held, 3);
            assert.equal(latin1(f.filter(bytes('0m more'))), '\x1b[10m more');
            assert.equal(latin1(f.filter(bytes('a\x1b'))), 'a');
            assert.equal(latin1(f.filter(bytes('[2!b'))), 'b');
        });

        it('(a) held bytes are dropped, never finished, by an unfiltered write', () => {
            for (const held of ['\x1b', '\x1b[', '\x1b[12', '\x1b[1;']) {
                const f = warmFilter();
                assert.equal(latin1(f.filter(bytes(`x${held}`))), 'x');
                const door = bytes('!|1K door');
                assert.equal(f.observe(door), door, JSON.stringify(held));
                assert.equal(f.state.held, 0);
            }
            const f = warmFilter();
            f.filter(bytes('\x1b['));
            assert.equal(f.observe('str'), 'str');
            f.filter(bytes('\x1b'));
            assert.equal(f.observe(bytes('[1!x')).toString('latin1'), '[1!x');
        });

        it('an empty unfiltered write sends nothing and changes nothing', () => {
            const f = warmFilter();
            assert.equal(latin1(f.filter(bytes('\x1b['))), '');
            const empty = Buffer.alloc(0);
            assert.equal(f.observe(empty), empty);
            assert.equal(f.observe(''), '');
            assert.equal(f.state.held, 2);
            assert.equal(latin1(f.filter(bytes('1!x'))), 'x');
            const g = warmFilter();
            g.filter(bytes('hi!'));
            g.observe('');
            assert.equal(latin1(g.observe(bytes('|1K'))), '\x00|1K');
        });

        describe('never leaves ESC or ESC [ params of its own open on the wire', () => {
            //  each: filtered write, unfiltered write, the whole wire
            const CASES = [
                ['\x1b[\x1b', '!|1K', 'hello!|1K'],
                ['\x1b[1;2\x1b', '!', 'hello!'],
                ['\x1b[0\x1b', '!|', 'hello!|'],
                ['\x1b\x1b', '[1!', 'hello[1!'],
                ['\x1b[\x1b', '|', 'hello|'],
                ['\x1b[1\x1b\x1b[0', '1!', 'hello1!'],
            ];
            CASES.forEach(([filtered, unfiltered, wire]) => {
                it(JSON.stringify([filtered, unfiltered]), () => {
                    const f = createRipOutputFilter();
                    const out = [f.filter(bytes('hello')), f.filter(bytes(filtered))];
                    out.push(f.observe(bytes(unfiltered)));
                    assert.equal(latin1(Buffer.concat(out)), wire);
                });
            });

            it('held bytes cut off by ESC are dropped, even from the write before', () => {
                const f = warmFilter();
                assert.equal(latin1(f.filter(bytes('a\x1b['))), 'a');
                assert.equal(latin1(f.filter(bytes('\x1b'))), '');
                assert.equal(latin1(f.observe(bytes('!|1K'))), '!|1K');
                const g = warmFilter();
                g.filter(bytes('\x1b[1'));
                assert.equal(latin1(g.filter(bytes('\x1b[2m'))), '\x1b[2m');
                assert.equal(filterAll(['\x1b\x1b[1mx']), '\x1b[1mx');
            });

            it('and a run that carries on an unfiltered one is dropped the same way', () => {
                const f = warmFilter();
                f.observe(bytes('\x1b['));
                assert.equal(latin1(f.filter(bytes('1\x1b'))), '');
                assert.equal(latin1(f.observe(bytes('!'))), '!');
            });
        });

        describe('holds at most MAX_HELD units', () => {
            it('a longer run is dropped and what follows is judged afresh', () => {
                assert.ok(MAX_HELD >= 64);
                const f = warmFilter();
                const run = '\x1b[' + '1'.repeat(MAX_HELD - 2);
                assert.equal(latin1(f.filter(bytes(run))), '');
                assert.equal(f.state.held, MAX_HELD);
                assert.equal(latin1(f.filter(bytes('2m'))), '2m');
                assert.equal(f.state.held, 0);
                //  a run that fits is sent whole
                const sgr = '\x1b[38;2;255;255;255;48;2;255;255;255m';
                assert.equal(filterAll([sgr]), sgr);
            });

            it('many one-byte writes after ESC [ stay bounded', () => {
                const f = warmFilter();
                f.filter(bytes('\x1b['));
                const wire = [];
                for (let i = 0; i < 60000; ++i) {
                    wire.push(f.filter(bytes('1')));
                    assert.ok(f.state.held <= MAX_HELD);
                }
                wire.push(f.observe(bytes('!|1K')));
                const sent = latin1(Buffer.concat(wire));
                assert.ok(!sent.includes('\x1b'), 'no ESC of its own reaches the wire');
            });

            it('after an unfiltered ESC [ a long run is never sent', () => {
                const f = warmFilter();
                f.observe(bytes('\x1b['));
                assert.equal(latin1(f.filter(bytes('1'.repeat(1000)))), '');
                assert.ok(f.state.held <= MAX_HELD);
                assert.equal(latin1(f.observe(bytes('!'))), '!');
                const g = warmFilter();
                g.observe(bytes('\x1b['));
                g.filter(bytes('1'.repeat(1000)));
                assert.equal(latin1(g.filter(bytes('!x'))), 'x');
            });

            it('never throws, on long strings or Buffers', () => {
                const f = warmFilter();
                assert.doesNotThrow(() => f.filter('\x1b[' + '1'.repeat(200000)));
                assert.equal(f.filter('a'), 'a');
                assert.equal(f.filter('\u0001'.repeat(200000)), '*'.repeat(200000));
                const big = Buffer.concat([bytes('\x1b['), Buffer.alloc(1e6, 0x31)]);
                assert.doesNotThrow(() => f.filter(big));
                assert.ok(f.state.held <= MAX_HELD);
                for (const held of ['\x1b', '\x1b[1', '\x1b[' + '2'.repeat(MAX_HELD)]) {
                    const g = warmFilter();
                    g.filter(held);
                    assert.doesNotThrow(() => g.filter('x'.repeat(200000)));
                }
            });
        });

        it('(a) bytes that carry on a sequence the wire has open are held too', () => {
            const f = warmFilter();
            f.observe(bytes('\x1b['));
            assert.equal(latin1(f.filter(bytes('12'))), '');
            assert.equal(latin1(f.observe(bytes('!x'))), '!x');
            const g = warmFilter();
            g.observe(bytes('\x1b'));
            assert.equal(latin1(g.filter(bytes('[1!y'))), 'y');
            const h = warmFilter();
            h.observe(bytes('\x1b['));
            assert.equal(latin1(h.filter(bytes('1;1H'))), '1;1H');
        });

        it('(b) a ! after unfiltered ESC [ params: only the ! is removed', () => {
            const f = warmFilter();
            f.observe(bytes('\x1b[1'));
            assert.equal(latin1(f.filter(bytes('!x'))), 'x');
        });

        it('(c) held, then a filtered write that finishes an ordinary sequence', () => {
            const f = warmFilter();
            assert.equal(latin1(f.filter(bytes('\x1b['))), '');
            assert.equal(latin1(f.filter(bytes('1;1H'))), '\x1b[1;1H');
        });

        it('a ! the filter sent, then an unfiltered |: a NUL between them', () => {
            const f = warmFilter();
            f.filter(bytes('hi!'));
            assert.equal(latin1(f.observe(bytes('|1K'))), '\x00|1K');
            assert.equal(f.observe('|s'), '|s');
            const g = warmFilter();
            g.observe(bytes('!'));
            const art = bytes('|1K');
            assert.equal(g.observe(art), art); //  both unfiltered: untouched
        });

        it('keeps its state across writes: every split of every attack string', () => {
            const attacks = [
                '!|1K',
                'x!|c0F|B0000A0A0\r\n',
                'abc !|* \x01|* \x02|1Q',
                '\x1b[1!\x1b[!_\x1b[0!\x1b[2!',
                '!!||!\x1b[!|',
            ];
            for (const attack of attacks) {
                const whole = filterAll([attack]);
                for (let at = 0; at <= attack.length; ++at) {
                    assert.equal(
                        filterAll([attack.slice(0, at), attack.slice(at)]),
                        whole,
                        `${JSON.stringify(attack)} split at ${at}`
                    );
                }
            }
        });

        it('hands back the same object when nothing has to change', () => {
            const f = warmFilter();
            const b = bytes('plain text, ESC[0m \x1b[0m, | and ! apart');
            assert.equal(f.filter(b), b);
            const s = 'a string';
            assert.equal(f.filter(s), s);
        });

        it('a | first thing after it is made gets a break: the byte before is unknown', () => {
            assert.equal(latin1(createRipOutputFilter().filter(bytes('|x'))), '\x00|x');
        });

        it('judges a string by the low byte of each unit and gives back a string', () => {
            const f = warmFilter();
            assert.equal(f.filter('a!|b\u0101|c\u263A'), 'a!\x00|b*|c\u263A');
            assert.equal(f.filter('\u0121|'), '\u0121\x00|');
        });

        describe('after unfiltered output', () => {
            it('a | straight after an unfiltered introducer gets its break', () => {
                for (const intro of ['!', '\x01', '\x02']) {
                    const f = warmFilter();
                    f.observe(bytes(`text${intro}`));
                    assert.equal(latin1(f.filter(bytes('|1K'))), '\x00|1K');
                }
            });

            it('a ! after unfiltered ESC [ digits: only the ! is removed', () => {
                const f = warmFilter();
                f.observe(bytes('\x1b[1'));
                assert.equal(latin1(f.filter(bytes('!x'))), 'x');
            });

            it('a RIP command it leaves open is ended before filtered text', () => {
                const f = warmFilter();
                f.observe(bytes('!|c0F'));
                assert.equal(latin1(f.filter(bytes('text'))), '\r\ntext');
                assert.equal(latin1(f.filter(bytes('more'))), 'more');
            });

            it('a command that ends in a continuation backslash gets a NUL first', () => {
                const f = warmFilter();
                f.observe(bytes('!|c0F\\'));
                assert.equal(latin1(f.filter(bytes('t'))), '\x00\r\nt');
                const g = warmFilter();
                g.observe(bytes('!|c0F\\\n'));
                assert.equal(latin1(g.filter(bytes('t'))), '\x00\r\nt');
                const h = warmFilter();
                h.observe(bytes('!|c0F\\\\'));
                assert.equal(latin1(h.filter(bytes('t'))), '\r\nt');
            });

            it('a command ended by CR, or continued and then ended, needs nothing', () => {
                for (const art of ['!|c0F|e\r\n', '!|c0F\\\r\n|e\r', '!|*\r']) {
                    const f = warmFilter();
                    f.observe(bytes(art));
                    assert.equal(latin1(f.filter(bytes('text'))), 'text', art);
                }
            });
        });
    });

    describe('the emulation', () => {
        it('an ANSI session has no output filter until the RIP layer is attached', () => {
            const emulation = Term.createEmulation('ansi');
            assert.equal(emulation.outputFilter, null);
            emulation.addLayer(Rip.createRipLayer({ source: 'probe' }));
            assert.equal('function', typeof emulation.outputFilter.filter);
            assert.equal('function', typeof emulation.outputFilter.observe);
        });

        it('PETSCII and ATASCII take no layer and so never have a filter', () => {
            for (const name of ['petscii', 'atascii']) {
                const emulation = Term.createEmulation(name);
                assert.equal(emulation.addLayer(Rip.createRipLayer({})), false);
                assert.equal(emulation.outputFilter, null);
            }
        });

        it('a second report of the same layer keeps the filter and its state', () => {
            const { term, client } = ripSession();
            const filter = term.emulation.outputFilter;
            term.rawWrite(bytes('ends with !'));
            attachRipLayer(client, { source: 'probe', version: 'RIPSCRIP015410' });
            assert.equal(term.emulation.outputFilter, filter);
            assert.equal(filter.state.prev, 0x21);
        });

        it('a filter starts with the write after it is attached', () => {
            const wire = [];
            const term = new ClientTerminal({
                writable: true,
                write: (d, cb) => (wire.push(Buffer.from(d)), cb && cb(null)),
            });
            term.rawWrite(bytes('before !|1K'));
            attachRipLayer({ term, log: null }, { source: 'probe' });
            term.rawWrite(bytes('after !|1K'));
            assert.deepEqual(wire.map(latin1), ['before !|1K', 'after !\x00|1K']);
        });
    });

    describe('a RIP session', () => {
        it('write, rawWrite and pipeWrite are filtered, after the codec', () => {
            const { term, sent } = ripSession();
            term.write('a \u263A|* b \u263B|1Q !|1K\n');
            term.rawWrite(bytes('\x01|*\x1b[1!'));
            term.pipeWrite('|04red !|e|07\n');
            assert.equal(
                sent(),
                'a *|* b *|1Q !\x00|1K\r\n*|*' + '\x1b[22;31mred !\x00|e\x1b[22;37m\r\n'
            );
        });

        it('a batch is filtered as one piece; unfiltered chunks keep their place', () => {
            const { term, sent } = ripSession();
            term.beginWrite();
            term.write('one !');
            term.passThroughWrite(bytes('|door!'));
            term.write('|two');
            term.writeUnfilteredRip(bytes('!|c0F'));
            term.write('three');
            term.commitWrite();
            assert.equal(sent(), 'one !\x00|door!\x00|two!|c0F\r\nthree');
        });

        it('(d) held bytes and dripWrite: the drip takes them, or holds its own tail', done => {
            const { term, sent } = ripSession();
            term.rawWrite(bytes('a\x1b['));
            term.dripWrite(bytes('1;1Hb \x1b[1'), 1e9, err => {
                assert.ifError(err);
                assert.equal(sent(), 'a\x1b[1;1Hb ');
                //  the drip's own unfinished tail is dropped by a door write
                term.passThroughWrite(bytes('!|1K'));
                assert.equal(sent(), 'a\x1b[1;1Hb !|1K');
                term.nativeDripWrite(bytes('x'), {}, 1e9, nerr => {
                    assert.ok(nerr, 'an ANSI (RIP) session takes no native output');
                    return done();
                });
            });
        });

        it('dripWrite: a write between two pieces meets the filter in wire order', () => {
            const timers = fakeTimers();
            try {
                //  rawWrite (filtered) lands after ESC [ went out: one stream
                const a = ripSession();
                let doneA = false;
                a.term.rawWrite(bytes('hello'));
                //  62.5 bytes a second: one byte every 16 ms tick
                a.term.dripWrite(bytes('\x1b[1zzzz'), 62.5, err => {
                    doneA = !err;
                });
                timers.tick();
                a.term.rawWrite(bytes('!'));
                timers.runAll();
                assert.ok(doneA);
                assert.equal(a.sent(), 'hello1zzzz');

                //  an unfiltered write lands there: the held ESC [ is dropped
                const b = ripSession();
                b.term.rawWrite(bytes('hello'));
                b.term.dripWrite(bytes('\x1b[1zzzz'), 62.5, () => {});
                timers.tick();
                b.term.passThroughWrite(bytes('!|1K'));
                timers.runAll();
                //  (and the RIP command the door left open is ended first)
                assert.equal(b.sent(), 'hello!|1K\r\n1zzzz');

                //  a filtered ! the drip ends with, then an unfiltered |
                const c = ripSession();
                c.term.rawWrite(bytes('x'));
                c.term.dripWrite(bytes('ab!'), 62.5, () => {});
                timers.tick();
                timers.tick();
                c.term.writeUnfilteredRip(bytes('|1K'));
                assert.equal(c.sent(), 'xab!\x00|1K');
            } finally {
                timers.restore();
            }
        });

        it('dripWrite without the RIP layer: the same pieces, timing and callback', () => {
            const timers = fakeTimers();
            try {
                const { term, calls } = makeTerm(ClientTerminal, Term, SESSIONS[0]);
                const buf = bytes('\x1b[1zzz!|1K');
                let called = 0;
                term.dripWrite(buf, 250, err => {
                    assert.ifError(err);
                    ++called;
                });
                term.rawWrite(bytes('!'));
                const delays = [];
                while (timers.queue.length > 0) {
                    delays.push(timers.tick().ms);
                }
                assert.equal(called, 1);
                //  250 bytes a second: 4 bytes a tick
                assert.deepEqual(
                    calls.map(c => latin1(c)),
                    ['\x1b[1z', '!', 'zz!|', '1K']
                );
                assert.ok(calls.every(c => Buffer.isBuffer(c)));
                assert.deepEqual(delays, [16, 16]);
            } finally {
                timers.restore();
            }
        });

        it('dripWrite is filtered', done => {
            const { term, sent } = ripSession();
            term.dripWrite(bytes('drip !|1K \x01|*'), 1e9, err => {
                assert.ifError(err);
                assert.equal(sent(), 'drip !\x00|1K *|*');
                return done();
            });
        });

        it('passThroughWrite, writeDoorOutput and writeUnfilteredRip are not', () => {
            const { term, sent } = ripSession();
            term.passThroughWrite(bytes('!|1K\r\n'));
            term.writeDoorOutput('!|e\r\n\u263A|*\r\n', false);
            term.writeUnfilteredRip(bytes('!|c0F|B0000A0A0\r\n\x1b[2!'));
            assert.equal(sent(), '!|1K\r\n!|e\r\n\x01|*\r\n!|c0F|B0000A0A0\r\n\x1b[2!');
        });

        it('writeDoorOutput encodes as write() does, line feeds included', () => {
            const { term, sent } = ripSession();
            term.writeDoorOutput('a\nb');
            term.writeDoorOutput('c\nd', false);
            assert.equal(sent(), 'a\r\nbc\nd');
        });

        it("a door's output reaches the caller unfiltered", () => {
            const Door = require('../core/door.js');
            const { term, client, sent } = ripSession();
            const door = new Door(client);
            door.encoding = 'cp437';
            door.doorDataHandler(bytes('!|1K\n\x01|*'));
            assert.equal(sent(), '!|1K\r\n\x01|*');
            assert.equal(term.emulation.outputFilter.state.prev, 0x2a);
        });

        it('a caller that announced RIP still gets the version query whole', done => {
            const { term, client, sent } = ripSession();
            const events = new EventEmitter();
            Object.assign(events, client);
            const basic = term.emulation.probes.find(p => 'basicPrepWork' === p.name);
            basic.run(events, err => {
                assert.ifError(err);
                assert.ok(sent().includes(Rip.VERSION_PROBE), JSON.stringify(sent()));
                return done();
            });
        });

        it('the version query would be taken apart by the filter', () => {
            assert.notEqual(filterAll([Rip.VERSION_PROBE]), Rip.VERSION_PROBE);
        });

        it('a UTF-8 RIP session: only literal U+0001 / U+0002 become *', () => {
            const { term, sent } = ripSession({ encoding: 'utf8' });
            term.write('\u263A|* \u0001|* caf\u00E9 !|1K');
            assert.equal(
                sent(),
                latin1(Buffer.from('\u263A|* *|* caf\u00E9 !', 'utf8')) + '\x00|1K'
            );
        });
    });

    describe('a session without the RIP layer is sent what origin/master sent', () => {
        let results;
        before(async () => {
            results = await runCorpus(ClientTerminal, Term);
        });

        Object.keys(MASTER_PINS).forEach(key => {
            it(key, () => {
                assert.equal(pinHash(results[key]), MASTER_PINS[key]);
            });
        });

        it('the corpus covers every case pinned, and only those', () => {
            assert.deepEqual(
                Object.keys(results).sort(),
                Object.keys(MASTER_PINS).sort()
            );
        });
    });

    describe('differential fuzz', () => {
        //  0x1234 is the seed a review found a hole with (case 3869)
        const SEEDS = [0x989, 0x1234, 0x5eed, 0xc0ffee];
        const CASES = 5000;
        const ALPHABET = [
            0x21, 0x21, 0x21, 0x7c, 0x7c, 0x7c, 0x01, 0x02, 0x1b, 0x1b, 0x5b, 0x5b, 0x30,
            0x31, 0x39, 0x3b, 0x0d, 0x0a, 0x5c, 0x5c, 0x00, 0x61, 0x20, 0x3f, 0xe9, 0xff,
            0x07, 0x7f,
        ];
        const DOOR_TEXT = ['!', '|', '☺', '☻', '\x1b', '[', '1', '\\', '\r', 'a'];
        //  what a filtered write may end with: open, or cut off by ESC
        const FILTERED_TAILS = [
            '\x1b',
            '\x1b[',
            '\x1b[1',
            '\x1b[12;',
            '\x1b[\x1b',
            '\x1b[0\x1b',
            '\x1b[1;2\x1b',
        ];
        //  what an unfiltered write may start or end with
        const UNFILTERED_HEADS = ['!', '|', '1!', ';1!', '[1!', '!|', '!|1K', '\\'];
        const UNFILTERED_TAILS = ['\x1b', '\x1b[', '\x1b[1', '\x1b[1;', '!|1K\\', '\r'];

        //
        //  What the filter itself takes in and gives out, byte by byte, and
        //  which bytes of what it gave out came from unfiltered input: all of
        //  observe()'s but anything it put in front, none of filter()'s. This
        //  is the provenance the invariant is checked against, apart from
        //  the reference model. After every filter() the wire must not end
        //  in an ESC or ESC [ params holding a filtered byte.
        //
        function instrument(term) {
            const f = term.emulation.outputFilter;
            const wire = [];
            const unfiltered = [];
            const problems = [];
            const toBytes = d => ('string' === typeof d ? bytes(d) : Buffer.from(d));
            const append = (out, fromInput) => {
                const b = toBytes(out);
                const front = b.length - fromInput;
                b.forEach((v, i) => {
                    wire.push(v);
                    unfiltered.push(i >= front);
                });
            };
            const { filter, observe } = f;
            f.filter = data => {
                const out = filter(data);
                if (out) {
                    append(out, 0);
                    let i = wire.length - 1;
                    if (i < 0 || 0x1b !== wire[i]) {
                        while (i >= 0 && isParam(wire[i])) {
                            --i;
                        }
                        i =
                            i >= 1 && 0x5b === wire[i] && 0x1b === wire[i - 1]
                                ? i - 1
                                : -1;
                    }
                    if (i >= 0 && !unfiltered.slice(i).every(Boolean)) {
                        problems.push(
                            `left open: ${JSON.stringify(latin1(wire.slice(i)))}`
                        );
                    }
                }
                return out;
            };
            f.observe = data => {
                const out = observe(data);
                if (out) {
                    append(out, data.length);
                }
                return out;
            };
            return { wire, unfiltered, problems };
        }

        //  The invariant, by provenance: on the wire, ESC [ params ! and an
        //  introducer before | only where every byte came from unfiltered
        //  input; and no 0x01 / 0x02 from filtered input
        function checkInvariant(wire, unfiltered) {
            for (let i = 0; i < wire.length; ++i) {
                if (0x21 === wire[i]) {
                    let k = i - 1;
                    while (k >= 0 && isParam(wire[k])) {
                        --k;
                    }
                    if (k >= 1 && 0x5b === wire[k] && 0x1b === wire[k - 1]) {
                        if (!unfiltered.slice(k - 1, i + 1).every(Boolean)) {
                            return `ESC [ params ! with a filtered byte, ending at ${i}`;
                        }
                    }
                }
                if (0x7c === wire[i] && i > 0 && isIntroducer(wire[i - 1])) {
                    if (!unfiltered[i] || !unfiltered[i - 1]) {
                        return `introducer | with a filtered byte at ${i}`;
                    }
                }
                if ((0x01 === wire[i] || 0x02 === wire[i]) && !unfiltered[i]) {
                    return `filtered 0x0${wire[i]} at ${i}`;
                }
            }
            return null;
        }

        function runFuzz(seed) {
            const rand = prng(seed);
            const pick = list => list[Math.floor(rand() * list.length)];
            const randomBytes = () =>
                Buffer.from(
                    Array.from(
                        { length: rand() < 0.1 ? 0 : Math.floor(rand() * 12) },
                        () => pick(ALPHABET)
                    )
                );
            const paramRun = () =>
                Array.from({ length: MAX_HELD - 8 + Math.floor(rand() * 40) }, () =>
                    pick('0123456789;')
                ).join('');
            const filteredBytes = () => {
                const r = rand();
                if (r < 0.03) {
                    //  a long parameter run, around MAX_HELD
                    const head = rand() < 0.6 ? '\x1b[' : '';
                    return bytes(head + paramRun() + pick(['', '!', 'm', '\x1b']));
                }
                const b = randomBytes();
                return r < 0.25 ? Buffer.concat([b, bytes(pick(FILTERED_TAILS))]) : b;
            };
            const unfilteredBytes = () => {
                const r = rand();
                const b = randomBytes();
                if (r < 0.3) {
                    return Buffer.concat([bytes(pick(UNFILTERED_HEADS)), b]);
                }
                if (r < 0.45) {
                    return Buffer.concat([b, bytes(pick(UNFILTERED_TAILS))]);
                }
                return r < 0.55 ? bytes(pick(UNFILTERED_TAILS)) : b;
            };

            const timers = fakeTimers();
            try {
                for (let n = 0; n < CASES; ++n) {
                    const { term, sent } = ripSession();
                    const seen = instrument(term);
                    const segments = [];

                    const filtered = b =>
                        segments.push({ bytes: [...b], filtered: true });
                    const unfiltered = b =>
                        segments.push({ bytes: [...b], filtered: false });

                    //  slow drips under way, in the order their next piece is
                    //  due (the timer queue's order)
                    const drips = [];
                    const tick = () => {
                        const drip = drips.shift();
                        filtered(drip.bytes.slice(drip.offset, drip.offset + drip.size));
                        drip.offset += drip.size;
                        if (drip.offset < drip.bytes.length) {
                            drips.push(drip);
                        }
                        timers.tick();
                    };

                    const one = inBatch => {
                        const op = pick([
                            'raw',
                            'raw',
                            'string',
                            'drip',
                            'pass',
                            'rip',
                            'door',
                        ]);
                        const b =
                            'pass' === op || 'rip' === op
                                ? unfilteredBytes()
                                : filteredBytes();
                        switch (op) {
                            case 'raw':
                                term.rawWrite(b);
                                return filtered(b);
                            case 'string':
                                term.rawWrite(latin1(b));
                                return filtered(
                                    inBatch ? Buffer.from(latin1(b), 'utf8') : b
                                );
                            case 'drip': {
                                if (inBatch) {
                                    term.rawWrite(b);
                                    return filtered(b);
                                }
                                //  62.5 or 250 bytes a second: 1 or 4 a tick;
                                //  or all at once
                                const rate = pick([62.5, 250, 1e9]);
                                const size =
                                    62.5 === rate ? 1 : 250 === rate ? 4 : b.length;
                                term.dripWrite(b, rate, () => {});
                                if (0 === b.length) {
                                    return;
                                }
                                filtered(b.slice(0, size));
                                if (size < b.length) {
                                    drips.push({ bytes: b, offset: size, size });
                                }
                                return;
                            }
                            case 'pass':
                                term.passThroughWrite(b);
                                return unfiltered(b);
                            case 'rip':
                                term.writeUnfilteredRip(b);
                                return unfiltered(b);
                            case 'door': {
                                const text = Array.from({ length: 6 }, () =>
                                    pick(DOOR_TEXT)
                                ).join('');
                                term.writeDoorOutput(text);
                                return unfiltered(term.encode(text));
                            }
                        }
                    };

                    const steps = 1 + Math.floor(rand() * 8);
                    for (let s = 0; s < steps; ++s) {
                        if (rand() < 0.25) {
                            term.beginWrite();
                            const count = 1 + Math.floor(rand() * 5);
                            for (let c = 0; c < count; ++c) {
                                one(true);
                            }
                            term.commitWrite();
                        } else {
                            one(false);
                        }
                        while (drips.length > 0 && rand() < 0.5) {
                            tick();
                        }
                    }
                    while (drips.length > 0) {
                        tick();
                    }
                    assert.equal(timers.queue.length, 0);

                    const actual = sent();
                    const tag = `seed ${seed} case ${n}: ${JSON.stringify(
                        segments.map(g => [g.filtered ? 'F' : 'U', latin1(g.bytes)])
                    )} => ${JSON.stringify(actual)}`;

                    //  the filter saw the writes in the order they reached
                    //  the socket, and nothing reached it around the filter
                    assert.equal(latin1(seen.wire), actual, tag);
                    assert.deepEqual(seen.problems, [], tag);
                    //  the invariant, by provenance alone
                    assert.equal(checkInvariant(seen.wire, seen.unfiltered), null, tag);

                    //  and against the reference: the same wire, the same
                    //  provenance, and undoing the documented changes gives
                    //  back the input
                    const ref = referenceWire(segments);
                    assert.equal(actual, latin1(ref.wire), tag);
                    assert.deepEqual(
                        seen.unfiltered,
                        ref.fromFilter.map(f => !f),
                        tag
                    );
                    const wire = [...bytes(actual)];
                    for (const place of ref.placed) {
                        assert.equal(undoFiltered(wire, place), null, tag);
                    }
                }
            } finally {
                timers.restore();
            }
        }

        SEEDS.forEach(seed => {
            it(`seed 0x${seed.toString(16)}: ${CASES} cases, random streams, chunkings, drips and paths`, () =>
                runFuzz(seed));
        });

        it('the provenance check catches a filtered byte in a sequence', () => {
            const wire = [...bytes('a\x1b[1!b!|')];
            const all = wire.map(() => true);
            assert.equal(checkInvariant(wire, all), null);
            const one = all.slice();
            one[2] = false;
            assert.ok(checkInvariant(wire, one));
            const pipe = all.slice();
            pipe[6] = false;
            assert.ok(checkInvariant(wire, pipe));
        });
    });
});
