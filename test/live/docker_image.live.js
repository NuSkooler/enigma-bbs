'use strict';

//
//  Build the Docker image for real and look inside it.
//
//  test/docker_image.test.js pins the shape of docker/Dockerfile -- a build
//  stage with the toolchain, a runtime stage without it -- but only a built
//  image can show that the copied node_modules actually loads, that sexyz
//  runs, and that gcc is really gone (#814). A build takes minutes and needs
//  a Docker daemon, so this only runs when asked:
//
//      ENIGMA_DOCKER_LIVE=1 npm run test:live
//
//  Set ENIGMA_DOCKER_IMAGE to probe an image that is already built instead of
//  building one -- the published tag, say -- and ENIGMA_DOCKER_KEEP=1 to leave
//  the image behind for a look.
//

const { strict: assert } = require('assert');
const paths = require('path');
const { execFileSync, spawnSync } = require('child_process');

const REPO_ROOT = paths.join(__dirname, '..', '..');
const DOCKERFILE = paths.join(REPO_ROOT, 'docker', 'Dockerfile');

const enabled = process.env.ENIGMA_DOCKER_LIVE === '1';
const prebuilt = process.env.ENIGMA_DOCKER_IMAGE;
const keep = process.env.ENIGMA_DOCKER_KEEP === '1' || !!prebuilt;

const IMAGE = prebuilt || `enigma-bbs-live-test:${process.pid}`;

function haveDocker() {
    const r = spawnSync('docker', ['info'], { stdio: 'ignore' });
    return r.status === 0;
}

//  Run a shell snippet inside the image. --entrypoint is overridden because
//  the real one wants a config volume and then execs pm2-runtime.
function inImage(script) {
    return spawnSync(
        'docker',
        ['run', '--rm', '--entrypoint', '/bin/sh', IMAGE, '-c', script],
        { encoding: 'utf8' }
    );
}

function inImageOk(script) {
    const r = inImage(script);
    assert.equal(r.status, 0, `in image: ${script}\n${r.stdout}${r.stderr}`);
    return r.stdout;
}

(enabled ? describe : describe.skip)('docker image (live, #814)', function () {
    this.timeout(30 * 60 * 1000);

    before(function () {
        if (!haveDocker()) {
            this.skip();
        }
        if (prebuilt) {
            return;
        }
        execFileSync('docker', ['build', '-t', IMAGE, '-f', DOCKERFILE, REPO_ROOT], {
            stdio: 'inherit',
        });
    });

    after(() => {
        if (!keep && haveDocker()) {
            spawnSync('docker', ['rmi', '-f', IMAGE], { stdio: 'ignore' });
        }
    });

    it('was never given a compiler toolchain in any shipped layer', () => {
        //  The filesystem probes below cannot tell the old image from the
        //  new one: apt-get remove hides gcc from a running container just
        //  fine, it only fails to reclaim the bytes. What shows the
        //  difference is the layer history of what ships -- a single-stage
        //  build carries the RUN that installed build-essential, and the
        //  RUN that removed it, as layers of the final image. A builder
        //  stage's layers never appear here.
        //  docker history lists newest first, so the layers this Dockerfile
        //  added are everything above the LABEL that opens the runtime
        //  stage. The node base image's own history has an apt-get purge in
        //  it, which is its business.
        const lines = execFileSync(
            'docker',
            ['history', '--no-trunc', '--format', '{{.CreatedBy}}', IMAGE],
            { encoding: 'utf8' }
        ).split('\n');
        const label = lines.findIndex(l => /LABEL maintainer=/.test(l));
        assert(label > 0, 'no LABEL maintainer layer in the image history');
        const history = lines.slice(0, label).join('\n');
        for (const pkg of ['build-essential', 'libssl-dev', 'python3']) {
            assert.doesNotMatch(
                history,
                new RegExp(`apt-get install[^&]*\\b${pkg}\\b`),
                `a shipped layer installs ${pkg}`
            );
        }
        assert.doesNotMatch(
            history,
            /apt-get (remove|purge)/,
            'a shipped layer removes packages'
        );
        assert.doesNotMatch(history, /\bnpm ci\b/, 'npm ci ran in a shipped layer');
    });

    it('does not ship a compiler toolchain', () => {
        for (const tool of ['gcc', 'g++', 'make', 'python3', 'git', 'curl']) {
            const r = inImage(`command -v ${tool}`);
            assert.notEqual(
                r.status,
                0,
                `${tool} is present in the image: ${r.stdout.trim()}`
            );
        }
        for (const pkg of ['build-essential', 'libssl-dev', 'python3']) {
            const r = inImage(
                `dpkg -s ${pkg} 2>/dev/null | grep -q '^Status: install ok'`
            );
            assert.notEqual(r.status, 0, `${pkg} is installed in the image`);
        }
    });

    it('ships the runtime archivers and lrzsz', () => {
        for (const tool of ['sz', 'rz', 'arj', 'lha', 'unrar-free', '7z']) {
            inImageOk(`command -v ${tool}`);
        }
    });

    it('loads the native modules copied out of the build stage', () => {
        //  This is the claim the multi-stage copy rests on: modules compiled
        //  in the build stage must load in the runtime stage.
        const script = [
            "require('node-pty')",
            "require('better-sqlite3')(':memory:').prepare('select 1 as one').get()",
            "require('cpu-features')()",
            "require('ssh2')",
        ].join('; ');
        inImageOk(`cd /enigma-bbs && node -e "${script}"`);
    });

    it('starts far enough to reach the config check', () => {
        //  No config is mounted, so oputil must run and main.js is never
        //  reached -- but getting here proves the dependency tree resolves.
        const out = inImageOk('cd /enigma-bbs && node oputil.js 2>&1 | head -3');
        assert.match(out, /oputil|usage/i);
    });

    it('runs the sexyz selected for the platform', () => {
        //  A binary for the wrong architecture fails to exec (#797). sexyz
        //  writes its banner to stderr, so fold it in.
        const out = inImageOk('sexyz v 2>&1');
        assert.match(out, /Synchronet External X\/Y\/ZMODEM/);
    });

    it('has pm2-runtime for the entrypoint', () => {
        inImageOk('command -v pm2-runtime');
    });

    it('has an executable entrypoint with LF line endings', () => {
        inImageOk('test -x /enigma-bbs/docker/bin/docker-entrypoint.sh');
        const r = inImage("grep -c $'\\r' /enigma-bbs/docker/bin/docker-entrypoint.sh");
        assert.notEqual(r.status, 0, 'entrypoint still has CR line endings');
    });

    it('stages art, mods and config for the entrypoint to seed empty volumes', () => {
        for (const dir of ['art', 'mods', 'config']) {
            inImageOk(`test -n "$(ls -A /enigma-bbs-pre/${dir})"`);
        }
    });
});
