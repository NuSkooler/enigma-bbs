/* jslint node: true */
/* eslint-disable no-console */
'use strict';

const config = require('../../core/config.js');
const db = require('../../core/database.js');

const _ = require('lodash');
const async = require('async');
const inq = require('inquirer');
const fs = require('fs');
const hjson = require('hjson');

const packageJson = require('../../package.json');

exports.printUsageAndSetExitCode = printUsageAndSetExitCode;
exports.getDefaultConfigPath = getDefaultConfigPath;
exports.getConfigPath = getConfigPath;
exports.initConfigAndDatabases = initConfigAndDatabases;
exports.getAreaAndStorage = getAreaAndStorage;
exports.looksLikePattern = looksLikePattern;
exports.getAnswers = getAnswers;
exports.writeConfig = writeConfig;

const HJSONStringifyCommonOpts = (exports.HJSONStringifyCommonOpts = {
    emitRootBraces: true,
    bracesSameLine: true,
    space: 4,
    keepWsc: true,
    quotes: 'min',
    eol: '\n',
});

const exitCodes = (exports.ExitCodes = {
    SUCCESS: 0,
    ERROR: -1,
    BAD_COMMAND: -2,
    BAD_ARGS: -3,
});

const argv = (exports.argv = require('minimist')(process.argv.slice(2), {
    alias: {
        h: 'help',
        v: 'version',
        c: 'config',
        n: 'no-prompt',
    },
}));

function printUsageAndSetExitCode(errMsg, exitCode) {
    if (_.isUndefined(exitCode)) {
        exitCode = exitCodes.ERROR;
    }

    process.exitCode = exitCode;

    if (errMsg) {
        console.error(errMsg);
    }
}

function getDefaultConfigPath() {
    return './config/';
}

function getConfigPath() {
    const baseConfigPath = argv.config ? argv.config : config.Config.getDefaultPath();
    return baseConfigPath + 'config.hjson';
}

function initConfig(cb) {
    const configPath = getConfigPath();

    config.Config.create(configPath, { keepWsc: true, hotReload: false }, cb);
}

function initConfigAndDatabases(cb) {
    async.series(
        [
            function init(callback) {
                initConfig(callback);
            },
            function initDb(callback) {
                db.initializeDatabases(callback);
            },
            function initArchiveUtil(callback) {
                //  ensure we init ArchiveUtil without events
                require('../../core/archive_util').getInstance(false); //  false=hotReload
                return callback(null);
            },
        ],
        err => {
            return cb(err);
        }
    );
}

function getAreaAndStorage(tags) {
    return tags.map(tag => {
        const parts = tag.toString().split('@');
        const entry = {
            areaTag: parts[0],
        };
        entry.pattern = entry.areaTag; //	handy
        if (parts[1]) {
            entry.storageTag = parts[1];
        }
        return entry;
    });
}

function looksLikePattern(tag) {
    //	globs can start with @
    if (tag.indexOf('@') > 0) {
        return false;
    }

    return /[*?[\]!()+|^]/.test(tag);
}

function getAnswers(questions, cb) {
    inq.prompt(questions).then(answers => {
        return cb(answers);
    });
}

function writeConfig(config, path) {
    config = hjson
        .stringify(config, HJSONStringifyCommonOpts)
        .replace(/%ENIG_VERSION%/g, packageJson.version)
        .replace(/%HJSON_VERSION%/g, hjson.version);

    try {
        fs.writeFileSync(path, config, 'utf8');
        return true;
    } catch (e) {
        return false;
    }
}
