/* jslint node: true */
'use strict';

//
//  The ENiGMA½ version, for everything that shows or sends one (#1194).
//
//  Two forms:
//
//  getVersion() -- what this install really is. Shown by --version, the WFC
//  and %VN / %VL, logged at startup, and served by NodeInfo and the REST API:
//
//    * Exactly on a release tag (vX.Y.Z or vX.Y.Z-rc.N): X.Y.Z (X.Y.Z-rc.N).
//    * Commits after one:   X.Y.Z-14-gabc1234 -- the nearest v[0-9]* tag,
//      the number of commits since it, and the commit (git describe).
//    * No tag reachable:    <package.json version>-gabc1234.
//    * Any of the above gets -dirty appended when tracked files are modified.
//    * Not a git checkout of this tree, or git missing or failing:
//      ENIGMA_VERSION_STRING if set (a Docker image is built with it, since
//      it carries no .git), else the package.json version.
//
//  getReleaseVersion() -- just the package.json version, which changes only
//  at a release. For places with a length or format limit, or that another
//  system parses: the FTN tearline, PID and Via, QWK, drop files, the SSH
//  identification string, MRC and bbs_link.
//
//  Worked out once, on first call (startup asks for it early), never per
//  call. This module requires nothing of ENiGMA's -- no config, no logger --
//  so it is safe to require from anywhere, however early.
//
const { execFileSync } = require('child_process');
const fs = require('fs');
const paths = require('path');

const InstallRoot = paths.resolve(__dirname, '..');
const EnvVarName = 'ENIGMA_VERSION_STRING';
const GitTimeoutMs = 2000;

//  Variables that point git at some other repository or index. A git hook
//  (lint-staged running the tests, say) sets these, and describe would then
//  report on whatever they name.
const GitLocationEnvVars = [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_COMMON_DIR',
    'GIT_OBJECT_DIRECTORY',
    'GIT_PREFIX',
];

exports.getVersion = getVersion;
exports.getReleaseVersion = getReleaseVersion;

//  for tests
exports.formatDescribe = formatDescribe;
exports.resolveVersion = resolveVersion;
exports.InstallRoot = InstallRoot;
exports.EnvVarName = EnvVarName;

let cachedVersion;

function getReleaseVersion() {
    return require('../package.json').version;
}

function getVersion() {
    if (undefined === cachedVersion) {
        cachedVersion = resolveVersion();
    }
    return cachedVersion;
}

//
//  Turn the output of
//  `git describe --tags --match 'v[0-9]*' --dirty --always` into a version,
//  or return undefined if it is not recognised.
//
function formatDescribe(describe, releaseVersion) {
    if (typeof describe !== 'string') {
        return;
    }
    describe = describe.trim();

    //  v0.7.0-14-gabc1234[-dirty]: after a tag
    let m = /^v(\d.*)-(\d+)-g([0-9a-f]{4,})(-dirty)?$/.exec(describe);
    if (m) {
        return `${m[1]}-${m[2]}-g${m[3]}${m[4] || ''}`;
    }

    //  abc1234[-dirty]: no tag reachable (--always gives the bare commit)
    m = /^([0-9a-f]{4,})(-dirty)?$/.exec(describe);
    if (m) {
        return `${releaseVersion}-g${m[1]}${m[2] || ''}`;
    }

    //  v0.7.0[-dirty]: exactly on a tag
    m = /^v(\d[^\s]*?)(-dirty)?$/.exec(describe);
    if (m) {
        return `${m[1]}${m[2] || ''}`;
    }
}

//
//  Never throws. |deps| replaces the outside world for tests: exec(file,
//  args, opts) -> stdout string, exists(path), realpath(path), env, root and
//  releaseVersion.
//
function resolveVersion(deps = {}) {
    const exec = deps.exec || execGit;
    const exists = deps.exists || fs.existsSync;
    const realpath = deps.realpath || fs.realpathSync;
    const env = deps.env || process.env;
    const root = deps.root || InstallRoot;

    let releaseVersion;
    try {
        releaseVersion = deps.releaseVersion || getReleaseVersion();
    } catch (e) {
        releaseVersion = 'unknown';
    }

    const fallback = () => {
        const fromEnv = env[EnvVarName];
        return typeof fromEnv === 'string' && fromEnv.trim()
            ? fromEnv.trim()
            : releaseVersion;
    };

    try {
        //  No .git (a directory, or a file for a worktree or submodule) in
        //  the install root: not a checkout of ENiGMA, whatever any parent
        //  directory is.
        if (!exists(paths.join(root, '.git'))) {
            return fallback();
        }

        const gitOpts = {
            cwd: root,
            env: gitEnv(env),
            timeout: GitTimeoutMs,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            windowsHide: true,
        };

        //  ...and the repository git finds from there must be rooted at the
        //  install root, not some repository ENiGMA was unpacked into.
        const topLevel = exec('git', ['rev-parse', '--show-toplevel'], gitOpts);
        if (!topLevel || realpath(topLevel.trim()) !== realpath(root)) {
            return fallback();
        }

        const describe = exec(
            'git',
            ['describe', '--tags', '--match', 'v[0-9]*', '--dirty', '--always'],
            gitOpts
        );
        return formatDescribe(describe, releaseVersion) || fallback();
    } catch (e) {
        return fallback();
    }
}

function execGit(file, args, opts) {
    return execFileSync(file, args, opts);
}

function gitEnv(env) {
    const out = Object.assign({}, env);
    GitLocationEnvVars.forEach(name => delete out[name]);
    return out;
}
