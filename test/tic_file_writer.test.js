'use strict';

//
//  Coverage for the outgoing TIC writer (#743).
//
//  A golden-file style test: the whole point of a writer is the exact bytes,
//  and pinning them here is far cheaper than diffing our output against a live
//  hub. Every assertion below traces to a line in FTS-5006.001 or FSC-0087.001.
//

const { strict: assert } = require('assert');
const fs = require('fs');
const os = require('os');
const paths = require('path');

const TicFileInfo = require('../core/tic_file_info.js');
const TicFileWriter = require('../core/tic_file_writer.js');
const Address = require('../core/ftn_address.js');

describe('TIC file writer', () => {
    let tmpDir;

    before(() => {
        tmpDir = fs.mkdtempSync(paths.join(os.tmpdir(), 'enigma_ticwrite_'));
    });

    after(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    //  Parse a TIC from literal text so tests read as the wire format.
    function parse(body) {
        const p = paths.join(tmpDir, 'IN.TIC');
        fs.writeFileSync(p, body.replace(/\n/g, '\r\n'));
        return new Promise((resolve, reject) => {
            TicFileInfo.createFromFile(p, (err, info) =>
                err ? reject(err) : resolve(info)
            );
        });
    }

    const INBOUND = [
        'Created by HTick, written by Gabriel Plutzar',
        'Area FSX_GEN',
        'Areadesc fsxNet General Files',
        'File NODELIST.Z21',
        'Lfile fsxnet-nodelist-2026-241.zip',
        'Desc fsxNet nodelist for day 241',
        'Ldesc The weekly fsxNet nodelist.',
        'Ldesc Generated automatically.',
        'Replaces NODELIST.*',
        'Origin 21:1/100',
        'From 21:1/100',
        'To 21:1/151',
        'Size 51200',
        'Date 1756500000',
        'Crc DEADBEEF',
        'Magic NODELIST',
        'Pw UPLINKPASS',
        'Path 21:1/100 1756500001 Fri, 29 Aug 2026 12:00:01 GMT',
        'Seenby 21:1/100',
        'Seenby 21:1/151',
    ].join('\n');

    const BASE = {
        from: Address.fromString('21:1/151'),
        to: Address.fromString('21:1/200'),
        password: 'DOWNPASS',
        crc: 'deadbeef',
        createdBy: 'ENiGMA1/2 0.5.1b',
        seenby: [
            Address.fromString('21:1/100'),
            Address.fromString('21:1/151'),
            Address.fromString('21:1/200'),
        ],
        pathEntry: '21:1/151 1756500100 Fri, 29 Aug 2026 12:01:40 GMT',
    };

    async function build(overrides = {}, body = INBOUND) {
        const info = await parse(body);
        return TicFileWriter.build(info, Object.assign({}, BASE, overrides));
    }

    it('produces the expected file, byte for byte', async () => {
        const out = await build();

        assert.equal(
            out,
            [
                'Created ENiGMA1/2 0.5.1b',
                'Area FSX_GEN',
                'Areadesc fsxNet General Files',
                'File NODELIST.Z21',
                'Lfile fsxnet-nodelist-2026-241.zip',
                'Desc fsxNet nodelist for day 241',
                'Ldesc The weekly fsxNet nodelist.',
                'Ldesc Generated automatically.',
                'Replaces NODELIST.*',
                'Origin 21:1/100',
                'Size 51200',
                'Date 1756500000',
                'Crc DEADBEEF',
                'From 21:1/151',
                'To 21:1/200',
                'Pw DOWNPASS',
                'Path 21:1/100 1756500001 Fri, 29 Aug 2026 12:00:01 GMT',
                'Path 21:1/151 1756500100 Fri, 29 Aug 2026 12:01:40 GMT',
                'Seenby 21:1/100',
                'Seenby 21:1/151',
                'Seenby 21:1/200',
                '',
            ].join('\r\n')
        );
    });

    describe('line endings', () => {
        it('always writes CRLF, never a bare LF', async () => {
            //  FTS-5006 2.2: "Application must only write files with a CR,LF
            //  pair."
            const out = await build();
            assert.ok(!/[^\r]\n/.test(out), 'every LF must be preceded by a CR');
            assert.ok(out.endsWith('\r\n'), 'the last line is terminated too');
        });

        it('writes CRLF even when the inbound TIC used bare LF', async () => {
            const info = await parse(INBOUND);
            //  parse() converted to CRLF; write the LF form directly instead
            const p = paths.join(tmpDir, 'LF.TIC');
            fs.writeFileSync(p, INBOUND);
            const lfInfo = await new Promise((res, rej) =>
                TicFileInfo.createFromFile(p, (e, i) => (e ? rej(e) : res(i)))
            );
            assert.equal(lfInfo.rawLines.length, info.rawLines.length);
            const out = TicFileWriter.build(lfInfo, BASE);
            assert.ok(!/[^\r]\n/.test(out));
        });
    });

    describe('keywords that must not be passed through', () => {
        //  FSC-0087 marks these '^'; Crc and Magic are covered in the writer's
        //  own notes.
        it("never leaks the uplink's password", async () => {
            const out = await build();
            assert.ok(!out.includes('UPLINKPASS'), 'the inbound Pw must not survive');
            assert.ok(out.includes('Pw DOWNPASS'), 'this link gets its own');
        });

        it('omits Pw entirely when the link has no password', async () => {
            const out = await build({ password: undefined });
            assert.ok(!/^Pw /m.test(out));
        });

        it("replaces the sender's Created banner with ours", async () => {
            const out = await build();
            assert.ok(!out.includes('HTick'), 'the inbound Created must not survive');
            assert.equal(out.split('\r\n')[0], 'Created ENiGMA1/2 0.5.1b');
        });

        it('rewrites From and To for this link', async () => {
            const out = await build();
            assert.ok(out.includes('From 21:1/151'));
            assert.ok(out.includes('To 21:1/200'));
            assert.ok(!/^From 21:1\/100$/m.test(out), 'not the inbound From');
            assert.ok(!/^To 21:1\/151$/m.test(out), 'not the inbound To');
        });

        it('drops Magic, which is only meaningful at the sending site', async () => {
            const out = await build();
            assert.ok(!out.includes('Magic'));
        });

        it('emits exactly one From, To, Crc and Created', async () => {
            const out = await build();
            ['From', 'To', 'Crc', 'Created'].forEach(k => {
                const n = out.split('\r\n').filter(l => l.startsWith(`${k} `)).length;
                assert.equal(n, 1, `expected one ${k} line, got ${n}`);
            });
        });
    });

    describe('Crc', () => {
        it('emits the computed CRC, not the announced one', async () => {
            //  When the inbound TIC carried Sha256, TicFileInfo verified that
            //  and never checked Crc -- passing that value on would have us
            //  vouch for a number nothing verified.
            const out = await build({ crc: 'c0ffee12' });
            assert.ok(out.includes('Crc C0FFEE12'));
            assert.ok(!out.includes('DEADBEEF'), 'the announced Crc is not reused');
        });

        it('zero pads and upper cases', async () => {
            //  We store it unpadded and lower case; a short CRC is a mismatch
            //  at the far end.
            assert.equal(TicFileWriter.formatCrc('1a2b'), '00001A2B');
            assert.equal(TicFileWriter.formatCrc(0x1a2b), '00001A2B');
            assert.equal(TicFileWriter.formatCrc('deadbeef'), 'DEADBEEF');
            const out = await build({ crc: '1a2b' });
            assert.ok(out.includes('Crc 00001A2B'));
        });
    });

    describe('long file names', () => {
        it('passes Lfile through by default', async () => {
            const out = await build();
            assert.ok(out.includes('Lfile fsxnet-nodelist-2026-241.zip'));
        });

        it('omits it for a peer that cannot cope', async () => {
            const out = await build({ longNames: false });
            assert.ok(!out.includes('Lfile'));
            assert.ok(out.includes('File NODELIST.Z21'), 'the 8.3 name still goes');
        });

        it('normalizes Fullname to Lfile when writing', async () => {
            //  FTS-5006: "always use Lfile when writing TIC files but recognise
            //  Fullname as an alias when reading."
            const out = await build(
                {},
                ['Area A', 'File A.ZIP', 'Fullname a-long-name.zip'].join('\n')
            );
            assert.ok(out.includes('Lfile a-long-name.zip'));
            assert.ok(!out.includes('Fullname'));
        });
    });

    describe('unknown keywords', () => {
        const withUnknown = [
            'Area FSX_GEN',
            'File A.ZIP',
            'X-Future-Thing some value',
            'App SOMEAPP data here',
        ].join('\n');

        it('passes them through unchanged by default', async () => {
            //  FTS-5006 2.2 and FSC-0087 both require this.
            const out = await build({}, withUnknown);
            assert.ok(out.includes('X-Future-Thing some value'));
            assert.ok(out.includes('App SOMEAPP data here'));
        });

        it('drops them for an FSC-87 subset peer, keeping known ones', async () => {
            //  htick with FileFixFSC87Subset off abandons a whole TIC over an
            //  unknown keyword.
            const out = await build({ passUnknownKeywords: false }, withUnknown);
            assert.ok(!out.includes('X-Future-Thing'));
            assert.ok(out.includes('App SOMEAPP data here'), 'App is an FSC-87 keyword');
            assert.ok(out.includes('Area FSX_GEN'));
        });

        it('never emits Sha256 unless asked', async () => {
            //  In neither spec and in neither reference implementation, so to
            //  every other peer it is an unknown keyword.
            const body = ['Area A', 'File A.ZIP', 'Sha256 abc123'].join('\n');
            assert.ok(!(await build({}, body)).includes('Sha256'));
            assert.ok((await build({ sha256: true }, body)).includes('Sha256 abc123'));
        });

        it('drops a known keyword that arrived blank', async () => {
            //  FSC-0087: "Known Keywords that are blank should not be passed
            //  though."
            const out = await build({}, ['Area A', 'File A.ZIP', 'Areadesc '].join('\n'));
            assert.ok(!/^Areadesc/m.test(out));
        });
    });

    describe('Path', () => {
        it('keeps existing lines in order and appends ours last', async () => {
            //  FTS-5006: "Path lines should be grouped and in order of
            //  processing."
            const out = await build();
            const path = out.split('\r\n').filter(l => l.startsWith('Path '));
            assert.deepEqual(path, [
                'Path 21:1/100 1756500001 Fri, 29 Aug 2026 12:00:01 GMT',
                'Path 21:1/151 1756500100 Fri, 29 Aug 2026 12:01:40 GMT',
            ]);
        });

        it('builds an entry with a decimal Unix timestamp', async () => {
            //  FSC-0087 says hex; FTS-5006's own example and every
            //  implementation in the field use decimal.
            const when = new Date(Date.UTC(2026, 7, 29, 12, 0, 0));
            const entry = TicFileWriter.pathEntry(
                Address.fromString('21:1/151'),
                when,
                'ENiGMA1/2'
            );
            assert.ok(
                entry.startsWith(`21:1/151 ${Math.floor(when.getTime() / 1000)} `),
                `decimal timestamp expected, got: ${entry}`
            );
            assert.ok(entry.endsWith(' ENiGMA1/2'));
        });

        it('is the sole Path source when the inbound had none', async () => {
            const out = await build({}, ['Area A', 'File A.ZIP'].join('\n'));
            assert.deepEqual(
                out.split('\r\n').filter(l => l.startsWith('Path ')),
                [`Path ${BASE.pathEntry}`]
            );
        });
    });

    describe('Seenby', () => {
        it('writes the caller-supplied list, one address per line', async () => {
            const out = await build();
            assert.deepEqual(
                out.split('\r\n').filter(l => l.startsWith('Seenby ')),
                ['Seenby 21:1/100', 'Seenby 21:1/151', 'Seenby 21:1/200']
            );
        });

        it('ignores whatever the inbound Seenby said', async () => {
            //  The list is the loop guard and depends on our downlink set, not
            //  on this one TIC. The caller owns it.
            const out = await build({ seenby: [Address.fromString('21:9/9')] });
            assert.deepEqual(
                out.split('\r\n').filter(l => l.startsWith('Seenby ')),
                ['Seenby 21:9/9']
            );
        });
    });

    describe('address dimensions', () => {
        it('writes 4D by default, dropping the domain', async () => {
            const out = await build({
                from: Address.fromString('21:1/151@fsxnet'),
                to: Address.fromString('21:1/200@fsxnet'),
            });
            assert.ok(out.includes('From 21:1/151'));
            assert.ok(!out.includes('@fsxnet'), 'a non-5D peer must not see a domain');
        });

        it('writes 5D on request', async () => {
            const out = await build({
                addressDimensions: '5D',
                from: Address.fromString('21:1/151@fsxnet'),
                to: Address.fromString('21:1/200@fsxnet'),
            });
            assert.ok(out.includes('From 21:1/151@fsxnet'));
            assert.ok(out.includes('To 21:1/200@fsxnet'));
        });

        it('keeps Seenby 4D even when 5D is requested', async () => {
            //
            //  Verified against Synchronet's tickit directly.
            //
            //  Seenby is the loop guard, not a routing field, and it only works
            //  if the far end can match it against its own link list. tickit
            //  does that by raw string equality -- it keys a map on the literal
            //  Seenby text, then looks up the configured link address -- so
            //  "Seenby 21:1/200@fsxnet" does not match a link written as
            //  "21:1/200", and it forwards the file back to a node that already
            //  has it. Its only other guard, the circular-Path check, never
            //  fires on a well-formed TIC.
            //
            //  htick writes 4D here regardless, and a 5D-aware processor reads
            //  4D fine. 4D is universally safe; 5D buys nothing and can loop.
            //
            const out = await build({
                addressDimensions: '5D',
                from: Address.fromString('21:1/151@fsxnet'),
                to: Address.fromString('21:1/200@fsxnet'),
                seenby: [
                    Address.fromString('21:1/100@fsxnet'),
                    Address.fromString('21:1/200@fsxnet'),
                ],
            });

            assert.deepEqual(
                out.split('\r\n').filter(l => l.startsWith('Seenby ')),
                ['Seenby 21:1/100', 'Seenby 21:1/200'],
                'a domain here can loop a file with a real peer'
            );
            //  ...while From and To still honour the request
            assert.ok(out.includes('From 21:1/151@fsxnet'));
        });

        it('keeps a point in Seenby, which is not the domain', async () => {
            //  4D means dropping the domain, not flattening points -- a point
            //  and its boss node are different subscribers.
            const out = await build({
                addressDimensions: '5D',
                seenby: [Address.fromString('21:1/200.4@fsxnet')],
            });
            assert.ok(out.includes('Seenby 21:1/200.4'));
            assert.ok(!out.includes('Seenby 21:1/200.4@'));
        });
    });

    describe('field order is load bearing for strict htick links', () => {
        //
        //  Verified against htick 1.9 built from source, not inferred.
        //
        //  htick has a per-link "FileFixFSC87Subset" setting. With it OFF, an
        //  unknown keyword makes htick abandon the entire TIC -- the file is
        //  renamed .bad and the payload is left orphaned in the inbound.
        //
        //  htick's known-keyword set (src/toss.c:96-114) contains no LFILE, no
        //  FULLNAME and no SHA256. So on the face of it every long-named file
        //  we forward should bounce off a strict-mode htick downlink.
        //
        //  It does not, and the reason is positional. |ticSourceLink| is a
        //  local in parseTic(), initialised to NULL (toss.c:486) and assigned
        //  only when the *From* line is parsed (:659). The unknown-keyword
        //  check is "if(ticSourceLink && !ticSourceLink->FileFixFSC87Subset)"
        //  (:737). Keywords appearing *before* From are therefore ignored
        //  unconditionally, in both modes.
        //
        //  Our writer emits everything passed through -- Lfile and any unknown
        //  keyword included -- in one block ahead of From, so we land on the
        //  safe side of that line. Confirmed empirically: strict-mode htick
        //  tossed our output cleanly, and hoisting From to the top of the very
        //  same file made it reject with "Unknown Keyword LFILE in Tic File".
        //
        //  That makes the order an interop requirement rather than a matter of
        //  taste, and it is not obvious from either specification. Hence this
        //  test: move From earlier and it fails here rather than silently
        //  bouncing every file off every strict downlink in the network.
        //

        //  src/toss.c:96-114, htick 1.9
        const HTICK_KNOWS = new Set([
            'created',
            'file',
            'altfile',
            'areadesc',
            'desc',
            'area',
            'crc',
            'replaces',
            'origin',
            'from',
            'to',
            'path',
            'seenby',
            'pw',
            'size',
            'date',
            'destination',
            'magic',
            'ldesc',
        ]);

        function keywordsOf(out) {
            return out
                .split('\r\n')
                .filter(l => l.length)
                .map(l => l.split(/\s/)[0].toLowerCase());
        }

        it('emits every keyword htick does not know before From', async () => {
            const out = await build(
                {},
                [
                    'Area FSX_GEN',
                    'File A.ZIP',
                    'Lfile a-long-name.zip',
                    'Sha256 abc123',
                    'X-Future-Thing whatever',
                    'Origin 21:1/100',
                    'From 21:1/100',
                ].join('\n')
            );

            const keywords = keywordsOf(out);
            const fromIdx = keywords.indexOf('from');
            assert.ok(fromIdx > 0, 'From must be present');

            keywords.forEach((kw, i) => {
                if (!HTICK_KNOWS.has(kw)) {
                    assert.ok(
                        i < fromIdx,
                        `"${kw}" is emitted at ${i}, after From at ${fromIdx}; a ` +
                            `strict-mode htick downlink will reject the whole TIC`
                    );
                }
            });
        });

        it('keeps Lfile ahead of From even when it arrived after it', async () => {
            //  The inbound order is not ours to rely on: our pass-through block
            //  is emitted as a unit and From is regenerated after it, so this
            //  holds regardless of how the uplink laid its TIC out.
            const out = await build(
                {},
                [
                    'Area FSX_GEN',
                    'From 21:1/100',
                    'File A.ZIP',
                    'Lfile a-long-name.zip',
                ].join('\n')
            );

            const keywords = keywordsOf(out);
            assert.ok(
                keywords.indexOf('lfile') < keywords.indexOf('from'),
                'Lfile must precede From however the inbound TIC was ordered'
            );
        });

        it('emits only keywords htick knows from From onward', async () => {
            //  The other half of the same invariant: nothing exotic may be
            //  appended to the tail.
            const out = await build();
            const keywords = keywordsOf(out);
            keywords.slice(keywords.indexOf('from')).forEach(kw => {
                assert.ok(
                    HTICK_KNOWS.has(kw),
                    `"${kw}" appears after From and htick does not know it`
                );
            });
        });
    });

    describe('line length', () => {
        it('clamps a line we generated to the FSC-0087 limit', async () => {
            //  "The maximum length of a keyword line is 256 characters,
            //  including the CRLF termination."
            const out = await build({ pathEntry: `21:1/151 1 ${'x'.repeat(400)}` });
            out.split('\r\n').forEach(l => assert.ok(l.length <= 254, l.length));
        });
    });
});
