#!/usr/bin/env node
'use strict';
/* eslint-disable no-console */

//
//  Image build smoke test (#905): every program the default archivers and
//  info-extract utilities run must be in the image.
//
//      node docker/check_tools.js [--unarc-version X.Y.Z]
//
//  A missing archiver does not fail loudly at runtime. An upload it should
//  have listed is filed as a plain file, with no FILE_ID.DIZ and nothing in the
//  log to say why, which is how the image shipped without unzip and with an
//  unrar that made every RAR look empty. So this reads the defaults the way
//  the BBS will -- the config loader's effectiveDefaults(), so this image's
//  ENIGMA_UNARC_ARCHIVERS applies exactly as it does at runtime -- and fails
//  the build on any program it cannot find, or on a name in that variable
//  the loader would ignore. A new default that calls a new program therefore has to bring
//  that program into the image with it, or route through unarc.
//
//  It also checks a few things command -v cannot see: that unrar is RARLAB's
//  and not unrar-free, and that unarc is the version the Dockerfile pinned.
//

const { spawnSync } = require('child_process');
const paths = require('path');

const _ = require('lodash');

const ROOT = paths.join(__dirname, '..');
const { effectiveDefaults } = require(paths.join(ROOT, 'core', 'config.js'));
const DefaultConfig = require(paths.join(ROOT, 'core', 'config_default.js'));
const { EnvVar, parseUnarcArchivers } = require(
    paths.join(ROOT, 'core', 'config', 'unarc_archivers.js')
);

const defaults = effectiveDefaults();

//  Programs the image installs that no default names. Listed so a package
//  that stops providing one fails the build like any other.
const EXTRA = {
    pdftotext: 'docker/Dockerfile (poppler-utils)',
};

const resolve = value =>
    _.isString(value) && value.startsWith('@reference:')
        ? _.get(defaults, value.slice('@reference:'.length))
        : value;

function wantedPrograms() {
    const wanted = new Map(); //  cmd -> [ where it is named ]
    const want = (cmd, where) => {
        if (!wanted.has(cmd)) {
            wanted.set(cmd, []);
        }
        wanted.get(cmd).push(where);
    };

    for (const [name, value] of Object.entries(defaults.archives.archivers)) {
        const archiver = resolve(value);
        if (!_.isObject(archiver)) {
            want(String(value), `archives.archivers.${name} (unresolved)`);
            continue;
        }
        for (const op of ['compress', 'decompress', 'list', 'extract']) {
            const cmd = _.get(archiver, [op, 'cmd']);
            if (cmd) {
                want(cmd, `archives.archivers.${name}.${op}`);
            }
        }
    }

    for (const [name, util] of Object.entries(defaults.infoExtractUtils)) {
        if (util.cmd) {
            want(util.cmd, `infoExtractUtils.${name}`);
        }
    }

    for (const [cmd, where] of Object.entries(EXTRA)) {
        want(cmd, where);
    }

    return wanted;
}

function run(cmd, args) {
    const r = spawnSync(cmd, args, { encoding: 'utf8' });
    return {
        status: r.status,
        out: `${r.stdout || ''}${r.stderr || ''}`,
        error: r.error,
    };
}

function main() {
    const argv = process.argv.slice(2);
    const at = argv.indexOf('--unarc-version');
    const unarcVersion = at >= 0 ? argv[at + 1] : undefined;

    const problems = [];

    //  A misspelt name is ignored at runtime, leaving that archiver on a tool
    //  the image may not have; here it fails the build instead.
    const { ignored } = parseUnarcArchivers(
        DefaultConfig().archives.archivers,
        process.env[EnvVar]
    );
    for (const name of ignored) {
        problems.push(
            `${EnvVar} names "${name}", which is not an archiver unarc can stand in for`
        );
    }

    for (const [cmd, where] of wantedPrograms()) {
        //  command -v also takes an absolute path, as Exiftool2Desc's is
        const found = run('sh', ['-c', 'command -v "$1"', 'sh', cmd]);
        if (0 === found.status) {
            console.info(`ok       ${cmd.padEnd(10)} ${found.out.trim()}`);
        } else {
            problems.push(`${cmd}: not found; needed by ${where.join(', ')}`);
            console.info(`MISSING  ${cmd.padEnd(10)} ${where.join(', ')}`);
        }
    }

    //  unrar-free answers to `unrar` too, but the Rar archiver cannot read its
    //  listing. RARLAB's banner names its author; unrar-free's does not.
    const unrar = run('unrar', []);
    if (!/Alexander Roshal/.test(unrar.out)) {
        problems.push(
            `unrar is not RARLAB's unrar (unrar-free?): ${unrar.out.split('\n')[0] || unrar.error}`
        );
    }

    const unarc = run('unarc', ['--version']);
    if (0 !== unarc.status) {
        problems.push(`unarc --version failed: ${unarc.out.trim() || unarc.error}`);
    } else if (unarcVersion && unarc.out.trim() !== `unarc ${unarcVersion}`) {
        problems.push(`unarc is "${unarc.out.trim()}", expected unarc ${unarcVersion}`);
    } else {
        console.info(`ok       ${unarc.out.trim()}`);
    }

    if (problems.length) {
        console.error(
            '\ncheck_tools: the image is missing what the default archivers or ' +
                'info-extract utilities need:\n' +
                problems.map(p => `  * ${p}`).join('\n') +
                '\nInstall it in docker/Dockerfile, or point the archiver at unarc ' +
                'with ENIGMA_UNARC_ARCHIVERS.'
        );
        process.exit(1);
    }

    console.info('check_tools: every default archiver and info-extract tool is present');
}

main();
