'use strict';

//
//  A simulated FTN file-echo network, driven through the real forwarding code.
//
//  Why this exists: every other test we have validates our code against our own
//  reading of FTS-5006 / FSC-0087, so a misreading is invisible. This one asks a
//  different question -- not "does each field match the spec text" but "does the
//  emergent behaviour of a network of these hold". A loop guard is not a
//  property of one TIC; it is a property of a topology, and no single-node test
//  can see it.
//
//  Several nodes are instantiated, each with its own config, address, downlink
//  set and outbound spool. A file is injected at one of them and the real
//  forwardTicToDownlinks() runs; whatever lands in a node's outbound is then
//  delivered to the downlink it was addressed to, parsed by the real
//  TicFileInfo, and fed onward. Everything between injection and quiescence is
//  production code: the writer, the Seenby/Path construction, the downlink
//  selection, the flow file queueing and the reader.
//
//  Only the file base is simulated. Persisting an entry needs a live database
//  and is covered thoroughly elsewhere; what is interesting here begins once
//  the payload is stored.
//

const { strict: assert } = require('assert');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const paths = require('path');

const configModule = require('../core/config.js');
const TicFileInfo = require('../core/tic_file_info.js');
const Address = require('../core/ftn_address.js');

const AREA = 'FSX_GEN';
const PASSWORD = 'SIMPASS';
const PAYLOAD = 'NODELIST.Z21';
const PAYLOAD_BYTES = 'payload bytes';

describe('TIC forwarding across a simulated network', function () {
    let root;

    beforeEach(async () => {
        root = await fsp.mkdtemp(paths.join(os.tmpdir(), 'enigma_ticnet_'));
    });

    afterEach(async () => {
        await fsp.rm(root, { recursive: true, force: true });
    });

    //  BSO flow file basename for an address: 4 hex net + 4 hex node.
    function flowBase(addr) {
        const a = Address.fromString(addr);
        return (
            `0000${a.net.toString(16)}`.slice(-4) + `0000${a.node.toString(16)}`.slice(-4)
        );
    }

    //
    //  One node in the simulated network.
    //
    //  |downlinks| is who this node passes the echo on to. Every node knows
    //  every other as a configured peer with a TIC password, so nothing is
    //  refused for lack of authentication -- that gate is tested directly in
    //  ftn_tic_forward.test.js and would only obscure the topology here.
    //
    class SimNode {
        constructor(addr, downlinks, allAddrs) {
            this.allAddrs = allAddrs;
            this.addr = addr;
            this.downlinks = downlinks;
            this.dir = paths.join(root, addr.replace(/[:/.]/g, '_'));
            this.outbound = paths.join(this.dir, 'outbound');
            this.fileBase = paths.join(this.dir, 'filebase');
            fs.mkdirSync(this.outbound, { recursive: true });
            fs.mkdirSync(this.fileBase, { recursive: true });

            this.nodes = {};
            allAddrs
                .filter(a => a !== addr)
                .forEach(a => {
                    this.nodes[a] = { tic: { password: PASSWORD } };
                });

            //  what this node has received, in arrival order
            this.received = [];
        }

        config() {
            return {
                debug: { assertsEnabled: false },
                general: { boardName: `Sim ${this.addr}` },
                fileBase: { areas: {}, storageTags: {} },
                scannerTossers: {
                    ftn_bso: {
                        defaultNetwork: 'simnet',
                        paths: { outbound: this.outbound },
                        tic: {},
                        ticAreas: {
                            fsx_gen: {
                                areaTag: 'simArea',
                                network: 'simnet',
                                //  every node may publish to every other; the
                                //  topology under test is the downlink graph,
                                //  not the authorization one
                                uplinks: this.allAddrs,
                                downlinks: this.downlinks,
                            },
                        },
                        nodes: this.nodes,
                    },
                },
                messageNetworks: {
                    ftn: {
                        networks: {
                            simnet: { localAddress: this.addr, defaultZone: 21 },
                        },
                    },
                },
            };
        }

        //  The payload as this node holds it, once imported.
        storePayload() {
            const p = paths.join(this.fileBase, PAYLOAD);
            if (!fs.existsSync(p)) {
                fs.writeFileSync(p, PAYLOAD_BYTES);
            }
            return p;
        }
    }

    //
    //  Run one node's forwarding pass over a TIC it has just received, then
    //  collect what it queued and deliver each piece to its addressee.
    //
    //  Delivery reads the flow file the way a mailer would: a node's queued
    //  work for a peer is the flow file named for that peer, and the '^'-marked
    //  .tic line in it is the announcement. Sending is then simulated by
    //  clearing the spool, as a successful session would.
    //
    async function runPass(node, ticPath) {
        const prev = configModule._pushTestConfig(node.config());
        try {
            const { getModule } = require('../core/scanner_tossers/ftn_bso.js');
            const inst = new getModule();

            const ticFileInfo = await new Promise((resolve, reject) =>
                TicFileInfo.createFromFile(ticPath, (e, i) =>
                    e ? reject(e) : resolve(i)
                )
            );

            const localInfo = {
                node: ticFileInfo.getAsString('From'),
                inboundType: 'secInbound',
                passwordVerified: true,
                externalAreaTag: AREA,
                newPath: node.storePayload(),
                wasRenamedOnCollision: false,
                fileEntry: { meta: { file_crc32: 'deadbeef' } },
            };

            await new Promise(resolve =>
                inst.forwardTicToDownlinks(ticFileInfo, localInfo, resolve)
            );
        } finally {
            configModule._popTestConfig(prev);
        }

        //  collect and drain
        const spoolDir = paths.join(node.outbound, 'outbound');
        let entries = [];
        try {
            entries = await fsp.readdir(spoolDir);
        } catch {
            return [];
        }

        const deliveries = [];
        for (const downlink of node.downlinks) {
            const base = flowBase(downlink);
            const flowName = entries.find(e => e.toLowerCase().startsWith(base));
            if (!flowName) {
                continue;
            }

            const flow = await fsp.readFile(paths.join(spoolDir, flowName), 'utf8');
            for (const line of flow.split('\n')) {
                const t = line.trim();
                if (!t.startsWith('^') || '.tic' !== paths.extname(t).toLowerCase()) {
                    continue;
                }
                deliveries.push({ to: downlink, ticPath: t.slice(1) });
            }
        }

        return deliveries;
    }

    //
    //  Inject a TIC at |originAddr| and run the network to quiescence.
    //
    //  |maxRounds| is a non-termination detector, not a tuning knob: a working
    //  loop guard settles in at most one round per hop, so blowing through it
    //  means the file is circulating.
    //
    async function simulate(topology, originAddr, opts = {}) {
        const maxRounds = opts.maxRounds || 20;
        const allAddrs = Object.keys(topology);
        const nodes = {};
        allAddrs.forEach(a => {
            nodes[a] = new SimNode(a, topology[a], allAddrs);
        });

        //  the TIC as hatched at the origin
        const originTic = paths.join(nodes[originAddr].dir, 'ORIGIN.TIC');
        fs.writeFileSync(
            originTic,
            [
                `Area ${AREA}`,
                `File ${PAYLOAD}`,
                'Desc simulated file',
                `Origin ${originAddr}`,
                `From ${originAddr}`,
                'Size 13',
                'Crc DEADBEEF',
                `Seenby ${originAddr}`,
                '',
            ].join('\r\n')
        );

        let queue = [{ to: originAddr, ticPath: originTic }];
        let rounds = 0;

        while (queue.length > 0) {
            if (++rounds > maxRounds) {
                const seen = allAddrs
                    .map(a => `${a}=${nodes[a].received.length}`)
                    .join(' ');
                assert.fail(
                    `network did not settle after ${maxRounds} rounds — the file is ` +
                        `still circulating (deliveries so far: ${seen})`
                );
            }

            const next = [];
            for (const item of queue) {
                const node = nodes[item.to];
                node.received.push(item.ticPath);
                //  every node forwards what it receives, including the origin's
                //  own initial hatch
                next.push(...(await runPass(node, item.ticPath)));
            }
            queue = next;
        }

        return { nodes, rounds };
    }

    //  Seenby of the last TIC a node received, as 4D strings.
    function seenbyOfLast(node) {
        const p = node.received[node.received.length - 1];
        const content = fs.readFileSync(p, 'utf8');
        return content
            .split('\r\n')
            .filter(l => l.startsWith('Seenby '))
            .map(l => l.slice(7).trim());
    }

    function pathCountOfLast(node) {
        const p = node.received[node.received.length - 1];
        return fs
            .readFileSync(p, 'utf8')
            .split('\r\n')
            .filter(l => l.startsWith('Path ')).length;
    }

    describe('a linear chain', () => {
        //  A -> B -> C -> D
        const CHAIN = {
            '21:1/100': ['21:1/200'],
            '21:1/200': ['21:1/300'],
            '21:1/300': ['21:1/400'],
            '21:1/400': [],
        };

        it('reaches every node exactly once and settles', async () => {
            const { nodes } = await simulate(CHAIN, '21:1/100');
            ['21:1/200', '21:1/300', '21:1/400'].forEach(a => {
                assert.equal(nodes[a].received.length, 1, `${a} received once`);
            });
        });

        it('accumulates a Path line per hop', async () => {
            //  FTS-5006: "Each system should add its own line to the TIC file."
            const { nodes } = await simulate(CHAIN, '21:1/100');
            assert.equal(pathCountOfLast(nodes['21:1/200']), 1);
            assert.equal(pathCountOfLast(nodes['21:1/300']), 2);
            assert.equal(pathCountOfLast(nodes['21:1/400']), 3);
        });

        it('grows Seenby monotonically toward the whole chain', async () => {
            const { nodes } = await simulate(CHAIN, '21:1/100');
            assert.deepEqual(seenbyOfLast(nodes['21:1/200']), ['21:1/100', '21:1/200']);
            assert.deepEqual(seenbyOfLast(nodes['21:1/400']), [
                '21:1/100',
                '21:1/200',
                '21:1/300',
                '21:1/400',
            ]);
        });
    });

    describe('a hub with many downlinks', () => {
        it('feeds every spoke exactly once, and no spoke re-sends', async () => {
            const spokes = ['21:1/200', '21:1/300', '21:1/400', '21:1/500'];
            const topology = { '21:1/100': spokes };
            spokes.forEach(s => {
                topology[s] = [];
            });

            const { nodes } = await simulate(topology, '21:1/100');
            spokes.forEach(s => assert.equal(nodes[s].received.length, 1, s));
        });

        it('tells every spoke about all the others', async () => {
            //  The Seenby a hub writes is the same complete list for everyone,
            //  which is what lets a node two hops away tell that a system it
            //  also feeds already has the file.
            const spokes = ['21:1/200', '21:1/300'];
            const topology = { '21:1/100': spokes, '21:1/200': [], '21:1/300': [] };
            const { nodes } = await simulate(topology, '21:1/100');

            assert.deepEqual(seenbyOfLast(nodes['21:1/200']), [
                '21:1/100',
                '21:1/200',
                '21:1/300',
            ]);
        });
    });

    describe('a cycle', () => {
        //  A -> B -> C -> A. Without a loop guard this never terminates.
        it('terminates, and the file does not return to its origin', async () => {
            const { nodes } = await simulate(
                {
                    '21:1/100': ['21:1/200'],
                    '21:1/200': ['21:1/300'],
                    '21:1/300': ['21:1/100'],
                },
                '21:1/100'
            );

            assert.equal(
                nodes['21:1/100'].received.length,
                1,
                'the origin must not receive its own file back'
            );
            assert.equal(nodes['21:1/200'].received.length, 1);
            assert.equal(nodes['21:1/300'].received.length, 1);
        });

        it('terminates on a longer cycle too', async () => {
            const { nodes } = await simulate(
                {
                    '21:1/100': ['21:1/200'],
                    '21:1/200': ['21:1/300'],
                    '21:1/300': ['21:1/400'],
                    '21:1/400': ['21:1/500'],
                    '21:1/500': ['21:1/100'],
                },
                '21:1/100'
            );
            assert.equal(nodes['21:1/100'].received.length, 1);
        });

        it('terminates when two hubs feed each other', async () => {
            //  The mutual-subscription mistake two sysops make between them.
            const { nodes } = await simulate(
                { '21:1/100': ['21:1/200'], '21:1/200': ['21:1/100'] },
                '21:1/100'
            );
            assert.equal(nodes['21:1/100'].received.length, 1);
            assert.equal(nodes['21:1/200'].received.length, 1);
        });
    });

    describe('a cycle that no other check can save', () => {
        //
        //  These are the topologies that isolate the Seenby guard, and they
        //  exist because the obvious cycle tests do not.
        //
        //  In A -> B -> C -> A the file is stopped when C considers A, but by
        //  the *Origin* check, not by Seenby -- A hatched it. Same for a cycle
        //  closing on the sender. So every such test still passes with the
        //  Seenby guard entirely removed, which makes them worthless as
        //  evidence that it works. Verified by deleting the guard and watching
        //  them all pass.
        //
        //  Here the loop closes on a node that is neither the origin, nor the
        //  sender, nor us. Only Seenby can stop it.
        //

        it('terminates when the loop closes away from the origin', async () => {
            //  A -> B -> C -> D -> B.  B is the loop point and A is the origin.
            const { nodes } = await simulate(
                {
                    '21:1/100': ['21:1/200'],
                    '21:1/200': ['21:1/300'],
                    '21:1/300': ['21:1/400'],
                    '21:1/400': ['21:1/200'],
                },
                '21:1/100'
            );

            assert.equal(
                nodes['21:1/200'].received.length,
                1,
                'B must not be fed a second time by D'
            );
            assert.equal(nodes['21:1/300'].received.length, 1);
            assert.equal(nodes['21:1/400'].received.length, 1);
        });

        it('terminates on a wider loop away from the origin', async () => {
            //  A -> B -> C -> D -> E -> C
            const { nodes } = await simulate(
                {
                    '21:1/100': ['21:1/200'],
                    '21:1/200': ['21:1/300'],
                    '21:1/300': ['21:1/400'],
                    '21:1/400': ['21:1/500'],
                    '21:1/500': ['21:1/300'],
                },
                '21:1/100'
            );
            assert.equal(nodes['21:1/300'].received.length, 1, 'C, once only');
        });

        it('terminates when two mid-network nodes feed each other', async () => {
            //  A -> {B, C}, and B <-> C. Neither is the origin or the sender
            //  from the other's point of view.
            const { nodes } = await simulate(
                {
                    '21:1/100': ['21:1/200', '21:1/300'],
                    '21:1/200': ['21:1/300'],
                    '21:1/300': ['21:1/200'],
                },
                '21:1/100'
            );
            assert.equal(nodes['21:1/200'].received.length, 1);
            assert.equal(nodes['21:1/300'].received.length, 1);
        });
    });

    describe('a diamond', () => {
        //  A -> {B, C}, and B -> D, C -> D.
        const DIAMOND = {
            '21:1/100': ['21:1/200', '21:1/300'],
            '21:1/200': ['21:1/400'],
            '21:1/300': ['21:1/400'],
            '21:1/400': [],
        };

        it('delivers to D twice — which is correct, not a bug', async () => {
            //
            //  Worth being explicit about, because "exactly once" is the
            //  tempting assertion and it would be wrong.
            //
            //  Seenby carries what the *forwarding* node knows: A writes
            //  {A, B, C}, since those are itself and its own downlinks. Neither
            //  B nor C is told that the other also feeds D, so both forward to
            //  it. Real FidoNet behaves the same way -- Seenby bounds loops, it
            //  does not deduplicate a diamond.
            //
            //  The protection is at the receiver: D's second import finds the
            //  file already present, collides, is stored under another name and
            //  is refused onward forwarding by the collision gate. That is
            //  covered in ftn_tic_forward.test.js.
            //
            const { nodes } = await simulate(DIAMOND, '21:1/100');
            assert.equal(nodes['21:1/400'].received.length, 2);
        });

        it('still settles rather than circulating', async () => {
            const { rounds } = await simulate(DIAMOND, '21:1/100');
            assert.ok(rounds <= 4, `settled in ${rounds} rounds`);
        });

        it('does not send back up the diamond', async () => {
            const { nodes } = await simulate(DIAMOND, '21:1/100');
            assert.equal(nodes['21:1/100'].received.length, 1, 'origin, once');
            assert.equal(nodes['21:1/200'].received.length, 1);
            assert.equal(nodes['21:1/300'].received.length, 1);
        });
    });

    describe('topologies that would loop without the guard', () => {
        it('does not re-send to a node listed as its own downlink', async () => {
            //  A configuration mistake, not a topology -- but it must not loop.
            const { nodes } = await simulate(
                { '21:1/100': ['21:1/100', '21:1/200'], '21:1/200': [] },
                '21:1/100'
            );
            assert.equal(nodes['21:1/100'].received.length, 1);
            assert.equal(nodes['21:1/200'].received.length, 1);
        });

        it('handles a node feeding back to the origin directly', async () => {
            const { nodes } = await simulate(
                {
                    '21:1/100': ['21:1/200', '21:1/300'],
                    '21:1/200': ['21:1/100'],
                    '21:1/300': ['21:1/100'],
                },
                '21:1/100'
            );
            assert.equal(nodes['21:1/100'].received.length, 1);
        });

        it('settles a fully connected mesh', async () => {
            //  Every node feeds every other. The pathological case: without a
            //  working guard this diverges immediately.
            const all = ['21:1/100', '21:1/200', '21:1/300', '21:1/400'];
            const mesh = {};
            all.forEach(a => {
                mesh[a] = all.filter(b => b !== a);
            });

            const { nodes } = await simulate(mesh, '21:1/100');

            //  The origin writes every node into Seenby on the first hop, so
            //  nobody has anyone left to forward to.
            all.slice(1).forEach(a =>
                assert.equal(nodes[a].received.length, 1, `${a} received once`)
            );
            assert.equal(nodes['21:1/100'].received.length, 1);
        });
    });

    describe('points', () => {
        it('feeds a point and its boss node independently', async () => {
            const { nodes } = await simulate(
                {
                    '21:1/100': ['21:1/200', '21:1/200.4'],
                    '21:1/200': [],
                    '21:1/200.4': [],
                },
                '21:1/100'
            );
            assert.equal(nodes['21:1/200'].received.length, 1);
            assert.equal(nodes['21:1/200.4'].received.length, 1);
        });

        it('does not confuse a point with its boss node in Seenby', async () => {
            const { nodes } = await simulate(
                {
                    '21:1/100': ['21:1/200', '21:1/200.4'],
                    '21:1/200': [],
                    '21:1/200.4': [],
                },
                '21:1/100'
            );
            const seenby = seenbyOfLast(nodes['21:1/200']);
            assert.ok(seenby.includes('21:1/200'), 'the boss node');
            assert.ok(seenby.includes('21:1/200.4'), 'and the point, separately');
        });
    });
});
