'use strict';

const { strict: assert } = require('assert');
const _ = require('lodash');
const paths = require('path');
const fs = require('fs');
const hjson = require('hjson');

const { buildSchema } = require('../core/config/schema');
const { validateConfig, suggestKey } = require('../core/config/validate');
const {
    IssueCodes,
    Severity,
    describeIssue,
    countBySeverity,
} = require('../core/config/issue');
const DefaultConfig = require('../core/config_default');

//  Merge the way ConfigLoader does, so tests exercise the real shadowing.
const merge = user => _.merge(DefaultConfig(), _.cloneDeep(user));

const validate = (user, options) =>
    validateConfig(user, merge(user), buildSchema(), options);

const codes = issues => issues.map(i => i.code);

// ─── The failure mode this exists to catch ───────────────────────────────────

describe('config validation: silent shadowing', () => {
    it('reports a misspelled key that the merge left sitting beside the default', () => {
        const issues = validate({
            scannerTossers: { ftn_bso: { paths: { outbund: '/home/bbs/out' } } },
        });

        assert.equal(issues.length, 1);
        assert.equal(issues[0].code, IssueCodes.UnknownKey);
        assert.equal(issues[0].severity, Severity.Warning);
        assert.equal(issues[0].path, 'scannerTossers.ftn_bso.paths.outbund');
        assert.equal(issues[0].suggestion, 'outbound');
    });

    it('says what to do about it', () => {
        const [issue] = validate({ general: { boardnam: 'x' } });
        const described = describeIssue(issue);
        assert.equal(described.severity, Severity.Warning);
        assert.equal(described.path, 'general.boardnam');
        assert.equal(
            described.message,
            'unknown key "boardnam" -- did you mean "boardName"?'
        );
    });

    it('offers no suggestion when nothing is close', () => {
        const [issue] = validate({ general: { zzzzzzzzzz: 1 } });
        assert.equal(issue.code, IssueCodes.UnknownKey);
        assert.equal(issue.suggestion, undefined);
        assert.equal(describeIssue(issue).message, 'unknown key "zzzzzzzzzz"');
    });
});

// ─── Staying quiet when it should ────────────────────────────────────────────

describe('config validation: false positives', () => {
    it('finds nothing wrong with the shipped defaults', () => {
        //  The defaults are where the types come from, so anything reported
        //  here is a bug in the schema rather than in a configuration.
        const issues = validateConfig({}, DefaultConfig(), buildSchema());
        assert.deepEqual(issues, []);
    });

    it('finds nothing wrong with a freshly generated configuration', () => {
        //
        //  The check the whole effort lives or dies on: a brand new
        //  installation must produce no findings at all. Anything here is a
        //  warning the very first sysop to run this would see on a config
        //  they did nothing wrong to create.
        //
        //  Reproduces what "oputil.js config new" builds -- the shipped
        //  template with real defaults merged over its XXXXX placeholders.
        //  ConfigIncludeKeys mirrors core/oputil/oputil_config.js:30-42; PR 3
        //  replaces this with a call to the command itself.
        //
        const ConfigIncludeKeys = [
            'theme',
            'users.preAuthIdleLogoutSeconds',
            'users.idleLogoutSeconds',
            'users.newUserNames',
            'users.failedLogin',
            'users.unlockAtEmailPwReset',
            'paths.logs',
            'loginServers',
            'contentServers',
            'fileBase.areaStoragePrefix',
            'logging.rotatingFile',
        ];

        const templatePath = paths.join(__dirname, '../misc/config_template.in.hjson');
        const template = hjson.parse(fs.readFileSync(templatePath, 'utf8'));

        const direct = {};
        const defaults = DefaultConfig();
        ConfigIncludeKeys.forEach(keyPath =>
            _.set(direct, keyPath, _.get(defaults, keyPath))
        );

        const generated = _.mergeWith(template, direct);
        generated.general.boardName = 'Test BBS';

        const issues = validate(generated);
        assert.deepEqual(
            issues.map(i => `${i.severity} ${i.path}: ${describeIssue(i).message}`),
            []
        );
    });

    it('does not object to extra keys in a file area', () => {
        //  §0.1: the two example areas in the defaults mention neither of
        //  these, and both are perfectly legal.
        const issues = validate({
            fileBase: {
                areas: {
                    retro_pc: {
                        name: 'Retro PC',
                        storageTags: ['retro_pc'],
                        acs: { download: 'GM[users]' },
                        hashTags: ['retro', 'pc'],
                    },
                },
            },
        });

        assert.deepEqual(issues, []);
    });

    it('does not object to sysop chosen keys in an open map', () => {
        const issues = validate({
            messageConferences: {
                my_conf: { name: 'Mine', areas: { my_area: { name: 'Area' } } },
            },
            fileBase: { storageTags: { my_tag: '/some/where' } },
        });

        assert.deepEqual(issues, []);
    });

    it('accepts a section that has no default at all', () => {
        const issues = validate({
            messageNetworks: {
                ftn: {
                    networks: {
                        agoranet: { localAddress: '46:1/100' },
                    },
                },
            },
        });

        assert.deepEqual(issues, []);
    });

    it('accepts null for a path documented as nullable', () => {
        const issues = validate({
            term: { forceOutputEncoding: null },
            email: { outbound: { fromDomain: null } },
        });

        assert.deepEqual(issues, []);
    });

    it('leaves an underscore-prefixed block alone', () => {
        //  "_snips" is a long standing convention for fragments that
        //  @reference: points at -- scratch space, not configuration
        const issues = validate({
            _snips: { someArt: 'shared', nested: { more: true } },
            _scratch: 1,
        });

        assert.deepEqual(issues, []);
    });

    it('recognises settings that are read but never defaulted', () => {
        //
        //  Every one of these was reported as an unknown key against a real,
        //  long-lived configuration, and every one is a genuine setting the
        //  code reads. They are declared in meta because config_default.js
        //  does not carry them.
        //
        const issues = validate({
            general: {},
            messageNetworks: { originLine: 'Somewhere in Utah' },
            email: {
                transport: { host: 'smtp.example.net' },
                defaultFrom: 'bbs@example.net',
                inbound: {
                    imap: {
                        host: 'imap.example.net',
                        user: 'bbs',
                        password: 'secret',
                        processedFolder: 'Processed',
                        failedFolder: 'Failed',
                    },
                },
            },
            loginServers: {
                telnet: { address: '10.0.0.1' },
                ssh: { address: '10.0.0.1' },
                webSocket: { ws: { address: '10.0.0.1' }, wss: { address: '10.0.0.1' } },
            },
            contentServers: {
                web: {
                    http: { address: '10.0.0.1' },
                    https: { address: '10.0.0.1' },
                    overrideUrlPrefix: 'https://bbs.example.net',
                    restApi: { corsAllowedOrigins: ['https://example.net'] },
                },
                gopher: { address: '10.0.0.1' },
            },
            scannerTossers: {
                ftn_bso: {
                    defaultNetwork: 'agoranet',
                    schedule: { import: 'every 1 hours' },
                    paths: { retain: '/tmp/retain' },
                },
            },
        });

        assert.deepEqual(
            issues.map(i => i.path),
            []
        );
    });

    it('still reports an address where nothing reads one', () => {
        //  NNTP listens via a URI and MRC does not bind, so these really are
        //  inert and saying so is the useful answer
        const issues = validate({
            contentServers: { nntp: { nntp: { address: '10.0.0.1' } } },
            chatServers: { mrc: { address: '10.0.0.1' } },
        });

        assert.deepEqual(issues.map(i => i.path).sort(), [
            'chatServers.mrc.address',
            'contentServers.nntp.nntp.address',
        ]);
    });

    it('reports a mod section once, not once per key inside it', () => {
        const issues = validate({
            my_fancy_mod: { one: 1, two: 2, three: { four: 4, five: 5 } },
        });

        assert.equal(issues.length, 1);
        assert.equal(issues[0].path, 'my_fancy_mod');
        assert.equal(issues[0].severity, Severity.Warning);
    });
});

// ─── Values ──────────────────────────────────────────────────────────────────

describe('config validation: values', () => {
    it('reports a type that disagrees with the default it overrides', () => {
        const [issue] = validate({ general: { maxConnections: 'lots' } });
        assert.equal(issue.code, IssueCodes.TypeMismatch);
        assert.equal(issue.severity, Severity.Error);
        assert.equal(describeIssue(issue).message, 'expected number, got string');
    });

    it('reports null where null is not documented', () => {
        const [issue] = validate({ general: { boardName: null } });
        assert.equal(issue.code, IssueCodes.TypeMismatch);
        assert.equal(issue.actual, 'null');
    });

    it('reports an object where a scalar belongs', () => {
        const [issue] = validate({ general: { boardName: { nope: true } } });
        assert.equal(issue.code, IssueCodes.TypeMismatch);
        assert.equal(issue.expected, 'string');
    });

    it('checks the elements of a typed array', () => {
        const schema = buildSchema({ list: ['a'] }, {});
        const issues = validateConfig({}, { list: ['ok', 7] }, schema);
        assert.equal(issues.length, 1);
        assert.equal(issues[0].code, IssueCodes.TypeMismatch);
        assert.equal(issues[0].path, 'list[1]');
    });

    it('enforces an enum meta declares', () => {
        const schema = buildSchema({ mode: 'warn' }, { mode: { enum: ['warn', 'off'] } });
        const [issue] = validateConfig({}, { mode: 'loud' }, schema);
        assert.equal(issue.code, IssueCodes.InvalidEnum);
        assert.equal(describeIssue(issue).message, '"loud" is not one of: warn, off');
    });

    it('enforces a range meta declares', () => {
        const schema = buildSchema({ port: 8080 }, { port: { min: 1, max: 65535 } });
        const [low] = validateConfig({}, { port: 0 }, schema);
        assert.equal(low.code, IssueCodes.ValueOutOfRange);
        assert.equal(describeIssue(low).message, '0 is below the minimum of 1');

        const [high] = validateConfig({}, { port: 70000 }, schema);
        assert.equal(describeIssue(high).message, '70000 is above the maximum of 65535');
    });

    it('says nothing about a node whose default carried no type', () => {
        const schema = buildSchema({ blob: {} }, {});
        assert.deepEqual(validateConfig({}, { blob: 'anything at all' }, schema), []);
    });
});

// ─── Unresolved @ specs ──────────────────────────────────────────────────────

describe('config validation: unresolved @ specs', () => {
    //
    //  When an environment variable is not set, _resolveAtSpecs() leaves the
    //  literal spec string in place. Type checking it would report a correct
    //  production config as broken purely because it was validated from the
    //  wrong shell.
    //
    const schema = buildSchema({ port: 8080 }, {});
    const merged = { port: '@environment:BBS_PORT:number' };

    it('ignores an unresolved spec by default', () => {
        assert.deepEqual(validateConfig({}, merged, schema), []);
    });

    it('reports one when asked to check the environment', () => {
        const issues = validateConfig({}, merged, schema, { checkEnv: true });
        assert.equal(issues.length, 1);
        assert.equal(issues[0].code, IssueCodes.UnresolvedSpec);
        assert.equal(issues[0].severity, Severity.Error);
        assert.equal(
            describeIssue(issues[0]).message,
            '"@environment:BBS_PORT:number" did not resolve'
        );
    });

    it('leaves an ordinary string beginning with @ alone', () => {
        const strings = buildSchema({ note: 'x' }, {});
        assert.deepEqual(
            validateConfig({}, { note: '@home tonight' }, strings, { checkEnv: true }),
            []
        );
    });
});

// ─── Suggestions ─────────────────────────────────────────────────────────────

describe('config validation: suggestions', () => {
    const siblings = ['outbound', 'inbound', 'secInbound', 'reject'];

    it('finds a single character slip', () => {
        assert.equal(suggestKey('outbund', siblings), 'outbound');
        assert.equal(suggestKey('inbnud', siblings), 'inbound');
    });

    it('is case insensitive', () => {
        assert.equal(suggestKey('OutBound', siblings), 'outbound');
    });

    it('gives up rather than guessing wildly', () => {
        assert.equal(suggestKey('completelyDifferent', siblings), undefined);
    });

    it('is stricter about short keys, where one edit is a different word', () => {
        //  "port" -> "sort" is one edit but plainly not a typo of the other
        assert.equal(suggestKey('acs', ['acl']), 'acl');
        assert.equal(suggestKey('acs', ['name', 'desc']), undefined);
    });
});

// ─── Reporting helpers ───────────────────────────────────────────────────────

describe('config validation: issue helpers', () => {
    it('counts by severity', () => {
        const issues = validate({
            general: { boardnam: 'x', maxConnections: 'lots' },
        });
        assert.deepEqual(countBySeverity(issues), { errors: 1, warnings: 1 });
        assert.deepEqual(codes(issues).sort(), [
            IssueCodes.TypeMismatch,
            IssueCodes.UnknownKey,
        ]);
    });

    it('returns nothing when there is no schema', () => {
        assert.deepEqual(validateConfig({ a: 1 }, { a: 1 }, undefined), []);
    });
});
