'use strict';

//
//  Coverage for TIC (file announcement) import.
//
//  Background (#735): a .tic control file and the file it announces routinely
//  arrive in *separate* mailer sessions -- a peer running htick was observed
//  announcing a full Zone 1 nodelist 15-20 minutes ahead of the payload. The
//  importer processed the .tic the moment it landed, failed with ENOENT because
//  the payload was not there yet, archived the announcement to reject/ and
//  unlinked it. The payload then arrived with nothing left to pair it with and
//  sat in the secure inbound forever, so that file never once imported.
//
//  The fix follows htick, the de facto reference implementation: processTic()
//  returns TIC_NotRecvd when the announced file is absent ("has not been
//  received, waiting") or when its CRC/size disagree, and processDir() leaves
//  the TIC in the inbound to be retried on a later pass. We do the same, bounded
//  by tic.holdMaxAgeMs so a payload that never comes cannot wedge the directory.
//
//  Also covered here, all found in the same code path:
//    * TicFileInfo#filePath threw a TypeError for a TIC with no "File" field,
//      which escaped into an fs callback and stalled the whole import pass.
//    * The announced name was matched case-sensitively, so a TIC saying
//      NODELIST.Z34 never found a delivered nodelist.z34 (htick: adaptcase()).
//    * tic.secureInOnly has been documented and defaulted to true since TIC
//      support landed but was never read, so TICs in the *unsecure* inbound were
//      imported on the strength of an unauthenticated "From" line.
//    * The TIC password was compared case-sensitively, unlike htick's stricmp()
//      and unlike our own packet password check.
//    * The packet and bundle stages run before TIC processing over the same
//      directory and would consume an announced payload whose name matched their
//      patterns (a bundle extension is a day-of-week pair plus one character).
//

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const paths = require('path');

const configModule = require('../core/config.js');
const TicFileInfo = require('../core/tic_file_info.js');
const CRC32 = require('../core/crc.js').CRC32;

let FtnBso;

const NODE_ADDR = '21:1/100';
const AREA = 'FSX_GEN';
const LOCAL_AREA_TAG = 'fsxGeneral';

function makeTempDir(prefix) {
    return fs.mkdtempSync(paths.join(os.tmpdir(), prefix));
}

function rmrf(dir) {
    fs.rmSync(dir, { recursive: true, force: true });
}

function crc32Of(buf) {
    const crc = new CRC32();
    crc.update(Buffer.from(buf));
    return crc.finalize();
}

//  Write a payload plus a .tic announcing it. |ticOverrides| replaces or (with a
//  null value) drops individual fields so a test can express exactly one defect.
function writeTicPair(dir, opts = {}) {
    const {
        ticName = 'a0010001.tic',
        fileName = 'NODELIST.Z34',
        //  what actually lands on disk; differs from |fileName| for the
        //  case-mismatch and missing-payload cases
        onDiskName = fileName,
        content = 'nodelist payload contents',
        writePayload = true,
        ticOverrides = {},
    } = opts;

    if (writePayload) {
        fs.writeFileSync(paths.join(dir, onDiskName), content);
    }

    const fields = Object.assign(
        {
            Area: AREA,
            Origin: NODE_ADDR,
            From: NODE_ADDR,
            File: fileName,
            Crc: crc32Of(content).toString(16).toUpperCase(),
            Size: String(Buffer.byteLength(content)),
            Desc: 'Nodelist for week 34',
        },
        ticOverrides
    );

    const lines = Object.entries(fields)
        .filter(([, v]) => v !== null)
        .map(([k, v]) => `${k} ${v}`);

    const ticPath = paths.join(dir, ticName);
    fs.writeFileSync(ticPath, lines.join('\r\n') + '\r\n');
    return ticPath;
}

function readTic(ticPath) {
    return new Promise((resolve, reject) => {
        TicFileInfo.createFromFile(ticPath, (err, info) =>
            err ? reject(err) : resolve(info)
        );
    });
}

//  Resolves with the validation error (or null) rather than rejecting: every
//  test here is *about* the error.
function validate(ticInfo, configOverrides = {}) {
    const config = Object.assign(
        {
            nodes: { [NODE_ADDR]: {} },
            localAreaTags: [LOCAL_AREA_TAG, AREA],
        },
        configOverrides
    );

    return new Promise(resolve => {
        ticInfo.validate(config, (err, localInfo) => resolve({ err, localInfo }));
    });
}

function ls(dir) {
    return fs.readdirSync(dir).sort();
}

function ageFile(path, ms) {
    const when = new Date(Date.now() - ms);
    fs.utimesSync(path, when, when);
}

describe('TIC payload resolution and validation', () => {
    let dir;
    beforeEach(() => {
        dir = makeTempDir('tic-validate-');
    });
    afterEach(() => {
        rmrf(dir);
        dir = null;
    });

    //
    //  The CRC-32 path is load-bearing for every "is this the announced file"
    //  decision below, so pin it to the standard check value rather than only
    //  ever comparing our implementation against itself.
    //
    it('computes standard CRC-32 (check value 0xCBF43926)', () => {
        assert.strictEqual(crc32Of('123456789'), 0xcbf43926);
    });

    it('imports a TIC whose payload is present and intact', async () => {
        const ticPath = writeTicPair(dir);
        const { err, localInfo } = await validate(await readTic(ticPath));

        assert.strictEqual(err, null, err && err.message);
        assert.strictEqual(localInfo.areaTag, AREA);
        assert.strictEqual(localInfo.node, NODE_ADDR);
        assert.strictEqual(typeof localInfo.crc32, 'number');
    });

    //
    //  The #735 detection. Before the fix this surfaced as a bare ENOENT from
    //  createReadStream and was indistinguishable from a corrupt announcement.
    //
    it('reports a missing payload as pending, not as a bad TIC', async () => {
        const ticPath = writeTicPair(dir, { writePayload: false });
        const { err } = await validate(await readTic(ticPath));

        assert.ok(err, 'validation must fail');
        assert.strictEqual(
            err.reasonCode,
            TicFileInfo.ReasonCodes.PayloadPending,
            `expected PayloadPending, got ${err.reasonCode}`
        );
        assert.ok(TicFileInfo.isPayloadPendingError(err));
    });

    //
    //  htick normalizes the announced name with adaptcase(); on a case-sensitive
    //  filesystem the literal 8.3 name from the TIC often simply is not there.
    //
    it('resolves the payload case-insensitively when the exact name misses', async () => {
        const ticPath = writeTicPair(dir, {
            fileName: 'NODELIST.Z34',
            onDiskName: 'nodelist.z34',
        });

        const ticInfo = await readTic(ticPath);
        const { err } = await validate(ticInfo);

        assert.strictEqual(err, null, err && err.message);
        assert.strictEqual(
            paths.basename(ticInfo.filePath),
            'nodelist.z34',
            'filePath must point at the file that actually exists'
        );
    });

    it('prefers an exact-case match over a case variant', async () => {
        const ticPath = writeTicPair(dir, {
            fileName: 'NODELIST.Z34',
            onDiskName: 'NODELIST.Z34',
            content: 'the announced one',
        });
        //  a differently-cased sibling with different contents must be ignored
        fs.writeFileSync(paths.join(dir, 'nodelist.z34'), 'the wrong one');

        const ticInfo = await readTic(ticPath);
        const { err } = await validate(ticInfo);

        assert.strictEqual(err, null, err && err.message);
        assert.strictEqual(paths.basename(ticInfo.filePath), 'NODELIST.Z34');
    });

    //
    //  A mailer that writes straight into the inbound (binkd and friends) can be
    //  caught mid-transfer. Short of the announced Size means "still arriving",
    //  which must never destroy the file.
    //
    it('reports a short payload as incomplete', async () => {
        const content = 'the full and complete payload';
        const ticPath = writeTicPair(dir, { content });
        //  truncate after the TIC was written, so Size/Crc describe the whole file
        fs.writeFileSync(paths.join(dir, 'NODELIST.Z34'), content.slice(0, 5));

        const { err } = await validate(await readTic(ticPath));

        assert.strictEqual(err.reasonCode, TicFileInfo.ReasonCodes.PayloadIncomplete);
        assert.ok(TicFileInfo.isPayloadPendingError(err));
    });

    it('reports an oversize payload as a mismatch', async () => {
        const ticPath = writeTicPair(dir, { content: 'short' });
        fs.writeFileSync(paths.join(dir, 'NODELIST.Z34'), 'short plus rather more');

        const { err } = await validate(await readTic(ticPath));

        assert.strictEqual(err.reasonCode, TicFileInfo.ReasonCodes.PayloadMismatch);
        assert.ok(TicFileInfo.isPayloadPendingError(err));
    });

    //
    //  Same length, wrong bytes: genuinely corrupt. Still retried rather than
    //  rejected outright (htick re-queues on bad CRC too) -- the hold window is
    //  what eventually gives up on it.
    //
    it('reports a same-size CRC failure as a mismatch', async () => {
        const ticPath = writeTicPair(dir, { content: 'abcdefgh' });
        fs.writeFileSync(paths.join(dir, 'NODELIST.Z34'), 'ABCDEFGH');

        const { err } = await validate(await readTic(ticPath));

        assert.strictEqual(err.reasonCode, TicFileInfo.ReasonCodes.PayloadMismatch);
        assert.ok(/Crc/.test(err.message), err.message);
    });

    it('prefers Sha256 over Crc when the TIC carries one', async () => {
        const content = 'sha checked payload';
        const ticPath = writeTicPair(dir, {
            content,
            ticOverrides: {
                //  correct CRC, wrong SHA: only a SHA-aware check can fail here
                Sha256: 'de'.repeat(32),
            },
        });

        const { err } = await validate(await readTic(ticPath));

        assert.strictEqual(err.reasonCode, TicFileInfo.ReasonCodes.PayloadMismatch);
        assert.ok(/Sha256/.test(err.message), err.message);
    });

    it('accepts a correct Sha256', async () => {
        const content = 'sha checked payload';
        const sha = require('crypto')
            .createHash('sha256')
            .update(Buffer.from(content))
            .digest('hex');

        const ticPath = writeTicPair(dir, {
            content,
            ticOverrides: { Sha256: sha.toUpperCase() },
        });

        const { err, localInfo } = await validate(await readTic(ticPath));
        assert.strictEqual(err, null, err && err.message);
        assert.strictEqual(localInfo.sha256, sha);
    });

    //
    //  htick compares the TIC password with stricmp(), and our own packet
    //  password check already upper-cases both sides. A TIC rejected purely over
    //  case is indistinguishable, to a sysop, from a lost file.
    //
    it('compares the TIC password without regard to case', async () => {
        const ticPath = writeTicPair(dir, { ticOverrides: { Pw: 'testy-test' } });
        const { err } = await validate(await readTic(ticPath), {
            nodes: { [NODE_ADDR]: { tic: { password: 'TESTY-TEST' } } },
        });

        assert.strictEqual(err, null, err && err.message);
    });

    it('still rejects a genuinely wrong password, and does not hold it', async () => {
        const ticPath = writeTicPair(dir, { ticOverrides: { Pw: 'nope' } });
        const { err } = await validate(await readTic(ticPath), {
            nodes: { [NODE_ADDR]: { tic: { password: 'TESTY-TEST' } } },
        });

        assert.ok(err);
        assert.ok(/password/i.test(err.message), err.message);
        assert.strictEqual(
            TicFileInfo.isPayloadPendingError(err),
            false,
            'a bad password must be rejected, never held'
        );
    });

    it('rejects a missing password when one is configured', async () => {
        const ticPath = writeTicPair(dir, { ticOverrides: { Pw: null } });
        const { err } = await validate(await readTic(ticPath), {
            nodes: { [NODE_ADDR]: { tic: { password: 'TESTY-TEST' } } },
        });

        assert.ok(err);
        assert.ok(/password/i.test(err.message), err.message);
    });

    it('rejects path traversal in the File field, before touching the disk', async () => {
        for (const bad of ['../escape.zip', '/etc/passwd', 'sub/dir.zip']) {
            const ticPath = writeTicPair(dir, {
                ticName: 'trav.tic',
                writePayload: false,
                ticOverrides: { File: bad },
            });
            const ticInfo = await readTic(ticPath);

            const { err } = await validate(ticInfo);
            assert.ok(err, `${bad} must be rejected`);
            assert.ok(/unsafe/i.test(err.message), err.message);
            assert.strictEqual(
                TicFileInfo.isPayloadPendingError(err),
                false,
                'traversal is never a "wait and retry" condition'
            );

            //  ...and standing alone, so the guard does not depend on call order
            await new Promise(resolve => {
                ticInfo.resolveFilePath(err => {
                    assert.ok(err && /unsafe/i.test(err.message));
                    resolve();
                });
            });
        }
    });

    //
    //  Security regression. "File" was traversal-checked, but the long-name
    //  fields were not -- and it is the *long* name the file is stored under:
    //  processSingleTicFile does
    //      fileEntry.fileName = ticFileInfo.longFileName
    //      dst = paths.join(areaStorageDir, fileEntry.fileName)
    //  and copies the payload there. An "Lfile ../../x" therefore wrote
    //  peer-controlled content anywhere the BBS user could write, which is a
    //  path to code execution. Verified against a live instance before the fix.
    //
    it('rejects path traversal in the Lfile and Fullname fields', async () => {
        for (const field of ['Lfile', 'Fullname']) {
            for (const bad of [
                '../../ESCAPED.txt',
                '/etc/cron.d/evil',
                'sub/dir.zip',
                '..\\..\\win.txt',
            ]) {
                const ticPath = writeTicPair(dir, {
                    ticName: `long-${field}.tic`,
                    ticOverrides: { [field]: bad },
                });

                const { err } = await validate(await readTic(ticPath));
                assert.ok(err, `${field}=${bad} must be rejected`);
                assert.ok(
                    new RegExp(`unsafe ${field}`, 'i').test(err.message),
                    `expected an unsafe-${field} rejection, got: ${err.message}`
                );
                assert.strictEqual(
                    TicFileInfo.isPayloadPendingError(err),
                    false,
                    'a traversal attempt is never held for retry'
                );
            }
        }
    });

    //
    //  Backstop for the same hole: even if a caller reaches longFileName without
    //  going through validate(), it must never hand back something that escapes
    //  the directory it is joined onto.
    //
    it('never returns an unsafe longFileName, falling back to a safe candidate', async () => {
        const ticPath = writeTicPair(dir, {
            ticOverrides: { Lfile: '../../ESCAPED.txt' },
        });
        const ticInfo = await readTic(ticPath);

        //  Lfile is discarded; the safe File value is used instead
        assert.strictEqual(ticInfo.longFileName, 'NODELIST.Z34');

        //  ...and with every candidate unsafe, nothing is returned at all
        const allBad = await readTic(
            writeTicPair(dir, {
                ticName: 'allbad.tic',
                writePayload: false,
                ticOverrides: {
                    File: '../a',
                    Lfile: '../b',
                    Fullname: '/c',
                },
            })
        );
        assert.strictEqual(allBad.longFileName, undefined);
    });

    it('still accepts a legitimate long file name', async () => {
        const ticPath = writeTicPair(dir, {
            ticOverrides: { Lfile: 'nodelist-week-34.zip' },
        });
        const ticInfo = await readTic(ticPath);

        assert.strictEqual(ticInfo.longFileName, 'nodelist-week-34.zip');
        const { err } = await validate(ticInfo);
        assert.strictEqual(err, null, err && err.message);
    });

    //
    //  Regression: filePath used to be paths.join(dirname, undefined), which
    //  throws. Every error path in the scanner/tosser reads this property, so the
    //  throw escaped into an fs callback and stalled the entire import pass.
    //
    it('returns undefined rather than throwing for a TIC with no File field', async () => {
        const ticPath = writeTicPair(dir, {
            writePayload: false,
            ticOverrides: { File: null },
        });
        const ticInfo = await readTic(ticPath);

        assert.doesNotThrow(() => ticInfo.filePath);
        assert.strictEqual(ticInfo.filePath, undefined);

        const { err } = await validate(ticInfo);
        assert.ok(err);
        assert.ok(/required fields/i.test(err.message), err.message);
    });

    it('rejects a TIC from an unknown node and one for an unmapped area', async () => {
        const unknownNode = await validate(await readTic(writeTicPair(dir)), {
            nodes: { '99:9/9': {} },
        });
        assert.ok(/known node/i.test(unknownNode.err.message), unknownNode.err.message);

        const unknownArea = await validate(await readTic(writeTicPair(dir)), {
            localAreaTags: ['somethingElse'],
        });
        assert.ok(/No local area/i.test(unknownArea.err.message));
    });
});

describe('TIC parsing robustness and pass-through retention', () => {
    //
    //  Address.fromString() returns undefined for anything it cannot parse, and
    //  that undefined used to be stored. For a repeatable keyword like Seenby
    //  it landed in an array whose elements getAsString() calls .toString() on,
    //  so a single malformed line from a remote peer threw inside an fs
    //  callback and hung the entire import pass -- the same shape of failure
    //  #735 fixed for a missing "File" field.
    //
    //  The raw lines are retained because both specs require a forwarding
    //  processor to pass unrecognised keywords through unchanged, and parsing
    //  into converted values loses the text a writer needs (#743).
    //

    function writeTic(dir, name, body) {
        const p = paths.join(dir, name);
        fs.writeFileSync(p, body.replace(/\n/g, '\r\n'));
        return p;
    }

    let dir;

    beforeEach(() => {
        dir = makeTempDir('enigma_ticparse_');
    });

    afterEach(() => {
        rmrf(dir);
    });

    function parse(body) {
        const p = writeTic(dir, 'PARSE.TIC', body);
        return new Promise((resolve, reject) => {
            TicFileInfo.createFromFile(p, (err, info) =>
                err ? reject(err) : resolve(info)
            );
        });
    }

    it('drops an unparsable Seenby instead of storing undefined', async () => {
        const info = await parse(
            [
                'Area FSX_GEN',
                'File TEST.ZIP',
                'Seenby 21:1/100',
                'Seenby not-an-address',
                'Seenby 21:1/200',
            ].join('\n')
        );

        const seenby = info.get('seenby');
        assert.strictEqual(seenby.length, 2, 'the bad line must not be stored');
        seenby.forEach(a => assert.ok(a && a.isValid()));
    });

    it('does not throw when serializing a list that had a bad entry', () => {
        //  This is the hang: getAsString() -> v.toString() on undefined.
        return parse(['Seenby 21:1/100', 'Seenby ???'].join('\n')).then(info => {
            assert.doesNotThrow(() => info.getAsString('Seenby', ' '));
            assert.equal(info.getAsString('Seenby', ' '), '21:1/100');
        });
    });

    it('records why a value was dropped, without failing the parse', async () => {
        const info = await parse(['Area FSX_GEN', 'Seenby garbage!!'].join('\n'));
        assert.equal(info.parseWarnings.length, 1);
        assert.equal(info.parseWarnings[0].key, 'seenby');
        assert.equal(info.parseWarnings[0].value, 'garbage!!');
        //  everything else still parsed
        assert.equal(info.getAsString('Area'), 'FSX_GEN');
    });

    it('lets hasRequiredFields catch a required address that would not parse', async () => {
        const info = await parse(
            ['Area A', 'Origin nope', 'From 21:1/100', 'File F.ZIP', 'Crc 1234'].join(
                '\n'
            )
        );
        //  Origin was dropped rather than stored as undefined; the existing
        //  required-field check is what rejects it, exactly as before.
        assert.ok(!info.hasRequiredFields());
        assert.equal(info.get('origin'), undefined);
    });

    it('accepts a password after the address on the From line', async () => {
        //  FSC-0087: "FROM [Address] [Pwd]". The anchored address regexp
        //  rejected the whole value, so such a TIC lost its From entirely and
        //  was refused as "required fields missing".
        const info = await parse(
            ['Area A', 'File A.ZIP', 'From 2:280/5555 SECRET', 'Origin 2:280/5555'].join(
                '\n'
            )
        );
        assert.equal(info.getAsString('From'), '2:280/5555');
        assert.equal(info.parseWarnings.length, 0);
    });

    it('does not carry that password into a forwarded TIC', async () => {
        //  FSC-0087: the From line's password is never passed through. It is
        //  safe because "from" is regenerated per downlink, not forwarded.
        const TicFileWriter = require('../core/tic_file_writer.js');
        const Address = require('../core/ftn_address.js');
        const info = await parse(
            ['Area A', 'File A.ZIP', 'From 2:280/5555 SECRET'].join('\n')
        );
        const out = TicFileWriter.build(info, {
            from: Address.fromString('21:1/151'),
            to: Address.fromString('21:1/200'),
            crc: 'deadbeef',
            seenby: [],
            createdBy: 'x',
        });
        assert.ok(!out.includes('SECRET'), out);
    });

    it('retains every line verbatim, in order, for pass-through', async () => {
        const body = [
            'Area FSX_GEN',
            'File TEST.ZIP',
            'Desc A test file',
            'Ldesc line one',
            'Ldesc line two',
            'SomeFutureKeyword with a value',
            'Seenby 21:1/100',
        ].join('\n');

        const info = await parse(body);

        assert.deepEqual(
            info.rawLines.map(r => r.line),
            body.split('\n'),
            'raw lines must survive parsing, in file order'
        );
        //  keys are normalized for lookup even though the text is not
        assert.deepEqual(
            info.rawLines.map(r => r.key),
            ['area', 'file', 'desc', 'ldesc', 'ldesc', 'somefuturekeyword', 'seenby']
        );
    });

    it('retains an unknown keyword exactly as written, casing included', async () => {
        const info = await parse('X-Weird-Thing  Value   With  Spaces');
        assert.equal(info.rawLines.length, 1);
        assert.equal(info.rawLines[0].line, 'X-Weird-Thing  Value   With  Spaces');
        assert.equal(info.rawLines[0].key, 'x-weird-thing');
    });

    it('skips blank lines entirely', async () => {
        const info = await parse(['Area A', '', '   ', 'File B.ZIP'].join('\n'));
        assert.deepEqual(
            info.rawLines.map(r => r.key),
            ['area', 'file']
        );
    });
});

describe('TIC hold, retry and rejection', () => {
    let inboundDir;
    let rejectDir;
    let inst;
    let imported;
    let prevConfig;

    //  Everything processTicFilesInDirectory reads out of Config().
    function pushConfig(ticConfig = {}) {
        if (prevConfig !== undefined) {
            configModule._popTestConfig(prevConfig);
        }
        prevConfig = configModule._pushTestConfig({
            debug: { assertsEnabled: false },
            menus: { cls: false },
            general: { boardName: 'ENiGMA½ BBS' },
            scannerTossers: {
                ftn_bso: {
                    tic: Object.assign({ secureInOnly: true }, ticConfig),
                },
            },
        });
    }

    before(() => {
        FtnBso = require('../core/scanner_tossers/ftn_bso.js');
    });

    beforeEach(() => {
        inboundDir = makeTempDir('tic-inbound-');
        rejectDir = makeTempDir('tic-reject-');
        imported = [];

        inst = new FtnBso.getModule();
        inst.moduleConfig = { paths: { reject: rejectDir } };

        //
        //  Stand-in for the file-base half of processSingleTicFile: runs the REAL
        //  validation -- which is where "the payload is not here yet" is detected
        //  and where the fix lives -- and on success records the import instead of
        //  scanning the file into an area and persisting a DB entry.
        //
        inst.processSingleTicFile = (ticFileInfo, inboundType, cb) => {
            ticFileInfo.validate(
                {
                    nodes: { [NODE_ADDR]: {} },
                    localAreaTags: [LOCAL_AREA_TAG, AREA],
                },
                err => {
                    if (err) {
                        return cb(err);
                    }
                    imported.push(paths.basename(ticFileInfo.filePath));
                    return cb(null);
                }
            );
        };

        pushConfig();
    });

    afterEach(() => {
        if (prevConfig !== undefined) {
            configModule._popTestConfig(prevConfig);
            prevConfig = undefined;
        }
        rmrf(inboundDir);
        rmrf(rejectDir);
    });

    function processOnce(inboundType = 'secInbound') {
        return new Promise((resolve, reject) => {
            inst.processTicFilesInDirectory(inboundType, inboundDir, err =>
                err ? reject(err) : resolve()
            );
        });
    }

    //
    //  The headline #735 scenario, end to end: announcement in one session,
    //  payload in the next.
    //
    it('holds a TIC whose payload has not arrived, then imports it when it does', async () => {
        //  Session 1: the .tic lands alone.
        const ticPath = writeTicPair(inboundDir, { writePayload: false });

        await processOnce();

        assert.deepStrictEqual(
            ls(inboundDir),
            ['a0010001.tic'],
            'the announcement must be kept, not rejected'
        );
        assert.deepStrictEqual(ls(rejectDir), [], 'nothing archived as a reject');
        assert.deepStrictEqual(imported, []);

        //  Session 2, 15-20 minutes later: the payload arrives, unannounced.
        fs.writeFileSync(
            paths.join(inboundDir, 'NODELIST.Z34'),
            'nodelist payload contents'
        );

        await processOnce();

        assert.deepStrictEqual(imported, ['NODELIST.Z34'], 'imported on the retry');
        assert.deepStrictEqual(
            ls(inboundDir),
            [],
            'TIC and payload both consumed once imported'
        );
        assert.deepStrictEqual(ls(rejectDir), []);
        assert.ok(fs.existsSync(ticPath) === false);
    });

    it('never unlinks a payload that is still arriving', async () => {
        const content = 'the full and complete payload';
        writeTicPair(inboundDir, { content });
        //  a partial write, as an inbound-writing mailer would leave it
        const payloadPath = paths.join(inboundDir, 'NODELIST.Z34');
        fs.writeFileSync(payloadPath, content.slice(0, 6));

        await processOnce();

        assert.ok(fs.existsSync(payloadPath), 'partial payload must survive');
        assert.deepStrictEqual(ls(inboundDir), ['NODELIST.Z34', 'a0010001.tic']);
        assert.deepStrictEqual(ls(rejectDir), []);

        //  ...and once the rest of it lands, it imports.
        fs.writeFileSync(payloadPath, content);
        await processOnce();

        assert.deepStrictEqual(imported, ['NODELIST.Z34']);
        assert.deepStrictEqual(ls(inboundDir), []);
    });

    it('holds across many passes without duplicating or losing anything', async () => {
        writeTicPair(inboundDir, { writePayload: false });

        for (let i = 0; i < 5; ++i) {
            await processOnce();
        }
        assert.deepStrictEqual(ls(inboundDir), ['a0010001.tic']);

        fs.writeFileSync(
            paths.join(inboundDir, 'NODELIST.Z34'),
            'nodelist payload contents'
        );
        await processOnce();
        await processOnce();

        assert.deepStrictEqual(imported, ['NODELIST.Z34'], 'imported exactly once');
    });

    //
    //  A payload that never comes must not wedge the directory forever.
    //
    it('gives up once the hold window expires, archiving the TIC as a reject', async () => {
        pushConfig({ holdMaxAgeMs: 60 * 1000 });

        const ticPath = writeTicPair(inboundDir, { writePayload: false });

        //  still inside the window
        await processOnce();
        assert.deepStrictEqual(ls(inboundDir), ['a0010001.tic']);

        //  ...and now past it
        ageFile(ticPath, 5 * 60 * 1000);
        await processOnce();

        assert.deepStrictEqual(ls(inboundDir), [], 'expired TIC removed from inbound');
        const rejects = ls(rejectDir);
        assert.strictEqual(rejects.length, 1);
        assert.ok(
            rejects[0].startsWith('reject-tic--'),
            `unexpected reject name ${rejects[0]}`
        );
        assert.deepStrictEqual(imported, []);
    });

    it('holds indefinitely when holdMaxAgeMs is 0', async () => {
        pushConfig({ holdMaxAgeMs: 0 });

        const ticPath = writeTicPair(inboundDir, { writePayload: false });
        ageFile(ticPath, 365 * 24 * 60 * 60 * 1000);

        await processOnce();

        assert.deepStrictEqual(ls(inboundDir), ['a0010001.tic']);
        assert.deepStrictEqual(ls(rejectDir), []);
    });

    it('falls back to the default window when holdMaxAgeMs is not a number', async () => {
        pushConfig({ holdMaxAgeMs: 'soon' });

        const ticPath = writeTicPair(inboundDir, { writePayload: false });
        await processOnce();
        assert.deepStrictEqual(ls(inboundDir), ['a0010001.tic'], 'held under default');

        //  the default is 48h; three days out must expire
        ageFile(ticPath, 72 * 60 * 60 * 1000);
        await processOnce();
        assert.deepStrictEqual(ls(inboundDir), []);
    });

    //
    //  A hold is only for "not here yet". Anything we can decide about now is
    //  rejected on the spot, exactly as before.
    //
    it('rejects a bad TIC immediately rather than holding it', async () => {
        writeTicPair(inboundDir, {
            ticName: 'badarea.tic',
            fileName: 'THING.ZIP',
            ticOverrides: { Area: 'NO_SUCH_AREA' },
        });

        await processOnce();

        assert.deepStrictEqual(ls(inboundDir), [], 'both TIC and payload consumed');
        assert.strictEqual(ls(rejectDir).length, 2, 'TIC and payload both archived');
        assert.deepStrictEqual(imported, []);
    });

    //
    //  Regression for the TypeError: this used to throw out of an fs callback,
    //  leaving async.eachSeries hung so no later TIC in the pass was ever seen.
    //
    it('rejects a TIC with no File field and keeps processing the rest of the pass', async () => {
        writeTicPair(inboundDir, {
            ticName: 'nofile.tic',
            writePayload: false,
            ticOverrides: { File: null },
        });
        writeTicPair(inboundDir, {
            ticName: 'good.tic',
            fileName: 'GOOD.ZIP',
            content: 'a good payload',
        });

        await processOnce();

        assert.deepStrictEqual(
            imported,
            ['GOOD.ZIP'],
            'the healthy TIC in the same pass still imported'
        );
        assert.deepStrictEqual(ls(inboundDir), []);
        assert.strictEqual(
            ls(rejectDir).filter(f => f.endsWith('nofile.tic')).length,
            1,
            'the malformed TIC was archived'
        );
    });

    it('imports a case-mismatched payload end to end', async () => {
        writeTicPair(inboundDir, {
            fileName: 'NODELIST.Z34',
            onDiskName: 'nodelist.z34',
        });

        await processOnce();

        assert.deepStrictEqual(imported, ['nodelist.z34']);
        assert.deepStrictEqual(
            ls(inboundDir),
            [],
            'the real, differently-cased file was cleaned up too'
        );
    });

    //
    //  tic.secureInOnly finally does something.
    //
    it('ignores TICs in the unsecure inbound when secureInOnly is set', async () => {
        writeTicPair(inboundDir);

        await processOnce('inbound');

        assert.deepStrictEqual(
            ls(inboundDir),
            ['NODELIST.Z34', 'a0010001.tic'],
            'left untouched rather than imported or destroyed'
        );
        assert.deepStrictEqual(imported, []);
        assert.deepStrictEqual(ls(rejectDir), []);
    });

    it('processes TICs in the unsecure inbound when secureInOnly is cleared', async () => {
        pushConfig({ secureInOnly: false });
        writeTicPair(inboundDir);

        await processOnce('inbound');

        assert.deepStrictEqual(imported, ['NODELIST.Z34']);
        assert.deepStrictEqual(ls(inboundDir), []);
    });

    it('always processes the secure inbound', async () => {
        writeTicPair(inboundDir);
        await processOnce('secInbound');
        assert.deepStrictEqual(imported, ['NODELIST.Z34']);
    });
});

describe('TIC payloads are not consumed by the packet or bundle stages', () => {
    let inboundDir;
    let rejectDir;
    let tempDir;
    let inst;
    let tossed;
    let extracted;

    before(() => {
        FtnBso = require('../core/scanner_tossers/ftn_bso.js');
    });

    beforeEach(() => {
        inboundDir = makeTempDir('tic-mixed-in-');
        rejectDir = makeTempDir('tic-mixed-reject-');
        tempDir = makeTempDir('tic-mixed-temp-');
        tossed = [];
        extracted = [];

        inst = new FtnBso.getModule();
        inst.moduleConfig = { paths: { reject: rejectDir } };
        inst.importTempDir = tempDir;

        inst.archUtil = {
            detectType: (path, cb) => cb(null, 'zip'),
            extractTo: (archivePath, extractPath, archType, cb) => {
                extracted.push(paths.basename(archivePath));
                return cb(null);
            },
        };
        inst.importMessagesFromPacketFile = (packetPath, password, cb) => {
            tossed.push(paths.basename(packetPath));
            return cb(null);
        };
        //  the TIC stage itself is covered above; here we only care that the
        //  earlier stages left its payload alone
        inst.processTicFilesInDirectory = (...args) => args[args.length - 1](null);
    });

    afterEach(() => {
        rmrf(inboundDir);
        rmrf(rejectDir);
        rmrf(tempDir);
    });

    function importOnce() {
        return new Promise((resolve, reject) => {
            inst.importFromDirectory('secInbound', inboundDir, err =>
                err ? reject(err) : resolve()
            );
        });
    }

    //
    //  A bundle extension is any day-of-week pair plus one character, so an
    //  announced FOO.SA1 looks exactly like a Saturday bundle. The bundle stage
    //  runs first and would archive it as a reject and unlink it, destroying the
    //  payload of a TIC that is at that moment being held for it.
    //
    it('leaves a TIC-announced payload that looks like a bundle alone', async () => {
        writeTicPair(inboundDir, {
            ticName: 'bundleish.tic',
            fileName: 'PKGSTUFF.SA1',
            content: 'not a bundle at all',
        });
        //  a genuine bundle alongside it, which must still be processed
        fs.writeFileSync(paths.join(inboundDir, 'realmail.mo0'), 'bundle');

        await importOnce();

        assert.deepStrictEqual(extracted, ['realmail.mo0'], 'only the real bundle ran');
        assert.ok(
            fs.existsSync(paths.join(inboundDir, 'PKGSTUFF.SA1')),
            'the announced payload must survive the bundle stage'
        );
        assert.ok(fs.existsSync(paths.join(inboundDir, 'bundleish.tic')));
    });

    it('leaves a TIC-announced payload named like a packet alone', async () => {
        writeTicPair(inboundDir, {
            ticName: 'pktish.tic',
            fileName: 'SAMPLE.PKT',
            content: 'a sample packet being distributed as a file',
        });
        fs.writeFileSync(paths.join(inboundDir, 'realmail.pkt'), 'PKT');

        await importOnce();

        assert.deepStrictEqual(tossed, ['realmail.pkt'], 'only the real packet tossed');
        assert.ok(
            fs.existsSync(paths.join(inboundDir, 'SAMPLE.PKT')),
            'the announced payload must survive the packet stage'
        );
    });

    it('matches an announced payload case-insensitively when protecting it', async () => {
        writeTicPair(inboundDir, {
            ticName: 'casebundle.tic',
            fileName: 'PKGSTUFF.SA1',
            onDiskName: 'pkgstuff.sa1',
            content: 'not a bundle at all',
        });

        await importOnce();

        assert.deepStrictEqual(extracted, []);
        assert.ok(fs.existsSync(paths.join(inboundDir, 'pkgstuff.sa1')));
    });

    //
    //  Name reservation must not outlive the decision to process a TIC. A .tic
    //  in the unsecure inbound is never processed (secureInOnly) and therefore
    //  never removed, so honouring its claim would let an unauthenticated peer
    //  permanently shield any file it names -- including real inbound mail --
    //  from being tossed.
    //
    it('ignores name claims from TICs it will not process', async () => {
        //  a hostile .tic in the unsecure inbound, claiming real inbound mail
        writeTicPair(inboundDir, {
            ticName: 'squatter.tic',
            fileName: 'realmail.pkt',
            writePayload: false,
        });
        fs.writeFileSync(paths.join(inboundDir, 'realmail.pkt'), 'PKT');
        fs.writeFileSync(paths.join(inboundDir, 'realmail.mo0'), 'bundle');

        //  'inbound' is the unsecure side, and secureInOnly defaults to true
        await new Promise((resolve, reject) => {
            inst.importFromDirectory('inbound', inboundDir, err =>
                err ? reject(err) : resolve()
            );
        });

        assert.deepStrictEqual(
            tossed,
            ['realmail.pkt'],
            'the claim must not stop real mail from being tossed'
        );
        assert.ok(
            !fs.existsSync(paths.join(inboundDir, 'realmail.pkt')),
            'the packet was consumed normally'
        );
    });

    it('still honours claims from TICs it will process', async () => {
        writeTicPair(inboundDir, {
            ticName: 'legit.tic',
            fileName: 'PAYLOAD.PKT',
            content: 'a file being distributed, not mail',
        });

        await importOnce(); //  secInbound

        assert.deepStrictEqual(tossed, []);
        assert.ok(fs.existsSync(paths.join(inboundDir, 'PAYLOAD.PKT')));
    });

    //
    //  The bundle pattern was unanchored, so anything with a day-of-week pair
    //  anywhere at the head of its extension matched.
    //
    it('only treats a trailing day-of-week extension as a bundle', async () => {
        fs.writeFileSync(paths.join(inboundDir, 'archive.sa1x'), 'not a bundle');
        fs.writeFileSync(paths.join(inboundDir, 'realmail.we2'), 'bundle');

        await importOnce();

        assert.deepStrictEqual(extracted, ['realmail.we2']);
        assert.ok(fs.existsSync(paths.join(inboundDir, 'archive.sa1x')));
    });
});
