'use strict';

//
//  Terminal replies and keys split across two network reads (#942): the ANSI
//  input decoder holds an unfinished CSI (ESC [ and parameter bytes) at the
//  end of a chunk until the next chunk, or a short timer, decides it. A lone
//  ESC, ESC O and every complete key decode at once, as before.
//

const { strict: assert } = require('assert');

const AnsiInput = require('../core/term/ansi/input_decoder.js');
const Term = require('../core/term');
const { selectClientEmulation } = require('../core/term/select.js');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const toBuffer = data =>
    Buffer.isBuffer(data) ? Buffer.from(data) : Buffer.from(data, 'latin1');

//  An event as compared here: replies as reported, keys as [ch, name]
function normalise(name, args) {
    if ('key press' === name) {
        const [ch, key] = args;
        return [name, ch, key ? key.name : undefined];
    }
    return [name, ...args];
}

//  What the stateless decode() gives for |chunks|, each decoded on its own:
//  the decoder's output before #942
function decodedApart(...chunks) {
    const events = [];
    const host = { isNixTerm: () => false };
    for (const chunk of chunks) {
        AnsiInput.decode(toBuffer(chunk), host, (name, ...args) =>
            events.push(normalise(name, args))
        );
    }
    return events;
}

//  ... and for all of |chunks| as one chunk
const decodedWhole = (...chunks) => decodedApart(chunks.join(''));

//  A decoder for one connection, and the events it reports
function makeDecoder(options = {}) {
    const decoder = AnsiInput.createAnsiInputDecoder(options);
    const events = [];
    const reported = [];
    const host = {
        isNixTerm: () => false,
        reportError: err => reported.push(err.message),
    };
    const emit = (name, ...args) => events.push(normalise(name, args));
    const decode = data => decoder.decode(toBuffer(data), host, emit);
    const keys = () => events.filter(e => 'key press' === e[0]);
    return { decoder, events, reported, host, decode, keys };
}

//  How many timers |fn| starts
function timersStartedBy(fn) {
    const original = global.setTimeout;
    let started = 0;
    global.setTimeout = (...args) => {
        ++started;
        return original(...args);
    };
    try {
        fn();
    } finally {
        global.setTimeout = original;
    }
    return started;
}

//  Every way to cut |text| into |pieces| pieces, each cut at |from| or later
function splits(text, pieces, from = 1) {
    if (1 === pieces) {
        return [[text]];
    }
    const out = [];
    for (let at = from; at <= text.length - (pieces - 1); ++at) {
        for (const rest of splits(text.slice(at), pieces - 1, 1)) {
            out.push([text.slice(0, at), ...rest]);
        }
    }
    return out;
}

const REPLIES = {
    CPR: '\x1b[24;80R',
    'DA (VT class: ConnectBot)': '\x1b[?63;1;2c',
    'DA (CTerm)': '\x1b[=67;84;101;114;109;1;315c',
    'CTerm capability': '\x1b[=6;1n',
    CTDA: '\x1b[<0;1;2;3;5c',
    'CTDA, the older n form': '\x1b[<0;1;2;3;5n',
    "CTDA, IcyTerm's form without the 0": '\x1b[<1;2;3;4;5;6;7c',
};

const CTDA_REPLIES = [REPLIES.CTDA, REPLIES['CTDA, the older n form']];

describe('ANSI input split across reads (#942)', () => {
    describe('replies', () => {
        for (const [name, reply] of Object.entries(REPLIES)) {
            it(`${name}: one reply and no key at every split after the ESC`, () => {
                const whole = decodedWhole(reply);
                assert.equal(whole.length, 1, 'the reply decodes when whole');
                assert.notEqual(whole[0][0], 'key press');

                for (const chunks of splits(reply, 2, 2)) {
                    const d = makeDecoder();
                    chunks.forEach(d.decode);
                    assert.deepEqual(d.events, whole, JSON.stringify(chunks));
                }
            });

            it(`${name}: split right after the ESC, decodes as before`, () => {
                const d = makeDecoder();
                d.decode(reply.slice(0, 1));
                d.decode(reply.slice(1));
                assert.deepEqual(
                    d.events,
                    decodedApart(reply.slice(0, 1), reply.slice(1))
                );
            });
        }

        it('CTDA in three pieces, at every pair of splits after the ESC', () => {
            for (const reply of CTDA_REPLIES) {
                const whole = decodedWhole(reply);
                for (const chunks of splits(reply, 3, 2)) {
                    const d = makeDecoder();
                    chunks.forEach(d.decode);
                    assert.deepEqual(d.events, whole, JSON.stringify(chunks));
                }
            }
        });

        it("the ticket's case: CTDA split, then a CPR, gives both and no keys", () => {
            const d = makeDecoder();
            d.decode('\x1b[<0;1;2');
            d.decode(';3;5c\x1b[1;1R');
            assert.deepEqual(
                d.events.map(e => e[0]),
                ['cterm device attributes', 'cursor position report']
            );
            assert.deepEqual(d.events[0][1].ctda, [1, 2, 3, 5]);
            assert.deepEqual(d.events[1][1], [1, 1]);
        });

        it('keys typed ahead of a split reply come out at once, in order', () => {
            const d = makeDecoder();
            d.decode('ab\x1b[24;');
            assert.deepEqual(d.events, decodedApart('ab'));
            d.decode('80Rc');
            assert.deepEqual(d.events, decodedWhole('ab\x1b[24;80Rc'));
        });
    });

    describe('keys', () => {
        const KEYS = {
            'up arrow': '\x1b[A',
            'page up': '\x1b[5~',
            'ctrl + right arrow': '\x1b[1;5C',
            f12: '\x1b[24~',
            'shift + tab': '\x1b[Z',
        };

        for (const [name, seq] of Object.entries(KEYS)) {
            it(`${name}: decodes whole at every split after the ESC`, () => {
                const whole = decodedWhole(seq);
                assert.equal(whole.length, 1);
                for (const chunks of splits(seq, 2, 2)) {
                    const d = makeDecoder();
                    chunks.forEach(d.decode);
                    assert.deepEqual(d.events, whole, JSON.stringify(chunks));
                }
            });

            it(`${name}: whole, decodes at once with no timer`, () => {
                const d = makeDecoder();
                assert.equal(
                    timersStartedBy(() => d.decode(seq)),
                    0
                );
                assert.deepEqual(d.events, decodedWhole(seq));
            });

            it(`${name}: split right after the ESC, decodes as before`, () => {
                const d = makeDecoder();
                d.decode(seq.slice(0, 1));
                d.decode(seq.slice(1));
                assert.deepEqual(d.events, decodedApart(seq.slice(0, 1), seq.slice(1)));
            });
        }

        //  none of these ends in an unfinished CSI: nothing may be held
        const AT_ONCE = {
            'a lone ESC (Escape)': '\x1b',
            'ESC ESC': '\x1b\x1b',
            'ESC x (an Alt key)': '\x1bx',
            'ESC O': '\x1bO',
            'ESC O A': '\x1bOA',
            'ESC [ [ (the start of a Cygwin f-key)': '\x1b[[',
            'a letter': 'a',
            return: '\r',
            'a byte above 0x7F on its own (a meta key)': '\xe1',
            typing: 'hello\r',
        };

        for (const [name, seq] of Object.entries(AT_ONCE)) {
            it(`${name}: decoded inside the same call, with no timer`, () => {
                const d = makeDecoder();
                assert.equal(
                    timersStartedBy(() => d.decode(seq)),
                    0
                );
                assert.deepEqual(d.events, decodedWhole(seq));
            });
        }

        it('a lone ESC is the Escape key, and what follows it is not joined to it', () => {
            const d = makeDecoder();
            d.decode('\x1b');
            assert.deepEqual(d.events, [['key press', '\x1b', 'escape']]);
            d.decode('x');
            assert.deepEqual(d.events, decodedApart('\x1b', 'x'));
        });

        it('ESC ESC [ split after the [ keeps the meta of the whole', () => {
            const d = makeDecoder();
            d.decode('\x1b\x1b[');
            d.decode('A');
            assert.deepEqual(d.events, decodedWhole('\x1b\x1b[A'));
        });
    });

    describe('held bytes and the chunk after them', () => {
        it('a chunk that cannot carry the sequence on: held bytes alone, then the chunk', () => {
            for (const next of ['\x1b[A', '\x1b', '\r', '\x7f', '\xe1', '\xe1\xe2']) {
                const d = makeDecoder();
                d.decode('\x1b[12');
                d.decode(next);
                assert.deepEqual(
                    d.events,
                    decodedApart('\x1b[12', next),
                    JSON.stringify(next)
                );
            }
        });

        it('a lone byte above 0x7F after held bytes is still a meta key', () => {
            const d = makeDecoder();
            d.decode('\x1b[');
            d.decode('\xe1');
            assert.deepEqual(d.events, [['key press', undefined, 'meta + a']]);
        });

        it('a byte above 0x7F ahead of the tail is not made a meta key', () => {
            const d = makeDecoder();
            d.decode('\xe1\x1b[');
            d.decode('24;80R');
            assert.deepEqual(d.events, decodedApart('\xe1\x1b[', '24;80R'));
        });

        it('a chunk that ends in a new unfinished CSI is held in its turn', () => {
            const d = makeDecoder();
            d.decode('\x1b[24;');
            d.decode('80R\x1b[1;');
            assert.deepEqual(d.events, [['cursor position report', [24, 80]]]);
            d.decode('1R');
            assert.deepEqual(d.events, [
                ['cursor position report', [24, 80]],
                ['cursor position report', [1, 1]],
            ]);
        });

        it('an SGR mouse report split after the [ is dropped like a whole one', () => {
            const d = makeDecoder();
            d.decode('\x1b[<0;10;');
            d.decode('5M');
            assert.deepEqual(d.events, []);
        });
    });

    describe('the hold timer', () => {
        it('lets held bytes go on their own after holdMs: the output from before', async () => {
            const d = makeDecoder({ csiHoldMs: 5 });
            assert.equal(
                timersStartedBy(() => d.decode('\x1b[12')),
                1
            );
            assert.deepEqual(d.events, []);
            await sleep(30);
            assert.deepEqual(d.events, decodedWhole('\x1b[12'));
            assert.deepEqual(
                d.keys().map(e => e[1]),
                ['1', '2']
            );
        });

        it('is 100 ms by default', () => {
            assert.equal(AnsiInput.DEFAULT_CSI_HOLD_MS, 100);
        });

        it('a key handler that throws from the timer reaches host.reportError', async () => {
            const decoder = AnsiInput.createAnsiInputDecoder({ csiHoldMs: 5 });
            const reported = [];
            const host = {
                isNixTerm: () => false,
                reportError: err => reported.push(err.message),
            };
            let calls = 0;
            decoder.decode(Buffer.from('\x1b[12', 'latin1'), host, () => {
                ++calls;
                throw new Error('menu threw');
            });
            assert.equal(calls, 0);
            await sleep(30);
            assert.equal(calls, 1); //  the first key threw; the rest of that decode stops
            assert.deepEqual(reported, ['menu threw']);
        });

        it('dispose() while holding: nothing is emitted, ever', async () => {
            const d = makeDecoder({ csiHoldMs: 5 });
            d.decode('\x1b[24;8');
            d.decoder.dispose();
            await sleep(30);
            assert.deepEqual(d.events, []);
        });

        it('after dispose() nothing is held and no timer is started', () => {
            const d = makeDecoder();
            d.decoder.dispose();
            assert.equal(
                timersStartedBy(() => d.decode('\x1b[24;8')),
                0
            );
            assert.deepEqual(d.events, decodedWhole('\x1b[24;8'));
        });
    });

    describe('the cap', () => {
        it(`a tail of ${AnsiInput.MAX_HELD_CSI_BYTES} bytes is held`, () => {
            const tail = '\x1b[' + '1'.repeat(AnsiInput.MAX_HELD_CSI_BYTES - 2);
            const d = makeDecoder();
            assert.equal(
                timersStartedBy(() => d.decode(tail)),
                1
            );
            assert.deepEqual(d.events, []);
            d.decoder.dispose();
        });

        it('a longer tail is decoded at once, not held', () => {
            const tail = '\x1b[' + '1'.repeat(68);
            const d = makeDecoder();
            assert.equal(
                timersStartedBy(() => d.decode(tail)),
                0
            );
            assert.deepEqual(d.events, decodedWhole(tail));
            assert.equal(d.keys().length, 68);
        });

        it('a held tail that grows past the cap is let go', () => {
            const d = makeDecoder();
            d.decode('\x1b[' + '1'.repeat(40));
            assert.deepEqual(d.events, []);
            assert.equal(
                timersStartedBy(() => d.decode('2'.repeat(40))),
                0
            );
            assert.equal(d.keys().length, 80);
        });
    });

    describe('with the RIPscrip reply scanner', () => {
        it('a split RIP reply and a split CPR after it come out whole, in order', () => {
            const d = makeDecoder();
            d.decoder.expectRipReply();
            d.decode('RIPSCR');
            d.decode('IP015410\x1b[24;');
            d.decode('80R');
            assert.deepEqual(d.events, [
                ['rip version', 'RIPSCRIP015410'],
                ['cursor position report', [24, 80]],
            ]);
        });

        it('a split CPR and a split RIP reply after it come out whole, in order', () => {
            const d = makeDecoder();
            d.decoder.expectRipReply();
            d.decode('\x1b[24;');
            d.decode('80RRIPSCRIP01');
            d.decode('5410');
            assert.deepEqual(d.events, [
                ['cursor position report', [24, 80]],
                ['rip version', 'RIPSCRIP015410'],
            ]);
        });

        it('both holding at once let go in stream order', async () => {
            const d = makeDecoder({ csiHoldMs: 5, ripReply: { holdMs: 15 } });
            d.decoder.expectRipReply();
            d.decode('a\x1b[1');
            d.decode('2;3RIPS');
            assert.deepEqual(d.events, decodedApart('a'));
            await sleep(40);
            assert.deepEqual(d.events, decodedApart('a', '\x1b[12;3', 'RIPS'));
        });
    });

    describe('emulations', () => {
        it('switching away from ANSI at ready drops held bytes', async () => {
            const emulation = Term.createEmulation('ansi');
            const client = {
                term: { termType: 'unknown', emulation },
                log: { info() {}, debug() {}, warn() {} },
            };
            const events = [];
            emulation.inputDecoder.decode(
                Buffer.from('\x1b[24;8', 'latin1'),
                { isNixTerm: () => false },
                (name, ...args) => events.push(normalise(name, args))
            );

            selectClientEmulation(client, {
                listener: { name: 'c64', emulation: 'petscii' },
            });
            assert.equal(client.term.emulation.name, 'petscii');

            await sleep(AnsiInput.DEFAULT_CSI_HOLD_MS + 50);
            assert.deepEqual(events, []);
        });

        it("the shared fallback emulation's decoder holds nothing", () => {
            const decoder = Term.emulationOf(undefined).inputDecoder;
            const events = [];
            const started = timersStartedBy(() =>
                decoder.decode(
                    Buffer.from('\x1b[24;8', 'latin1'),
                    { isNixTerm: () => false },
                    (name, ...args) => events.push(normalise(name, args))
                )
            );
            assert.equal(started, 0);
            assert.deepEqual(events, decodedWhole('\x1b[24;8'));
        });
    });
});
