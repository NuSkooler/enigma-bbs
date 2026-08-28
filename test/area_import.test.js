'use strict';

const { strict: assert } = require('assert');
const fs = require('fs');
const paths = require('path');

const {
    AreaListFormat,
    parseAreaList,
    sniffAreaListFormat,
    isValidAreaTag,
    validateUplinks,
    localAreaTagFor,
    buildAreaImportRecords,
    buildFileAreaImportRecords,
} = require('../core/area_import.js');

const FixtureDir = paths.join(__dirname, 'fixtures', 'area_lists');

const readFixture = name => fs.readFileSync(paths.join(FixtureDir, name), 'utf8');

// ─── Format sniffing over real network info packs ────────────────────────────
//
//  Expected values are measured against the committed fixtures; see
//  test/fixtures/area_lists/README.md for provenance and what each one shows.
//
describe('area_import: real network area lists', () => {
    const cases = [
        //  file                     format                    entries
        ['fsxnet-2025.na', AreaListFormat.NA, 13],
        ['fsxnet-2018.na', AreaListFormat.NA, 2],
        ['retronet-msg.na', AreaListFormat.NA, 18],
        ['dorenet-msg.na', AreaListFormat.NA, 15],
        ['agoranet.na', AreaListFormat.NA, 10],
        ['araknet-msg.na', AreaListFormat.NA, 9],
        ['zer0net-msg.na', AreaListFormat.NA, 9],
        //  file echo list shipped as plain "TAG DESC" -- the opposite convention
        ['araknet-file.na', AreaListFormat.NA, 3],
        //  ".na" extension, FILEBONE content
        ['fsxnet-file-2025.na', AreaListFormat.FileBone, 10],
        ['fsxnet-file-2018.na', AreaListFormat.FileBone, 8],
        ['agoranet-file.na', AreaListFormat.FileBone, 6],
        ['zer0net-file.na', AreaListFormat.FileBone, 3],
        //  reversed columns: recognized, deliberately not parsed
        ['spooknet-baselist.txt', AreaListFormat.DescFirst, 0],
    ];

    cases.forEach(([fixture, expectFormat, expectCount]) => {
        it(`${fixture} -> ${expectFormat} (${expectCount} entries)`, () => {
            const result = parseAreaList(readFixture(fixture));
            assert.equal(result.format, expectFormat);
            assert.equal(result.entries.length, expectCount);
        });
    });

    it('never emits a comment character as an area tag (#733)', () => {
        //  Before the shared parser, a leading ';' or '%' line produced an
        //  entry whose tag was the comment character itself.
        fs.readdirSync(FixtureDir)
            .filter(f => f !== 'README.md')
            .forEach(f => {
                const result = parseAreaList(readFixture(f));
                result.entries.forEach(entry => {
                    assert.ok(
                        isValidAreaTag(entry.ftnTag),
                        `${f}: bad tag "${entry.ftnTag}"`
                    );
                    assert.ok(
                        ![';', '%', '#'].includes(entry.ftnTag),
                        `${f}: comment char imported as an area tag`
                    );
                });
            });
    });

    it('never emits "Area" as an area tag from a FILEBONE list (#733)', () => {
        ['fsxnet-file-2025.na', 'fsxnet-file-2018.na', 'agoranet-file.na'].forEach(f => {
            const result = parseAreaList(readFixture(f));
            result.entries.forEach(entry => {
                assert.notEqual(entry.ftnTag.toLowerCase(), 'area');
            });
        });
    });
});

// ─── Comment handling ────────────────────────────────────────────────────────

describe('area_import: comment stripping', () => {
    it("strips ';' comments", () => {
        const result = parseAreaList(
            [
                '; ==========================',
                ';  FSXNet Echo List',
                '; ==========================',
                'FSX_GEN              General Chat',
            ].join('\n')
        );
        assert.equal(result.format, AreaListFormat.NA);
        assert.deepEqual(
            result.entries.map(e => e.ftnTag),
            ['FSX_GEN']
        );
        assert.equal(result.stats.commentLines, 3);
    });

    it("strips '%' comments -- fsxNet used these before switching to ';'", () => {
        const result = parseAreaList(
            ['% Agoranet Echo List', '%', 'AGN_GEN              General Chat'].join('\n')
        );
        assert.equal(result.format, AreaListFormat.NA);
        assert.deepEqual(
            result.entries.map(e => e.ftnTag),
            ['AGN_GEN']
        );
        assert.equal(result.stats.commentLines, 2);
    });

    it("strips '#' comments", () => {
        const result = parseAreaList('# a comment\nFSX_GEN  General Chat');
        assert.deepEqual(
            result.entries.map(e => e.ftnTag),
            ['FSX_GEN']
        );
    });

    it('treats an indented comment character as a comment', () => {
        const result = parseAreaList('    ; indented\nFSX_GEN  General Chat');
        assert.equal(result.entries.length, 1);
        assert.equal(result.stats.commentLines, 1);
    });

    it('does not strip a comment character mid-line', () => {
        const result = parseAreaList('FSX_GEN  Chat; and more');
        assert.equal(result.entries[0].name, 'Chat; and more');
    });
});

// ─── Whitespace / line ending tolerance ──────────────────────────────────────

describe('area_import: separator and line ending tolerance', () => {
    it('accepts tabs as separators', () => {
        const result = parseAreaList('ARK_CYBER\t\t\t\t  Araknet: Cyber Culture');
        assert.equal(result.entries[0].ftnTag, 'ARK_CYBER');
        assert.equal(result.entries[0].name, 'Araknet: Cyber Culture');
    });

    it('accepts CRLF line endings and trailing whitespace', () => {
        const result = parseAreaList('FSX_GEN  General Chat   \r\nFSX_BBS  BBS Dev\r\n');
        assert.equal(result.entries.length, 2);
        assert.equal(result.entries[0].name, 'General Chat');
    });

    it('accepts a missing final newline', () => {
        const result = parseAreaList('FSX_GEN  General Chat\nFSX_BBS  BBS Dev');
        assert.equal(result.entries.length, 2);
        assert.equal(result.entries[1].ftnTag, 'FSX_BBS');
    });

    it('accepts bare CR line endings', () => {
        const result = parseAreaList('FSX_GEN  General Chat\rFSX_BBS  BBS Dev');
        assert.equal(result.entries.length, 2);
    });

    it('strips a leading BOM rather than corrupting the first tag', () => {
        const result = parseAreaList('﻿FSX_GEN  General Chat');
        assert.equal(result.entries[0].ftnTag, 'FSX_GEN');
    });
});

// ─── Refuse to guess ─────────────────────────────────────────────────────────

describe('area_import: refuses rather than guessing', () => {
    it('reports reversed columns instead of importing 35 wrong entries', () => {
        const result = parseAreaList(readFixture('spooknet-baselist.txt'));
        assert.equal(result.format, AreaListFormat.DescFirst);
        assert.equal(result.entries.length, 0);
        //  every data line accounted for, none silently dropped
        assert.equal(result.skipped.length, result.stats.dataLines);
    });

    it('rejects English prose as an unrecognized format', () => {
        //  HappyNet ships its area list this way; there is nothing to parse
        const result = parseAreaList(
            [
                'Welcome to the network! The following echos are carried by all',
                'systems. Please ask your uplink to connect you to the ones you',
                'would like to receive on your board.',
            ].join('\n')
        );
        assert.equal(result.format, AreaListFormat.Unknown);
        assert.equal(result.entries.length, 0);
    });

    it('returns unknown for a file that is only comments', () => {
        const result = parseAreaList('; nothing here\n;\n');
        assert.equal(result.format, AreaListFormat.Unknown);
        assert.equal(result.entries.length, 0);
    });

    it('returns unknown for an empty file', () => {
        const result = parseAreaList('');
        assert.equal(result.format, AreaListFormat.Unknown);
        assert.equal(result.entries.length, 0);
    });

    it('prefers a normal list when both columns look tag-shaped', () => {
        //  all-upper-case descriptions must not read as reversed columns
        const result = parseAreaList('FSX_GEN  GENERAL\nFSX_BBS  SUPPORT');
        assert.equal(result.format, AreaListFormat.NA);
        assert.deepEqual(
            result.entries.map(e => e.ftnTag),
            ['FSX_GEN', 'FSX_BBS']
        );
    });

    it('skips a stray FILEBONE line inside an otherwise plain list', () => {
        const result = parseAreaList(
            [
                'FSX_GEN  General Chat',
                'FSX_BBS  BBS Dev',
                'FSX_MYS  Mystic Support',
                'Area FSX_NODE  0  !  Weekly Nodelist',
            ].join('\n')
        );
        assert.equal(result.format, AreaListFormat.NA);
        assert.deepEqual(
            result.entries.map(e => e.ftnTag),
            ['FSX_GEN', 'FSX_BBS', 'FSX_MYS']
        );
        assert.equal(result.skipped.length, 1);
    });

    it('skips a line with a tag but no description', () => {
        const result = parseAreaList('FSX_GEN  General Chat\nFSX_BBS');
        assert.equal(result.entries.length, 1);
        assert.equal(result.skipped.length, 1);
        assert.equal(result.skipped[0].lineNumber, 2);
    });
});

// ─── AREAS.BBS ───────────────────────────────────────────────────────────────

describe('area_import: AREAS.BBS', () => {
    const parseBbs = data => parseAreaList(data, { format: AreaListFormat.AreasBbs });

    it('takes the second token as the tag and the rest as uplinks', () => {
        const result = parseBbs('/path/to/area  FSX_GEN  21:1/100 21:1/101');
        assert.equal(result.entries.length, 1);
        assert.equal(result.entries[0].ftnTag, 'FSX_GEN');
        assert.deepEqual(result.entries[0].uplinks, ['21:1/100', '21:1/101']);
        assert.equal(result.entries[0].name, 'Area: FSX_GEN');
    });

    it('accepts comma separated uplinks', () => {
        const result = parseBbs('CODE FSX_GEN 21:1/100,21:1/101');
        assert.deepEqual(result.entries[0].uplinks, ['21:1/100', '21:1/101']);
    });

    it('strips comments here too', () => {
        const result = parseBbs('; AREAS.BBS\nCODE FSX_GEN 21:1/100');
        assert.equal(result.entries.length, 1);
    });

    it('is never chosen by sniffing', () => {
        //  cannot be told from a plain area list by shape; must be asked for
        const { format } = sniffAreaListFormat('CODE FSX_GEN 21:1/100');
        assert.notEqual(format, AreaListFormat.AreasBbs);
    });
});

// ─── Tag validation ──────────────────────────────────────────────────────────

describe('area_import: area tag validation', () => {
    [
        ['FSX_GEN', true],
        ['DN-ADMI', true],
        ['0N-BBS', true],
        ['SOME.AREA', true],
        ['netmail', true], //  lower case is accepted; tags compare case-insensitively
        [';', false],
        ['%', false],
        ['Aliens,', false],
        ['[ADMIN]', false],
        ['--------', false],
        ['has space', false],
        ['', false],
        ['A'.repeat(65), false],
    ].forEach(([tag, expected]) => {
        it(`${JSON.stringify(tag)} -> ${expected}`, () => {
            assert.equal(isValidAreaTag(tag), expected);
        });
    });
});

// ─── Record building / uplink validation ─────────────────────────────────────

describe('area_import: record builders', () => {
    it('lower cases the FTN tag for the local area tag', () => {
        assert.equal(localAreaTagFor('FSX_GEN'), 'fsx_gen');
    });

    it('builds conference and FTN network records', () => {
        const entries = [{ ftnTag: 'FSX_GEN', name: 'General Chat' }];
        const records = buildAreaImportRecords(entries, {
            confTag: 'fsxnet',
            networkName: 'fsxnet',
            uplinks: ['21:1/100'],
        });

        assert.deepEqual(records.messageConferences.fsxnet.areas.fsx_gen, {
            name: 'General Chat',
            desc: 'General Chat',
        });
        assert.deepEqual(records.messageNetworks.ftn.areas.fsx_gen, {
            network: 'fsxnet',
            tag: 'FSX_GEN',
            uplinks: ['21:1/100'],
        });
    });

    it('prefers per-entry uplinks (AREAS.BBS) over the fallback', () => {
        const entries = [
            { ftnTag: 'FSX_GEN', name: 'General', uplinks: ['21:1/101'] },
            { ftnTag: 'FSX_BBS', name: 'BBS' },
        ];
        const records = buildAreaImportRecords(entries, {
            confTag: 'fsxnet',
            networkName: 'fsxnet',
            uplinks: ['21:1/100'],
        });
        assert.deepEqual(records.messageNetworks.ftn.areas.fsx_gen.uplinks, ['21:1/101']);
        assert.deepEqual(records.messageNetworks.ftn.areas.fsx_bbs.uplinks, ['21:1/100']);
    });

    it('omits FTN network records when no network is given', () => {
        const records = buildAreaImportRecords([{ ftnTag: 'LOCAL', name: 'Local' }], {
            confTag: 'local',
        });
        assert.deepEqual(records.messageNetworks.ftn.areas, {});
        assert.ok(records.messageConferences.local.areas.local);
    });

    it('validates uplinks as FTN addresses', () => {
        assert.equal(validateUplinks(['21:1/100']), true);
        assert.equal(validateUplinks(['21:1/100', '21:1/101.1']), true);
        assert.equal(validateUplinks(['not-an-address']), false);
        assert.equal(validateUplinks([]), false);
        assert.equal(validateUplinks('21:1/100'), false);
    });
});

// ─── File base area records ──────────────────────────────────────────────────

describe('area_import: file base record builder', () => {
    const build = fixture =>
        buildFileAreaImportRecords(parseAreaList(readFixture(fixture)).entries);

    it('builds the same records the FileGate/FILEBONE regex used to', () => {
        //  Long standing oputil behaviour: the area tag comes from the
        //  description and the storage tag combines description and FTN tag.
        //  Changing either would orphan already-imported storage directories.
        const records = build('fsxnet-file-2025.na');

        assert.equal(records.count, 10);
        assert.deepEqual(records.areas.weekly_nodelist_fsx_net, {
            name: 'Weekly Nodelist (fsxNet)',
            desc: 'Weekly Nodelist (fsxNet)',
            storageTags: ['weekly_nodelist_fsx_net__fsx_node'],
        });
        assert.equal(records.storageTags.weekly_nodelist_fsx_net__fsx_node, 'FSX_NODE');
    });

    it('handles a file echo list shipped as a plain TAG/description list', () => {
        //  ArakNet ships its FILE echoes this way -- the opposite convention
        //  from the FILEBONE lists most networks use. This used to import
        //  nothing at all.
        const records = build('araknet-file.na');

        assert.equal(records.count, 3);
        assert.equal(
            records.storageTags.araknet_infopack_sysop_access_only__ark_info,
            'ARK_INFO'
        );
    });

    it('produces nothing from a reversed-column list', () => {
        const parsed = parseAreaList(readFixture('spooknet-baselist.txt'));
        assert.equal(parsed.format, AreaListFormat.DescFirst);
        assert.equal(buildFileAreaImportRecords(parsed.entries).count, 0);
    });

    it('skips an entry that cannot produce a usable tag', () => {
        //  a description of only punctuation sanitizes away to nothing
        const records = buildFileAreaImportRecords([
            { ftnTag: 'FSX_NODE', name: '...', lineNumber: 1 },
            { ftnTag: 'FSX_INFO', name: 'Infopack', lineNumber: 2 },
        ]);
        assert.equal(records.count, 1);
        assert.equal(records.skipped.length, 1);
        assert.ok(records.areas.infopack);
    });

    it('accepts a multi-digit level and flags beyond ! and *&', () => {
        //  the regex this replaced allowed a single digit and only "!" / "*&"
        const parsed = parseAreaList(
            [
                'Area FSX_NODE  10   !R    Weekly Nodelist',
                'Area FSX_INFO  0    *&    Weekly Infopack',
                'Area FSX_MYST  100  !     Mystic BBS Software',
            ].join('\n')
        );
        assert.equal(parsed.format, AreaListFormat.FileBone);
        assert.equal(buildFileAreaImportRecords(parsed.entries).count, 3);
    });

    it('does not treat an English sentence starting with "Area" as an entry', () => {
        //  the numeric level requirement is what keeps prose out
        const parsed = parseAreaList(
            [
                'Area 51 is a place',
                'Area codes are not area tags',
                'Area FSX_NODE 0 ! Weekly Nodelist',
            ].join('\n')
        );
        assert.equal(parsed.entries.filter(e => e.ftnTag === 'FSX_NODE').length, 1);
        assert.equal(parsed.entries.length, 1);
    });
});
