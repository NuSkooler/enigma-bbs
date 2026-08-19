'use strict';

const { strict: assert } = require('assert');

const fsp = require('fs/promises');
const path = require('path');
const os = require('os');

const {
    localAddresses,
    addressKey,
    findBestNodeMatch,
    buildSpool,
} = require('../core/binkp/util.js');
const Address = require('../core/ftn_address.js');

describe('binkp/util — localAddresses', () => {
    it('returns localAddress strings for every configured network', () => {
        const config = {
            messageNetworks: {
                ftn: {
                    networks: {
                        a: { localAddress: '21:1/100' },
                        b: { localAddress: '700:100/0' },
                    },
                },
            },
        };
        assert.deepEqual(localAddresses(config).sort(), ['21:1/100', '700:100/0']);
    });

    it('drops networks without a localAddress', () => {
        const config = {
            messageNetworks: {
                ftn: {
                    networks: {
                        a: { localAddress: '21:1/100' },
                        b: { someOtherKey: true }, // no localAddress
                    },
                },
            },
        };
        assert.deepEqual(localAddresses(config), ['21:1/100']);
    });

    it('returns [] when no FTN networks are configured', () => {
        assert.deepEqual(localAddresses({}), []);
        assert.deepEqual(localAddresses({ messageNetworks: {} }), []);
        assert.deepEqual(localAddresses({ messageNetworks: { ftn: {} } }), []);
    });
});

describe('binkp/util — addressKey', () => {
    it('formats as zone:net/node', () => {
        assert.equal(addressKey({ zone: 21, net: 1, node: 100 }), '21:1/100');
        assert.equal(addressKey({ zone: 700, net: 100, node: 0 }), '700:100/0');
    });

    it('falls back to zone=0 when zone is undefined', () => {
        //  An Address built from a 4D string without a zone has zone=undefined;
        //  the key must still be deterministic for dedupe Map use.
        assert.equal(addressKey({ net: 1, node: 100 }), '0:1/100');
    });

    it('two addresses with the same zone:net/node produce the same key', () => {
        //  Property exercised by the pollNodes dedupe Map and the crashmail
        //  pending-set: same logical node = same key, regardless of source.
        const a = { zone: 21, net: 1, node: 100, point: 0 };
        const b = { zone: 21, net: 1, node: 100, domain: 'fsxnet' };
        assert.equal(addressKey(a), addressKey(b));
    });
});

describe('binkp/util — findBestNodeMatch', () => {
    //  All these tests pin the same essential property: the most specific
    //  matching pattern wins, regardless of HJSON insertion order. The
    //  legacy first-match-wins behavior was config-order-dependent and a
    //  reliable footgun (a wildcard catch-all would shadow specific
    //  overrides if it happened to come first in the file).

    const ADDR = Address.fromString('21:1/100');

    it('returns undefined when no patterns match', () => {
        const nodes = { '99:1/1': { host: 'nope.example' } };
        assert.equal(findBestNodeMatch(nodes, ADDR), undefined);
    });

    it('returns undefined for empty config', () => {
        assert.equal(findBestNodeMatch({}, ADDR), undefined);
        assert.equal(findBestNodeMatch(null, ADDR), undefined);
        assert.equal(findBestNodeMatch(undefined, ADDR), undefined);
    });

    it('returns the lone matching entry', () => {
        const nodes = { '21:1/100': { host: 'a.example' } };
        const got = findBestNodeMatch(nodes, ADDR);
        assert.equal(got.host, 'a.example');
    });

    it('concrete pattern beats wildcard catch-all (wildcard listed FIRST)', () => {
        //  Without specificity sort this would return the catch-all due to
        //  insertion order — the bug we're fixing.
        const nodes = {
            '21:*': { host: 'catchall.example', sessionPassword: 'wrong' },
            '21:1/100': { host: 'specific.example', sessionPassword: 'right' },
        };
        const got = findBestNodeMatch(nodes, ADDR);
        assert.equal(got.host, 'specific.example');
        assert.equal(got.sessionPassword, 'right');
    });

    it('concrete pattern beats wildcard catch-all (wildcard listed LAST)', () => {
        //  Same outcome with reversed declaration order — the result must
        //  not depend on object key order.
        const nodes = {
            '21:1/100': { host: 'specific.example' },
            '21:*': { host: 'catchall.example' },
        };
        const got = findBestNodeMatch(nodes, ADDR);
        assert.equal(got.host, 'specific.example');
    });

    it('21:1/* beats 21:*', () => {
        //  Two wildcards, but one is more specific (binds net to 1).
        const nodes = {
            '21:*': { host: 'zone.example' },
            '21:1/*': { host: 'net.example' },
        };
        const got = findBestNodeMatch(nodes, ADDR);
        assert.equal(got.host, 'net.example');
    });

    it('non-matching concrete patterns are ignored even if listed first', () => {
        const nodes = {
            '21:2/200': { host: 'wrong.example' },
            '21:*': { host: 'catchall.example' },
        };
        const got = findBestNodeMatch(nodes, ADDR);
        assert.equal(got.host, 'catchall.example');
    });

    it('accepts a plain object that is not an Address instance', () => {
        //  Defensive: callers pass through Address.fromString() but a
        //  hand-built {zone, net, node} should also work.
        const nodes = { '21:1/100': { host: 'plain.example' } };
        const got = findBestNodeMatch(nodes, { zone: 21, net: 1, node: 100 });
        assert.equal(got.host, 'plain.example');
    });
});

describe('binkp/util — buildSpool', () => {
    let tmpDir;

    before(async () => {
        tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'enigma_buildspool_'));
    });

    after(async () => {
        await fsp.rm(tmpDir, { recursive: true, force: true });
    });

    function makeConfig(overrides = {}) {
        return {
            scannerTossers: {
                ftn_bso: Object.assign(
                    {
                        paths: {
                            outbound: tmpDir,
                            inbound: path.join(tmpDir, 'in'),
                            secInbound: path.join(tmpDir, 'secin'),
                        },
                    },
                    overrides
                ),
            },
            messageNetworks: {
                ftn: {
                    networks: {
                        testnet: { localAddress: '1:218/700', defaultZone: 1 },
                    },
                },
            },
        };
    }

    it('wires paths and networks through to the spool', async () => {
        //  Round-trip rather than inspect: a spool built from |config| must
        //  find mail written under that config's outbound path.
        const outDir = path.join(tmpDir, 'outbound');
        await fsp.mkdir(outDir, { recursive: true });
        const pkt = path.join(outDir, 'pending.pkt');
        await fsp.writeFile(pkt, 'DATA');
        await fsp.writeFile(path.join(outDir, '00da02bd.flo'), `^${pkt}\n`);

        const spool = buildSpool(makeConfig());
        const pending = await spool.getNodesWithPendingMail();

        assert.equal(pending.length, 1);
        assert.equal(pending[0].toString('3D'), '1:218/701');
    });

    it('passes staleLockMaxAgeMs through when configured', () => {
        const spool = buildSpool(makeConfig({ binkp: { staleLockMaxAgeMs: 1234 } }));
        assert.equal(spool._staleLockMaxAgeMs, 1234);
    });

    it('tolerates an empty or absent config rather than throwing', () => {
        assert.doesNotThrow(() => buildSpool({}));
        assert.doesNotThrow(() => buildSpool(undefined));
    });
});
