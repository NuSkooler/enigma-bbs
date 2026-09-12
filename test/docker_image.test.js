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
const RUNTIME_PACKAGES = ['lrzsz', 'arj', 'lhasa', 'unrar-free', 'p7zip-full'];

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

//  Group instructions by stage. Each stage records the image it starts FROM
//  and the name given with AS, if any.
function parseStages(text) {
    const stages = [];
    for (const inst of parseInstructions(text)) {
        if (inst.name === 'FROM') {
            const m = inst.args.match(/^(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?$/i);
            assert(m, `unparseable FROM: ${inst.args}`);
            stages.push({ image: m[1], name: m[2] || null, instructions: [] });
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

    it('does not pin --platform on either FROM (#794)', () => {
        const text = fs.readFileSync(DOCKERFILE, 'utf8');
        for (const inst of parseInstructions(text).filter(i => i.name === 'FROM')) {
            assert.doesNotMatch(inst.args, /--platform/, `FROM ${inst.args}`);
        }
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
});
