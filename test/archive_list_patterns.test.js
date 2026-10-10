'use strict';

const { strict: assert } = require('assert');

const configDefault = require('../core/config_default.js');

//  Runs an archiver's |list.entryMatch| over captured listing output the
//  way ArchiveUtil.listEntries() does, returning [ byteSize, fileName ] pairs
const listWith = (archiverName, output) => {
    const { list } = configDefault().archives.archivers[archiverName];
    const re = new RegExp(list.entryMatch, 'gm');
    return [...output.matchAll(re)].map(m => [parseInt(m[1]), m[2]]);
};

describe('archiver list patterns', () => {
    describe('7Zip', () => {
        //  7za l, 7-Zip 23.01 and 26.02
        it('lists every entry of a solid archive', () => {
            const output = [
                '   Date      Time    Attr         Size   Compressed  Name',
                '------------------- ----- ------------ ------------  ------------------------',
                '2026-10-09 16:55:51 D....            0            0  src',
                '2026-10-09 16:55:03 ....A           17     20005194  src/README',
                '2026-10-09 16:55:03 ....A            4               src/RELEASE.NFO',
                '2026-10-09 16:55:51 ....A     20000000               src/large.bin',
                '------------------- ----- ------------ ------------  ------------------------',
                '2026-10-09 16:55:51           20000021     20005194  3 files, 1 folders',
            ].join('\r\n');

            assert.deepEqual(listWith('7Zip', output), [
                [0, 'src'],
                [17, 'src/README'],
                [4, 'src/RELEASE.NFO'],
                [20000000, 'src/large.bin'],
            ]);
        });

        it('keeps spaces in names', () => {
            const output =
                '2026-10-09 16:55:03 ....A         4053         3279  Disk 1 of 2.adf';
            assert.deepEqual(listWith('7Zip', output), [[4053, 'Disk 1 of 2.adf']]);
        });
    });
});
