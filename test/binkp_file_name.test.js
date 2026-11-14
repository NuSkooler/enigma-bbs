'use strict';

const { strict: assert } = require('assert');

const {
    MAX_NAME_BYTES,
    decodeWireName,
    isPlainFileName,
    plainFileName,
} = require('../core/binkp/file_name.js');

describe('binkp/file_name — decodeWireName', () => {
    it('leaves a name without escapes untouched', () => {
        assert.equal(decodeWireName('0000fff0.pkt'), '0000fff0.pkt');
        assert.equal(decodeWireName('NODELIST.Z45'), 'NODELIST.Z45');
    });

    it('decodes \\xHH escapes, either case of hex digit', () => {
        assert.equal(decodeWireName('my\\x20file.zip'), 'my file.zip');
        assert.equal(decodeWireName('a\\x5Cb'), 'a\\b');
        assert.equal(decodeWireName('a\\x5cb'), 'a\\b');
    });

    it('decodes the bare \\HH form binkd also accepts', () => {
        assert.equal(decodeWireName('my\\20file.zip'), 'my file.zip');
    });

    it('keeps a backslash that does not start an escape', () => {
        assert.equal(decodeWireName('a\\zb'), 'a\\zb');
        assert.equal(decodeWireName('a\\x2'), 'a\\x2');
        assert.equal(decodeWireName('trailing\\'), 'trailing\\');
    });

    it('reads escaped bytes as UTF-8 when they form valid UTF-8', () => {
        assert.equal(decodeWireName('caf\\xc3\\xa9.txt'), 'café.txt');
    });

    it('falls back to Latin-1 when the escaped bytes are not UTF-8', () => {
        assert.equal(decodeWireName('caf\\xe9.txt'), 'caf\u00e9.txt');
    });

    it('keeps unescaped non-ASCII text alongside escapes', () => {
        assert.equal(decodeWireName('café\\x20menu.txt'), 'café menu.txt');
    });

    it('returns an empty string for anything that is not a string', () => {
        assert.equal(decodeWireName(undefined), '');
        assert.equal(decodeWireName(null), '');
        assert.equal(decodeWireName(42), '');
    });
});

describe('binkp/file_name — isPlainFileName', () => {
    it('accepts ordinary 8.3 and long names', () => {
        for (const name of [
            '0000fff0.pkt',
            '00010002.mo0',
            'NODELIST.Z45',
            'a8f3c2d1.tic',
            'some-long_file.name.with.dots.tar.gz',
            'my file.zip',
            'café.txt',
            'x',
        ]) {
            assert.ok(isPlainFileName(name), name);
        }
    });

    it('refuses an empty name', () => {
        assert.ok(!isPlainFileName(''));
        assert.ok(!isPlainFileName(undefined));
        assert.ok(!isPlainFileName(null));
    });

    it('refuses forward and back slashes', () => {
        assert.ok(!isPlainFileName('a/b'));
        assert.ok(!isPlainFileName('/abs.pkt'));
        assert.ok(!isPlainFileName('a\\b'));
        assert.ok(!isPlainFileName('C:\\x.pkt'));
    });

    it('refuses a colon', () => {
        assert.ok(!isPlainFileName('C:x.pkt'));
        assert.ok(!isPlainFileName('file.pkt:stream'));
    });

    it('refuses . and .. and any other leading dot', () => {
        assert.ok(!isPlainFileName('.'));
        assert.ok(!isPlainFileName('..'));
        assert.ok(!isPlainFileName('.hidden'));
    });

    it('accepts dots that are not leading', () => {
        assert.ok(isPlainFileName('a..b'));
        assert.ok(isPlainFileName('name.'));
    });

    it('refuses NUL, other control characters and DEL', () => {
        assert.ok(!isPlainFileName('a\0b'));
        assert.ok(!isPlainFileName('a\nb'));
        assert.ok(!isPlainFileName('a\tb'));
        assert.ok(!isPlainFileName('a\x1bb'));
        assert.ok(!isPlainFileName('a\x7fb'));
    });

    it('refuses a name longer than the file system allows', () => {
        assert.ok(isPlainFileName('a'.repeat(MAX_NAME_BYTES)));
        assert.ok(!isPlainFileName('a'.repeat(MAX_NAME_BYTES + 1)));
        //  Counted in bytes, not characters.
        assert.ok(!isPlainFileName('é'.repeat(Math.ceil(MAX_NAME_BYTES / 2) + 1)));
    });
});

describe('binkp/file_name — plainFileName', () => {
    it('passes an ordinary wire name through unchanged', () => {
        assert.equal(plainFileName('0000fff0.pkt'), '0000fff0.pkt');
        assert.equal(plainFileName('NODELIST.Z45'), 'NODELIST.Z45');
    });

    it('decodes a name binkd escaped because it has a space', () => {
        assert.equal(plainFileName('my\\x20file.zip'), 'my file.zip');
    });

    it('returns null for a name with path components', () => {
        assert.equal(plainFileName('../../x.pkt'), null);
        assert.equal(plainFileName('..\\..\\x.pkt'), null);
        assert.equal(plainFileName('/etc/x'), null);
        assert.equal(plainFileName('sub/x.pkt'), null);
    });

    it('returns null when the path components are escaped', () => {
        assert.equal(plainFileName('\\x2e\\x2e\\x2fx.pkt'), null);
        assert.equal(plainFileName('a\\x2fb'), null);
        assert.equal(plainFileName('a\\x5cb'), null);
        assert.equal(plainFileName('a\\2fb'), null);
        assert.equal(plainFileName('\\x2e\\x2e'), null);
    });

    it('returns null for an escaped NUL or control character', () => {
        assert.equal(plainFileName('a\\x00b.pkt'), null);
        assert.equal(plainFileName('a\\x0ab.pkt'), null);
    });

    it('returns null for a leading dot, escaped or not', () => {
        assert.equal(plainFileName('.hidden'), null);
        assert.equal(plainFileName('\\x2ehidden'), null);
        assert.equal(plainFileName('.'), null);
        assert.equal(plainFileName('..'), null);
    });

    it('returns null for an empty name', () => {
        assert.equal(plainFileName(''), null);
        assert.equal(plainFileName(undefined), null);
    });
});
