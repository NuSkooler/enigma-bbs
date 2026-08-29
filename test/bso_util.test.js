'use strict';

const { strict: assert } = require('assert');

const {
    DEFAULT_NETWORK_DIR_NAME,
    canonicalNetworkName,
    resolveDefaultNetworkName,
    resolveNetworkDefaultZone,
    resolveNetworkNameForZone,
    outboundDirName,
    legacyOutboundDirName,
    validateOutboundConfig,
} = require('../core/bso_util.js');

// ── fixtures ──────────────────────────────────────────────────────────────────

//  Three networks, in config order. Matches the layout from issue #719.
const THREE_NETWORKS = {
    fidonet: { localAddress: '1:103/705' },
    fsxnet: { localAddress: '21:1/121' },
    spooknet: { localAddress: '700:100/28' },
};

const ONE_NETWORK = { fsxnet: { localAddress: '21:1/121' } };

const MIXED_CASE_NETWORK = { fsxNet: { localAddress: '21:1/121' } };

describe('bso_util — outbound spool path resolution', () => {
    describe('resolveDefaultNetworkName', () => {
        it('returns the first configured network when defaultNetwork is unset', () => {
            assert.equal(resolveDefaultNetworkName(THREE_NETWORKS, undefined), 'fidonet');
        });

        it('returns the single configured network when defaultNetwork is unset', () => {
            assert.equal(resolveDefaultNetworkName(ONE_NETWORK, undefined), 'fsxnet');
        });

        it('honors an explicit defaultNetwork that is not first-listed', () => {
            assert.equal(
                resolveDefaultNetworkName(THREE_NETWORKS, 'spooknet'),
                'spooknet'
            );
        });

        it('matches defaultNetwork case-insensitively and returns the canonical key', () => {
            assert.equal(
                resolveDefaultNetworkName(MIXED_CASE_NETWORK, 'fsxnet'),
                'fsxNet'
            );
            assert.equal(resolveDefaultNetworkName(THREE_NETWORKS, 'FsxNet'), 'fsxnet');
        });

        it('falls back to the first network when defaultNetwork names an unconfigured network', () => {
            assert.equal(
                resolveDefaultNetworkName(THREE_NETWORKS, 'nosuchnet'),
                'fidonet'
            );
        });

        it('returns undefined when defaultNetwork is explicitly disabled', () => {
            for (const disabled of [null, false, '']) {
                assert.equal(
                    resolveDefaultNetworkName(THREE_NETWORKS, disabled),
                    undefined,
                    `defaultNetwork: ${JSON.stringify(disabled)} should mean "no default"`
                );
            }
        });

        it('returns undefined when no networks are configured', () => {
            assert.equal(resolveDefaultNetworkName({}, undefined), undefined);
            assert.equal(resolveDefaultNetworkName(undefined, undefined), undefined);
        });
    });

    describe('resolveNetworkDefaultZone', () => {
        it('prefers an explicit defaultZone', () => {
            const networks = { n: { localAddress: '1:2/3', defaultZone: 42 } };
            assert.equal(resolveNetworkDefaultZone(networks, 'n'), 42);
        });

        it('falls back to the localAddress zone', () => {
            assert.equal(resolveNetworkDefaultZone(THREE_NETWORKS, 'fsxnet'), 21);
        });

        it('resolves the network name case-insensitively', () => {
            assert.equal(resolveNetworkDefaultZone(MIXED_CASE_NETWORK, 'fsxnet'), 21);
        });

        it('returns undefined rather than guessing when neither is usable', () => {
            assert.equal(resolveNetworkDefaultZone({ n: {} }, 'n'), undefined);
            assert.equal(
                resolveNetworkDefaultZone({ n: { localAddress: 'nonsense' } }, 'n'),
                undefined
            );
            assert.equal(resolveNetworkDefaultZone(THREE_NETWORKS, 'nope'), undefined);
        });
    });

    //  Which network originates mail to a given zone. The answer has to match
    //  outboundDirName()'s idea of who owns the directory for that zone, or a
    //  packet would be sent from one network's address and filed under
    //  another's -- see issue #739.
    describe('resolveNetworkNameForZone', () => {
        it('resolves a zone claimed by exactly one network', () => {
            const got = resolveNetworkNameForZone(THREE_NETWORKS, undefined, 21);
            assert.equal(got.name, 'fsxnet');
            assert.deepEqual(got.candidates, ['fsxnet']);
        });

        it('resolves each of several networks by its own zone', () => {
            assert.equal(
                resolveNetworkNameForZone(THREE_NETWORKS, undefined, 1).name,
                'fidonet'
            );
            assert.equal(
                resolveNetworkNameForZone(THREE_NETWORKS, undefined, 700).name,
                'spooknet'
            );
        });

        it('returns no name for a zone no network claims', () => {
            const got = resolveNetworkNameForZone(THREE_NETWORKS, undefined, 2);
            assert.equal(got.name, undefined);
            assert.deepEqual(got.candidates, []);
        });

        it('honours an explicit defaultZone over the localAddress zone', () => {
            const networks = { odd: { localAddress: '1:1/1', defaultZone: 42 } };
            assert.equal(resolveNetworkNameForZone(networks, undefined, 42).name, 'odd');
            assert.equal(
                resolveNetworkNameForZone(networks, undefined, 1).name,
                undefined
            );
        });

        it('breaks a shared zone with defaultNetwork, and reports the tie', () => {
            const networks = {
                fidonet: { localAddress: '1:103/705' },
                privnet: { localAddress: '1:999/1' },
            };
            const got = resolveNetworkNameForZone(networks, 'privnet', 1);
            assert.equal(got.name, 'privnet');
            assert.deepEqual(got.candidates.sort(), ['fidonet', 'privnet']);
        });

        it('agrees with outboundDirName on who owns a shared zone', () => {
            //  The from-address and the outbound directory must be decided the
            //  same way; this is the case where they could diverge.
            const networks = {
                fidonet: { localAddress: '1:103/705' },
                privnet: { localAddress: '1:999/1' },
            };
            for (const defaultNetwork of [undefined, 'fidonet', 'privnet']) {
                const { name } = resolveNetworkNameForZone(networks, defaultNetwork, 1);
                assert.equal(
                    outboundDirName(networks, defaultNetwork, name, 1),
                    outboundDirName(
                        networks,
                        defaultNetwork,
                        resolveDefaultNetworkName(networks, defaultNetwork),
                        1
                    ),
                    `defaultNetwork=${defaultNetwork}`
                );
            }
        });

        it('still resolves when defaultNetwork names something unconfigured', () => {
            const networks = {
                fidonet: { localAddress: '1:103/705' },
                privnet: { localAddress: '1:999/1' },
            };
            const got = resolveNetworkNameForZone(networks, 'nope', 1);
            assert.ok(got.candidates.includes(got.name));
        });

        it('ignores a network whose zone cannot be resolved', () => {
            const networks = { broken: {}, fsxnet: { localAddress: '21:1/121' } };
            assert.equal(
                resolveNetworkNameForZone(networks, undefined, 21).name,
                'fsxnet'
            );
        });

        it('returns no name for an empty or absent network table', () => {
            assert.equal(resolveNetworkNameForZone({}, undefined, 21).name, undefined);
            assert.equal(
                resolveNetworkNameForZone(undefined, undefined, 21).name,
                undefined
            );
        });
    });

    describe('canonicalNetworkName', () => {
        it('maps any casing to the configured key', () => {
            assert.equal(canonicalNetworkName(MIXED_CASE_NETWORK, 'FSXNET'), 'fsxNet');
        });

        it('returns undefined for unknown or empty names', () => {
            assert.equal(canonicalNetworkName(THREE_NETWORKS, 'nope'), undefined);
            assert.equal(canonicalNetworkName(THREE_NETWORKS, ''), undefined);
            assert.equal(canonicalNetworkName(THREE_NETWORKS, undefined), undefined);
        });
    });

    describe('outboundDirName', () => {
        it('gives the default network the bare outbound dir', () => {
            assert.equal(
                outboundDirName(THREE_NETWORKS, undefined, 'fidonet', 1),
                DEFAULT_NETWORK_DIR_NAME
            );
        });

        it('gives every other network its own dir', () => {
            assert.equal(
                outboundDirName(THREE_NETWORKS, undefined, 'fsxnet', 21),
                'fsxnet'
            );
            assert.equal(
                outboundDirName(THREE_NETWORKS, undefined, 'spooknet', 700),
                'spooknet'
            );
        });

        it('follows an explicit defaultNetwork', () => {
            assert.equal(
                outboundDirName(THREE_NETWORKS, 'fsxnet', 'fsxnet', 21),
                DEFAULT_NETWORK_DIR_NAME
            );
            assert.equal(
                outboundDirName(THREE_NETWORKS, 'fsxnet', 'fidonet', 1),
                'fidonet'
            );
        });

        it('gives no network the bare outbound dir when the default is disabled', () => {
            assert.equal(outboundDirName(THREE_NETWORKS, null, 'fidonet', 1), 'fidonet');
            assert.equal(outboundDirName(THREE_NETWORKS, null, 'fsxnet', 21), 'fsxnet');
        });

        it('lowercases the directory component regardless of the config key casing', () => {
            assert.equal(
                outboundDirName(MIXED_CASE_NETWORK, null, 'fsxNet', 21),
                'fsxnet'
            );
            //  ...and still recognizes it as the default network
            assert.equal(
                outboundDirName(MIXED_CASE_NETWORK, undefined, 'fsxNet', 21),
                DEFAULT_NETWORK_DIR_NAME
            );
        });

        it('appends a 3-hex zone suffix for non-default zones', () => {
            assert.equal(
                outboundDirName(THREE_NETWORKS, undefined, 'fidonet', 15),
                'outbound.00f'
            );
            assert.equal(
                outboundDirName(THREE_NETWORKS, undefined, 'fsxnet', 2),
                'fsxnet.002'
            );
            assert.equal(
                outboundDirName(THREE_NETWORKS, undefined, 'spooknet', 700),
                'spooknet'
            );
        });

        it('omits the zone suffix when no zone is supplied', () => {
            assert.equal(
                outboundDirName(THREE_NETWORKS, undefined, 'fsxnet', undefined),
                'fsxnet'
            );
        });
    });

    describe('legacyOutboundDirName', () => {
        it('gives the pre-0.5.1-beta name for the default network', () => {
            assert.equal(
                legacyOutboundDirName(THREE_NETWORKS, undefined, 'fidonet', 1),
                'fidonet'
            );
            assert.equal(
                legacyOutboundDirName(THREE_NETWORKS, undefined, 'fidonet', 15),
                'fidonet.00f'
            );
        });

        it('returns null for non-default networks, whose name never changed', () => {
            assert.equal(
                legacyOutboundDirName(THREE_NETWORKS, undefined, 'fsxnet', 21),
                null
            );
        });

        it('returns null when there is no default network', () => {
            assert.equal(legacyOutboundDirName(THREE_NETWORKS, null, 'fidonet', 1), null);
        });
    });

    describe('validateOutboundConfig', () => {
        it('reports nothing for a healthy config', () => {
            assert.deepEqual(validateOutboundConfig(THREE_NETWORKS, 'fsxnet'), []);
        });

        it('reports a defaultNetwork that names no configured network', () => {
            const issues = validateOutboundConfig(THREE_NETWORKS, 'nosuchnet');
            assert.equal(issues.length, 1);
            assert.equal(issues[0].code, 'unknownDefaultNetwork');
            assert.equal(issues[0].using, 'fidonet');
        });

        it('does not report an explicitly disabled defaultNetwork as unknown', () => {
            assert.deepEqual(validateOutboundConfig(THREE_NETWORKS, null), []);
        });

        it('reports a network whose zone cannot be resolved', () => {
            const issues = validateOutboundConfig({ broken: {} }, undefined);
            assert.equal(issues.length, 1);
            assert.equal(issues[0].code, 'unresolvableZone');
            assert.equal(issues[0].network, 'broken');
        });

        it('reports a network name that collides with the default outbound dir', () => {
            const issues = validateOutboundConfig(
                {
                    fidonet: { localAddress: '1:103/705' },
                    Outbound: { localAddress: '21:1/121' },
                },
                undefined
            );
            assert.equal(issues.length, 1);
            assert.equal(issues[0].code, 'reservedNetworkName');
            assert.equal(issues[0].network, 'Outbound');
        });
    });
});
