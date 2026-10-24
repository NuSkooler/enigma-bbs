'use strict';

//
//  Structural checks on docker/Dockerfile and the workflow that builds it.
//
//  #814: the image installed a compiler toolchain, ran npm ci, and then
//  apt-get removed the toolchain in a later RUN. That removal reclaims
//  nothing -- a layer can only add to an image, and a later delete is a
//  whiteout over bytes that are still pulled -- so four fifths of the
//  published image was the layer that installed the toolchain. The fix is a
//  builder stage that keeps the toolchain and a runtime stage that copies
//  node_modules out of it. These tests pin the shape of that fix without
//  needing Docker: they parse the Dockerfile into stages and check what each
//  one installs, copies and removes.
//
//  test/live/docker_image.live.js builds the image for real, when asked to.
//

const { strict: assert } = require('assert');
const fs = require('fs');
const paths = require('path');

const REPO_ROOT = paths.join(__dirname, '..');
const DOCKERFILE = paths.join(REPO_ROOT, 'docker', 'Dockerfile');
const DOCKERIGNORE = paths.join(REPO_ROOT, '.dockerignore');
const WORKFLOW = paths.join(REPO_ROOT, '.github', 'workflows', 'docker.yml');

const BUILD_ONLY_PACKAGES = ['build-essential', 'python3', 'libssl-dev', 'git', 'curl'];
//  #905: zip/unzip, exiftool, poppler-utils and xdms are what the default
//  archivers and info-extract utilities call; unrar is RARLAB's, from non-free.
const RUNTIME_PACKAGES = [
    'lrzsz',
    'arj',
    'lhasa',
    'unrar',
    'p7zip-full',
    'zip',
    'unzip',
    'libimage-exiftool-perl',
    'poppler-utils',
    'xdms',
];

//  Reduce a Dockerfile to its instructions: comments dropped, backslash
//  continuations joined, each instruction as { name, args } with |args| being
//  the whole remainder of the line, whitespace collapsed.
function parseInstructions(text) {
    const instructions = [];
    let pending = '';
    for (const rawLine of text.split('\n')) {
        const line = rawLine.replace(/\r$/, '');
        if (!pending && /^\s*(#|$)/.test(line)) {
            continue;
        }
        if (pending && /^\s*#/.test(line)) {
            //  A comment inside a continued RUN is allowed and ignored.
            continue;
        }
        if (/\\\s*$/.test(line)) {
            pending += line.replace(/\\\s*$/, '') + ' ';
            continue;
        }
        const whole = (pending + line).replace(/\s+/g, ' ').trim();
        pending = '';
        if (!whole) {
            continue;
        }
        const m = whole.match(/^(\S+)\s*(.*)$/);
        instructions.push({ name: m[1].toUpperCase(), args: m[2] });
    }
    assert.equal(pending, '', 'Dockerfile ends inside a line continuation');
    return instructions;
}

//  Group instructions by stage. Each stage records the image it starts FROM,
//  the --platform it pins, if any, and the name given with AS, if any. ARGs
//  before the first FROM are global and land in |globals|.
function parseStages(text, globals = []) {
    const stages = [];
    for (const inst of parseInstructions(text)) {
        if (inst.name === 'FROM') {
            const m = inst.args.match(
                /^(?:--platform=(\S+)\s+)?(\S+)(?:\s+AS\s+(\S+))?$/i
            );
            assert(m, `unparseable FROM: ${inst.args}`);
            stages.push({
                image: m[2],
                platform: m[1] || null,
                name: m[3] || null,
                instructions: [],
            });
            continue;
        }
        if (!stages.length && inst.name === 'ARG') {
            globals.push(inst);
            continue;
        }
        assert(stages.length, `instruction before first FROM: ${inst.name}`);
        stages[stages.length - 1].instructions.push(inst);
    }
    return stages;
}

const aptInstalls = stage =>
    stage.instructions
        .filter(i => i.name === 'RUN')
        .flatMap(i => i.args.split('&&'))
        .filter(cmd => /apt-get\s+install\b/.test(cmd))
        .flatMap(cmd => cmd.replace(/.*apt-get\s+install\b/, '').split(' '))
        .filter(tok => tok && !tok.startsWith('-'));

const aptRemoves = stage =>
    stage.instructions
        .filter(i => i.name === 'RUN')
        .flatMap(i => i.args.split('&&'))
        .filter(cmd => /apt-get\s+(remove|purge)\b/.test(cmd))
        .flatMap(cmd => cmd.replace(/.*apt-get\s+(remove|purge)\b/, '').split(' '))
        .filter(tok => tok && !tok.startsWith('-'));

describe('docker/Dockerfile (#814)', () => {
    let stages;
    let build;
    let runtime;

    before(() => {
        stages = parseStages(fs.readFileSync(DOCKERFILE, 'utf8'));
        runtime = stages[stages.length - 1];
        build = stages.find(s => s.name === 'build');
    });

    it('is a multi-stage build with a stage named "build" and a final runtime stage', () => {
        assert(
            stages.length >= 2,
            `expected at least two stages, found ${stages.length}`
        );
        assert(build, 'no stage named "build"');
        assert.notEqual(build, runtime, 'the build stage must not be the final stage');
    });

    it('runs both stages on the same base image, so compiled native modules can be copied across', () => {
        assert(build, 'no stage named "build"');
        //  node-pty, better-sqlite3, cpu-features and ssh2's crypto binding
        //  are compiled in the build stage against its libc and node ABI.
        //  Copying them is only sound when the runtime stage is the same
        //  image, and neither stage pins --platform (#794).
        assert.equal(runtime.image, build.image);
        assert.doesNotMatch(build.image, /\$\{?BUILDPLATFORM/);
    });

    it('does not pin --platform on the build or runtime stage (#794)', () => {
        //  Only a stage that cross compiles may run on BUILDPLATFORM; these
        //  two run npm ci and copy the tree, so they must run on the target.
        assert.equal(build.platform, null, `build stage pins ${build.platform}`);
        assert.equal(runtime.platform, null, `runtime stage pins ${runtime.platform}`);
    });

    it('installs the toolchain and runs npm ci in the build stage', () => {
        assert(build, 'no stage named "build"');
        const installed = aptInstalls(build);
        for (const pkg of ['build-essential', 'python3', 'git']) {
            assert(installed.includes(pkg), `build stage does not install ${pkg}`);
        }
        const runs = build.instructions.filter(i => i.name === 'RUN').map(i => i.args);
        assert(
            runs.some(r => /\bnpm ci\b/.test(r)),
            'build stage does not run npm ci'
        );
    });

    it('copies only the lockfile inputs before npm ci, so a source change does not rebuild native modules', () => {
        assert(build, 'no stage named "build"');
        const copies = build.instructions.filter(
            i => i.name === 'COPY' || i.name === 'ADD'
        );
        assert.equal(
            copies.length,
            1,
            `expected exactly one COPY in the build stage, got ${copies.length}`
        );
        const files = copies[0].args.split(' ').slice(0, -1);
        assert.deepEqual(files.sort(), ['package-lock.json', 'package.json']);
    });

    it('never installs the toolchain in the runtime stage', () => {
        const installed = aptInstalls(runtime);
        for (const pkg of BUILD_ONLY_PACKAGES) {
            assert(!installed.includes(pkg), `runtime stage installs ${pkg}`);
        }
    });

    it('never apt-get removes anything in the runtime stage (a remove reclaims nothing)', () => {
        //  This is the exact anti-pattern the issue is about. If something has
        //  to go, it has to not be installed in this stage in the first place.
        assert.deepEqual(aptRemoves(runtime), []);
    });

    it('installs the runtime archivers and lrzsz in the runtime stage', () => {
        const installed = aptInstalls(runtime);
        for (const pkg of RUNTIME_PACKAGES) {
            assert(installed.includes(pkg), `runtime stage does not install ${pkg}`);
        }
    });

    it('installs RARLAB unrar from non-free, not unrar-free (#905)', () => {
        //  unrar-free prints each entry over two lines, so the Rar archiver's
        //  list pattern matches nothing and every RAR looks empty.
        assert(
            !aptInstalls(runtime).includes('unrar-free'),
            'runtime installs unrar-free'
        );
        const runs = runtime.instructions.filter(i => i.name === 'RUN').map(i => i.args);
        const install = runs.find(r => /apt-get\s+install\b[^&]*\bunrar\b/.test(r));
        assert(install, 'no RUN installs unrar');
        const enable = install.indexOf('non-free');
        assert(enable >= 0, 'the RUN that installs unrar does not enable non-free');
        assert(
            enable < install.indexOf('apt-get update'),
            'non-free enabled after apt-get update'
        );
    });

    it('copies node_modules out of the build stage, before the source tree', () => {
        const copies = runtime.instructions.filter(i => i.name === 'COPY');
        const fromBuild = copies.findIndex(c => /^--from=build\b/.test(c.args));
        assert(fromBuild >= 0, 'runtime stage has no COPY --from=build');
        assert.match(
            copies[fromBuild].args,
            /\/enigma-bbs\/node_modules \/enigma-bbs\/node_modules$/
        );

        const source = copies.findIndex(c => /^\. \/enigma-bbs$/.test(c.args));
        assert(source >= 0, 'runtime stage does not COPY . /enigma-bbs');
        assert(fromBuild < source, 'node_modules must be copied before the source tree');
    });

    it('excludes node_modules from the build context, so COPY . cannot overwrite the compiled tree', () => {
        const patterns = fs
            .readFileSync(DOCKERIGNORE, 'utf8')
            .split('\n')
            .map(l => l.trim())
            .filter(l => l && !l.startsWith('#'));
        assert(
            patterns.includes('node_modules') || patterns.includes('**/node_modules'),
            '.dockerignore does not exclude node_modules'
        );
    });

    it('selects the per-platform sexyz and verifies it in the runtime stage (#797)', () => {
        const runs = runtime.instructions.filter(i => i.name === 'RUN').map(i => i.args);
        assert(runs.some(r => /TARGETARCH/.test(r) && /sexyz v\b/.test(r)));
        assert(
            runtime.instructions.some(i => i.name === 'ARG' && i.args === 'TARGETARCH')
        );
    });

    it('builds a pinned unarc for the target in a stage of its own (#906)', () => {
        const unarc = stages.find(s => s.name === 'unarc');
        assert(unarc, 'no stage named "unarc"');
        assert.notEqual(unarc, runtime);

        //  Cross compiled on the builder rather than built under QEMU, so it
        //  must run on BUILDPLATFORM and pick its target from TARGETARCH.
        assert.equal(unarc.platform, '$BUILDPLATFORM');
        assert(unarc.instructions.some(i => i.name === 'ARG' && i.args === 'TARGETARCH'));
        const install = unarc.instructions
            .filter(i => i.name === 'RUN')
            .map(i => i.args)
            .find(r => /cargo install\b/.test(r));
        assert(install, 'unarc stage does not cargo install');
        assert.match(install, /--locked\b/);
        assert.match(install, /\bunarc-cli\b/);
        assert.match(install, /--version "\$UNARC_VERSION"/);
        for (const arch of ['amd64', 'arm64', 'arm']) {
            assert.match(install, new RegExp(`\\b${arch}\\)`), `no case for ${arch}`);
        }
    });

    it('pins one unarc version, shared by the build and the check (#801)', () => {
        const globals = [];
        parseStages(fs.readFileSync(DOCKERFILE, 'utf8'), globals);
        const pin = globals.find(g => /^UNARC_VERSION=/.test(g.args));
        assert(pin, 'no global ARG UNARC_VERSION');
        assert.match(pin.args, /^UNARC_VERSION=\d+\.\d+\.\d+$/);

        //  Stages redeclare it without a default, so there is one place to bump.
        for (const stage of stages) {
            for (const arg of stage.instructions.filter(i => i.name === 'ARG')) {
                assert.doesNotMatch(
                    arg.args,
                    /^UNARC_VERSION=/,
                    `${stage.name}: ${arg.args}`
                );
            }
        }
    });

    it('copies only the unarc binary and its licence into the runtime stage', () => {
        const copies = runtime.instructions
            .filter(i => i.name === 'COPY' && /^--from=unarc\b/.test(i.args))
            .map(i => i.args.replace(/^--from=unarc\s+/, ''));
        assert.deepEqual(copies.sort(), [
            '/opt/unarc/bin/unarc /usr/local/bin/unarc',
            '/opt/unarc/share/doc/unarc/ /usr/share/doc/unarc/',
        ]);
    });

    it('reads LZX and ATR with unarc, and keeps RAR on unrar (#906)', () => {
        const env = runtime.instructions.find(
            i => i.name === 'ENV' && /^ENIGMA_UNARC_ARCHIVERS=/.test(i.args)
        );
        assert(env, 'runtime stage does not set ENIGMA_UNARC_ARCHIVERS');
        const names = env.args.replace(/^ENIGMA_UNARC_ARCHIVERS=/, '').split(',');
        assert.deepEqual(names.sort(), ['Atr', 'Lzx']);
    });

    it('checks every default archiver and info-extract tool while building (#905)', () => {
        const runs = runtime.instructions.filter(i => i.name === 'RUN').map(i => i.args);
        const check = runs.find(r => /docker\/check_tools\.js\b/.test(r));
        assert(check, 'runtime stage does not run docker/check_tools.js');
        assert.match(check, /--unarc-version "\$UNARC_VERSION"/);
        //  as a step of the chain, so a failure fails the build
        assert.match(check, /&& node \/enigma-bbs\/docker\/check_tools\.js/);

        const envAt = runtime.instructions.findIndex(
            i => i.name === 'ENV' && /^ENIGMA_UNARC_ARCHIVERS=/.test(i.args)
        );
        const checkAt = runtime.instructions.findIndex(i => i.args === check);
        assert(envAt >= 0 && envAt < checkAt, 'the check runs before the routing is set');
    });

    it('never starts the BBS while building the image', () => {
        //  The old file ran `pm2 start main.js` in the post-copy RUN. That
        //  actually launched main.js at build time and shipped whatever it
        //  wrote -- pm2 daemon state, and sqlite databases if the checkout
        //  had a config -- inside the image.
        for (const stage of stages) {
            for (const inst of stage.instructions.filter(i => i.name === 'RUN')) {
                assert.doesNotMatch(
                    inst.args,
                    /\bpm2 start\b/,
                    `${stage.name || 'runtime'}: ${inst.args}`
                );
                assert.doesNotMatch(
                    inst.args,
                    /\bnode main\.js\b/,
                    `${stage.name || 'runtime'}: ${inst.args}`
                );
            }
        }
    });

    it('keeps the staging copy of art, mods and config that the entrypoint seeds volumes from', () => {
        const runs = runtime.instructions
            .filter(i => i.name === 'RUN')
            .map(i => i.args)
            .join(' && ');
        for (const dir of ['art', 'mods', 'config']) {
            assert(
                new RegExp(`cp -rp ${dir}/\\* \\.\\./enigma-bbs-pre/${dir}/`).test(runs),
                `runtime stage does not stage ${dir}`
            );
        }
    });
});

describe('.github/workflows/docker.yml cache (#814)', () => {
    let text;

    before(() => {
        text = fs.readFileSync(WORKFLOW, 'utf8');
    });

    it('exports the build stage layers with mode=max, since mode=min drops discarded stages', () => {
        //  mode=min exports only the layers of the final image. With a
        //  builder stage that is exactly the wrong half: the npm ci layer
        //  that holds the QEMU native rebuilds lives in the discarded stage.
        const m = text.match(/cache-to:\s*(.*)/);
        assert(m, 'no cache-to in docker.yml');
        assert.match(m[1], /type=gha,mode=max/);
    });

    it('still writes no cache from a pull request', () => {
        const m = text.match(/cache-to:\s*(.*)/);
        assert.match(m[1], /github\.event_name != 'pull_request'/);
    });

    it('builds a pull request that changes what check_tools reads (#905)', () => {
        //  docker/check_tools.js reads the defaults through core/config.js,
        //  and checks util/exiftool2desc.js, so a change to any of them can
        //  fail the build.
        for (const path of [
            'core/config_default.js',
            'core/config.js',
            'core/config/unarc_archivers.js',
            'util/exiftool2desc.js',
        ]) {
            const re = new RegExp(`^\\s*- '${path.replace(/[./]/g, '\\$&')}'$`, 'm');
            assert.match(text, re, `docker.yml does not build on ${path}`);
        }
    });
});

describe('docker/bin/docker-entrypoint.sh', () => {
    const ENTRYPOINT = paths.join(REPO_ROOT, 'docker', 'bin', 'docker-entrypoint.sh');
    let lines;

    before(() => {
        lines = fs
            .readFileSync(ENTRYPOINT, 'utf8')
            .split('\n')
            .filter(l => !/^\s*(#|$)/.test(l));
    });

    it('gives pm2-runtime a kill timeout that outlasts the shutdown, unless one is set', () => {
        //  PM2's default of 1600 ms SIGKILLs ENiGMA½ in the middle of its
        //  shutdown. pm2-runtime has no --kill-timeout option and ignores
        //  the flag; PM2_KILL_TIMEOUT is read by the PM2 it runs.
        const exp = lines.find(l => /PM2_KILL_TIMEOUT=/.test(l));
        assert(exp, 'PM2_KILL_TIMEOUT is not set');
        const m = exp.match(/export PM2_KILL_TIMEOUT="\$\{PM2_KILL_TIMEOUT:-(\d+)\}"/);
        assert(m, `not overridable: ${exp.trim()}`);
        const { ShutdownTimeoutMs } = require('../core/bbs.js');
        assert(
            Number(m[1]) > ShutdownTimeoutMs,
            `${m[1]} ms does not outlast the ${ShutdownTimeoutMs} ms shutdown timer`
        );

        const execAt = lines.findIndex(l => /exec pm2-runtime/.test(l));
        assert(lines.indexOf(exp) < execAt, 'set after pm2-runtime starts');
        assert.doesNotMatch(lines[execAt], /--kill-timeout/);
    });
});
