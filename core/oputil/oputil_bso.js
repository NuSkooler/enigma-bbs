/* jslint node: true */
/* eslint-disable no-console */
'use strict';

/**
 * oputil_bso.js — BSO outbound spool inspection
 *
 * Answers the question an operator otherwise has to answer by reading the
 * spool by hand: who is not collecting their mail, how long has it been
 * sitting there, and is any of it queued against a file that no longer
 * exists?
 *
 * A flow file stores an absolute path (FTS-5005.003 §3.1). When the file it
 * names is deleted or moved -- a file base tidied, an area reorganised, a
 * forwarded TIC payload removed -- the entry can never be sent. The spool
 * skips it and says so periodically, but nothing removes it, and nothing but
 * this told the operator which node was affected.
 *
 * Commands:
 *   bso status                 Every node with outbound, and what is wrong
 *   bso list <address>         Every queued entry for one node
 *   bso prune <address>        Drop entries whose file is gone (--yes to write)
 */

const {
    printUsageAndSetExitCode,
    argv,
    ExitCodes,
    initConfigAndDatabases,
} = require('./oputil_common.js');
const { getHelpFor } = require('./oputil_help.js');

exports.handleBsoCommand = handleBsoCommand;

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeSpool() {
    const Config = require('../config.js').get;
    const { BsoSpool } = require('../binkp/bso_spool.js');
    const config = Config();
    const bsoConfig = config.scannerTossers?.ftn_bso || {};

    if (!bsoConfig.paths?.outbound) {
        //  Without this every command dies in the directory walk with a bare
        //  TypeError, which says nothing about what is actually missing.
        throw new Error(
            'scannerTossers.ftn_bso.paths.outbound is not configured; there is no outbound spool to inspect'
        );
    }

    return new BsoSpool({
        paths: bsoConfig.paths || {},
        networks: config.messageNetworks?.ftn?.networks || {},
        defaultNetwork: bsoConfig.defaultNetwork,
    });
}

function parseAddress(s) {
    const Address = require('../ftn_address.js');
    const addr = Address.fromString(s);
    //  fromString hands back an Address either way; a string it could not
    //  parse leaves the required parts undefined.
    if (!addr || undefined === addr.net || undefined === addr.node) {
        return null;
    }
    return addr;
}

function friendlySize(bytes) {
    if (null === bytes || undefined === bytes) {
        return '-';
    }
    const units = ['B', 'KB', 'MB', 'GB'];
    let n = bytes;
    let u = 0;
    while (n >= 1024 && u < units.length - 1) {
        n /= 1024;
        ++u;
    }
    return `${0 === u ? n : n.toFixed(1)} ${units[u]}`;
}

//  Compact enough to keep a column: "3d", "4h", "12m". moment's fromNow()
//  says "a few seconds", which is friendlier prose and useless in a table.
function friendlyAge(timestamp) {
    if (!timestamp) {
        return '-';
    }

    const secs = Math.max(0, Math.floor(Date.now() / 1000) - timestamp);
    if (secs < 60) {
        return `${secs}s`;
    }
    if (secs < 3600) {
        return `${Math.floor(secs / 60)}m`;
    }
    if (secs < 86400) {
        return `${Math.floor(secs / 3600)}h`;
    }
    return `${Math.floor(secs / 86400)}d`;
}

function oldestTimestamp(entries) {
    const stamps = entries.filter(e => e.timestamp).map(e => e.timestamp);
    return stamps.length ? Math.min(...stamps) : null;
}

function pad(s, width) {
    s = String(s);
    return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

function padLeft(s, width) {
    s = String(s);
    return s.length >= width ? s : ' '.repeat(width - s.length) + s;
}

//  Entries an operator is waiting on, i.e. not the ones already sent.
function liveEntries(node) {
    return node.entries.filter(e => 'sent' !== e.status);
}

function withSpool(handler) {
    initConfigAndDatabases(err => {
        if (err) {
            console.error(err.message);
            process.exitCode = ExitCodes.ERROR;
            return;
        }

        let spool;
        try {
            spool = makeSpool();
        } catch (e) {
            console.error(`Could not read the outbound spool: ${e.message}`);
            process.exitCode = ExitCodes.ERROR;
            return;
        }

        handler(spool).catch(e => {
            console.error(e.message);
            process.exitCode = ExitCodes.ERROR;
        });
    });
}

// ─── status ──────────────────────────────────────────────────────────────────

function cmdStatus() {
    withSpool(async spool => {
        const nodes = await spool.inspectOutbound();
        const interesting = nodes.filter(n => liveEntries(n).length > 0);

        if (0 === interesting.length) {
            console.info('Nothing queued in the outbound.');
            return;
        }

        console.info(
            `${pad('Node', 22)}${padLeft('Queued', 8)}${padLeft(
                'Missing',
                9
            )}${padLeft('Oldest', 8)}`
        );
        console.info('-'.repeat(47));

        let missingTotal = 0;
        let unreadableTotal = 0;
        for (const node of interesting) {
            const live = liveEntries(node);
            const missing = live.filter(e => 'missing' === e.status);
            missingTotal += missing.length;
            unreadableTotal += live.filter(e => 'unreadable' === e.status).length;

            console.info(
                `${pad(node.address.toString(), 22)}${padLeft(
                    live.length,
                    8
                )}${padLeft(missing.length || '', 9)}${padLeft(
                    friendlyAge(oldestTimestamp(live)),
                    8
                )}`
            );
        }

        if (missingTotal > 0) {
            console.info('');
            console.info(
                `${missingTotal} queued ${
                    1 === missingTotal ? 'entry names a file' : 'entries name files'
                } that no longer exist. Those will never be sent.`
            );
            console.info(
                'Use "oputil bso list <address>" to see them, and — once you are'
            );
            console.info('satisfied the files are really gone and not merely offline —');
            console.info('"oputil bso prune <address> --yes" to drop them.');
        }

        if (unreadableTotal > 0) {
            console.info('');
            console.info(
                `${unreadableTotal} queued ${
                    1 === unreadableTotal ? 'entry could' : 'entries could'
                } not be read — a permissions problem, or a`
            );
            console.info(
                'volume that is not mounted. Those are never pruned; see "bso list".'
            );
        }
    });
}

// ─── list ────────────────────────────────────────────────────────────────────

function cmdList(addressArg) {
    const addr = parseAddress(addressArg);
    if (!addr) {
        return printUsageAndSetExitCode(getHelpFor('Bso'), ExitCodes.BAD_ARGS);
    }

    withSpool(async spool => {
        const { sameAddress } = require('../binkp/bso_spool.js');
        const node = (await spool.inspectOutbound()).find(n =>
            sameAddress(n.address, addr)
        );
        const live = node ? liveEntries(node) : [];

        if (0 === live.length) {
            console.info(`Nothing queued for ${addr.toString()}.`);
            return;
        }

        console.info(`${addr.toString()}`);
        for (const entry of live) {
            const flag =
                {
                    missing: 'MISSING',
                    unreadable: 'UNREADABLE',
                }[entry.status] || 'ok';
            console.info(
                `  ${pad(flag, 9)}${padLeft(friendlySize(entry.size), 10)}${padLeft(
                    friendlyAge(entry.timestamp),
                    8
                )}  ${entry.path}`
            );
        }

        const unreadable = live.filter(e => 'unreadable' === e.status);
        if (unreadable.length > 0) {
            console.info('');
            console.info(
                `${unreadable.length} could not be read at all — a permissions problem, or`
            );
            console.info(
                'a volume that is not mounted. Those are not pruned: the file may well'
            );
            console.info('still be there. Fix the access and they will send.');
        }

        const missing = live.filter(e => 'missing' === e.status);
        if (missing.length > 0) {
            console.info('');
            console.info(
                `${missing.length} of these ${
                    1 === missing.length ? 'names a file' : 'name files'
                } that is not on disk. ${addr.toString()} will never receive`
            );
            console.info(
                `${1 === missing.length ? 'it' : 'them'} while the reference stands.`
            );
        }
    });
}

// ─── prune ───────────────────────────────────────────────────────────────────

function cmdPrune(addressArg) {
    const addr = parseAddress(addressArg);
    if (!addr) {
        return printUsageAndSetExitCode(getHelpFor('Bso'), ExitCodes.BAD_ARGS);
    }

    //  Default to a dry run. Removing a queue entry is the one thing in here
    //  that discards something, and an unreachable file store looks exactly
    //  like a deleted one from here.
    const write = true === argv.yes;

    withSpool(async spool => {
        const { removed, busy } = await spool.pruneMissingRefs(addr, {
            dryRun: !write,
        });

        if (busy.length > 0) {
            //  Not the same as "nothing to do": the entries are still there,
            //  we simply were not allowed to touch the file.
            console.info(
                `${addr.toString()} is busy — a mail session or the tosser holds its`
            );
            console.info('lock. Nothing was changed; try again in a moment.');
            if (0 === removed.length) {
                return;
            }
        }

        if (0 === removed.length) {
            console.info(`Nothing to prune for ${addr.toString()}.`);
            return;
        }

        console.info(
            `${write ? 'Removed' : 'Would remove'} ${removed.length} ${
                1 === removed.length ? 'entry' : 'entries'
            } for ${addr.toString()}:`
        );
        for (const entry of removed) {
            console.info(`  ${entry.path}`);
        }

        if (!write) {
            console.info('');
            console.info('Nothing has been changed. Re-run with --yes to remove.');
        }
    });
}

// ─── entry point ─────────────────────────────────────────────────────────────

function handleBsoCommand() {
    if (argv.help) {
        return printUsageAndSetExitCode(getHelpFor('Bso'), ExitCodes.SUCCESS);
    }

    const action = argv._[1];

    switch (action) {
        case 'status':
            return cmdStatus();

        case 'list':
            return cmdList(argv._[2]);

        case 'prune':
            return cmdPrune(argv._[2]);

        default:
            return printUsageAndSetExitCode(getHelpFor('Bso'), ExitCodes.BAD_COMMAND);
    }
}
