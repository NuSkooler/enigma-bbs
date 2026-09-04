'use strict';

//
//  oputil bso — the command layer.
//
//  The spool methods underneath are covered in binkp_bso_spool.test.js. What
//  is only reachable from here is the CLI contract itself: that a destructive
//  command stays behind --yes, that a busy node is reported rather than
//  passed off as "nothing to do", and that failures exit non-zero with
//  something an operator can read.
//
//  These run oputil as a real process. |argv| is bound from process.argv when
//  oputil_common is first required, so exercising the handlers in-process
//  would mean rebuilding the module tree per case with a doctored argv --
//  more machinery than the thing under test. test/server_listen.test.js
//  already shells out this way.
//

const { strict: assert } = require('assert');
const { execFileSync } = require('child_process');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');

const REPO_ROOT = path.join(__dirname, '..');

//  net=0x00da=218 node=0x02bd=701 -> 00da02bd
const NODE = '1:218/701';
const FLOW_NAME = '00da02bd.clo';

describe('oputil bso', function () {
    //  Each case spawns node and opens the databases; a handful of those is
    //  still fast, but nowhere near mocha's default 2s.
    this.timeout(30000);

    let tmpDir;

    before(async () => {
        tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'enigma_oputil_bso_'));
    });

    after(async () => {
        await fsp.rm(tmpDir, { recursive: true, force: true });
    });

    //
    //  A throwaway config plus an outbound holding one real file and one whose
    //  file is gone. |outbound| is the base; the default network's directory
    //  is the "outbound" beneath it.
    //
    async function makeFixture(name, { extra = '' } = {}) {
        const root = path.join(tmpDir, name);
        const flowDir = path.join(root, 'ob', 'outbound');
        for (const d of [path.join(root, 'db'), path.join(root, 'logs'), flowDir]) {
            await fsp.mkdir(d, { recursive: true });
        }

        const realFile = path.join(root, 'real.pkt');
        const goneFile = path.join(root, 'vanished.zip');
        await fsp.writeFile(realFile, 'PKTDATA');

        const flowPath = path.join(flowDir, FLOW_NAME);
        await fsp.writeFile(flowPath, `^${realFile}\n^${goneFile}\n`);

        await fsp.writeFile(
            path.join(root, 'config.hjson'),
            `{
                general: { boardName: "Test BBS" }
                paths: { db: "${path.join(root, 'db')}", logs: "${path.join(
                    root,
                    'logs'
                )}" }
                loginServers: { telnet: { enabled: false }, ssh: { enabled: false } }
                messageNetworks: {
                    ftn: { networks: { testnet: { localAddress: "1:218/700", defaultZone: 1 } } }
                }
                scannerTossers: {
                    ftn_bso: {
                        defaultNetwork: "testnet"
                        paths: { outbound: "${path.join(root, 'ob')}" }
                        ${extra}
                    }
                }
            }`
        );

        return { root, flowPath, realFile, goneFile };
    }

    //  oputil's getConfigPath() concatenates rather than joins, so the config
    //  path has to carry its own trailing separator.
    function runOputil(root, args) {
        try {
            const out = execFileSync(
                process.execPath,
                ['./oputil.js', '-c', `${root}${path.sep}`, 'bso', ...args],
                { cwd: REPO_ROOT, encoding: 'utf8', stdio: 'pipe' }
            );
            return { code: 0, out };
        } catch (err) {
            return {
                code: err.status,
                out: `${err.stdout || ''}${err.stderr || ''}`,
            };
        }
    }

    // ── 1. the --yes gate ─────────────────────────────────────────────────────

    it('prune without --yes leaves the flow file byte for byte as it was', async () => {
        //  The one case worth having even if there were no others: a
        //  regression here makes a destructive command destructive by default.
        const { root, flowPath, goneFile } = await makeFixture('gate');
        const before = await fsp.readFile(flowPath, 'utf8');

        const { code, out } = runOputil(root, ['prune', NODE]);

        assert.equal(code, 0);
        assert.ok(out.includes(goneFile), 'it should still say what it would remove');
        assert.match(out, /--yes/, 'and how to actually do it');
        assert.equal(
            await fsp.readFile(flowPath, 'utf8'),
            before,
            'nothing may have been written'
        );
    });

    // ── 2. the write path ─────────────────────────────────────────────────────

    it('prune --yes removes the missing entry and keeps the rest', async () => {
        const { root, flowPath, realFile, goneFile } = await makeFixture('write');

        const { code, out } = runOputil(root, ['prune', NODE, '--yes']);

        assert.equal(code, 0);
        assert.match(out, /Removed/);

        const content = await fsp.readFile(flowPath, 'utf8');
        assert.ok(content.includes(realFile), 'the sendable entry must survive');
        assert.ok(!content.includes(goneFile), 'the missing one must be gone');
    });

    // ── 3. the node the poller hides ──────────────────────────────────────────

    it('status shows a node whose every entry has gone missing', async () => {
        //  getNodesWithPendingMail deliberately skips it, so it appears
        //  nowhere else. That is the whole reason this command exists.
        const { root } = await makeFixture('hidden');
        const otherFlow = path.join(root, 'ob', 'outbound', '00da02be.clo'); // 1:218/702
        await fsp.writeFile(otherFlow, `^${path.join(root, 'never_existed.zip')}\n`);

        const { code, out } = runOputil(root, ['status']);

        assert.equal(code, 0);
        assert.match(out, /1:218\/702/, 'the hidden node must be listed');
        assert.match(out, /never be sent/, 'and be called out as undeliverable');
    });

    // ── 4. the scripting contract ─────────────────────────────────────────────

    it('exits non-zero and prints usage for an address it cannot parse', async () => {
        const { root } = await makeFixture('badaddr');

        const { code, out } = runOputil(root, ['list', 'not-an-address']);

        assert.notEqual(code, 0, 'a bad argument must not look like success');
        assert.match(out, /usage: oputil\.js bso/);
    });

    // ── 5. the config guard ───────────────────────────────────────────────────

    it('explains an unconfigured outbound instead of dumping a stack trace', async () => {
        const { root } = await makeFixture('noconfig');
        const cfgPath = path.join(root, 'config.hjson');
        const cfg = await fsp.readFile(cfgPath, 'utf8');
        await fsp.writeFile(cfgPath, cfg.replace(/outbound: "[^"]*"/, 'outbound: null'));

        const { code, out } = runOputil(root, ['status']);

        assert.notEqual(code, 0);
        assert.match(out, /paths\.outbound/, 'it should name what is missing');
        assert.ok(!/at .*\.js:\d+/.test(out), `expected no stack trace, got:\n${out}`);
    });

    // ── 6. a live system holding the lock ─────────────────────────────────────

    it('changes nothing while another process holds the node .bsy lock', async () => {
        //  This is the one the review caught: oputil is its own process, so
        //  the in-process write chain says nothing about what the running BBS
        //  is doing. Only the FTS-5005 lock does.
        const bsoLock = require('../core/bso_lock');

        //  A short wait so the case does not sit out the 5s default.
        const { root, flowPath, goneFile } = await makeFixture('busy', {
            extra: 'flowLockTimeoutMs: 250',
        });
        const before = await fsp.readFile(flowPath, 'utf8');

        const bsyPath = bsoLock.bsyPathForFlowFile(flowPath);
        assert.equal(
            await bsoLock.acquire(bsyPath, { staleMaxAgeMs: 600000 }),
            true,
            'the test could not take the lock it means to hold'
        );

        let result;
        try {
            result = runOputil(root, ['prune', NODE, '--yes']);
        } finally {
            await bsoLock.release(bsyPath);
        }

        assert.equal(result.code, 0, 'a busy node is a deferral, not a failure');
        assert.match(result.out, /busy/i, 'it must say why nothing happened');
        assert.ok(
            !/Removed/.test(result.out),
            `nothing may be claimed as removed, got:\n${result.out}`
        );
        assert.equal(
            await fsp.readFile(flowPath, 'utf8'),
            before,
            'the flow file must be untouched'
        );

        //  ...and with the lock released it goes through.
        const after = runOputil(root, ['prune', NODE, '--yes']);
        assert.match(after.out, /Removed/);
        assert.ok(!(await fsp.readFile(flowPath, 'utf8')).includes(goneFile));
    });
});
