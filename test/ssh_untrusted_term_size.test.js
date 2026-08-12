/* jslint node: true */
'use strict';

const assert = require('assert');
const configModule = require('../core/config.js');
const defaultConfig = require('../core/config_default.js')();

//  ssh.js binds Config at require time, so the mock goes in first and comes
//  straight back out. ssh.js keeps the getter it captured, so no other test
//  file ends up loading under our config.
const previousConfig = configModule._pushTestConfig(defaultConfig);
const { isUntrustedTermSizeClient } = require('../core/servers/login/ssh.js');
configModule._popTestConfig(previousConfig);

describe('SSH untrusted terminal size clients', () => {
    it('ships stock cryptlib in the default list', () => {
        assert.ok(
            defaultConfig.loginServers.ssh.untrustedTermSizeClients.includes(
                'SSH-2.0-cryptlib'
            )
        );
    });

    it('flags NetRunner, which identifies as stock cryptlib', () => {
        assert.strictEqual(isUntrustedTermSizeClient('SSH-2.0-cryptlib'), true);
    });

    it('ignores case', () => {
        assert.strictEqual(isUntrustedTermSizeClient('ssh-2.0-CRYPTLIB'), true);
    });

    //  Clients on Synchronet's cryptlib fork send the actual terminal size, so
    //  they must not be caught by the entry for stock cryptlib. Both idents were
    //  captured from live SyncTERM sessions: released 1.9rc4 sends the fork's
    //  compiled-in default, while 1.10a from master names itself.
    it('leaves cryptlib-derived clients that report honestly alone', () => {
        assert.strictEqual(isUntrustedTermSizeClient('SSH-2.0-cryptlib(SBBS)'), false);
        assert.strictEqual(isUntrustedTermSizeClient('SSH-2.0-SyncTERM_1.10a'), false);
    });

    //  Representative idents, not captured ones; any non-matching string
    //  exercises the same path.
    it('leaves other clients alone', () => {
        assert.strictEqual(isUntrustedTermSizeClient('SSH-2.0-OpenSSH_9.6'), false);
        assert.strictEqual(
            isUntrustedTermSizeClient('SSH-2.0-PuTTY_Release_0.80'),
            false
        );
    });
});
