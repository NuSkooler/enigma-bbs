'use strict';

const { strict: assert } = require('assert');
const os = require('os');

const DropFile = require('../core/dropfile.js');

function makeClient() {
    return {
        node: 1,
        user: {
            userId: 1,
            getSanitizedName: which => ('real' === which ? 'Test User' : 'testuser'),
            getLegacySecurityLevel: () => 30,
        },
    };
}

function door32Lines(commType) {
    const opts = { fileType: 'DOOR32', baseDir: os.tmpdir() };
    if (commType) {
        opts.commType = commType;
    }
    const dropFile = new DropFile(makeClient(), opts);
    return dropFile.getContents().toString('latin1').split('\r\n');
}

describe('DOOR32.SYS comm type', () => {
    it('reports local mode with no handle for a door on standard streams', () => {
        const lines = door32Lines('local');
        assert.equal(lines[0], '0', 'comm type should be local');
        assert.equal(lines[1], '0', 'there is no descriptor to hand over');
    });

    it('defaults to local when the caller says nothing', () => {
        assert.deepEqual(door32Lines().slice(0, 2), ['0', '0']);
    });

    it('keeps the telnet spelling when a socket is shared', () => {
        const lines = door32Lines('socket');
        assert.equal(lines[0], '2', 'comm type should be telnet');
        assert.equal(lines[1], '-1');
    });

    it('reports serial for a door on an emulated COM port', () => {
        const lines = door32Lines('serial');
        assert.equal(lines[0], '1', 'comm type should be serial');
        assert.equal(lines[1], '0', 'a serial port carries no socket descriptor');
    });

    it('never claims a socket while supplying no handle', () => {
        for (const mode of ['local', undefined, 'socket', 'serial']) {
            const [commType, handle] = door32Lines(mode);
            if ('2' === commType) {
                assert.notEqual(handle, '0');
            } else {
                assert.equal(handle, '0');
            }
        }
    });
});
