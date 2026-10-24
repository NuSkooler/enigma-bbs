'use strict';

//
//  ENIGMA_UNARC_ARCHIVERS (#906): the Docker image ships unarc but neither
//  unlzx nor atr, and names the archivers unarc should stand in for. Without
//  the variable the defaults must be exactly what they were.
//

const { strict: assert } = require('assert');

const _ = require('lodash');

const configDefault = require('../core/config_default.js');
const ConfigLoader = require('../core/config_loader.js');

const UNARC = '@reference:archives.archivers.Unarc';

describe('ENIGMA_UNARC_ARCHIVERS', () => {
    let saved;

    beforeEach(() => {
        saved = process.env.ENIGMA_UNARC_ARCHIVERS;
    });

    afterEach(() => {
        if (undefined === saved) {
            delete process.env.ENIGMA_UNARC_ARCHIVERS;
        } else {
            process.env.ENIGMA_UNARC_ARCHIVERS = saved;
        }
    });

    const archiversWith = value => {
        if (undefined === value) {
            delete process.env.ENIGMA_UNARC_ARCHIVERS;
        } else {
            process.env.ENIGMA_UNARC_ARCHIVERS = value;
        }
        return configDefault().archives.archivers;
    };

    it('leaves every archiver alone when unset or empty', () => {
        for (const value of [undefined, '', ' , ']) {
            const archivers = archiversWith(value);
            assert.equal(archivers.Atr.list.cmd, 'atr');
            assert.equal(archivers.Lzx.list.cmd, 'unlzx');
            assert.equal(archivers.Rar.list.cmd, 'unrar');
        }
    });

    it('points the named archivers at Unarc and no others', () => {
        const archivers = archiversWith('Atr, Lzx');
        assert.equal(archivers.Atr, UNARC);
        assert.equal(archivers.Lzx, UNARC);
        assert.equal(archivers.Rar.list.cmd, 'unrar');
        assert.equal(archivers.Unarc.list.cmd, 'unarc');
    });

    it('ignores names that are not archivers, and Unarc itself', () => {
        const archivers = archiversWith('lzx,NoSuchThing,Unarc');
        assert.equal(archivers.Lzx.list.cmd, 'unlzx');
        assert(!('lzx' in archivers));
        assert(!('NoSuchThing' in archivers));
        assert.equal(archivers.Unarc.list.cmd, 'unarc');
    });

    it('resolves to the Unarc archiver once loaded, and config.hjson still wins', () => {
        process.env.ENIGMA_UNARC_ARCHIVERS = 'Atr,Lzx';

        //  the merge config.js does, what the operator wrote over the
        //  defaults, then the loader's @reference resolution
        const merged = _.merge(configDefault(), {
            archives: { archivers: { Lzx: { list: { cmd: 'my-unlzx' } } } },
        });
        const resolved = new ConfigLoader()._resolveAtSpecs(merged);

        assert.equal(resolved.archives.archivers.Atr.list.cmd, 'unarc');
        assert.equal(resolved.archives.archivers.Atr.list.outputFormat, 'json');
        assert.equal(resolved.archives.archivers.Lzx.list.cmd, 'my-unlzx');
    });
});
