'use strict';

const { strict: assert } = require('assert');
const fs = require('fs');
const os = require('os');
const paths = require('path');

const { endWriteStream } = require('../core/file_util.js');
const StatLog = require('../core/stat_log.js');
const { BlueWavePacketWriter } = require('../core/bluewave_mail_packet.js');

function tempFile(name) {
    return paths.join(fs.mkdtempSync(paths.join(os.tmpdir(), 'enigstream-')), name);
}

describe('ending a packet write stream', () => {
    it('answers once the stream has closed', done => {
        const ws = fs.createWriteStream(tempFile('ok.dat'));
        ws.write('some packet bytes');
        endWriteStream(ws, err => {
            assert.equal(err, null);
            assert.ok(ws.destroyed, 'the stream was ended');
            done();
        });
    });

    //
    //  The regression. A stream that failed earlier has already emitted its
    //  'close', so a listener attached now would never hear one -- and the
    //  export it belongs to would wait on the callback until the carrier
    //  dropped, with the idle monitor already stopped.
    //
    it('refuses a stream that has already gone, rather than waiting on it', done => {
        const ws = fs.createWriteStream(tempFile('gone.dat'));
        ws.once('close', () => {
            assert.ok(ws.destroyed, 'precondition: the stream is already gone');
            endWriteStream(ws, err => {
                assert.ok(err, 'expected an error rather than silence');
                assert.match(err.message, /closed before it could be finished/);
                done();
            });
        });
        ws.destroy();
    });

    it('hands back the failure when the stream dies while ending', done => {
        const ws = fs.createWriteStream(tempFile('dies.dat'));
        endWriteStream(ws, err => {
            assert.ok(err, 'expected an error');
            assert.equal(err.message, 'the disk went away');
            done();
        });
        ws.destroy(new Error('the disk went away'));
    });

    it('answers only once, however many events arrive', done => {
        const ws = fs.createWriteStream(tempFile('once.dat'));
        let calls = 0;

        endWriteStream(ws, () => {
            calls += 1;
        });

        setTimeout(() => {
            ws.emit('error', new Error('and then it failed too'));
            ws.emit('close');
            assert.equal(calls, 1);
            done();
        }, 20);
    });
});

//
//  The same failure seen from the caller's side: a writer whose packet stream
//  died must end the export, not leave it waiting on a 'finished' that the
//  series can no longer reach.
//
describe('an offline packet writer whose stream died', () => {
    const realInit = StatLog.init;
    const realGetSystemStat = StatLog.getSystemStat;

    beforeEach(() => {
        StatLog.init = cb => cb(null);
        StatLog.getSystemStat = () => 'SysOp Name';
    });

    afterEach(() => {
        StatLog.init = realInit;
        StatLog.getSystemStat = realGetSystemStat;
    });

    it('emits error instead of hanging', done => {
        const writer = new BlueWavePacketWriter({
            bbsID: 'ENIGMA',
            user: null,
            systemName: 'Test Board',
            sysOpName: 'SysOp Name',
        });

        writer.once('ready', () => {
            //  the .DAT stream dies mid-export, before finish() is reached
            writer.datStream.once('close', () => {
                writer.once('finished', () =>
                    done(new Error('reported success over a dead stream'))
                );
                writer.once('error', err => {
                    assert.match(err.message, /closed before it could be finished/);
                    writer.temptmp.cleanup();
                    done();
                });

                writer.finish(writer.workDir);
            });
            writer.datStream.destroy();
        });

        writer.init();
    });
});
