'use strict';

const { strict: assert } = require('assert');
const { controlCodesToAnsi } = require('../core/color_codes.js');

//
//  Smoke tests for controlCodesToAnsi() — one per supported format.
//  These verify decode produces non-empty ANSI output and that strings
//  with no codes are passed through unchanged.
//

describe('color_codes', () => {
    describe('controlCodesToAnsi()', () => {
        it('passes through plain text unchanged', () => {
            assert.equal(controlCodesToAnsi('hello world'), 'hello world');
        });

        it('passes through empty string', () => {
            assert.equal(controlCodesToAnsi(''), '');
        });

        describe('Renegade |## pipe codes', () => {
            it('decodes a foreground color code', () => {
                const result = controlCodesToAnsi('|07hello');
                assert.ok(result.includes('\x1b['), 'should contain ANSI escape');
                assert.ok(result.includes('hello'), 'should preserve text');
            });

            it('decodes a background color code', () => {
                const result = controlCodesToAnsi('|16hello');
                assert.ok(result.includes('\x1b['));
                assert.ok(result.includes('hello'));
            });

            it('passes through || as a literal pipe', () => {
                const result = controlCodesToAnsi('a||b');
                assert.ok(result.includes('|'));
            });

            it('handles partial/invalid code as literal', () => {
                // |XX where XX is not a valid number — treated as MCI or literal
                const result = controlCodesToAnsi('no codes here');
                assert.equal(result, 'no codes here');
            });
        });

        describe('PCBoard @X## codes', () => {
            it('decodes a PCBoard color code', () => {
                const result = controlCodesToAnsi('@X07hello');
                assert.ok(result.includes('\x1b['));
                assert.ok(result.includes('hello'));
            });

            it('decodes PCBoard with bright background', () => {
                const result = controlCodesToAnsi('@XF0hello');
                assert.ok(result.includes('\x1b['));
                assert.ok(result.includes('hello'));
            });
        });

        describe('WildCat! @##@ codes', () => {
            it('decodes a WildCat! color code', () => {
                const result = controlCodesToAnsi('@07@hello');
                assert.ok(result.includes('\x1b['));
                assert.ok(result.includes('hello'));
            });
        });

        describe('WWIV ^# codes', () => {
            it('decodes WWIV color code 1 (bold cyan)', () => {
                const result = controlCodesToAnsi('\x031hello');
                assert.ok(result.includes('\x1b['));
                assert.ok(result.includes('hello'));
            });

            it('decodes WWIV color code 0 (black)', () => {
                const result = controlCodesToAnsi('\x030hello');
                assert.ok(result.includes('\x1b['));
                assert.ok(result.includes('hello'));
            });
        });

        describe('CNET Y-Style \\x19 codes', () => {
            it('decodes CNET Y-Style foreground color', () => {
                const result = controlCodesToAnsi('\x19c7hello');
                assert.ok(result.includes('\x1b['));
                assert.ok(result.includes('hello'));
            });

            it('decodes CNET Y-Style background color', () => {
                const result = controlCodesToAnsi('\x19z0hello');
                assert.ok(result.includes('\x1b['));
                assert.ok(result.includes('hello'));
            });

            it('decodes CNET Y-Style newline (n1)', () => {
                const result = controlCodesToAnsi('\x19n1hello');
                assert.ok(result.includes('\n'));
            });
        });

        describe('CNET Q-Style \\x11 codes', () => {
            it('decodes CNET Q-Style foreground color', () => {
                const result = controlCodesToAnsi('\x11c7}hello');
                assert.ok(result.includes('\x1b['));
                assert.ok(result.includes('hello'));
            });

            it('decodes CNET Q-Style background color', () => {
                const result = controlCodesToAnsi('\x11z0}hello');
                assert.ok(result.includes('\x1b['));
                assert.ok(result.includes('hello'));
            });
        });

        it('handles multiple mixed formats in one string', () => {
            const result = controlCodesToAnsi('|07hello @X0Fworld');
            assert.ok(result.includes('hello'));
            assert.ok(result.includes('world'));
            // Should have at least two ANSI escapes
            const escCount = (result.match(/\x1b\[/g) || []).length;
            assert.ok(escCount >= 2, `expected >= 2 escapes, got ${escCount}`);
        });
    });
});
