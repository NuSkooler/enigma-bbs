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

    describe('Rar', () => {
        //  unrar l, RARLAB UNRAR 6.21 (Debian bookworm non-free, as the Docker
        //  image ships it since #905)
        it('lists the entries of a RARLAB unrar listing', () => {
            const output = [
                '',
                'UNRAR 6.21 freeware      Copyright (c) 1993-2023 Alexander Roshal',
                '',
                'Archive: /fixtures/acid-70a.rar',
                'Details: RAR 4',
                '',
                ' Attributes      Size     Date    Time   Name',
                '----------- ---------  ---------- -----  ----',
                '    ...D...         0  1998-07-09 17:36  AcidView',
                '    ..A....      3544  1998-04-26 11:32  AcidView/AcidAnsi.class',
                '    ..A....    142961  1998-07-01 18:26  ass-psycho.jpg',
                '    ..A....       375  1998-07-09 18:24  file_id.diz',
                '----------- ---------  ---------- -----  ----',
                '              146880                    4',
                '',
            ].join('\n');

            assert.deepEqual(listWith('Rar', output), [
                [0, 'AcidView'],
                [3544, 'AcidView/AcidAnsi.class'],
                [142961, 'ass-psycho.jpg'],
                [375, 'file_id.diz'],
            ]);
        });
    });
});
