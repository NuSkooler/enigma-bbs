'use strict';

const { strict: assert } = require('assert');

const { glyphSmiliesAllowed, smiliesToGlyphs } = require('../core/mrc_smilies.js');

describe('MRC smilies', () => {
    const client = rip => ({ terminalSupports: q => rip && q === 'rip' });

    it('turns smilies into the CP437 glyph bytes', () => {
        assert.equal(
            smiliesToGlyphs('hi :) there :D ok =)'),
            'hi \x01 there \x02 ok \x02'
        );
        assert.equal(smiliesToGlyphs('nothing here'), 'nothing here');
    });

    it('follows the user preference for a caller without RIPscrip', () => {
        assert.equal(glyphSmiliesAllowed({ showSmilies: true }, client(false)), true);
        assert.equal(glyphSmiliesAllowed({ showSmilies: false }, client(false)), false);
        assert.equal(glyphSmiliesAllowed(undefined, client(false)), false);
    });

    it('never uses the glyph bytes for a RIPscrip caller (#989)', () => {
        assert.equal(glyphSmiliesAllowed({ showSmilies: true }, client(true)), false);
    });

    it('asks for the rip capability and nothing else', () => {
        const asked = [];
        glyphSmiliesAllowed(
            { showSmilies: true },
            {
                terminalSupports: q => {
                    asked.push(q);
                    return false;
                },
            }
        );
        assert.deepEqual(asked, ['rip']);
    });

    it('a real session with the rip layer answers the capability', () => {
        const { createEmulation, createLayer } = require('../core/term');
        const emulation = createEmulation('ansi');
        assert.equal(emulation.supports('rip', {}), false);
        emulation.addLayer(createLayer('rip'));
        assert.equal(emulation.supports('rip', {}), true);
    });
});
