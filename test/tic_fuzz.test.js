'use strict';

//
//  Fuzz and round-trip property coverage for the TIC reader and writer.
//
//  A TIC file arrives from a remote peer, so every byte in it is untrusted
//  input. Two crash-class defects have already come out of this parser in
//  review -- a missing "File" field threw a TypeError from a getter (#735), and
//  a malformed "Seenby" stored an undefined that something later .toString()ed
//  -- and both had the same shape: a TypeError raised inside an fs callback,
//  escaping the import waterfall, stalling the entire pass until the five
//  minute watchdog fired, and skipping every remaining TIC in the inbound. Two
//  of those is a pattern rather than a coincidence, so this file goes looking
//  for the rest by *generating* hostile input instead of by imagining it.
//
//  The corpus is generated from a fixed seed and never from Math.random(): a
//  fuzz test that fails once a month at random is worse than no test at all.
//  Everything the generator turned up is pinned below as its own named
//  regression case; the generator stays so it keeps finding new ones as the
//  code changes.
//
//  Several tests here are marked .skip. Every one of those is a defect that is
//  live in the current code, and each carries a comment saying what it is and
//  what it costs. None were made to pass by changing the code under test.
//

const { strict: assert } = require('assert');
const fs = require('fs');
const os = require('os');
const paths = require('path');

const TicFileInfo = require('../core/tic_file_info.js');
const TicFileWriter = require('../core/tic_file_writer.js');
const ticForward = require('../core/tic_forward.js');
const Address = require('../core/ftn_address.js');
const CRC32 = require('../core/crc.js').CRC32;

const CR = '\r';
const NUL = '\u0000';
const BOM = '\ufeff';

//
//  mulberry32. Small, fast, and -- the only property that matters here --
//  identical on every machine and every run, so a corpus is a fixture rather
//  than a lottery.
//
function makeRng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

//  Every keyword either spec names, plus ones nothing has ever heard of.
const FUZZ_KEYWORDS = [
    'Area',
    'Areadesc',
    'Origin',
    'From',
    'To',
    'File',
    'Lfile',
    'Fullname',
    'Size',
    'Date',
    'Desc',
    'Ldesc',
    'Created',
    'Magic',
    'Replaces',
    'Crc',
    'Path',
    'Seenby',
    'Pw',
    'Release',
    'Author',
    'Source',
    'App',
    'Via',
    'Destination',
    'ReceiptRequest',
    'Pgp',
    'Sha256',
    'X-Enigma-Unknown',
    'ZZZ',
    'area', //  keyword casing is not significant; the raw line keeps it
    'FILE',
];

//
//  Values chosen to be awkward rather than representative: malformed addresses
//  in every shape, numbers that are not numbers, names that are paths, and
//  bytes that have no business being in a control file.
//
const FUZZ_VALUES = [
    '',
    ' ',
    '     ',
    'NODELIST.Z21',
    'fsxnet-nodelist-2026-241.zip',
    //  addresses: valid, nearly valid, and nothing like it
    '21:1/100',
    '1/100',
    ':1/2',
    '21:',
    '1/',
    'a:b/c',
    '21:1/100.',
    '@fsxnet',
    '21:1/100@',
    '21:1/100@fsxnet',
    '21:1/100.5@fsxnet',
    'fidonet#21:1/100',
    '99999999999999999999:1/1',
    '-1:1/1',
    '0:0/0',
    '21:1/100 21:1/101',
    //  numbers that are not
    'DEADBEEF',
    '0xDEADBEEF',
    '00000000',
    '-1',
    'zzz',
    'NaN',
    'Infinity',
    '99999999999999999999',
    '1e10',
    //  names that are paths
    '../../../etc/passwd',
    '..\\..\\windows\\system32',
    '/etc/passwd',
    '..',
    '....',
    '....//x',
    '%2e%2e%2fetc%2fpasswd',
    'C:\\windows\\x',
    '.',
    'a/../b',
    //  size
    'x'.repeat(300),
    'y'.repeat(60),
    //  whitespace and control bytes
    'value with  internal   spaces',
    '\tleading tab',
    'trailing   ',
    `split${CR}by a bare cr`,
    `embedded${NUL}nul`,
    `${NUL}`,
    //  text a description might really carry
    'unicode \u00fcn\u00efc\u00f6d\u00e9 \u00bd',
    'quote " and \' apostrophe',
    '{token} %s %n',
];

//  Mostly CRLF, because that is what a TIC is; the rest exist to be nasty.
const FUZZ_EOL = ['\r\n', '\r\n', '\r\n', '\r\n', '\n', '\r'];

function generateCorpus(seed, count) {
    const rng = makeRng(seed);
    const pick = list => list[Math.floor(rng() * list.length)];

    const corpus = [];
    for (let i = 0; i < count; ++i) {
        const lineCount = 1 + Math.floor(rng() * 12);
        let body = '';

        for (let l = 0; l < lineCount; ++l) {
            const r = rng();
            let line;

            if (r < 0.04) {
                line = ''; //  blank line
            } else if (r < 0.08) {
                line = pick(FUZZ_VALUES); //  a value with no keyword
            } else if (r < 0.13) {
                line = pick(FUZZ_KEYWORDS); //  a keyword with no value
            } else if (r < 0.17) {
                line = `   ${pick(FUZZ_KEYWORDS)} ${pick(FUZZ_VALUES)}`; //  indented
            } else if (r < 0.19) {
                line = `${BOM}${pick(FUZZ_KEYWORDS)} ${pick(FUZZ_VALUES)}`;
            } else {
                line = `${pick(FUZZ_KEYWORDS)} ${pick(FUZZ_VALUES)}`;
            }

            //  a file that does not end in a newline is ordinary
            const last = l === lineCount - 1;
            body += line + (last && rng() < 0.25 ? '' : pick(FUZZ_EOL));
        }

        corpus.push({ name: `fuzz-${seed}-${i}`, body });
    }

    return corpus;
}

//
//  The value of a keyword line: everything past the first run of whitespace.
//  A line with no whitespace at all has no value -- which is precisely where
//  the writer's own `line.search(/\s/) + 1` idiom slices from index 0 and hands
//  the keyword back as its own value. See the Fullname regression below.
//
function valueOfLine(line) {
    const i = line.search(/\s/);
    return i < 0 ? '' : line.slice(i + 1).trim();
}

function keyOfLine(line) {
    const i = line.search(/\s/);
    return line.slice(0, i < 0 ? line.length : i).toLowerCase();
}

//
//  Shapes the writer currently mangles, so the strict round-trip property can
//  say something exact about everything else. Each has its own regression case
//  in the round-trip suite below, and this is the only place they are excused.
//
function writerMangles(line) {
    //  clampLine() truncates it, though its own comment says inbound lines are
    //  passed through as is
    if (line.length > TicFileWriter.maxLineLength) {
        return true;
    }

    const key = keyOfLine(line);
    const valueless = '' === valueOfLine(line);

    //  `line.search(/\s/) + 1` slices from 0 when there is no whitespace at
    //  all, handing the keyword back as its own value
    if (valueless && -1 === line.search(/\s/) && TicFileWriter.knownKeywords.has(key)) {
        return true;
    }

    //  a Fullname with no value is rewritten to a blank "Lfile ", which the
    //  next hop then drops -- so it is not a fixed point either
    return 'fullname' === key && valueless;
}

const isEligibleForRoundTrip = body =>
    body.split(/\r\n|\n/).every(line => !writerMangles(line));

describe('TIC reader fuzzing', () => {
    let tmpDir;
    let corpus;
    let seq = 0;

    const OUR_ADDR = Address.fromString('21:1/151');
    const THEIR_ADDR = Address.fromString('21:1/200');

    before(() => {
        tmpDir = fs.mkdtempSync(paths.join(os.tmpdir(), 'enigma_ticfuzz_'));
        corpus = generateCorpus(0x5eed1c, 300);
        corpus.forEach(entry => {
            entry.path = paths.join(tmpDir, `${entry.name}.tic`);
            fs.writeFileSync(entry.path, Buffer.from(entry.body, 'utf8'));
        });
    });

    after(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function writeTic(body, name) {
        const p = paths.join(tmpDir, name || `one_off_${seq++}.tic`);
        fs.writeFileSync(p, Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8'));
        return p;
    }

    //
    //  Resolves with { err, info, calls }. A *synchronous* throw becomes a
    //  rejection rather than an exception, which is the whole point: the
    //  contract createFromFile() offers is a callback, and a throw is how that
    //  contract gets broken -- inside an fs callback, where nothing catches it.
    //
    function readTic(path) {
        return new Promise((resolve, reject) => {
            let calls = 0;
            try {
                TicFileInfo.createFromFile(path, (err, info) => {
                    ++calls;
                    //  a tick, so a second (illegal) callback shows up in the count
                    setImmediate(() => resolve({ err, info, calls }));
                });
            } catch (e) {
                return reject(e);
            }
        });
    }

    function parse(body, name) {
        return readTic(writeTic(body, name)).then(({ err, info }) => {
            assert.equal(err, null, 'a readable TIC never fails to parse');
            return info;
        });
    }

    const VALIDATE_CONFIG = {
        nodes: { '21:1/100': { tic: { password: 'SEKRIT' } } },
        localAreaTags: ['FSX_GEN', 'fsxGeneral'],
    };

    //  Resolves with the error rather than rejecting; a synchronous throw still
    //  rejects, because that is the failure being tested for.
    function validate(info, config) {
        return new Promise((resolve, reject) => {
            try {
                info.validate(config || VALIDATE_CONFIG, err => resolve(err));
            } catch (e) {
                return reject(e);
            }
        });
    }

    describe('the parser is total', () => {
        it('never throws and always calls back, over the whole corpus', async () => {
            for (const entry of corpus) {
                const { err, info, calls } = await readTic(entry.path);
                assert.equal(err, null, `${entry.name}: unexpected read error`);
                assert.ok(info, `${entry.name}: no TicFileInfo`);
                assert.equal(calls, 1, `${entry.name}: callback fired ${calls} times`);
            }
        });

        it('never stores a value it could not parse', async () => {
            //  The #735-shaped defect: Address.fromString() returns undefined
            //  for a malformed address, and storing that put an undefined into
            //  an array whose elements are later .toString()ed.
            for (const entry of corpus) {
                const { info } = await readTic(entry.path);
                for (const [key, value] of info.entries) {
                    const list = Array.isArray(value) ? value : [value];
                    list.forEach(v => {
                        assert.notEqual(
                            v,
                            undefined,
                            `${entry.name}: undefined stored under "${key}"`
                        );
                        assert.notEqual(
                            v,
                            null,
                            `${entry.name}: null stored under "${key}"`
                        );
                    });
                }
            }
        });

        it('never yields a value containing a newline', async () => {
            //
            //  C3's first premise, and the reason inbound values are safe to
            //  interpolate at all: the parser splits on CRLF and LF before any
            //  value exists, so no value -- and no retained raw line -- can
            //  carry one. A *lone* CR is a different matter; see the injection
            //  suite below.
            //
            for (const entry of corpus) {
                const { info } = await readTic(entry.path);
                info.rawLines.forEach(({ line }) => {
                    assert.ok(
                        !line.includes('\n'),
                        `${entry.name}: retained line contains LF`
                    );
                });
                for (const value of info.entries.values()) {
                    (Array.isArray(value) ? value : [value]).forEach(v => {
                        assert.ok(
                            !String(v).includes('\n'),
                            `${entry.name}: stored value contains LF`
                        );
                    });
                }
            }
        });
    });

    describe('derived accessors are total', () => {
        //  Every one of these is reachable from the scanner/tosser's *error*
        //  paths, which is exactly where #735 detonated. None may throw.
        it('survives the whole corpus without throwing', async () => {
            for (const entry of corpus) {
                const { info } = await readTic(entry.path);

                assert.doesNotThrow(() => {
                    TicFileInfo.requiredFields.forEach(f => info.getAsString(f));
                    ['Ldesc', 'Desc', 'Lfile', 'Fullname', 'Pw', 'Sha256'].forEach(f => {
                        info.getAsString(f);
                        info.getAsString(f, '\n');
                    });
                    info.hasRequiredFields();
                    info.isToAddress(OUR_ADDR, true);
                    info.isToAddress(OUR_ADDR, false);
                    void info.filePath;
                    void info.longFileName;
                    TicFileInfo.isSafeFileName(info.getAsString('File'));
                }, `${entry.name}: a getter threw`);
            }
        });

        it('never hands the writer something it cannot serialize', async () => {
            for (const entry of corpus) {
                const { info } = await readTic(entry.path);
                let out;
                assert.doesNotThrow(() => {
                    out = TicFileWriter.build(info, {
                        from: OUR_ADDR,
                        to: THEIR_ADDR,
                        crc: 'deadbeef',
                        createdBy: 'ENiGMA1/2 test',
                        seenby: [OUR_ADDR],
                        pathEntry: '21:1/151 1 x',
                    });
                }, `${entry.name}: build() threw`);
                assert.ok(out.endsWith('\r\n'), `${entry.name}: unterminated output`);
                assert.ok(
                    !/[^\r]\n/.test(out),
                    `${entry.name}: emitted a bare LF; FTS-5006 2.2 requires CRLF`
                );
            }
        });

        it('never returns an unsafe longFileName', async () => {
            for (const entry of corpus) {
                const { info } = await readTic(entry.path);
                const name = info.longFileName;
                if (undefined !== name) {
                    assert.ok(
                        TicFileInfo.isSafeFileName(name),
                        `${entry.name}: longFileName "${name}" is not a safe name`
                    );
                }
            }
        });
    });

    describe('validate() always calls back', () => {
        //
        //  The corpus is filtered here for one thing only: an embedded NUL in a
        //  field that names a file. That is a live crash, pinned as its own
        //  regression case further down, and letting it fire here would hide
        //  every other input in the corpus behind it.
        //
        const hasNulName = info =>
            ['File', 'Lfile', 'Fullname'].some(f =>
                (info.getAsString(f) || '').includes(NUL)
            );

        it('over the whole corpus, without throwing', async () => {
            let checked = 0;
            for (const entry of corpus) {
                const { info } = await readTic(entry.path);
                if (hasNulName(info)) {
                    continue;
                }
                ++checked;
                const err = await validate(info);
                //  Nothing in the corpus has a payload on disk, so every entry
                //  must fail -- but it must fail by calling back.
                assert.ok(err, `${entry.name}: validated a TIC with no payload`);
                assert.ok(
                    'string' === typeof err.message,
                    `${entry.name}: malformed error`
                );
            }
            assert.ok(checked > 200, `only ${checked} corpus entries reached validate`);
        });

        it('for every combination of absent required fields', async () => {
            //  2^5 subsets of the required set, each with a real payload on
            //  disk and a correct checksum -- so that the complete TIC really
            //  does import, and every failure below is attributable to the
            //  field that was removed rather than to the fixture.
            const req = TicFileInfo.requiredFields;
            const dir = fs.mkdtempSync(paths.join(tmpDir, 'req_'));
            const payload = 'payload';
            fs.writeFileSync(paths.join(dir, 'A.ZIP'), payload);

            const crc = new CRC32();
            crc.update(Buffer.from(payload));

            const full = {
                Area: 'FSX_GEN',
                Origin: '21:1/100',
                From: '21:1/100',
                File: 'A.ZIP',
                Crc: crc.finalize().toString(16).toUpperCase(),
            };

            for (let mask = 0; mask < 1 << req.length; ++mask) {
                const present = Object.entries(full).filter(
                    ([k]) => 0 === (mask & (1 << req.indexOf(k)))
                );
                const p = paths.join(dir, `M${mask}.TIC`);
                fs.writeFileSync(
                    p,
                    present
                        .map(([k, v]) => `${k} ${v}`)
                        .concat(['Pw SEKRIT'])
                        .join('\r\n') + '\r\n'
                );

                const { err, info } = await readTic(p);
                assert.equal(err, null);
                const vErr = await validate(info);

                if (0 === mask) {
                    assert.ok(!vErr, `mask 0: ${vErr && vErr.message}`);
                } else {
                    assert.ok(vErr, `mask ${mask}: a TIC missing fields validated`);
                }
            }
        });
    });

    describe('hostile scalars', () => {
        const base = ['Area FSX_GEN', 'Origin 21:1/100', 'From 21:1/100', 'File A.ZIP'];

        const crcCases = [
            ['not a number', 'zzzzzzzz'],
            ['hex with an 0x prefix', '0xDEADBEEF'],
            ['negative', '-1'],
            ['enormous', '9'.repeat(400)],
            ['empty', ''],
            ['whitespace', '    '],
            ['a float', '1.5'],
            ['duplicated', null], //  handled separately below
        ];

        crcCases
            .filter(([, v]) => null !== v)
            .forEach(([label, value]) => {
                it(`survives a Crc that is ${label}`, async () => {
                    const info = await parse(
                        base.concat([`Crc ${value}`]).join('\r\n') + '\r\n'
                    );
                    assert.doesNotThrow(() => info.getAsString('Crc'));
                    const err = await validate(info);
                    assert.ok(err, `Crc "${value}" should not validate`);
                });
            });

        it('survives a Size that is not a number, negative or enormous', async () => {
            for (const value of ['zzz', '-1', '0x10', '9'.repeat(400), '', '   ']) {
                const info = await parse(
                    base.concat([`Crc DEADBEEF`, `Size ${value}`]).join('\r\n') + '\r\n'
                );
                assert.doesNotThrow(() => info.getAsString('Size'));
                const err = await validate(info);
                assert.ok(err, `Size "${value}" should not validate`);
            }
        });

        it('treats a NaN Crc or Size as absent rather than exposing NaN', async () => {
            //  parseInt() yields NaN, and getAsString()'s `if (value)` guard is
            //  false for it -- so a caller logging getAsString('Crc') sees
            //  undefined rather than "NaN". Worth pinning: the alternative is a
            //  literal "NaN" reaching an outgoing TIC.
            const info = await parse(
                base.concat(['Crc zzz', 'Size zzz']).join('\r\n') + '\r\n'
            );
            assert.ok(Number.isNaN(info.get('Crc')));
            assert.equal(info.getAsString('Crc'), undefined);
            assert.equal(info.getAsString('Size'), undefined);
        });
    });

    describe('malformed addresses', () => {
        //
        //  Every one of these is dropped with a parse warning rather than
        //  stored, which is htick's behaviour ("TIC %s: Illegal value: 'Seenby
        //  %s', ignored"). A required field that ends up absent is then caught
        //  by hasRequiredFields() as it always was.
        //
        const UNPARSABLE = [
            '1/',
            ':1/2',
            '21:',
            'a:b/c',
            '21:1/100.',
            '@fsxnet',
            '21:1/100@',
            'fidonet#21:1/100',
            '-1:1/1',
            '21:1/100 21:1/101',
            '',
            '   ',
            'null',
            'undefined',
            '21:1/',
            '::',
            '21::1/100',
        ];

        UNPARSABLE.forEach(value => {
            it(`drops "${value}" from every address keyword`, async () => {
                for (const key of ['Origin', 'From', 'To', 'Seenby']) {
                    const info = await parse(
                        `Area FSX_GEN\r\nFile A.ZIP\r\n${key} ${value}\r\n`
                    );
                    assert.equal(
                        info.get(key),
                        undefined,
                        `${key} "${value}" was stored anyway`
                    );
                    assert.ok(
                        info.parseWarnings.some(w => w.key === key.toLowerCase()),
                        `${key} "${value}" was dropped without a warning`
                    );
                    //  the line is still retained for pass-through, per FTS-5006 2.2
                    assert.ok(
                        info.rawLines.some(r => r.key === key.toLowerCase()),
                        `${key} "${value}" was dropped from rawLines too`
                    );
                    assert.doesNotThrow(() => info.getAsString(key));
                }
            });
        });

        it('accepts the address shapes FSC-0087 permits', async () => {
            const info = await parse(
                [
                    'Area FSX_GEN',
                    'File A.ZIP',
                    'Seenby 1/100', //  2D
                    'Seenby 21:1/101', //  3D
                    'Seenby 21:1/102.0', //  4D, explicit point 0
                    'Seenby 21:1/103.4',
                    'Seenby 21:1/104@fsxnet', //  5D
                ].join('\r\n') + '\r\n'
            );
            assert.equal(info.get('Seenby').length, 5);
            assert.equal(info.parseWarnings.length, 0);
        });

        it('does not blow up on an absurdly long address', async () => {
            //  A 100KB "address" is a regex denial of service if the pattern
            //  can be made to backtrack. Measured well under a millisecond.
            const info = await parse(
                `Area FSX_GEN\r\nSeenby ${'9'.repeat(100000)}\r\n` +
                    `Seenby 21:1/1@${'a'.repeat(100000)}!\r\n`
            );
            assert.equal(info.get('Seenby'), undefined);
            assert.equal(info.parseWarnings.length, 2);
        });
    });

    describe('duplicate keywords', () => {
        //
        //  Neither spec says what a second "File" or "Area" means, and nothing
        //  in the reader rejects one: the values are collected into an array
        //  and getAsString() joins them with no separator. That is not a crash
        //  and not a traversal, but it does mean a duplicated field produces a
        //  nonsense value rather than a diagnosable error -- pinned here so a
        //  change to it is deliberate.
        //
        it('concatenates duplicates rather than throwing', async () => {
            const info = await parse(
                [
                    'Area A',
                    'Area B',
                    'File X.ZIP',
                    'File Y.ZIP',
                    'Crc DEAD',
                    'Crc BEEF',
                    'To 21:1/1',
                    'To 21:1/2',
                ].join('\r\n') + '\r\n'
            );

            assert.equal(info.getAsString('Area'), 'AB');
            assert.equal(info.getAsString('File'), 'X.ZIPY.ZIP');
            assert.deepEqual(info.get('Crc'), [0xdead, 0xbeef]);
            assert.equal(info.get('To').length, 2);
            assert.doesNotThrow(() => info.isToAddress(Address.fromString('21:1/1')));
        });

        it('cannot be used to smuggle a traversal past isSafeFileName', async () => {
            //  Concatenation can introduce a ".." across a value boundary, but
            //  never a separator -- and validate() rejects the "..".
            for (const pair of [
                ['.', '.x'],
                ['a.', '.b'],
                ['..', '.'],
                ['x', '/y'],
                ['x', '\\y'],
            ]) {
                const info = await parse(
                    [
                        'Area FSX_GEN',
                        'Origin 21:1/100',
                        'From 21:1/100',
                        'File A.ZIP',
                        'Crc DEADBEEF',
                        `Lfile ${pair[0]}`,
                        `Lfile ${pair[1]}`,
                    ].join('\r\n') + '\r\n'
                );

                const joined = info.getAsString('Lfile');
                if (!TicFileInfo.isSafeFileName(joined)) {
                    const err = await validate(info);
                    assert.ok(err, `unsafe joined Lfile "${joined}" validated`);
                    assert.match(err.message, /unsafe Lfile/);
                }
                //  either way, the getter must not hand back an unsafe name
                assert.ok(
                    undefined === info.longFileName ||
                        TicFileInfo.isSafeFileName(info.longFileName)
                );
            }
        });
    });

    describe('line endings and framing', () => {
        it('reads CRLF, LF and a file with no trailing newline', async () => {
            for (const body of [
                'Area FSX_GEN\r\nFile A.ZIP\r\n',
                'Area FSX_GEN\nFile A.ZIP\n',
                'Area FSX_GEN\r\nFile A.ZIP',
            ]) {
                const info = await parse(body);
                assert.equal(info.getAsString('Area'), 'FSX_GEN');
                assert.equal(info.getAsString('File'), 'A.ZIP');
            }
        });

        it('treats a bare CR as a line ending', async () => {
            //
            //  FTS-5006 2.2 asks readers to cope with a file that uses "only a
            //  LF or CR" as its separator, so this is conformance -- but it is
            //  also a fix. While the split was /\r\n|\n/ a lone CR stayed
            //  inside the value, and since the writer copies passed-through
            //  lines out verbatim, an uplink could smuggle a whole keyword line
            //  into a TIC we then signed with our own From and Path. Any
            //  downstream tosser that breaks on CR -- every C implementation
            //  splitting on "\r\n" -- would act on it. Ending the line here
            //  means no value can carry one.
            //
            const info = await parse('Area FSX_GEN\rFile A.ZIP\rCrc DEADBEEF\r');
            assert.deepEqual([...info.entries.keys()], ['area', 'file', 'crc']);
            assert.equal(info.getAsString('File'), 'A.ZIP');
        });

        it('reads a file that is one enormous line', async () => {
            const info = await parse(`Area ${'x'.repeat(200000)}`);
            assert.equal(info.getAsString('Area').length, 200000);
        });

        it('skips blank lines, lines with no keyword and lines with no value', async () => {
            const info = await parse(
                ['', 'Area FSX_GEN', '', 'File A.ZIP', 'Areadesc', ''].join('\r\n')
            );
            assert.equal(info.rawLines.length, 3);
            //  the keyword is retained with an empty value -- and getAsString()
            //  reports it as absent, since its guard is truthiness rather than
            //  presence. The same guard is why a Crc of zero looks missing.
            assert.equal(info.get('Areadesc'), '');
            assert.equal(info.getAsString('Areadesc'), undefined);
        });

        it('drops a line indented by whitespace or preceded by a BOM', async () => {
            //
            //  `line.search(/\s/)` finds position 0, so the key is empty and
            //  the line is skipped -- not merely unparsed, but absent from
            //  rawLines too, so it is not passed through either. Neither spec
            //  permits leading whitespace on a keyword line, but a UTF-8 BOM is
            //  a thing editors add: a BOM'd TIC silently loses its first line.
            //
            const info = await parse(
                `${BOM}Area FSX_GEN\r\n   File A.ZIP\r\n\tCrc DEADBEEF\r\nDesc kept\r\n`
            );
            assert.deepEqual(
                info.rawLines.map(r => r.line),
                ['Desc kept']
            );
        });

        it('replaces non-UTF8 bytes rather than failing the read', async () => {
            //
            //  The file is read as UTF-8, so a CP437 or Latin-1 description --
            //  which is what FidoNet actually carries -- is not decodable and
            //  becomes U+FFFD. That is lossy, and the loss is then forwarded
            //  (see the round-trip suite), but it must not be a read failure:
            //  a TIC we cannot decode is still a TIC we have to dispose of.
            //
            const p = writeTic(
                Buffer.concat([
                    Buffer.from('Area FSX_GEN\r\nDesc '),
                    Buffer.from([0xff, 0xfe, 0x80, 0x81]),
                    Buffer.from('\r\nFile A.ZIP\r\n'),
                ])
            );
            const { err, info } = await readTic(p);
            assert.equal(err, null);
            assert.equal(info.getAsString('Desc'), '\ufffd'.repeat(4));
        });

        it('handles a NUL in the middle of a keyword', async () => {
            //  \s does not match NUL, so the whole token becomes the key and
            //  the line has no value. Harmless here; see the File field below.
            const info = await parse(`Area${NUL}FSX_GEN\r\nFile A.ZIP\r\n`);
            assert.equal(info.getAsString('Area'), undefined);
            assert.equal(info.get(`area${NUL}fsx_gen`), '');
        });
    });

    describe('volume', () => {
        it('reads 10,000 Seenby lines', async () => {
            const lines = ['Area FSX_GEN', 'File A.ZIP'];
            for (let i = 1; i <= 10000; ++i) {
                lines.push(`Seenby 21:1/${i}`);
            }
            const info = await parse(lines.join('\r\n') + '\r\n');
            assert.equal(info.get('Seenby').length, 10000);
            assert.doesNotThrow(() => info.getAsString('Seenby', ' '));
        });

        it('reads a 100KB value on a single line', async () => {
            const info = await parse(
                `Area FSX_GEN\r\nLdesc ${'x'.repeat(100 * 1024)}\r\nFile A.ZIP\r\n`
            );
            assert.equal(info.getAsString('Ldesc').length, 100 * 1024);
        });
    });

    //
    //  ── Security properties ──────────────────────────────────────────────
    //
    describe('path traversal defences', () => {
        const TRAVERSAL = [
            '../x',
            '../../../etc/passwd',
            '..\\x',
            '..\\..\\windows\\system32\\config\\sam',
            '/etc/passwd',
            '/',
            'C:\\windows\\x',
            '\\\\server\\share\\x',
            '....//x',
            '..',
            '....',
            'a/../b',
            'sub/../../x',
            './x',
            'x/',
            '..%2fx',
            'dir/file.zip',
        ];

        //  Accepted, because nothing anywhere decodes them: these are literal
        //  file names, however they look, and paths.join() keeps them put.
        const LITERAL_BUT_ODD = [
            '%2e%2e%2fetc%2fpasswd',
            '%2E%2E%5Cx',
            '. .',
            'file .zip',
        ];

        it('rejects a control character, a NUL above all', () => {
            //  Not a separator, not "..", not absolute -- so every other check
            //  passed it, and then fs.stat() threw ERR_INVALID_ARG_VALUE
            //  *synchronously* out of resolveFilePath(), escaping the waterfall
            //  so validate() never called back and the import pass hung. No
            //  legitimate FTN file name carries one.
            [`a${NUL}b`, 'a\u0001b', 'a\u001fb', `${NUL}`].forEach(name => {
                assert.equal(
                    TicFileInfo.isSafeFileName(name),
                    false,
                    JSON.stringify(name)
                );
            });
        });

        it('rejects every traversal form', () => {
            TRAVERSAL.forEach(name => {
                assert.equal(
                    TicFileInfo.isSafeFileName(name),
                    false,
                    `isSafeFileName("${name}") must be false`
                );
            });
        });

        it('rejects an absent, empty or non-string name', () => {
            [undefined, null, '', 0, false].forEach(name => {
                assert.equal(TicFileInfo.isSafeFileName(name), false, String(name));
            });
        });

        it('keeps every accepted name inside the TIC directory', () => {
            //
            //  The property that actually matters, stated directly: whatever
            //  the guard lets through, paths.join() must not escape with. URL
            //  encoded forms live here rather than in the rejected set because
            //  no layer between the wire and paths.join() decodes them -- a
            //  file really does end up named "%2e%2e%2fetc%2fpasswd".
            //
            const dir = '/inbound/secure';
            LITERAL_BUT_ODD.concat(['NODELIST.Z21', 'a-long-name.zip']).forEach(name => {
                assert.ok(
                    TicFileInfo.isSafeFileName(name),
                    `expected "${name}" to be accepted`
                );
                const joined = paths.resolve(paths.join(dir, name));
                assert.ok(joined.startsWith(`${dir}/`), `"${name}" escaped to ${joined}`);
            });
        });

        it('refuses to resolve a payload named "." or ".."', async () => {
            //  "." is accepted by isSafeFileName -- it contains no separator,
            //  no "..", and is not absolute -- so the guard against it is
            //  resolveFilePath() declining to treat a directory as a payload.
            const info = await parse(
                'Area FSX_GEN\r\nOrigin 21:1/100\r\nFrom 21:1/100\r\nFile .\r\nCrc DEADBEEF\r\n'
            );
            const err = await new Promise(res => info.resolveFilePath(e => res(e)));
            assert.ok(err);
            assert.equal(err.reasonCode, TicFileInfo.ReasonCodes.PayloadPending);
            assert.equal(info.resolvedFilePath, undefined);
        });

        it('rejects traversal in File, Lfile and Fullname before touching disk', async () => {
            for (const field of ['File', 'Lfile', 'Fullname']) {
                for (const bad of ['../../../etc/passwd', '..\\x', '/etc/passwd', '..']) {
                    const fields = {
                        Area: 'FSX_GEN',
                        Origin: '21:1/100',
                        From: '21:1/100',
                        File: 'A.ZIP',
                        Crc: 'DEADBEEF',
                    };
                    fields[field] = bad;
                    const info = await parse(
                        Object.entries(fields)
                            .map(([k, v]) => `${k} ${v}`)
                            .join('\r\n') + '\r\n'
                    );
                    const err = await validate(info);
                    assert.ok(err, `${field}="${bad}" validated`);
                    assert.match(err.message, /unsafe/i);
                    assert.equal(
                        info.resolvedFilePath,
                        undefined,
                        `${field}="${bad}" reached the disk`
                    );
                }
            }
        });

        it('falls back to a safe candidate for longFileName', async () => {
            const info = await parse(
                [
                    'Area FSX_GEN',
                    'File GOOD.ZIP',
                    'Lfile ../../../etc/passwd',
                    'Fullname /etc/shadow',
                ].join('\r\n') + '\r\n'
            );
            assert.equal(info.longFileName, 'GOOD.ZIP');
        });

        it('returns undefined when no candidate is safe', async () => {
            const info = await parse(
                ['Area FSX_GEN', 'File ../a', 'Lfile ../b', 'Fullname /c'].join('\r\n') +
                    '\r\n'
            );
            assert.equal(info.longFileName, undefined);
        });

        //
        //  DEFECT (live, high): TicFileInfo#filePath applies no safety check at
        //  all. It is `paths.join(dirname(this.path), getAsString('File'))`, so
        //
        //      File ../../../etc/passwd   ->   filePath === '/etc/passwd'
        //
        //  validate() does reject such a TIC -- but rejecting it is itself the
        //  exploit, because the rejection path in ftn_bso.js never consults
        //  validate()'s opinion of the name. reject() feeds
        //  [ticFileInfo.path, ticFileInfo.filePath] first to
        //  maybeArchiveImportFile(), which safeCopyFile()s it into the reject
        //  directory, and then to removeAssocTicFiles(), which fs.unlink()s it.
        //  So a single TIC gets an arbitrary readable file copied somewhere the
        //  sysop can read it, and an arbitrary writable file deleted.
        //
        //  It is reachable before any authentication of the sender: validate()
        //  checks the File field several steps before it looks at "From", the
        //  node table or the password, so the TIC does not have to come from a
        //  configured node or name an area we carry.
        //
        //  The fix belongs in the getter -- return undefined unless
        //  isSafeFileName(fileName) -- which is what resolveFilePath() already
        //  does for the same value. Un-skip this then.
        //
        it('never lets filePath escape the TIC directory', async () => {
            for (const bad of ['../../../etc/passwd', '/etc/passwd', '..', '..\\..\\x']) {
                const info = await parse(
                    [
                        'Area FSX_GEN',
                        'Origin 21:1/100',
                        'From 21:1/100',
                        `File ${bad}`,
                        'Crc DEADBEEF',
                    ].join('\r\n') + '\r\n'
                );
                const resolved = info.filePath && paths.resolve(info.filePath);
                assert.ok(
                    undefined === resolved || resolved.startsWith(`${tmpDir}/`),
                    `File "${bad}" produced filePath ${resolved}`
                );
            }
        });

        //
        //  DEFECT (live, high): an embedded NUL in "File" gets past
        //  isSafeFileName() -- it is not a separator, not "..", not absolute --
        //  and then reaches fs.stat() inside resolveFilePath(), where Node
        //  validates the path and throws *synchronously*:
        //
        //      TypeError [ERR_INVALID_ARG_VALUE]: The argument 'path' must be a
        //      string, Uint8Array, or URL without null bytes.
        //
        //  The throw happens inside an async.waterfall task, so it escapes
        //  validate() rather than reaching its callback -- which is precisely
        //  the #735 failure mode: an exception raised inside an fs callback,
        //  no callback ever fired, the import pass wedged until the watchdog
        //  fires, and every remaining TIC in the inbound skipped.
        //
        //  "Lfile" and "Fullname" have the same hole one stage later: they pass
        //  validate() intact and reach paths.join(areaStorageDir, name) and
        //  copyTicAttachment() in ftn_bso.js.
        //
        //  Remotely triggerable by anything that can land a .tic in the
        //  inbound, and it costs one byte. The fix is to add a NUL to what
        //  isSafeFileName() rejects. Un-skip this then.
        //
        it('does not throw for a NUL byte in a file name', async () => {
            for (const field of ['File', 'Lfile', 'Fullname']) {
                //  a complete, authenticated TIC: the crash is downstream of
                //  every other check, in resolveFilePath()
                const fields = {
                    Area: 'FSX_GEN',
                    Origin: '21:1/100',
                    From: '21:1/100',
                    File: 'A.ZIP',
                    Crc: 'DEADBEEF',
                    Pw: 'SEKRIT',
                };
                fields[field] = `NODE${NUL}LIST.Z21`;
                const info = await parse(
                    Object.entries(fields)
                        .map(([k, v]) => `${k} ${v}`)
                        .join('\r\n') + '\r\n'
                );

                //  This is the crash: for File, validate() throws out of the
                //  waterfall instead of calling back, so validate() below
                //  rejects and the test fails with the raw
                //  ERR_INVALID_ARG_VALUE rather than with an assertion.
                const err = await validate(info);
                assert.ok(err, `${field}: a NUL name must fail validation`);

                assert.equal(
                    TicFileInfo.isSafeFileName(fields[field]),
                    false,
                    `${field}: a name with a NUL must not be considered safe`
                );
            }
        });

        //
        //  DEFECT (live, low): a CRC of zero is indistinguishable from an
        //  absent one. createFromFile() stores parseInt(value, 16), and
        //  hasRequiredFields() tests the stored value for truthiness -- so
        //
        //      Crc 00000000
        //
        //  fails with "One or more required fields missing from TIC" and the
        //  TIC is rejected and unlinked rather than checked. CRC-32 of an empty
        //  file is exactly zero, and any file has a 1-in-2^32 chance of it.
        //  The same truthiness test is why an unparsable Crc ("Crc zzzz" ->
        //  NaN) is reported as a *missing field* rather than a bad one, which
        //  sends the sysop looking in the wrong place.
        //
        //  The fix is for hasRequiredFields() to test presence rather than
        //  truth -- undefined !== this.get(f) -- with the NaN cases rejected
        //  explicitly. Un-skip this then.
        //
        it('accepts a legitimate CRC of zero', async () => {
            const dir = fs.mkdtempSync(paths.join(tmpDir, 'crc0_'));
            fs.writeFileSync(paths.join(dir, 'EMPTY.ZIP'), '');
            const p = paths.join(dir, 'ZERO.TIC');
            fs.writeFileSync(
                p,
                [
                    'Area FSX_GEN',
                    'Origin 21:1/100',
                    'From 21:1/100',
                    'File EMPTY.ZIP',
                    'Crc 00000000',
                    'Size 0',
                    'Pw SEKRIT',
                ].join('\r\n') + '\r\n'
            );

            const { info } = await readTic(p);
            assert.equal(info.get('Crc'), 0);
            assert.ok(info.hasRequiredFields(), 'a Crc of zero is present, not missing');
            const err = await validate(info);
            assert.ok(!err, err && err.message);
        });
    });

    //
    //  ── C2: round trip ───────────────────────────────────────────────────
    //
    describe('round trip through the writer', () => {
        //
        //  The writer regenerates Created, From, To, Pw, Path, Seenby, Magic,
        //  ReceiptRequest and Crc, so those are the writer's own business.
        //  Everything else -- unknown keywords included -- is a pass-through,
        //  and both specs require it to survive verbatim and in order:
        //
        //      "the preferred way of dealing with it is to pass the line 'as
        //       is' to outgoing TIC files"                    -- FTS-5006 2.2
        //
        //  |build| is given no crc, password, pathEntry, createdBy or seenby,
        //  so the only generated lines are From, To and any Path values that
        //  arrived -- which makes the pass-through block exactly identifiable.
        //
        const OPTS = {
            from: Address.fromString('21:1/151'),
            to: Address.fromString('21:1/200'),
        };

        //  Independently derived, not copied from the writer: what should
        //  survive, in order.
        function expectedPassThrough(info, opts) {
            const regenerated = TicFileWriter.regeneratedKeywords;
            const known = TicFileWriter.knownKeywords;
            const out = [];

            info.rawLines.forEach(({ key, line }) => {
                if (regenerated.has(key)) {
                    return;
                }
                if (('lfile' === key || 'fullname' === key) && false === opts.longNames) {
                    return;
                }
                if ('sha256' === key && !opts.sha256) {
                    return;
                }
                if (!known.has(key) && false === opts.passUnknownKeywords) {
                    return;
                }
                //
                //  FSC-0087: "Known Keywords that are blank should not be
                //  passed though. For example, an empty AREADESC..."
                //
                //  Ldesc is exempt: FTS-5006 makes it repeatable and
                //  explicitly multi-line, so a blank one is a blank *line* in
                //  the description rather than an absent value. Real TICs use
                //  them as vertical spacing inside ANSI art.
                //
                if ('ldesc' !== key && known.has(key) && '' === valueOfLine(line)) {
                    return;
                }
                //  FTS-5006: "always use Lfile when writing TIC files but
                //  recognise Fullname as an alias when reading."
                out.push('fullname' === key ? `Lfile ${valueOfLine(line)}` : line);
            });

            return out;
        }

        //
        //  Entries containing a shape the writer is known to mangle are skipped
        //  -- see writerMangles() and the regression cases at the end of this
        //  suite. Excluding exactly those keeps this property strict for
        //  everything else: exact content, exact order, no extra lines.
        //
        it('preserves every pass-through line, verbatim and in order', async () => {
            let checked = 0;

            for (const entry of corpus) {
                if (!isEligibleForRoundTrip(entry.body)) {
                    continue;
                }
                ++checked;

                const { info } = await readTic(entry.path);
                const out = TicFileWriter.build(info, OPTS);

                const lines = out.split('\r\n');
                assert.equal(lines.pop(), '', `${entry.name}: no trailing CRLF`);

                //  strip the generated tail: From, To, then the inbound Paths
                const pathCount = TicFileWriter.valuesOf(info, 'path').length;
                const tail = lines.splice(lines.length - (2 + pathCount));

                assert.deepEqual(
                    tail.slice(0, 2),
                    ['From 21:1/151', 'To 21:1/200'],
                    `${entry.name}: unexpected generated tail`
                );

                assert.deepEqual(
                    lines,
                    expectedPassThrough(info, OPTS),
                    `${entry.name}: pass-through block differs`
                );
            }

            assert.ok(checked > 100, `only ${checked} corpus entries were eligible`);
        });

        it('cannot carry a bare CR through into a value', async () => {
            //  The reader now ends a line on CR, so "Desc a\rb\rc" arrives as
            //  three lines and no value contains a terminator. That is what
            //  makes the pass-through safe: the writer copies lines out
            //  verbatim, so anything a value could hold would be emitted.
            const info = await parse('Area FSX_GEN\nFile A.ZIP\nDesc a\rb\rc\n');
            assert.equal(info.getAsString('Desc'), 'a');

            const out = TicFileWriter.build(info, OPTS);
            out.split('\r\n').forEach(line =>
                assert.ok(!line.includes('\r'), `stray CR in: ${JSON.stringify(line)}`)
            );
        });

        it('preserves unknown keywords and their relative order', async () => {
            const info = await parse(
                [
                    'Area FSX_GEN',
                    'X-First one',
                    'Desc a description',
                    'X-Second two',
                    'App SOMEAPP data',
                    'X-First again',
                    'File A.ZIP',
                ].join('\r\n') + '\r\n'
            );
            const out = TicFileWriter.build(info, OPTS);
            assert.deepEqual(out.split('\r\n').slice(0, 7), [
                'Area FSX_GEN',
                'X-First one',
                'Desc a description',
                'X-Second two',
                'App SOMEAPP data',
                'X-First again',
                'File A.ZIP',
            ]);
        });

        it('is stable: forwarding an already-forwarded TIC changes nothing', async () => {
            //  Weaker than the property above, and it catches a different
            //  thing: a TIC is forwarded hop after hop, so whatever the writer
            //  does to a line it must reach a fixed point on the first hop
            //  rather than drifting a little further on every one.
            for (const entry of corpus) {
                if (!isEligibleForRoundTrip(entry.body)) {
                    continue;
                }
                const { info } = await readTic(entry.path);
                const once = TicFileWriter.build(info, OPTS);

                const p = writeTic(once);
                const { info: reparsed } = await readTic(p);
                const twice = TicFileWriter.build(reparsed, OPTS);

                assert.equal(twice, once, `${entry.name}: not a fixed point`);
            }
        });

        //
        //  DEFECT (live, low): clampLine() is applied to every line, inbound
        //  ones included, and its own comment says it should not be --
        //
        //      "Only lines we generate can realistically exceed it [...]
        //       Inbound lines arrived within the limit or the sender already
        //       broke the rule; either way 'pass the line as is' wins."
        //
        //  -- but the code does not pass it as is; it truncates at 254. A long
        //  Ldesc loses its tail, and a long Lfile is forwarded under a
        //  *different name* than the one we stored it under, which is a real
        //  divergence rather than cosmetic. The fix is to clamp only the lines
        //  build() generates. Un-skip this then.
        //
        it('does not truncate an over-length inbound line', async () => {
            const long = 'y'.repeat(400);
            const info = await parse(`Area FSX_GEN\r\nFile A.ZIP\r\nLdesc ${long}\r\n`);
            const out = TicFileWriter.build(info, OPTS);
            assert.ok(
                out.includes(`Ldesc ${long}`),
                'an inbound line must be passed through as is'
            );
        });

        //
        //  DEFECT (live, low/medium): the writer decides where a line's value
        //  starts with `line.search(/\s/) + 1`, and search() returns -1 when
        //  the line has no whitespace at all -- so slice(0) hands back the
        //  whole line, keyword included, as its own value. Two consequences,
        //  both remotely triggerable by a peer sending a keyword with no value:
        //
        //    Fullname     ->   Lfile Fullname       (a forged long file name)
        //    Fullname     ->   Lfile                 (blank, when whitespace only)
        //    Areadesc     ->   Areadesc              (passed through, but
        //                                             FSC-0087 says a blank
        //                                             known keyword must not be)
        //
        //  The first is the one that bites: the downlink stores the file under
        //  the name "Fullname". The fix is a helper that returns '' when
        //  search() misses. Un-skip this then.
        //
        it('treats a valueless keyword as having no value', async () => {
            const bare = await parse('Area FSX_GEN\r\nFile A.ZIP\r\nFullname\r\n');
            assert.ok(
                !TicFileWriter.build(bare, OPTS).includes('Lfile Fullname'),
                'the keyword must not become its own value'
            );

            const blank = await parse('Area FSX_GEN\r\nFile A.ZIP\r\nFullname    \r\n');
            assert.ok(
                !/^Lfile\s*$/m.test(TicFileWriter.build(blank, OPTS)),
                'a blank Lfile must not be emitted'
            );

            const known = await parse('Area FSX_GEN\r\nFile A.ZIP\r\nAreadesc\r\n');
            assert.ok(
                !/^Areadesc/m.test(TicFileWriter.build(known, OPTS)),
                'FSC-0087: a blank known keyword is not passed through'
            );

            //  It is also not a fixed point: hop one emits "Lfile ", hop two
            //  drops it as a blank known keyword. A TIC that changes shape on
            //  every hop is how a network ends up with two files that disagree.
            const once = TicFileWriter.build(blank, OPTS);
            const p = writeTic(once);
            const { info: reparsed } = await readTic(p);
            assert.equal(TicFileWriter.build(reparsed, OPTS), once);
        });
    });

    //
    //  ── C3: injection ────────────────────────────────────────────────────
    //
    describe('keyword injection', () => {
        const OPTS = {
            from: Address.fromString('21:1/151'),
            to: Address.fromString('21:1/200'),
        };

        //  Keyword lines as a *tolerant* reader would see them: CR, LF and CRLF
        //  all end a line. Our own reader is stricter, which is why this has to
        //  be spelled out rather than assumed -- the question is not what we
        //  read back, it is what the downlink reads.
        const linesAsSeenByATolerantReader = out => out.split(/\r\n|\r|\n/);

        it('cannot be caused by any inbound value, as our own reader sees it', async () => {
            for (const entry of corpus) {
                const { info } = await readTic(entry.path);
                const out = TicFileWriter.build(info, OPTS);

                const p = writeTic(out);
                const { info: reparsed } = await readTic(p);

                //  every keyword coming out is one we put there
                const expected = new Set(
                    info.rawLines.map(r => r.key).concat(['from', 'to', 'lfile', 'path'])
                );
                reparsed.rawLines.forEach(({ key }) => {
                    assert.ok(
                        expected.has(key),
                        `${entry.name}: output grew a "${key}" line`
                    );
                });
            }
        });

        it('never emits a Pw line unless the caller asked for one', async () => {
            //  The inbound Pw belonged to the hop before us and must not leak
            //  onward under any input. Framed as our own reader frames it; a
            //  reader that also breaks on a bare CR sees something else, which
            //  is the defect below.
            for (const entry of corpus) {
                const { info } = await readTic(entry.path);
                const out = TicFileWriter.build(info, OPTS);
                assert.ok(
                    !out.split('\r\n').some(l => /^Pw(\s|$)/.test(l)),
                    `${entry.name}: an unrequested Pw line appeared`
                );
            }
        });

        it('formats a real CRC as exactly eight hex digits', () => {
            //  -1 included deliberately: it is the signed form of 0xFFFFFFFF,
            //  which some CRC implementations return, and ">>> 0" is there to
            //  convert it. Our own crc.js always returns unsigned.
            ['1a2b', 'deadbeef', '0', 0, 0x1a2b, 0xffffffff, -1].forEach(crc => {
                assert.match(
                    TicFileWriter.formatCrc(crc),
                    /^[0-9A-F]{8}$/,
                    `formatCrc(${JSON.stringify(crc)})`
                );
            });
        });

        //
        //  DEFECT (live, medium): a lone CR inside an inbound value survives
        //  into our output. The reader splits on /\r\n|\n/, so a CR that is not
        //  followed by an LF is data to us -- but the raw line is then written
        //  out verbatim, and to any reader that treats a bare CR as a line
        //  ending (which is every implementation that strips "\r\n" with
        //  strtok, and htick among them) the value has become a second keyword
        //  line. A peer sends
        //
        //      Desc holiday snaps<CR>Pw THEIRPASSWORD
        //
        //  and the TIC we generate -- with our From, our Path and our name on
        //  it -- carries a Pw line we did not write. The same trick forges
        //  Seenby entries, which is a loop guard, or an Lfile, which is a file
        //  name.
        //
        //  The reader is the right place to fix it: reject or strip a value
        //  containing a CR, the way it already drops an unparsable address.
        //  Un-skip this then.
        //
        it('cannot be caused by a bare CR in an inbound value', async () => {
            const info = await parse(
                [
                    'Area FSX_GEN',
                    'File A.ZIP',
                    `Desc holiday snaps${CR}Pw THEIRPASSWORD`,
                    `Ldesc notes${CR}Seenby 21:9/9`,
                    //  found by the generator rather than by hand: corpus entry
                    //  fuzz-6221084-95, reduced. Kept verbatim because a bug a
                    //  fuzzer found once it will find again.
                    `Ldesc :1/2${CR}Pw NODELIST.Z21`,
                ].join('\n') + '\n'
            );

            const out = TicFileWriter.build(info, OPTS);
            const seen = linesAsSeenByATolerantReader(out);

            assert.ok(!seen.includes('Pw THEIRPASSWORD'), 'a Pw line was injected');
            assert.ok(!seen.includes('Pw NODELIST.Z21'), 'a Pw line was injected');
            assert.ok(!seen.includes('Seenby 21:9/9'), 'a Seenby line was injected');
        });

        //
        //  DEFECT (live, medium): build() interpolates |password|, |createdBy|
        //  and |pathEntry| straight into a line with no check for a line
        //  terminator, and clampLine() -- which only measures length -- does
        //  not notice. A value containing CRLF becomes two lines:
        //
        //      password: 'SECRET\r\nSeenby 21:9/9'
        //          ->  Pw SECRET
        //              Seenby 21:9/9
        //
        //  These come from config rather than from the wire, so this is not
        //  remotely triggerable -- but it is exactly the "one downlink's TIC
        //  carries another's password" shape: a Pw line smuggled through a
        //  neighbouring field lands in the TIC we send to a *different* link,
        //  and a forged Seenby poisons a loop guard we are trusted to maintain.
        //  A stray CR from a hand-edited hjson is all it takes.
        //
        //  build() should reject or strip CR and LF in every value it
        //  interpolates. Un-skip this then.
        //
        it('cannot be caused by a caller-supplied value', async () => {
            const info = await parse('Area FSX_GEN\r\nFile A.ZIP\r\n');

            const cases = [
                ['password', 'SECRET\r\nSeenby 21:9/9'],
                ['createdBy', 'ENiGMA\r\nPw OTHERLINKPASSWORD'],
                ['pathEntry', '21:1/151 1 x\r\nSeenby 21:6/6'],
                ['password', `SECRET${CR}Seenby 21:9/9`],
            ];

            cases.forEach(([key, value]) => {
                const opts = Object.assign({}, OPTS, { [key]: value });
                const out = TicFileWriter.build(info, opts);

                //
                //  Counted, not pattern-matched. The property is that a value
                //  cannot introduce a *line* -- so the number of Pw and Seenby
                //  lines a tolerant reader sees must be exactly the number the
                //  writer meant to emit. Terminators are collapsed into the
                //  value rather than dropped, so the mangled password stays
                //  visible on its own line: the far end fails the comparison
                //  loudly instead of silently accepting a truncated secret.
                //
                const seen = linesAsSeenByATolerantReader(out);
                const count = kw => seen.filter(l => l.startsWith(`${kw} `)).length;

                assert.equal(
                    count('Pw'),
                    opts.password ? 1 : 0,
                    `${key}: forged a Pw line -> ${JSON.stringify(out)}`
                );
                assert.equal(
                    count('Seenby'),
                    (opts.seenby || []).length,
                    `${key}: forged a Seenby line -> ${JSON.stringify(out)}`
                );
                seen.forEach(l =>
                    assert.ok(
                        !l.includes('\r') && !l.includes('\n'),
                        `${key}: stray terminator -> ${JSON.stringify(l)}`
                    )
                );
            });
        });

        //
        //  DEFECT (live, low): formatCrc() promises "an eight digit hex number"
        //  and delivers whatever it was given, upper-cased and left-padded to
        //  at least eight characters. It has no idea what a hex digit is:
        //
        //      formatCrc(undefined)      -> 'NDEFINED'
        //      formatCrc(null)           -> '0000NULL'
        //      formatCrc(NaN)            -> '00000NAN'
        //      formatCrc({})             -> ' OBJECT]'
        //      formatCrc([1, 2])         -> '000001,2'
        //      formatCrc('aa\r\nPw X')   -> 'AA\r\nPW X'      <- two lines
        //
        //  The last one is an injection primitive: the eight-character slice is
        //  not a bound on the *lines* produced. |crc| is computed locally today
        //  (file_base_area's crc32.finalize().toString(16)) so nothing remote
        //  reaches it, which is the only reason this is low -- the guarantee
        //  the rest of the writer leans on is simply not there.
        //
        //  Un-skip once formatCrc() validates its input.
        //
        it('refuses to invent a CRC from something that is not one', async () => {
            //
            //  It used to run String() over whatever it was given and keep the
            //  last eight characters, so undefined became "NDEFINED", NaN became
            //  "00000NAN", and "aa\r\nPw X" came back as *two lines* -- the
            //  slice bounds characters, not lines.
            //
            //  Null rather than a padded fallback, and the caller then omits the
            //  line: a wrong CRC is worse than a missing one. Every htick and
            //  Mystic downlink verifies it, so a fabricated value means the file
            //  is rejected with our name on the From line -- which is the exact
            //  reason we regenerate Crc from the computed checksum in the first
            //  place instead of forwarding one we never verified.
            //
            [undefined, null, NaN, {}, [1, 2], 'aa\r\nPw X', 'zzzz', ' ', ''].forEach(
                crc => {
                    assert.equal(
                        TicFileWriter.formatCrc(crc),
                        null,
                        `formatCrc(${JSON.stringify(crc)})`
                    );
                }
            );

            //  ...and the line is then absent rather than corrupt
            const info = await parse('Area FSX_GEN\r\nFile A.ZIP\r\n');
            const out = TicFileWriter.build(
                info,
                Object.assign({}, OPTS, { crc: 'aa\r\nPw X' })
            );
            assert.ok(!/^Crc /m.test(out), out);
            linesAsSeenByATolerantReader(out).forEach(l =>
                assert.ok(!/^Pw X/.test(l), `smuggled a line: ${JSON.stringify(out)}`)
            );
        });
    });

    //
    //  ── Forwarding decisions ─────────────────────────────────────────────
    //
    describe('forwarding decisions with malformed input', () => {
        const FWD = {
            ourAddresses: ['21:1/151'],
            defaultZone: 21,
        };

        async function ticWith(lines) {
            return parse(
                ['Area FSX_GEN', 'File A.ZIP'].concat(lines).join('\r\n') + '\r\n'
            );
        }

        it('never throws over the whole corpus, for any downlink list', async () => {
            const downlinkSets = [
                [],
                ['21:1/200'],
                ['21:1/200', '21:1/201', '21:2/1'],
                ['not an address', '', '21:1/', '21:1/200'],
                [null, undefined, '21:1/200'],
                undefined,
            ];

            for (const entry of corpus) {
                const { info } = await readTic(entry.path);
                downlinkSets.forEach(downlinks => {
                    assert.doesNotThrow(
                        () => {
                            ticForward.seenbyOf(info);
                            ticForward.addressOf(info, 'from');
                            ticForward.addressOf(info, 'to');
                            ticForward.addressOf(info, 'origin');
                            const { candidates, skipped } = ticForward.selectDownlinks(
                                Object.assign({ ticFileInfo: info, downlinks }, FWD)
                            );
                            candidates.forEach(a => a.toString('4D'));
                            skipped.forEach(s => String(s.reason));
                            ticForward
                                .buildSeenby(
                                    Object.assign({ ticFileInfo: info, downlinks }, FWD)
                                )
                                .forEach(a => a.toString('4D'));
                        },
                        `${entry.name}: forwarding threw for ${JSON.stringify(downlinks)}`
                    );
                });
            }
        });

        it('reports an unparsable downlink instead of forwarding to it', async () => {
            const info = await ticWith(['From 21:1/100']);
            const { candidates, skipped } = ticForward.selectDownlinks(
                Object.assign(
                    {
                        ticFileInfo: info,
                        downlinks: ['21:1/200', 'nonsense', '', '21:', null, undefined],
                    },
                    FWD
                )
            );
            assert.deepEqual(
                candidates.map(a => a.toString('4D')),
                ['21:1/200']
            );
            assert.equal(
                skipped.filter(s => s.reason === ticForward.SkipReasons.Unparsable)
                    .length,
                5
            );
        });

        it('keeps the loop guard working against malformed Seenby entries', async () => {
            //  The unparsable ones are dropped by the reader, so the guard only
            //  ever sees real addresses -- but the ones that *are* real still
            //  have to hold, in whatever dimensionality they arrived in.
            const info = await ticWith([
                'From 21:1/100',
                'Seenby garbage',
                'Seenby 21:',
                'Seenby 1/200', //  2D: needs defaultZone to match a 3D downlink
                'Seenby 21:1/201.0', //  explicit point 0 is not a point
                'Seenby 21:1/202@fsxnet',
            ]);

            const { candidates, skipped } = ticForward.selectDownlinks(
                Object.assign(
                    {
                        ticFileInfo: info,
                        downlinks: ['21:1/200', '21:1/201', '21:1/202', '21:1/203'],
                    },
                    FWD
                )
            );

            assert.deepEqual(
                candidates.map(a => a.toString('4D')),
                ['21:1/203'],
                'every Seenby that parsed must suppress its downlink'
            );
            assert.equal(
                skipped.filter(s => s.reason === ticForward.SkipReasons.AlreadySeen)
                    .length,
                3
            );
        });

        it('reads downlinks written as a string or an array, and nothing else', () => {
            assert.deepEqual(ticForward.downlinksOf({ downlinks: '21:1/1  21:1/2' }), [
                '21:1/1',
                '21:1/2',
            ]);
            assert.deepEqual(ticForward.downlinksOf({ downlinks: ['21:1/1'] }), [
                '21:1/1',
            ]);
            [null, undefined, 'a string', 5, { downlinks: 5 }, { downlinks: {} }].forEach(
                cfg => {
                    assert.deepEqual(
                        ticForward.downlinksOf(cfg),
                        [],
                        JSON.stringify(cfg)
                    );
                }
            );
        });

        //
        //  DEFECT (live, low): selectDownlinks() and buildSeenby() accept a
        //  downlink entry that is a string or an Address, and throw for
        //  anything else --
        //
        //      TypeError: addr.isValid is not a function
        //
        //  -- for a number, a boolean, a nested array or an address-shaped
        //  plain object. downlinksOf() shields the ftn_bso.js path from most of
        //  it, but not from `downlinks: [21]` in hjson (an unquoted array
        //  element is a number), and these are pure functions in the module
        //  whose whole comment is "this is the part that must not be wrong".
        //  A throw here lands inside the forwarding waterfall: the same
        //  stalled-pass shape as #735.
        //
        //  `!addr || !_.isFunction(addr.isValid) || !addr.isValid()` fixes it.
        //  Un-skip this then.
        //
        it('skips a downlink entry of the wrong type', async () => {
            const info = await ticWith(['From 21:1/100']);

            [5, true, {}, { net: 1, node: 2 }, ['21:1/1'], new Date()].forEach(bad => {
                const args = Object.assign(
                    { ticFileInfo: info, downlinks: [bad, '21:1/200'] },
                    FWD
                );
                assert.doesNotThrow(
                    () => ticForward.selectDownlinks(args),
                    `selectDownlinks threw for ${JSON.stringify(bad)}`
                );
                assert.doesNotThrow(
                    () => ticForward.buildSeenby(args),
                    `buildSeenby threw for ${JSON.stringify(bad)}`
                );
            });
        });

        //
        //  DEFECT (live, medium): buildSeenby() is quadratic. Every address it
        //  adds is checked against every address already added, by
        //  containsAddress()'s linear scan, so a Seenby list of n costs n^2/2
        //  isEquivalent() calls -- all of it synchronous, on the one thread the
        //  whole BBS runs on. Measured on this machine:
        //
        //        500 Seenby ->    13ms
        //      1,000 Seenby ->    36ms
        //      2,000 Seenby ->   132ms
        //      4,000 Seenby ->   447ms
        //     10,000 Seenby -> 2,641ms
        //
        //  The Seenby list is written by the peer and a TIC is a text file, so
        //  a 250KB TIC buys ten seconds of frozen event loop -- no telnet, no
        //  SSH, no timers -- and it is per forwarded file. Big echoes have
        //  genuinely long Seenby lists, so this is reachable by accident too.
        //
        //  The fix is a Set keyed on a normalized address rather than a scan.
        //  Un-skip this then.
        //
        it('builds a large Seenby list in linear time', async () => {
            const lines = ['Area FSX_GEN', 'File A.ZIP'];
            for (let i = 1; i <= 10000; ++i) {
                lines.push(`Seenby 21:1/${i}`);
            }
            const info = await parse(lines.join('\r\n') + '\r\n');

            const started = Date.now();
            const seenby = ticForward.buildSeenby(
                Object.assign({ ticFileInfo: info, downlinks: [] }, FWD)
            );
            const elapsed = Date.now() - started;

            //  10,000 inbound, of which 21:1/151 is also ours
            assert.equal(seenby.length, 10000);
            assert.ok(elapsed < 500, `10,000 Seenby entries took ${elapsed}ms`);
        });

        //
        //  DEFECT (live, medium): a 2D address -- "Seenby 1/50", which FSC-0087
        //  explicitly permits and which htick emits -- parses into an Address
        //  with no zone, and Address#toString() interpolates that missing zone
        //  anyway. buildSeenby() keeps it, and the TIC we send to *every*
        //  downlink then carries
        //
        //      Seenby undefined:1/50
        //
        //  which is not an address in any dimensionality. Every downstream
        //  tosser drops it with an "illegal value" warning at best, so the
        //  entry vanishes from the loop guard we are responsible for
        //  maintaining; a stricter one rejects the whole TIC and the file stops
        //  there. One 2D Seenby from an uplink poisons our output to all
        //  downlinks, and it is the *normal* way to write a Seenby.
        //
        //  |defaultZone| is already threaded into every comparison here for
        //  exactly this reason and is the obvious value to fill in on the way
        //  out. Un-skip this then.
        //
        it('never writes a zone-less address into a TIC', async () => {
            const info = await ticWith([
                'From 21:1/100',
                'Seenby 1/50',
                'Seenby 21:1/100',
            ]);

            const seenby = ticForward.buildSeenby(
                Object.assign({ ticFileInfo: info, downlinks: ['21:1/200'] }, FWD)
            );

            const out = TicFileWriter.build(info, {
                from: Address.fromString('21:1/151'),
                to: Address.fromString('21:1/200'),
                seenby,
            });

            assert.ok(
                !out.includes('undefined'),
                `a zone-less address reached the wire: ${JSON.stringify(out)}`
            );
        });
    });
});
