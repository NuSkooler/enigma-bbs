/* jslint node: true */
/* eslint-disable no-console */
'use strict';

const { printUsageAndSetExitCode, ExitCodes, argv, initConfigAndDatabases } =
    require('./oputil_common.js');
const getHelpFor = require('./oputil_help.js').getHelpFor;

const async = require('async');

exports.handleRestCommand = handleRestCommand;

function handleRestCommand() {
    if (true === argv.help) {
        return printUsageAndSetExitCode(getHelpFor('Rest'), ExitCodes.SUCCESS);
    }

    const action = argv._[1];
    const sub = argv._[2];

    if (action === 'api-key') {
        switch (sub) {
            case 'generate':
                return _apiKeyGenerate();
            case 'list':
                return _apiKeyList();
            case 'revoke':
                return _apiKeyRevoke();
            default:
                return printUsageAndSetExitCode(getHelpFor('Rest'), ExitCodes.BAD_COMMAND);
        }
    }

    return printUsageAndSetExitCode(getHelpFor('Rest'), ExitCodes.BAD_COMMAND);
}

function _apiKeyGenerate() {
    const username = argv._[3] || argv.user;
    const label = argv.label || '';
    const scope = argv.scope || 'read';

    if (!username) {
        return printUsageAndSetExitCode(
            'Username is required (--user USERNAME or positional argument)',
            ExitCodes.BAD_ARGS
        );
    }

    const validScopes = ['read', 'write', 'read,write'];
    if (!validScopes.includes(scope)) {
        return printUsageAndSetExitCode(
            `Invalid scope "${scope}". Valid values: read, write, read,write`,
            ExitCodes.BAD_ARGS
        );
    }

    async.waterfall(
        [
            callback => initConfigAndDatabases(callback),
            (config, callback) => {
                const User = require('../user');
                User.getUserByUsername(username, (err, user) => {
                    if (err || !user) {
                        return callback(new Error(`User not found: ${username}`));
                    }
                    return callback(null, user);
                });
            },
            (user, callback) => {
                const { storeApiKey } = require('../rest/auth');
                storeApiKey(user.userId, label, scope, (err, rawKey) => {
                    if (err) {
                        return callback(err);
                    }
                    return callback(null, rawKey);
                });
            },
        ],
        (err, rawKey) => {
            if (err) {
                console.error(`Error: ${err.message}`);
                process.exitCode = ExitCodes.ERROR;
                return;
            }
            console.info('API key generated (shown once — store it securely):');
            console.info('');
            console.info(rawKey);
            console.info('');
            console.info(`User:  ${username}`);
            console.info(`Label: ${label || '(none)'}`);
            console.info(`Scope: ${scope}`);
        }
    );
}

function _apiKeyList() {
    const username = argv._[3] || argv.user;

    async.waterfall(
        [
            callback => initConfigAndDatabases(callback),
            (config, callback) => {
                if (!username) {
                    return callback(null, null);
                }
                const User = require('../user');
                User.getUserByUsername(username, (err, user) => {
                    if (err || !user) {
                        return callback(new Error(`User not found: ${username}`));
                    }
                    return callback(null, user);
                });
            },
            (user, callback) => {
                const { dbs } = require('../database');
                let rows;
                if (user) {
                    rows = dbs.user
                        .prepare(
                            `SELECT k.id, u.user_name, k.label, k.scope, k.created_at,
                                    k.last_used_at, k.revoked
                             FROM api_keys k
                             JOIN user u ON u.id = k.user_id
                             WHERE k.user_id = ?
                             ORDER BY k.created_at DESC`
                        )
                        .all(user.userId);
                } else {
                    rows = dbs.user
                        .prepare(
                            `SELECT k.id, u.user_name, k.label, k.scope, k.created_at,
                                    k.last_used_at, k.revoked
                             FROM api_keys k
                             JOIN user u ON u.id = k.user_id
                             ORDER BY k.created_at DESC`
                        )
                        .all();
                }
                return callback(null, rows);
            },
        ],
        (err, rows) => {
            if (err) {
                console.error(`Error: ${err.message}`);
                process.exitCode = ExitCodes.ERROR;
                return;
            }
            if (!rows || rows.length === 0) {
                console.info('No API keys found.');
                return;
            }
            console.info('');
            console.info(
                `${'ID'.padEnd(6)}${'User'.padEnd(20)}${'Label'.padEnd(20)}${'Scope'.padEnd(14)}${'Created'.padEnd(22)}${'Last Used'.padEnd(22)}Status`
            );
            console.info('-'.repeat(110));
            for (const row of rows) {
                const status = row.revoked ? 'revoked' : 'active';
                const lastUsed = row.last_used_at || '(never)';
                console.info(
                    `${String(row.id).padEnd(6)}${row.user_name.padEnd(20)}${(row.label || '').padEnd(20)}${row.scope.padEnd(14)}${row.created_at.padEnd(22)}${lastUsed.padEnd(22)}${status}`
                );
            }
            console.info('');
        }
    );
}

function _apiKeyRevoke() {
    const keyId = parseInt(argv._[3] || argv.id, 10);

    if (!keyId || isNaN(keyId)) {
        return printUsageAndSetExitCode(
            'Key ID is required (positional argument or --id ID)',
            ExitCodes.BAD_ARGS
        );
    }

    async.waterfall(
        [
            callback => initConfigAndDatabases(callback),
            (config, callback) => {
                const { dbs } = require('../database');
                const info = dbs.user
                    .prepare('UPDATE api_keys SET revoked = 1 WHERE id = ?')
                    .run(keyId);
                return callback(null, info.changes > 0);
            },
        ],
        (err, revoked) => {
            if (err) {
                console.error(`Error: ${err.message}`);
                process.exitCode = ExitCodes.ERROR;
                return;
            }
            if (revoked) {
                console.info(`API key ${keyId} revoked.`);
            } else {
                console.info(`No API key found with ID ${keyId}.`);
                process.exitCode = ExitCodes.ERROR;
            }
        }
    );
}
