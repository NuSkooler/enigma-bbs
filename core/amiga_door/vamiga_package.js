'use strict';

//
//  Which enigma-vamiga this process has, and whether Amiga doors can run on it.
//
//  The door module keeps a door's disk in its image file (the package's
//  file-backed hard disk, enigma-vamiga 0.2.0 and later): the guest's writes
//  reach the image as the door makes them, and a snapshot holds the image's
//  path instead of the disk. 0.1.x has no file-backed disk, and its snapshots
//  would carry a whole disk, so there is no fallback to it.
//
//  Plain module, Node built-ins only; enigma-vamiga is required lazily so that
//  a missing package is a message, not a crash at startup.
//
const RequiredVersion = '0.2.0';

//  "0.2.0-dev" -> [0, 2, 0]: a prerelease of the required version counts as
//  that version (the package is developed as 0.2.0-dev before 0.2.0 ships)
function versionParts(version) {
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version || ''));
    return m ? m.slice(1, 4).map(n => parseInt(n, 10)) : null;
}

function versionAtLeast(version, required) {
    const have = versionParts(version);
    const want = versionParts(required);
    if (!have || !want) {
        return false;
    }
    for (let i = 0; i < 3; i++) {
        if (have[i] !== want[i]) {
            return have[i] > want[i];
        }
    }
    return true;
}

//
//  { version, problem }: |problem| is null when doors can run, otherwise one
//  line saying what is installed and what is needed. |load| returns
//  { pkg: the package's exports, version: its package.json version }, and is
//  a parameter for tests only.
//
function checkPackage(load = loadInstalled) {
    let pkg;
    let version;
    try {
        ({ pkg, version } = load());
    } catch (e) {
        return {
            version: null,
            problem: `enigma-vamiga ${RequiredVersion} or later is required and cannot be loaded: ${e.message}`,
        };
    }
    const VAmiga = pkg && pkg.VAmiga;
    const fileBacked =
        VAmiga &&
        VAmiga.prototype &&
        'function' === typeof VAmiga.prototype.hdfSync &&
        'function' === typeof VAmiga.prototype.setWriteThrough;
    if (versionAtLeast(version, RequiredVersion) && !fileBacked) {
        return {
            version: version || null,
            problem:
                `enigma-vamiga ${version} is installed but has no file-backed disk support ` +
                `(hdfSync, setWriteThrough); Amiga doors need the ${RequiredVersion} build. ` +
                "Run npm install in ENiGMA's directory",
        };
    }
    if (!versionAtLeast(version, RequiredVersion)) {
        return {
            version: version || null,
            problem:
                `enigma-vamiga ${version || '(unknown version)'} is installed; Amiga doors need ` +
                `${RequiredVersion} or later (its file-backed hard disk). Run npm install in ` +
                "ENiGMA's directory",
        };
    }
    return { version, problem: null };
}

function loadInstalled() {
    return {
        pkg: require('enigma-vamiga'),
        version: require('enigma-vamiga/package.json').version,
    };
}

module.exports = {
    RequiredVersion,
    versionAtLeast,
    checkPackage,
};
