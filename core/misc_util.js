/* jslint node: true */
'use strict';

//  deps
const paths = require('path');
const os = require('os');

const packageJson = require('../package.json');

exports.isProduction = isProduction;
exports.isDevelopment = isDevelopment;
exports.valueWithDefault = valueWithDefault;
exports.resolvePath = resolvePath;
exports.getCleanEnigmaVersion = getCleanEnigmaVersion;
exports.getEnigmaUserAgent = getEnigmaUserAgent;
exports.valueAsArray = valueAsArray;

function isProduction() {
    var env = process.env.NODE_ENV || 'dev';
    return 'production' === env;
}

function isDevelopment() {
    return !isProduction();
}

function valueWithDefault(val, defVal) {
    return typeof val !== 'undefined' ? val : defVal;
}

function resolvePath(path) {
    if (path.substr(0, 2) === '~/') {
        var mswCombined = process.env.HOMEDRIVE + process.env.HOMEPATH;
        path =
            (process.env.HOME ||
                mswCombined ||
                process.env.HOMEPATH ||
                process.env.HOMEDIR ||
                process.cwd()) + path.substr(1);
    }
    return paths.resolve(path);
}

function getCleanEnigmaVersion() {
    return packageJson.version
        .replace(/-/g, '.')
        .replace(/alpha/, 'a')
        .replace(/beta/, 'b');
}

//  See also ftn_util.js getTearLine() & getProductIdentifier()
function getEnigmaUserAgent() {
    //  can't have 1/2 or ½ in User-Agent according to RFC 1945  :(
    const version = getCleanEnigmaVersion();
    const nodeVer = process.version.substr(1); //  remove 'v' prefix

    return `ENiGMA-BBS/${version} (${os.platform()}; ${os.arch()}; ${nodeVer})`;
}

function valueAsArray(value) {
    if (!value) {
        return [];
    }
    return Array.isArray(value) ? value : [value];
}
