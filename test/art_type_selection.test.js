'use strict';

//
//  Art type selection in core/art.js: getArtTypePolicy() and how getArt()
//  applies it when picking among NAME.<type> / NAME<n>.<type> candidates.
//
//  The '.utf8ans' preference for UTF-8 terminals must behave exactly as it
//  did when it was a special case. The injected |term.artTypes| cases stand
//  in for a future emulation (PETSCII, RIP) without adding real types.
//

const { strict: assert } = require('assert');
const fs = require('fs');
const os = require('os');
const paths = require('path');
const _ = require('lodash');

const FIXTURE_FILES = [
    'MATRIX.ans',
    'MATRIX.utf8ans',
    'ONLYANS.ans',
    'ONLYUTF8.utf8ans',
    'MIXED.ans',
    'MIXED.asc',
    'RAND1.ans',
    'RAND2.ans',
    'RAND3.ans',
    'RANDx.ans', //  non-numeric suffix: never a random variant
    'VAR1.ans',
    'VAR2.ans',
    'VAR1.utf8ans',
    'VAR2.utf8ans',
];

const ALL_TYPES = ['.ans', '.utf8ans', '.asc', '.pcb', '.bbs', '.amiga', '.txt'];

const termClient = term => ({ term });
const cp437Client = () => termClient({ outputEncoding: 'cp437' });
const utf8Client = () => termClient({ outputEncoding: 'utf8' });

describe('art type selection', function () {
    let art;
    let artDir;

    before(function () {
        //  Lazily: art.js captures config.js's |get| at require time.
        art = require('../core/art.js');

        artDir = fs.mkdtempSync(paths.join(os.tmpdir(), 'enig-art-types-'));
        FIXTURE_FILES.forEach(f => fs.writeFileSync(paths.join(artDir, f), `${f}\r\n`));
    });

    after(function () {
        if (artDir) {
            fs.rmSync(artDir, { recursive: true, force: true });
        }
    });

    //  Resolve |name| and call back with the chosen file's basename (or the error).
    function pick(name, options, cb) {
        const opts = Object.assign({ basePath: artDir, random: false }, options);
        art.getArt(name, opts, (err, artInfo) => {
            if (err) {
                return cb(err);
            }
            return cb(null, paths.basename(artInfo.fromPath));
        });
    }

    //  Random mode, run once per evenly spaced Math.random() value so every
    //  slot of the pool is hit; calls back with the sorted set of files picked.
    function pickAllRandom(name, options, cb) {
        const samples = 24;
        const seen = new Set();
        const realRandom = Math.random;
        let i = 0;

        const next = () => {
            if (i >= samples) {
                Math.random = realRandom;
                return cb(null, [...seen].sort());
            }
            const value = (i + 0.5) / samples;
            i += 1;
            Math.random = () => value;
            pick(name, Object.assign({}, options, { random: true }), (err, file) => {
                Math.random = realRandom;
                if (err) {
                    return cb(err);
                }
                seen.add(file);
                return next();
            });
        };
        next();
    }

    describe('getArtTypePolicy()', function () {
        const cases = [
            {
                desc: 'no client: every requested type, one tier',
                client: undefined,
                types: ALL_TYPES,
                allowed: ALL_TYPES,
                preferred: [ALL_TYPES],
            },
            {
                desc: 'client without a term: every requested type, one tier',
                client: {},
                types: ALL_TYPES,
                allowed: ALL_TYPES,
                preferred: [ALL_TYPES],
            },
            {
                desc: 'cp437 client: every type allowed, .utf8ans only as a last resort',
                client: cp437Client(),
                types: ALL_TYPES,
                allowed: ALL_TYPES,
                preferred: [ALL_TYPES.filter(t => t !== '.utf8ans'), ['.utf8ans']],
            },
            {
                desc: 'utf8 client: .utf8ans first, the rest after in request order',
                client: utf8Client(),
                types: ALL_TYPES,
                allowed: ALL_TYPES,
                preferred: [['.utf8ans'], ALL_TYPES.filter(t => t !== '.utf8ans')],
            },
            {
                desc: 'utf8 client, caller order kept in the last tier',
                client: utf8Client(),
                types: ['.asc', '.ans', '.utf8ans'],
                allowed: ['.asc', '.ans', '.utf8ans'],
                preferred: [['.utf8ans'], ['.asc', '.ans']],
            },
            {
                desc: 'utf8 client, .utf8ans not requested: no empty tier',
                client: utf8Client(),
                types: ['.ans', '.asc'],
                allowed: ['.ans', '.asc'],
                preferred: [['.ans', '.asc']],
            },
            {
                desc: 'utf8 client, only .utf8ans requested',
                client: utf8Client(),
                types: ['.utf8ans'],
                allowed: ['.utf8ans'],
                preferred: [['.utf8ans']],
            },
            {
                desc: 'injected allowed list removes other types entirely',
                client: termClient({ artTypes: { allowed: ['.asc'], preferred: [] } }),
                types: ALL_TYPES,
                allowed: ['.asc'],
                preferred: [['.asc']],
            },
            {
                desc: 'injected allowed type the caller did not request: nothing',
                client: termClient({ artTypes: { allowed: ['.seq'] } }),
                types: ['.ans'],
                allowed: [],
                preferred: [],
            },
            {
                desc: 'injected tier keeps the terminal order; unranked types last',
                client: termClient({ artTypes: { preferred: [['.asc', '.ans']] } }),
                types: ['.ans', '.asc', '.pcb'],
                allowed: ['.ans', '.asc', '.pcb'],
                preferred: [['.asc', '.ans'], ['.pcb']],
            },
            {
                desc: 'injected tiers drop types that are not allowed or already ranked',
                client: termClient({
                    artTypes: {
                        allowed: ['.ans', '.asc'],
                        preferred: [['.pcb'], ['.asc', '.asc'], ['.asc', '.ans']],
                    },
                }),
                types: ALL_TYPES,
                allowed: ['.ans', '.asc'],
                preferred: [['.asc'], ['.ans']],
            },
            {
                desc: 'term.artTypes wins over the output encoding',
                client: termClient({
                    outputEncoding: 'utf8',
                    artTypes: { preferred: [['.ans']] },
                }),
                types: ['.utf8ans', '.ans'],
                allowed: ['.utf8ans', '.ans'],
                preferred: [['.ans'], ['.utf8ans']],
            },
        ];

        cases.forEach(c => {
            it(c.desc, function () {
                const types = c.types.slice();
                const policy = art.getArtTypePolicy(c.client, types);
                assert.deepEqual(policy, { allowed: c.allowed, preferred: c.preferred });
                assert.deepEqual(types, c.types, 'requested types are not mutated');
            });
        });
    });

    describe('getArt() selection, non-random', function () {
        const cases = [
            //  today's behaviour
            { name: 'MATRIX', client: utf8Client(), expect: 'MATRIX.utf8ans' },
            { name: 'MATRIX', client: cp437Client(), expect: 'MATRIX.ans' },
            { name: 'MATRIX', client: undefined, expect: 'MATRIX.ans' },
            { name: 'ONLYANS', client: utf8Client(), expect: 'ONLYANS.ans' },
            { name: 'ONLYUTF8', client: cp437Client(), expect: 'ONLYUTF8.utf8ans' },
            { name: 'ONLYUTF8', client: utf8Client(), expect: 'ONLYUTF8.utf8ans' },
            { name: 'matrix', client: utf8Client(), expect: 'MATRIX.utf8ans' },
            { name: 'MIXED', client: cp437Client(), expect: 'MIXED.ans' },
            { name: 'MIXED', client: utf8Client(), expect: 'MIXED.ans' },
            { name: 'MISSING', client: cp437Client(), expect: 'DoesNotExist' },
            { name: 'RAND', client: cp437Client(), expect: 'DoesNotExist' },

            //  explicit extension: read as-is, no policy
            { name: 'MATRIX.ans', client: utf8Client(), expect: 'MATRIX.ans' },
            { name: 'MATRIX.utf8ans', client: cp437Client(), expect: 'MATRIX.utf8ans' },
            {
                name: 'MATRIX.ans',
                client: termClient({ artTypes: { allowed: ['.asc'] } }),
                expect: 'MATRIX.ans',
            },

            //  explicit options.types from a caller
            {
                name: 'MIXED',
                types: ['.asc', '.ans'],
                client: cp437Client(),
                expect: 'MIXED.asc',
            },
            { name: 'MIXED', types: '.ASC', client: cp437Client(), expect: 'MIXED.asc' },
            {
                name: 'MATRIX',
                types: ['.ans'],
                client: utf8Client(),
                expect: 'MATRIX.ans',
            },
            {
                name: 'MATRIX',
                types: ['.ans', '.utf8ans'],
                client: utf8Client(),
                expect: 'MATRIX.utf8ans',
            },
            {
                name: 'ONLYUTF8',
                types: ['.ans'],
                client: utf8Client(),
                expect: 'DoesNotExist',
            },

            //  injected policies (stand-ins for future emulations / layers)
            {
                desc: 'a disallowed type is never a fallback',
                name: 'ONLYANS',
                client: termClient({
                    artTypes: { allowed: ['.asc'], preferred: [['.asc']] },
                }),
                expect: 'DoesNotExist',
            },
            {
                desc: 'an allowed type is found among disallowed siblings',
                name: 'MIXED',
                client: termClient({
                    artTypes: { allowed: ['.asc'], preferred: [['.asc']] },
                }),
                expect: 'MIXED.asc',
            },
            {
                desc: 'a layer preference falls back to the base types',
                name: 'ONLYANS',
                client: termClient({ artTypes: { preferred: [['.asc']] } }),
                expect: 'ONLYANS.ans',
            },
            {
                desc: 'a layer preference wins when its file exists',
                name: 'MIXED',
                client: termClient({ artTypes: { preferred: [['.asc']] } }),
                expect: 'MIXED.asc',
            },
            {
                desc: 'an allowed type the caller did not request is not found',
                name: 'MIXED',
                types: ['.ans'],
                client: termClient({ artTypes: { allowed: ['.asc'] } }),
                expect: 'DoesNotExist',
            },
        ];

        cases.forEach(c => {
            const label =
                c.desc ||
                `${c.name} for ${_.get(c, 'client.term.outputEncoding', 'no client')}` +
                    (c.types ? ` with types ${JSON.stringify(c.types)}` : '');
            it(`${label} -> ${c.expect}`, function (done) {
                const options = { client: c.client };
                if (c.types) {
                    options.types = Array.isArray(c.types) ? c.types.slice() : c.types;
                }
                pick(c.name, options, (err, file) => {
                    if ('DoesNotExist' === c.expect) {
                        assert.ok(err, `expected no art, got ${file}`);
                        assert.match(err.message, /No matching art/);
                    } else {
                        assert.ifError(err);
                        assert.equal(file, c.expect);
                    }
                    return done();
                });
            });
        });
    });

    describe('getArt() selection, random variants', function () {
        const cases = [
            {
                name: 'RAND',
                client: cp437Client(),
                expect: ['RAND1.ans', 'RAND2.ans', 'RAND3.ans'],
            },
            {
                name: 'RAND',
                client: utf8Client(),
                expect: ['RAND1.ans', 'RAND2.ans', 'RAND3.ans'],
            },
            {
                desc: 'utf8 client draws only from the .utf8ans variants',
                name: 'VAR',
                client: utf8Client(),
                expect: ['VAR1.utf8ans', 'VAR2.utf8ans'],
            },
            {
                //  A non-UTF-8 client is never handed .utf8ans while another
                //  type matches.
                desc: 'cp437 client draws only from the non-UTF-8 variants',
                name: 'VAR',
                client: cp437Client(),
                expect: ['VAR1.ans', 'VAR2.ans'],
            },
            {
                desc: 'random mode also matches the bare name',
                name: 'MATRIX',
                client: utf8Client(),
                expect: ['MATRIX.utf8ans'],
            },
            {
                desc: 'injected allowed list filters the random pool',
                name: 'VAR',
                client: termClient({ artTypes: { allowed: ['.ans'] } }),
                expect: ['VAR1.ans', 'VAR2.ans'],
            },
            {
                desc: 'injected allowed list with no variant of that type',
                name: 'RAND',
                client: termClient({ artTypes: { allowed: ['.asc'] } }),
                expect: 'DoesNotExist',
            },
        ];

        cases.forEach(c => {
            const label = c.desc || `${c.name} for ${c.client.term.outputEncoding}`;
            it(`${label}`, function (done) {
                pickAllRandom(c.name, { client: c.client }, (err, files) => {
                    if ('DoesNotExist' === c.expect) {
                        assert.ok(err, `expected no art, got ${files}`);
                        assert.match(err.message, /No matching art/);
                    } else {
                        assert.ifError(err);
                        assert.deepEqual(files, c.expect);
                    }
                    return done();
                });
            });
        });
    });
});
