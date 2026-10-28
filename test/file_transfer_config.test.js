'use strict';

const { strict: assert } = require('assert');

const configModule = require('../core/config.js');

//  Distinct protocol objects so a lookup is identifiable by identity.
const PROTOCOLS = {
    zmodem8kSz: { name: 'default' },
    zmodem8kSexyz: { name: 'sexyz' },
    xmodem: { name: 'xmodem' },
};
const TEST_CONFIG = {
    debug: { assertsEnabled: false },
    menus: { cls: false },
    fileTransferProtocols: PROTOCOLS,
};

describe('file_transfer settings resolution (#943)', () => {
    let previousConfig;
    let TransferModule;

    before(() => {
        previousConfig = configModule._pushTestConfig(TEST_CONFIG);
        TransferModule = require('../core/file_transfer.js').getModule;
    });

    after(() => {
        configModule._popTestConfig(previousConfig);
    });

    const make = (config, extraArgs) =>
        new TransferModule({
            menuName: 'sendFilesToUser',
            menuConfig: { config },
            client: {},
            extraArgs,
        });

    it('uses the config block when extraArgs are unrelated (menu prompt form data)', () => {
        const m = make(
            { protocol: 'zmodem8kSexyz', direction: 'recv', sendQueue: ['/a/b'] },
            { command: 'D' }
        );
        assert.equal(m.protocolConfig, PROTOCOLS.zmodem8kSexyz);
        assert.equal(m.direction, 'recv');
        assert.deepEqual(m.sendQueue, [{ path: '/a/b' }]);
    });

    it('lets partial extraArgs override only the keys they define', () => {
        const m = make(
            { protocol: 'zmodem8kSexyz', direction: 'recv', recvDirectory: '/cfg' },
            { protocol: 'xmodem' }
        );
        assert.equal(m.protocolConfig, PROTOCOLS.xmodem);
        assert.equal(m.direction, 'recv');
        assert.equal(m.recvDirectory, '/cfg');
    });

    it('works with extraArgs only and no config block', () => {
        const m = make(undefined, {
            protocol: 'xmodem',
            direction: 'recv',
            recvFileName: 'x.bin',
            recvDirectory: '/tmp/x',
            sendQueue: [{ path: '/q' }],
        });
        assert.equal(m.protocolConfig, PROTOCOLS.xmodem);
        assert.equal(m.direction, 'recv');
        assert.equal(m.recvFileName, 'x.bin');
        assert.equal(m.recvDirectory, '/tmp/x');
        assert.deepEqual(m.sendQueue, [{ path: '/q' }]);
    });

    it('keeps the defaults when neither source sets anything', () => {
        const m = make({}, undefined);
        assert.equal(m.protocolConfig, PROTOCOLS.zmodem8kSz);
        assert.equal(m.direction, 'send');
        assert.deepEqual(m.sendQueue, []);
    });
});
