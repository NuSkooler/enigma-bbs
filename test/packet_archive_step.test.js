'use strict';

const { strict: assert } = require('assert');
const fs = require('fs');
const os = require('os');
const paths = require('path');

const ArchiveUtil = require('../core/archive_util.js');
const { BlueWavePacketWriter } = require('../core/bluewave_mail_packet.js');
const { QWKPacketWriter } = require('../core/qwk_mail_packet.js');

//
//  The last step of both packet writers: hand the work directory to the
//  archiver, then report the archive it wrote. Exercised against a stubbed
//  archiver so no zip needs to be installed.
//
[
    ['Blue Wave', BlueWavePacketWriter],
    ['QWK', QWKPacketWriter],
].forEach(([formatName, Writer]) => {
    describe(`${formatName} packet archive step`, () => {
        let realGetInstance;
        let dir;

        beforeEach(() => {
            realGetInstance = ArchiveUtil.getInstance;
            dir = fs.mkdtempSync(paths.join(os.tmpdir(), 'enig-archive-step-'));
            fs.mkdirSync(paths.join(dir, 'work'));
        });

        afterEach(() => {
            ArchiveUtil.getInstance = realGetInstance;
            fs.rmSync(dir, { recursive: true, force: true });
        });

        //  |writes|: whether the stubbed archiver leaves an archive behind
        const run = ({ archiveErr, writes }, cb) => {
            ArchiveUtil.getInstance = () => ({
                compressTo: (format, archivePath, files, workDir, done) => {
                    if (writes) {
                        fs.writeFileSync(archivePath, 'PK');
                    }
                    return done(archiveErr);
                },
            });

            const events = { packet: [], warning: [] };
            const writer = Object.create(Writer.prototype);
            Object.assign(writer, {
                workDir: paths.join(dir, 'work'),
                options: { archiveFormat: 'application/zip' },
                _getNextAvailPacketFileName: (packetDir, done) =>
                    done(null, 'ENIGMA.PKT'),
                emit: (name, value) => events[name] && events[name].push(value),
            });

            writer._producePacketArchive(dir, err => cb(err, events));
        };

        it('reports the packet the archiver wrote', done => {
            run({ archiveErr: null, writes: true }, (err, events) => {
                assert.equal(err, null);
                assert.equal(events.packet.length, 1);
                assert.equal(events.warning.length, 0);
                done();
            });
        });

        //  a missing archiver, not ENOENT on the archive it never wrote
        it('reports why the archiver failed when there is no archive', done => {
            const archiveErr = new Error('spawn zip ENOENT');
            run({ archiveErr, writes: false }, (err, events) => {
                assert.equal(err, archiveErr);
                assert.equal(events.packet.length, 0);
                done();
            });
        });

        //  7z exits 1 on "Warning (Non fatal error(s))"
        it('delivers an archive written despite a non-zero exit', done => {
            const archiveErr = new Error('exited with code 1');
            run({ archiveErr, writes: true }, (err, events) => {
                assert.equal(err, null);
                assert.equal(events.packet.length, 1);
                assert.deepEqual(events.warning, [archiveErr]);
                done();
            });
        });
    });
});
