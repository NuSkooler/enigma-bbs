'use strict';

//
//  ENIGMA_UNARC_ARCHIVERS (#906): the Docker image ships unarc but neither
//  unlzx nor atr, and names the archivers unarc should stand in for.
//
//  It is applied by the config loader only. config_default.js -- and so the
//  schema, validation, `config new` and misc/config.schema.json built from it
//  -- must come out the same whatever the environment says.
//

const { strict: assert } = require('assert');
const fs = require('fs');
const os = require('os');
const paths = require('path');

const configDefault = require('../core/config_default.js');
const ConfigLoader = require('../core/config_loader.js');
const { effectiveDefaults } = require('../core/config.js');
const {
    EnvVar,
    UnarcReference,
    parseUnarcArchivers,
    routeArchiversToUnarc,
} = require('../core/config/unarc_archivers.js');

describe('ENIGMA_UNARC_ARCHIVERS', () => {
    let saved;
    let dir;

    beforeEach(() => {
        saved = process.env[EnvVar];
        dir = fs.mkdtempSync(paths.join(os.tmpdir(), 'enig-unarc-env-'));
    });

    afterEach(() => {
        if (undefined === saved) {
            delete process.env[EnvVar];
        } else {
            process.env[EnvVar] = saved;
        }
        fs.rmSync(dir, { recursive: true, force: true });
    });

    const setEnv = value => {
        if (undefined === value) {
            delete process.env[EnvVar];
        } else {
            process.env[EnvVar] = value;
        }
    };

    const archiversWith = value =>
        routeArchiversToUnarc(configDefault(), { [EnvVar]: value }).archives.archivers;

    //  Load |hjson| through a real ConfigLoader with the defaults config.js
    //  uses. A plain loader, not Config.create(), so no global config changes.
    let fileSeq = 0;
    const load = (hjson, cb) => {
        const path = paths.join(dir, `config-${++fileSeq}.hjson`);
        fs.writeFileSync(path, hjson);
        const loader = new ConfigLoader({
            hotReload: false,
            defaultConfig: effectiveDefaults,
        });
        loader.init(path, err => cb(err, loader));
    };

    describe('routing', () => {
        it('leaves every archiver alone when unset or empty', () => {
            for (const value of [undefined, '', ' , ']) {
                const archivers = archiversWith(value);
                assert.equal(archivers.Atr.list.cmd, 'atr');
                assert.equal(archivers.Lzx.list.cmd, 'unlzx');
                assert.equal(archivers.Rar.list.cmd, 'unrar');
            }
        });

        it('points the named archivers at Unarc, by reference, and no others', () => {
            const archivers = archiversWith(' Atr, Lzx ');
            assert.equal(archivers.Atr, UnarcReference);
            assert.equal(archivers.Lzx, UnarcReference);
            assert.equal(archivers.Rar.list.cmd, 'unrar');
            assert.equal(archivers.Unarc.list.cmd, 'unarc');
        });

        it('ignores names that are not own archiver keys', () => {
            const junk =
                'lzx,NoSuchThing,Unarc,constructor,toString,__proto__,hasOwnProperty,valueOf,,;';
            const before = configDefault().archives.archivers;
            const archivers = archiversWith(junk);

            assert.deepEqual(Object.keys(archivers), Object.keys(before));
            assert.deepEqual(archivers, before);
            assert.equal(typeof archivers.constructor, 'function');

            const { routed, ignored } = parseUnarcArchivers(before, junk);
            assert.deepEqual(routed, []);
            assert.deepEqual(ignored, [
                'lzx',
                'NoSuchThing',
                'Unarc',
                'constructor',
                'toString',
                '__proto__',
                'hasOwnProperty',
                'valueOf',
                ';',
            ]);
        });

        it('takes the environment by default', () => {
            setEnv('Lzx');
            assert.equal(
                routeArchiversToUnarc(configDefault()).archives.archivers.Lzx,
                UnarcReference
            );
        });
    });

    describe('kept out of the defaults themselves', () => {
        it('never changes config_default.js output', () => {
            setEnv(undefined);
            const unset = JSON.stringify(configDefault());
            setEnv('Atr,Lzx');
            assert.equal(JSON.stringify(configDefault()), unset);
        });

        it('builds the same schema with and without the variable', () => {
            const { buildSchema } = require('../core/config/schema.js');
            const { toJsonSchema, serialize } = require('../core/config/json_schema.js');

            setEnv(undefined);
            const unset = serialize(toJsonSchema(buildSchema()));
            setEnv('Atr,Lzx');
            assert.equal(serialize(toJsonSchema(buildSchema())), unset);
        });
    });

    describe('through the config loader', () => {
        const { buildSchema } = require('../core/config/schema.js');
        const { validateConfig } = require('../core/config/validate.js');

        //  Two values of the wrong type, which validation must report however
        //  the variable is set.
        const BadArchivers = `{
            archives: {
                archivers: {
                    Rar: { list: { args: "l {archivePath}" } }
                    MyArc: { list: { cmd: 7, args: [ "l" ] } }
                }
            }
        }\n`;

        const issuesWith = (value, hjson, cb) => {
            setEnv(value);
            load(hjson, (err, loader) => {
                if (err) {
                    return cb(err);
                }
                const issues = validateConfig(
                    loader.getUserConfig(),
                    loader.get(),
                    buildSchema()
                );
                return cb(null, issues, loader.get());
            });
        };

        const summary = issues => issues.map(i => `${i.code}:${i.path}`).sort();

        it('routes Atr and Lzx to the Unarc archiver when set', done => {
            issuesWith('Atr,Lzx', '{}\n', (err, issues, config) => {
                if (err) {
                    return done(err);
                }
                const { Atr, Lzx, Unarc, Rar } = config.archives.archivers;
                assert.equal(Atr.list.cmd, 'unarc');
                assert.equal(Atr.list.outputFormat, 'json');
                assert.deepEqual(Lzx, Unarc);
                assert.equal(Rar.list.cmd, 'unrar');
                assert.deepEqual(issues, []);
                return done();
            });
        });

        it("carries an operator's Unarc override through to Atr and Lzx", done => {
            const hjson =
                '{ archives: { archivers: { Unarc: { list: { cmd: "/opt/unarc" } } } } }\n';
            issuesWith('Atr,Lzx', hjson, (err, issues, config) => {
                if (err) {
                    return done(err);
                }
                assert.equal(config.archives.archivers.Atr.list.cmd, '/opt/unarc');
                assert.equal(config.archives.archivers.Lzx.list.cmd, '/opt/unarc');
                return done();
            });
        });

        it('reports the same validation issues with and without the variable', done => {
            issuesWith(undefined, BadArchivers, (err, unset) => {
                if (err) {
                    return done(err);
                }
                issuesWith('Atr,Lzx', BadArchivers, (err, set) => {
                    if (err) {
                        return done(err);
                    }
                    assert(
                        unset.length >= 2,
                        `expected the type errors: ${JSON.stringify(unset)}`
                    );
                    assert.deepEqual(summary(set), summary(unset));
                    assert(
                        summary(set).some(s =>
                            /^typeMismatch:archives\.archivers\.Rar\.list\.args$/.test(s)
                        ),
                        JSON.stringify(set)
                    );
                    assert(
                        summary(set).some(s =>
                            /^typeMismatch:archives\.archivers\.MyArc\.list\.cmd$/.test(s)
                        ),
                        JSON.stringify(set)
                    );
                    return done();
                });
            });
        });

        it('reports a clean config as clean with and without the variable', done => {
            issuesWith(undefined, '{}\n', (err, unset) => {
                if (err) {
                    return done(err);
                }
                issuesWith('Atr,Lzx', '{}\n', (err, set) => {
                    if (err) {
                        return done(err);
                    }
                    assert.deepEqual(unset, []);
                    assert.deepEqual(set, []);
                    return done();
                });
            });
        });
    });
});
