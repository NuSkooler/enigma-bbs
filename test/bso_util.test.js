'use strict';

const { strict: assert } = require('assert');

const Address = require('../core/ftn_address.js');

const {
    DEFAULT_NETWORK_DIR_NAME,
    canonicalNetworkName,
    resolveDefaultNetworkName,
    resolveNetworkDefaultZone,
    resolveNetworkNameForZone,
    selectLocalNetworkForAddress,
    canonicalNetworkNameForAddress,
    outboundDirName,
    legacyOutboundDirName,
    validateOutboundConfig,
    flowRefIsSent,
    flowRefBody,
    companionTicIndex,
    withCompanionTicRefs,
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

//
//  The companion rule: a forwarded payload and the TIC announcing it are
//  queued in one append, adjacent and in that order, so removing one must
//  remove the other. This lives here because it is shared -- ftn_bso's
//  scrubFlowFileRefs() knew it and bso_spool's prune path did not, which left
//  downlinks holding TICs for files they would never receive (#862).
//
describe('bso_util — flow file reference lines', () => {
    const PAYLOAD = '/files/nodelist/NODELIST.246';
    const TIC = '/ob/outbound/0a1b2c3d.tic';

    describe('flowRefIsSent / flowRefBody', () => {
        it('reads the directive off each of the FTS-5005 prefixes', () => {
            for (const prefix of ['^', '#', '-', '!', '']) {
                assert.equal(flowRefBody(`${prefix}${PAYLOAD}`), PAYLOAD, prefix);
                assert.equal(flowRefIsSent(`${prefix}${PAYLOAD}`), false, prefix);
            }
            assert.equal(flowRefBody(`~${PAYLOAD}`), PAYLOAD);
            assert.equal(flowRefIsSent(`~${PAYLOAD}`), true);
        });

        it('ignores surrounding whitespace, which real flow files carry', () => {
            assert.equal(flowRefBody(`  ^${PAYLOAD}\r`), PAYLOAD);
            assert.equal(flowRefIsSent(`  ~${PAYLOAD}\r`), true);
        });
    });

    describe('companionTicIndex', () => {
        it('finds the TIC queued immediately after a payload', () => {
            assert.equal(companionTicIndex([PAYLOAD, `^${TIC}`], 0), 1);
        });

        it('is case insensitive about the extension', () => {
            assert.equal(companionTicIndex([PAYLOAD, '^/ob/0A1B2C3D.TIC'], 0), 1);
        });

        it('does not claim a TIC that is not adjacent', () => {
            assert.equal(
                companionTicIndex([PAYLOAD, '/files/other.zip', `^${TIC}`], 0),
                -1
            );
        });

        it('does not claim a line without the delete-after-send directive', () => {
            //  Only a TIC we generated carries '^'. One queued any other way
            //  is a payload in its own right and is not ours to remove.
            assert.equal(companionTicIndex([PAYLOAD, TIC], 0), -1);
            assert.equal(companionTicIndex([PAYLOAD, `-${TIC}`], 0), -1);
        });

        it('does not claim a TIC that has already been sent', () => {
            //  It has gone; rewriting history helps nobody.
            assert.equal(companionTicIndex([PAYLOAD, `~${TIC}`], 0), -1);
        });

        it('does not claim a file that merely follows, whatever its name', () => {
            assert.equal(companionTicIndex([PAYLOAD, '^/ob/bundle.su0'], 0), -1);
            assert.equal(companionTicIndex([PAYLOAD, '^/ob/notatic'], 0), -1);
        });

        it('copes with the payload being the last line', () => {
            assert.equal(companionTicIndex([PAYLOAD], 0), -1);
            assert.equal(companionTicIndex([PAYLOAD, ''], 0), -1);
        });
    });

    describe('withCompanionTicRefs', () => {
        const sorted = result => Array.from(result.indices).sort((a, b) => a - b);

        it('takes the TIC with its payload, and reports it for unlinking', () => {
            const lines = [PAYLOAD, `^${TIC}`, '/files/keep.zip'];
            const result = withCompanionTicRefs(lines, [0]);

            assert.deepEqual(sorted(result), [0, 1]);
            assert.deepEqual(result.ticPaths, [TIC]);
        });

        it('leaves a payload queued without a TIC alone', () => {
            //  A link configured noTic gets the file bare.
            const lines = ['/files/a.zip', '/files/b.zip'];
            const result = withCompanionTicRefs(lines, [0]);

            assert.deepEqual(sorted(result), [0]);
            assert.deepEqual(result.ticPaths, []);
        });

        it('pairs each payload with its own TIC across several forwards', () => {
            const lines = [
                '/files/a.zip',
                '^/ob/aaaaaaaa.tic',
                '/files/b.zip',
                '^/ob/bbbbbbbb.tic',
                '/files/c.zip',
                '^/ob/cccccccc.tic',
            ];
            const result = withCompanionTicRefs(lines, [0, 4]);

            assert.deepEqual(sorted(result), [0, 1, 4, 5]);
            assert.deepEqual(result.ticPaths, ['/ob/aaaaaaaa.tic', '/ob/cccccccc.tic']);
            assert.ok(
                !result.indices.has(2) && !result.indices.has(3),
                'the forward in between must be untouched'
            );
        });

        it('still unlinks a TIC the caller had already selected in its own right', () => {
            //  Both the payload and its generated TIC gone from disk: the
            //  prune path reports each as missing, so both indices arrive
            //  here. The TIC is named once, not twice.
            const lines = [PAYLOAD, `^${TIC}`];
            const result = withCompanionTicRefs(lines, [0, 1]);

            assert.deepEqual(sorted(result), [0, 1]);
            assert.deepEqual(result.ticPaths, [TIC]);
        });

        it('returns the input untouched when nothing is being removed', () => {
            const result = withCompanionTicRefs([PAYLOAD, `^${TIC}`], []);
            assert.deepEqual(sorted(result), []);
            assert.deepEqual(result.ticPaths, []);
        });
    });
});

//  #757: an area carried on more than one network, or a hub with several AKAs.
//
//  resolveNetworkNameForZone() above answers "which network owns this zone?",
//  which is right for choosing a *directory* -- a zone maps to exactly one
//  outbound subdirectory. It is the wrong tool for choosing a From line,
//  because it gives one answer for a whole area: TIC forwarding took the
//  network from the first downlink's zone and then signed every downlink with
//  it.
//
describe('bso_util — choosing an AKA per link', () => {
    const THREE = {
        fidonet: { localAddress: '1:103/705' },
        fsxnet: { localAddress: '21:1/121' },
        spooknet: { localAddress: '700:100/28' },
    };

    const pick = (networks, defaultNetwork, addr) =>
        selectLocalNetworkForAddress(networks, defaultNetwork, Address.fromString(addr));

    it('prefers an AKA in the same net, which is the closest we can be', () => {
        const r = pick(THREE, undefined, '1:103/999');
        assert.equal(r.name, 'fidonet');
        assert.equal(r.distance, 0);
        assert.equal(r.address.toString(), '1:103/705');
    });

    it('falls back to an AKA in the same zone', () => {
        const r = pick(THREE, undefined, '1:250/1');
        assert.equal(r.name, 'fidonet');
        assert.equal(r.distance, 1);
    });

    it('gives each network its own links rather than one answer for all', () => {
        //  The actual defect. These three downlinks previously all got
        //  whichever network the first one resolved to.
        assert.equal(pick(THREE, undefined, '1:103/999').name, 'fidonet');
        assert.equal(pick(THREE, undefined, '21:1/200').name, 'fsxnet');
        assert.equal(pick(THREE, undefined, '700:100/50').name, 'spooknet');
    });

    it('still answers for a zone no AKA shares, and says it is a stretch', () => {
        //  Better than refusing: a link may well know us by an address from
        //  another network. The distance is how the caller knows to say so.
        const r = pick(THREE, undefined, '99:9/9');
        assert.ok(r.name, 'some address must be offered');
        assert.equal(r.distance, 2);
    });

    it("honours a network's declared defaultZone over its localAddress", () => {
        //  A system whose address is in one zone may still be configured to
        //  serve another.
        const networks = {
            main: { localAddress: '1:103/705' },
            odd: { localAddress: '1:1/1', defaultZone: 42 },
        };
        assert.equal(pick(networks, undefined, '42:10/20').name, 'odd');
    });

    it('breaks a genuine tie with defaultNetwork, then config order', () => {
        //
        //  Both in net 1, so both are distance 0 and the tie-break is what
        //  decides. Note the fixture has to be built this way *on purpose*: if
        //  the two networks were in different nets, distance would resolve it
        //  first and this would pass no matter what the tie-break did.
        //
        const networks = {
            first: { localAddress: '21:1/100' },
            second: { localAddress: '21:1/200' },
        };
        assert.equal(pick(networks, 'second', '21:1/300').name, 'second');
        assert.equal(pick(networks, undefined, '21:1/300').name, 'first');
        assert.deepEqual(pick(networks, 'second', '21:1/300').candidates, [
            'first',
            'second',
        ]);
    });

    it('lets distance win before any tie-break is reached', () => {
        //
        //  And here is the case the fixture above cannot show. These two
        //  networks both claim zone 1, so resolveNetworkNameForZone() answers
        //  'neta' -- defaultNetwork/first. Distance answers 'netb', because we
        //  are a neighbour in that downlink's own net.
        //
        //  The two disagreeing is correct and load bearing: one picks an
        //  identity per link, the other names the single canonical directory
        //  for a zone. Only the second may decide where a file is filed.
        //
        const networks = {
            neta: { localAddress: '1:100/1' },
            netb: { localAddress: '1:200/1' },
        };

        assert.equal(pick(networks, undefined, '1:200/5').name, 'netb');
        assert.equal(pick(networks, undefined, '1:200/5').distance, 0);
        assert.equal(
            resolveNetworkNameForZone(networks, undefined, 1).name,
            'neta',
            'the zone resolver still answers for the directory'
        );
        assert.equal(
            canonicalNetworkNameForAddress(
                networks,
                undefined,
                Address.fromString('1:200/5')
            ),
            'neta',
            'and the canonical directory follows the zone, not the identity'
        );
    });

    it('ignores a network whose localAddress will not parse', () => {
        const networks = {
            broken: { localAddress: 'not-an-address' },
            good: { localAddress: '21:1/121' },
        };
        assert.equal(pick(networks, undefined, '21:1/200').name, 'good');
    });

    it('answers nothing rather than guessing when it has nothing to go on', () => {
        assert.deepEqual(pick({}, undefined, '21:1/200'), {});
        assert.deepEqual(
            selectLocalNetworkForAddress(THREE, undefined, undefined),
            {},
            'no address'
        );
        assert.deepEqual(
            selectLocalNetworkForAddress(THREE, undefined, { net: 1, node: 2 }),
            {},
            'an address with no zone says nothing about which network it is on'
        );
    });
});
