'use strict';

const { strict: assert } = require('assert');
const os = require('os');

const DropFile = require('../core/dropfile.js');
const ACS = require('../core/acs.js');
const configModule = require('../core/config.js');
const { getCtermVersion } = require('../core/client.js');

//
//  BBSDEV.DRP version 1.0: 19 positional lines, numbered here as the spec
//  numbers them. See https://github.com/RealDeuce/bbsdev.drp
//
const Line = {
    Version: 1,
    CommType: 2,
    CommParams: 3,
    Alias: 4,
    UserKey: 5,
    Width: 6,
    Height: 7,
    Ansi: 8,
    Rip: 9,
    CTerm: 10,
    Logoff: 11,
    Encoding: 12,
    Language: 13,
    Software: 14,
    BoardName: 15,
    SysOp: 16,
    AccessLevel: 17,
    Node: 18,
    LocalDisplay: 19,
};

function makeClient(properties = {}) {
    const props = Object.assign({}, properties);

    //  the drop file states a logoff deadline, so the user has to answer the
    //  questions core/user_time.js asks of a real one
    const user = {
        userId: 42,
        username: 'testuser',
        properties: props,
        getSanitizedName: which => ('real' === which ? 'Test User' : 'testuser'),
        getLegacySecurityLevel: () => 30,
        isSysOp: () => false,
        isRoot: () => false,
        isGroupMember: () => false,
        isAuthenticated: () => true,
        getProperty: name => props[name],
        getPropertyAsNumber: name => parseInt(props[name], 10),
        persistProperty: (name, value) => {
            props[name] = value;
        },
    };

    const client = {
        node: 3,
        term: {
            termWidth: 132,
            termHeight: 43,
            outputEncoding: 'cp437',
            ctermVersion: null,
        },
        user,
    };
    client.acs = new ACS({ client, user });
    return client;
}

function makeDropFile(opts = {}, client = makeClient()) {
    return new DropFile(
        client,
        Object.assign({ fileType: 'BBSDEV', baseDir: os.tmpdir() }, opts)
    );
}

const bbsDevLines = (opts, client) =>
    makeDropFile(opts, client).getContents().toString('utf8').split('\r\n');

//  one field, by its spec line number
const field = (opts, n, client) => bbsDevLines(opts, client)[n - 1];

//  the mechanism and its parameter, lines 2 and 3
const comm = (opts, client) => bbsDevLines(opts, client).slice(1, 3);

describe('BBSDEV.DRP', () => {
    it('is named as the spec requires', () => {
        const dropFile = makeDropFile();
        assert.equal(dropFile.fileName, 'BBSDEV.DRP');
        assert.ok(dropFile.isSupported());
    });

    it('writes 19 CRLF terminated lines of UTF-8 with no byte-order mark', () => {
        const buf = makeDropFile().getContents();
        assert.notEqual(buf[0], 0xef, 'no byte-order mark');

        const contents = buf.toString('utf8');
        assert.equal(contents.slice(-2), '\r\n');
        assert.equal(
            contents.replace(/\r\n/g, '').indexOf('\n'),
            -1,
            'no bare line feeds'
        );

        //  every line ends with CRLF, so the last one leaves an empty tail
        const lines = contents.split('\r\n');
        assert.equal(lines.length, 20);
        assert.equal(lines[19], '');
        assert.equal(lines[Line.Version - 1], '1.0');
    });

    it('reports the session ENiGMA has', () => {
        const lines = bbsDevLines();
        const at = n => lines[n - 1];
        assert.equal(at(Line.Alias), 'testuser');
        assert.equal(at(Line.UserKey), '42');
        assert.equal(at(Line.Width), '132');
        assert.equal(at(Line.Height), '43');
        assert.equal(at(Line.Ansi), 'Y');
        assert.equal(at(Line.Rip), 'N');
        assert.equal(at(Line.Encoding), 'IBM437');
        assert.equal(at(Line.Language), 'en-US');
        assert.ok(at(Line.Software).startsWith('ENiGMA'));
        assert.equal(at(Line.AccessLevel), '30');
        assert.equal(at(Line.Node), '3');
        assert.equal(at(Line.LocalDisplay), 'N');
    });

    //  nothing will end this session, and the format says so by omission
    it('leaves the logoff deadline empty for an unlimited user', () => {
        assert.equal(field({}, Line.Logoff), '');
    });

    //
    //  The same character set reaches us under several spellings: iconv's
    //  own, a sysop's |encoding|, and the aliases iconv accepts that our
    //  table is not keyed on.
    //
    it('names the door encoding by its IANA name', () => {
        const named = (encoding, want) =>
            assert.equal(field({ encoding }, Line.Encoding), want, encoding);

        named('cp437', 'IBM437');
        named('utf8', 'UTF-8');
        named('utf-8', 'UTF-8');
        named('cp1252', 'windows-1252');
        named('ISO-8859-1', 'ISO-8859-1');
        named('latin1', 'ISO-8859-1');

        //  spellings iconv accepts that the table is not keyed on; refusing
        //  these would stop every door on the board over a spelling
        named('437', 'IBM437');
        named('850', 'IBM850');
        named('1252', 'windows-1252');
        named('csibm437', 'IBM437');
        named('win1252', 'windows-1252');
    });

    //
    //  Door decodes the door's output with the door's own |encoding|
    //  (door.js:58), not the caller's terminal encoding. A line 12 taken from
    //  the terminal tells the door to emit bytes ENiGMA will then misread.
    //
    it('states the door encoding, not the terminal encoding', () => {
        const client = makeClient();
        client.term.outputEncoding = 'utf8';

        assert.equal(field({ encoding: 'cp437' }, Line.Encoding, client), 'IBM437');
    });

    //  a name we cannot give in the registry's spelling is not one a door may
    //  accept, so the file is refused rather than written with a guess
    it('refuses to write when the encoding has no IANA name', done => {
        makeDropFile({ encoding: 'cp1006' }).createFile(err => {
            assert.ok(err, 'expected an error');
            assert.match(err.message, /cp1006/);
            done();
        });
    });

    it('reports the CTerm revision only when one was detected', () => {
        assert.equal(field({}, Line.CTerm), '');

        const syncTerm = makeClient();
        syncTerm.term.ctermVersion = '1.332';
        assert.equal(field({}, Line.CTerm, syncTerm), '1.332');
    });

    it('uses the portable role tokens', () => {
        const sysOp = makeClient();
        sysOp.user.isSysOp = () => true;
        assert.equal(field({}, Line.AccessLevel, sysOp), 'sysop');

        const coSysOp = makeClient();
        coSysOp.user.isGroupMember = groups => 'sysops' === groups;
        assert.equal(field({}, Line.AccessLevel, coSysOp), 'cosysop');
    });

    //
    //  There is no quoting or escaping in the format, so a value that could
    //  carry a line ending or a control character is cleaned first.
    //
    it('strips control characters and outer whitespace from names', () => {
        const client = makeClient();
        client.user.username = '  evil\r\nuser  ';
        assert.equal(field({}, Line.Alias, client), 'eviluser');
    });

    it('falls back to a usable alias when nothing is left of the name', () => {
        const client = makeClient();
        client.user.username = '';
        assert.equal(field({}, Line.Alias, client), 'user42');
    });
});

describe('BBSDEV.DRP comm type', () => {
    it('says stdio for a door on standard streams', () => {
        assert.deepEqual(comm({ commType: 'stdio' }), ['stdio', '']);
    });

    it('defaults to local when the caller says nothing', () => {
        assert.deepEqual(comm(), ['local', '']);
    });

    it('carries the parameter of a mode that needs one', () => {
        assert.deepEqual(comm({ commType: 'uart', commParams: '03F8,4' }), [
            'uart',
            '03F8,4',
        ]);
        assert.deepEqual(comm({ commType: 'fossil', commParams: '0' }), ['fossil', '0']);
        assert.deepEqual(comm({ commType: 'serial', commParams: '5' }), ['serial', '5']);
    });

    //  HJSON hands us a number when the sysop writes one
    it('takes a parameter written as a number', () => {
        assert.deepEqual(comm({ commType: 'fossil', commParams: 0 }), ['fossil', '0']);
        assert.deepEqual(comm({ commType: 'serial', commParams: 5 }), ['serial', '5']);
    });

    it('accepts a comm type in any case', () => {
        assert.deepEqual(comm({ commType: 'StDiO' }), ['stdio', '']);
    });

    //
    //  'local' is a positive claim in this format — the door uses its current
    //  local console — so a channel we cannot name is refused rather than
    //  reported as local. That covers io: socket, where ENiGMA shares a socket
    //  server the door dials rather than a descriptor it inherits.
    //
    describe('refuses a channel it cannot name', () => {
        const unusable = [
            { commType: 'socket' }, //  no descriptor to share
            { commType: 'serial', commParams: 'COM1' }, //  not a descriptor
            { commType: 'uart', commParams: '3F8,4' }, //  not four hex digits
            { commType: 'uart', commParams: '03F8,16' }, //  IRQ out of range
            { commType: 'fossil', commParams: '255' }, //  reserved by FSC-0015
            { commType: 'stdio', commParams: '5' }, //  takes no parameter
            { commType: 'telnet', commParams: '5' }, //  not a registered type
        ];

        unusable.forEach(opts => {
            it(`${opts.commType} ${opts.commParams || ''}`.trim(), done => {
                makeDropFile(opts).createFile(err => {
                    assert.ok(err, 'expected an error');
                    assert.match(err.message, /BBSDEV\.DRP/);
                    done();
                });
            });
        });
    });

    //
    //  ENiGMA's |io: socket| stands up a listener the door dials; the
    //  format's 'socket' is a descriptor the door inherits, with the native
    //  socket value on line 3. ENiGMA has none to pass on, so a hand-written
    //  commParams would name an fd the door never received -- refused
    //  whatever it is given, with the reason naming what a bridge should say.
    //
    describe('refuses socket outright', () => {
        ['', '5', '007'].forEach(commParams => {
            it(`refuses socket with commParams "${commParams}"`, () => {
                const { commError } = DropFile.normalizeComm(
                    'BBSDEV',
                    'socket',
                    commParams
                );
                assert.ok(commError, 'expected a commError');
                assert.match(commError, /uart/);
                assert.match(commError, /fossil/);
            });
        });

        it('is not a BBSDEV communications type at all', () => {
            assert.ok(!DropFile.validCommTypes('BBSDEV').includes('socket'));
            //  the legacy formats still report it, as they always have
            assert.ok(DropFile.validCommTypes('DOOR32').includes('socket'));
        });
    });

    //
    //  Line 13 MUST be well formed or a conforming door may reject the file,
    //  so a language that is not is refused here rather than written.
    //
    describe('the language tag', () => {
        const withLanguage = (language, cb) => {
            const previous = configModule._pushTestConfig({
                debug: { assertsEnabled: false },
                menus: { cls: false },
                general: { language },
                paths: { dropFiles: os.tmpdir() },
            });
            makeDropFile().createFile(err => {
                configModule._popTestConfig(previous);
                cb(err);
            });
        };

        it('refuses a malformed tag', done => {
            withLanguage('English (US)', err => {
                assert.ok(err, 'expected an error');
                assert.match(err.message, /BCP 47/);
                done();
            });
        });

        it('accepts a well-formed one', done => {
            withLanguage('de-DE', err => {
                assert.equal(err, null);
                done();
            });
        });
    });

    //  the legacy formats have no line for a parameter and never had one
    it('does not let the new modes reach the legacy formats', () => {
        const door32 = new DropFile(makeClient(), {
            fileType: 'DOOR32',
            baseDir: os.tmpdir(),
            commType: 'fossil',
            commParams: '0',
        });
        assert.equal(door32.commType, 'local');
        assert.equal(door32.commParams, '');

        const door32Serial = new DropFile(makeClient(), {
            fileType: 'DOOR32',
            baseDir: os.tmpdir(),
            commType: 'serial',
        });
        assert.equal(door32Serial.commType, 'serial', 'unchanged by the parameter rules');
    });
});

//
//  abracadabra decides what to tell the drop file, and hands the door the path
//  to it. The module is exercised through its prototype: constructing it wants
//  a live menu stack, and none of this touches one.
//
describe('abracadabra and BBSDEV.DRP', () => {
    const AbracadabraModule = require('../core/abracadabra.js').getModule;

    function makeModule(config) {
        const mod = Object.create(AbracadabraModule.prototype);
        mod.config = config;
        mod.warnings = [];
        mod.client = { log: { warn: (ctx, msg) => mod.warnings.push(msg) } };
        return mod;
    }

    it('says stdio for a stdio door, where the legacy formats say local', () => {
        assert.equal(
            makeModule({ dropFileType: 'BBSDEV' }).getDropFileCommType(),
            'stdio'
        );
        assert.equal(
            makeModule({ dropFileType: 'DOOR32' }).getDropFileCommType(),
            'local'
        );
    });

    it('keeps a configured mode, and leaves DropFile to judge it', () => {
        assert.equal(
            makeModule({
                dropFileType: 'BBSDEV',
                commType: 'fossil',
                commParams: '0',
            }).getDropFileCommType(),
            'fossil'
        );

        //  passed through rather than coerced: the file is refused instead
        const mod = makeModule({ dropFileType: 'BBSDEV', commType: 'telnet' });
        assert.equal(mod.getDropFileCommType(), 'telnet');
        assert.equal(mod.warnings.length, 0);
    });

    it('coerces an unknown mode for the legacy formats, as it always has', () => {
        const mod = makeModule({ dropFileType: 'DOOR32', commType: 'stdio' });
        assert.equal(mod.getDropFileCommType(), 'local');
        assert.equal(mod.warnings.length, 1);
    });

    //
    //  The door reads BBSDEV_DRP from its own environment, so losing the
    //  variable loses the drop file with nothing to fall back on.
    //
    it('puts the path in the door environment', () => {
        const mod = makeModule({ dropFileType: 'BBSDEV', cmd: '/bin/true' });
        mod.dropFile = makeDropFile({ commType: 'stdio' });

        const env = mod.doorEnvironment(mod.config.env);

        assert.equal(env.BBSDEV_DRP, mod.dropFile.fullPath);
        assert.ok(env.BBSDEV_DRP.endsWith('BBSDEV.DRP'));
        assert.ok(env.PATH, 'the rest of the environment survives');
    });

    it('leaves the environment alone for the legacy formats', () => {
        const mod = makeModule({ dropFileType: 'DOOR32', env: { FOO: 'bar' } });
        mod.dropFile = new DropFile(makeClient(), {
            fileType: 'DOOR32',
            baseDir: os.tmpdir(),
        });

        assert.deepEqual(mod.doorEnvironment(mod.config.env), { FOO: 'bar' });
    });
});

describe('CTerm revision', () => {
    it('reads the revision out of a Device Attributes reply', () => {
        assert.equal(getCtermVersion('67;84;101;114;109;1;332'), '1.332');
    });

    //  a fork appends a component rather than incrementing an existing one
    it('keeps a component a fork appended', () => {
        assert.equal(getCtermVersion('67;84;101;114;109;1;332;1'), '1.332.1');
    });

    it('reports nothing when the reply carries no usable revision', () => {
        assert.equal(getCtermVersion('67;84;101;114;109'), null);
        assert.equal(getCtermVersion('67;84;101;114;109;1;33x'), null);
        assert.equal(getCtermVersion('67;84;101;114;109;01;332'), null);
    });
});
