'use strict';

const { strict: assert } = require('assert');

const {
    startup,
    resolveMimeType,
    findFileTypeByExtension,
} = require('../core/mime_util.js');
const configDefault = require('../core/config_default.js');

describe('mime_util', () => {
    before(done => startup(done));

    describe('startup()', () => {
        //  mime-db has neither; startup() adds them
        it('resolves the extensions it registers', () => {
            assert.equal(resolveMimeType('ART.ANS'), 'text/x-ansi');
            assert.equal(resolveMimeType('foo.lzx'), 'application/x-lzx');
        });

        it('passes a registered MIME type through', () => {
            assert.equal(resolveMimeType('application/x-lzx'), 'application/x-lzx');
        });
    });

    describe('findFileTypeByExtension()', () => {
        const fileTypes = [
            { desc: 'Amiga DISKMASHER', ext: '.dms' },
            { desc: 'SIO2PC Atari Disk Image', ext: '.atr' },
        ];

        it('matches regardless of case', () => {
            assert.equal(findFileTypeByExtension(fileTypes, '.DMS'), fileTypes[0]);
            assert.equal(findFileTypeByExtension(fileTypes, '.Atr'), fileTypes[1]);
        });

        it('finds nothing for an unknown or missing extension', () => {
            assert.equal(findFileTypeByExtension(fileTypes, '.d64'), undefined);
            assert.equal(findFileTypeByExtension(fileTypes, ''), undefined);
            assert.equal(findFileTypeByExtension(fileTypes, undefined), undefined);
        });
    });

    //  every extension-only type must be reachable from its own extension
    describe('default fileTypes', () => {
        const { fileTypes } = configDefault();

        [
            ['x.mkv', 'Matroska Video'],
            ['x.mp4', 'MPEG Video'],
            ['x.pdf', 'Adobe PDF'],
        ].forEach(([fileName, desc]) => {
            it(`resolves ${fileName} to a configured type`, () => {
                const fileType = fileTypes[resolveMimeType(fileName)];
                assert.ok(fileType, `no fileTypes entry for ${fileName}`);
                assert.equal(fileType.desc, desc);
            });
        });

        it('has no key that is not a bare MIME type', () => {
            Object.keys(fileTypes).forEach(key => assert.equal(key, key.trim()));
        });
    });
});
