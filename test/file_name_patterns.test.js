'use strict';

const { strict: assert } = require('assert');

const configDefault = require('../core/config_default.js');

//  fileBase.fileNamePatterns pick the description files out of an archive
describe('default description file patterns', () => {
    const { desc, descLong } = configDefault().fileBase.fileNamePatterns;
    const matches = (patterns, name) =>
        patterns.some(pattern => new RegExp(pattern, 'i').test(name));

    it('find description files', () => {
        ['FILE_ID.DIZ', 'sub/file_id.diz', 'FILE_ID.ANS', 'DESCRIPT.ION'].forEach(name =>
            assert.ok(matches(desc, name), name)
        );
        ['RELEASE.NFO', 'README', 'readme.txt', 'READ.ME', 'RELEASE-INFO.ASC'].forEach(
            name => assert.ok(matches(descLong, name), name)
        );
    });

    //  a pattern's dot must be literal: Amiga archives hold a .info icon per file
    it('do not take Amiga .info icons for an NFO', () => {
        ['.info', 'Disk.info', 'README.info', 'FILE_IDXDIZ'].forEach(name => {
            assert.ok(!matches(desc, name), name);
            assert.ok(!matches(descLong, name), name);
        });
    });
});
