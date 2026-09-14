'use strict';

const { strict: assert } = require('assert');
const os = require('os');

const DropFile = require('../core/dropfile.js');
const UserProps = require('../core/user_property.js');
const ACS = require('../core/acs.js');

function makeClient(properties = {}) {
    const props = Object.assign(
        {
            login_count: '5',
            location: 'Anywhere',
        },
        properties
    );

    //  the drop files state a time budget, so the user has to answer the
    //  questions core/user_time.js asks of a real one
    const user = {
        userId: 1,
        properties: props,
        getSanitizedName: which => ('real' === which ? 'Test User' : 'testuser'),
        getLegacySecurityLevel: () => 30,
        isAuthenticated: () => true,
        isRoot: () => false,
        isGroupMember: () => false,
        getProperty: name => props[name],
        getPropertyAsNumber: name => parseInt(props[name], 10),
        persistProperty: (name, value) => {
            props[name] = value;
        },
    };

    const client = { node: 1, term: { termHeight: 25 }, user };
    client.acs = new ACS({ client, user });
    return client;
}

function dropFileLines(fileType, commType, properties) {
    const opts = { fileType, baseDir: os.tmpdir() };
    if (commType) {
        opts.commType = commType;
    }
    const dropFile = new DropFile(makeClient(properties), opts);
    return dropFile.getContents().toString('latin1').split('\r\n');
}

const door32Lines = commType => dropFileLines('DOOR32', commType);

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

    //
    //  ENiGMA½ has no descriptor to share, so it cannot write an honest
    //  telnet/handle pair at all: bivrost! overwrites both lines with the
    //  real fd before the door reads the file. This pins the contract rather
    //  than pretending the -1 is something a door could use.
    //
    it('leaves the socket pair for bivrost! to rewrite', () => {
        assert.deepEqual(door32Lines('socket').slice(0, 2), ['2', '-1']);
    });

    it('falls back to local for a comm type it does not recognize', () => {
        assert.deepEqual(door32Lines('telnet').slice(0, 2), ['0', '0']);
        assert.deepEqual(door32Lines(42).slice(0, 2), ['0', '0']);
    });

    it('accepts a comm type in any case', () => {
        assert.deepEqual(door32Lines('SoCkEt').slice(0, 2), ['2', '-1']);
    });
});

describe('DOOR.SYS comm port', () => {
    //  line 1: "Comm Port - COM0: = LOCAL MODE"
    it('reports COM0: for a door on standard streams', () => {
        assert.equal(dropFileLines('DOOR', 'local')[0], 'COM0:');
    });

    it('defaults to local when the caller says nothing', () => {
        assert.equal(dropFileLines('DOOR')[0], 'COM0:');
    });

    it('reports a port for serial and socket doors', () => {
        assert.equal(dropFileLines('DOOR', 'serial')[0], 'COM1:');
        assert.equal(dropFileLines('DOOR', 'socket')[0], 'COM1:');
    });
});

describe('DOOR.SYS call times', () => {
    it('writes distinct current and previous call times in 24-hour format', () => {
        const lines = dropFileLines('DOOR', undefined, {
            [UserProps.LastLoginTs]: '2026-09-12T14:32:00',
            [UserProps.PrevLoginTs]: '2026-09-11T08:05:00',
        });

        assert.equal(lines[43], '14:32');
        assert.equal(lines[44], '08:05');
    });

    it('leaves the previous call time blank for a first-time caller', () => {
        const lines = dropFileLines('DOOR', undefined, {
            [UserProps.LastLoginTs]: '2026-09-12T14:32:00',
        });

        assert.equal(lines[43], '14:32');
        assert.equal(lines[44], '');
    });
});

describe('DORINFO comm port', () => {
    //  line 4: the serial port, "or 0 if logged in on console"
    it('reports 0 for a door on standard streams', () => {
        assert.equal(dropFileLines('DORINFO', 'local')[3], '0');
    });

    it('defaults to local when the caller says nothing', () => {
        assert.equal(dropFileLines('DORINFO')[3], '0');
    });

    it('reports a port for serial and socket doors', () => {
        assert.equal(dropFileLines('DORINFO', 'serial')[3], 'COM1');
        assert.equal(dropFileLines('DORINFO', 'socket')[3], 'COM1');
    });
});
