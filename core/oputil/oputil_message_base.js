/* jslint node: true */
/* eslint-disable no-console */
'use strict';

const {
    printUsageAndSetExitCode,
    getConfigPath,
    ExitCodes,
    argv,
    initConfigAndDatabases,
    getAnswers,
    writeConfig,
} = require('./oputil_common.js');

const getHelpFor = require('./oputil_help.js').getHelpFor;
const Address = require('../ftn_address.js');
const Errors = require('../enig_error.js').Errors;
const {
    AreaListFormat,
    parseAreaList,
    describeFormat,
    validateUplinks,
    localAreaTagFor,
    buildAreaImportRecords,
} = require('../area_import.js');

//	deps
const async = require('async');
const paths = require('path');
const fs = require('fs');
const hjson = require('hjson');
const _ = require('lodash');
const moment = require('moment');

exports.handleMessageBaseCommand = handleMessageBaseCommand;

function areaFix() {
    //
    //	oputil mb areafix CMD1 CMD2 ... ADDR [--password PASS]
    //
    if (argv._.length < 3) {
        return printUsageAndSetExitCode(getHelpFor('MessageBase'), ExitCodes.ERROR);
    }

    async.waterfall(
        [
            function init(callback) {
                return initConfigAndDatabases(callback);
            },
            function validateAddress(callback) {
                const addrArg = argv._.slice(-1)[0];
                const ftnAddr = Address.fromString(addrArg);

                if (!ftnAddr) {
                    return callback(
                        Errors.Invalid(`"${addrArg}" is not a valid FTN address`)
                    );
                }

                //
                //	We need to validate the address targets a system we know unless
                //	the --force option is used
                //
                //	:TODO:
                return callback(null, ftnAddr);
            },
            function fetchFromUser(ftnAddr, callback) {
                //
                //	--from USER || +op from system
                //
                //	If possible, we want the user ID of the supplied user as well
                //
                const User = require('../user.js');

                if (argv.from) {
                    User.getUserIdAndNameByLookup(argv.from, (err, userId, fromName) => {
                        if (err) {
                            return callback(null, ftnAddr, argv.from, 0);
                        }

                        //	fromName is the same as argv.from, but case may be differnet (yet correct)
                        return callback(null, ftnAddr, fromName, userId);
                    });
                } else {
                    User.getUserName(User.RootUserID, (err, fromName) => {
                        return callback(
                            null,
                            ftnAddr,
                            fromName || 'SysOp',
                            err ? 0 : User.RootUserID
                        );
                    });
                }
            },
            function createMessage(ftnAddr, fromName, fromUserId, callback) {
                //
                //	Build message as commands separated by line feed
                //
                //	We need to remove quotes from arguments. These are required
                //	in the case of e.g. removing an area: "-SOME_AREA" would end
                //	up confusing minimist, therefor they must be quoted: "'-SOME_AREA'"
                //
                const messageBody =
                    argv._.slice(2, -1)
                        .map(arg => {
                            return arg.replace(/["']/g, '');
                        })
                        .join('\r\n') + '\n';

                const Message = require('../message.js');

                const message = new Message({
                    toUserName: argv.to || 'AreaFix',
                    fromUserName: fromName,
                    subject: argv.password || '',
                    message: messageBody,
                    areaTag: Message.WellKnownAreaTags.Private, //	mark private
                    meta: {
                        System: {
                            [Message.SystemMetaNames.RemoteToUser]: ftnAddr.toString(), //	where to send it
                            [Message.SystemMetaNames.ExternalFlavor]:
                                Message.AddressFlavor.FTN, //	on FTN-style network
                        },
                    },
                });

                if (0 !== fromUserId) {
                    message.setLocalFromUserId(fromUserId);
                }

                return callback(null, message);
            },
            function persistMessage(message, callback) {
                message.persist(err => {
                    if (!err) {
                        console.log(
                            'AreaFix message persisted and will be exported at next scheduled scan'
                        );
                    }
                    return callback(err);
                });
            },
        ],
        err => {
            if (err) {
                process.exitCode = ExitCodes.ERROR;
                console.error(`${err.message}${err.reason ? ': ' + err.reason : ''}`);
            }
        }
    );
}

function getMsgAreaImportType(path) {
    if (argv.type) {
        return argv.type.toLowerCase();
    }

    return paths.extname(path).substr(1).toLowerCase(); //  bbs|na|...
}

function importAreas() {
    const importPath = argv._[argv._.length - 1];
    if (argv._.length < 3 || !importPath || 0 === importPath.length) {
        return printUsageAndSetExitCode(getHelpFor('Config'), ExitCodes.ERROR);
    }

    const importType = getMsgAreaImportType(importPath);
    if ('na' !== importType && 'bbs' !== importType) {
        return console.error(`"${importType}" is not a recognized import file type`);
    }

    //	optional data - we'll prompt if for anything not found
    let confTag = argv.conf;
    let networkName = argv.network;
    let uplinks = argv.uplinks;
    if (uplinks) {
        uplinks = uplinks.split(/[\s,]+/);
    }

    let importEntries;
    let importSkipped = [];

    async.waterfall(
        [
            function readImportFile(callback) {
                fs.readFile(importPath, 'utf8', (err, importData) => {
                    if (err) {
                        return callback(err);
                    }

                    //
                    //  AREAS.BBS cannot be told apart from a plain area list by
                    //  shape, so it is only ever used when asked for explicitly.
                    //  Everything else is sniffed from content: the extension
                    //  does not indicate the format -- several networks ship a
                    //  FILEBONE file echo list named "*.na".
                    //
                    const parsed = parseAreaList(
                        importData,
                        'bbs' === importType ? { format: AreaListFormat.AreasBbs } : {}
                    );

                    if (AreaListFormat.FileBone === parsed.format) {
                        return callback(
                            Errors.Invalid(
                                `"${paths.basename(importPath)}" is a ${describeFormat(
                                    parsed.format
                                )}, not a message area list.\n` +
                                    'File echo lists are imported with "oputil.js fb import-areas".'
                            )
                        );
                    }

                    if (0 === parsed.entries.length) {
                        return callback(
                            Errors.Invalid(
                                `Nothing to import from "${paths.basename(
                                    importPath
                                )}": ${describeFormat(parsed.format)} ` +
                                    `(${parsed.stats.dataLines} data line(s), ` +
                                    `${parsed.stats.commentLines} comment line(s))`
                            )
                        );
                    }

                    importEntries = parsed.entries;
                    importSkipped = parsed.skipped;

                    //	We should have enough to validate uplinks
                    if ('bbs' === importType) {
                        for (let i = 0; i < importEntries.length; ++i) {
                            if (!validateUplinks(importEntries[i].uplinks)) {
                                return callback(Errors.Invalid('Invalid uplink(s)'));
                            }
                        }
                    } else {
                        if (!validateUplinks(uplinks || [])) {
                            return callback(Errors.Invalid('Invalid uplink(s)'));
                        }
                    }

                    return callback(null);
                });
            },
            function init(callback) {
                return initConfigAndDatabases(callback);
            },
            function validateAndCollectInput(callback) {
                const msgArea = require('../../core/message_area.js');
                const sysConfig = require('../../core/config.js').get();

                let msgConfs = msgArea.getSortedAvailMessageConferences(null, {
                    noClient: true,
                });
                if (!msgConfs) {
                    return callback(
                        Errors.DoesNotExist('No conferences exist in your configuration')
                    );
                }

                msgConfs = msgConfs.map(mc => {
                    return {
                        name: mc.conf.name,
                        value: mc.confTag,
                    };
                });

                if (
                    confTag &&
                    !msgConfs.find(mc => {
                        return confTag === mc.value;
                    })
                ) {
                    return callback(
                        Errors.DoesNotExist(`Conference "${confTag}" does not exist`)
                    );
                }

                const existingNetworkNames = Object.keys(
                    _.get(sysConfig, 'messageNetworks.ftn.networks', {})
                );

                if (
                    networkName &&
                    !existingNetworkNames.find(net => networkName === net)
                ) {
                    return callback(
                        Errors.DoesNotExist(
                            `FTN style Network "${networkName}" does not exist`
                        )
                    );
                }

                //  can't use --uplinks without a network
                if (!networkName && 0 === existingNetworkNames.length && uplinks) {
                    return callback(
                        Errors.Invalid(
                            'Cannot use --uplinks without an FTN network to import to'
                        )
                    );
                }

                getAnswers(
                    [
                        {
                            name: 'confTag',
                            message: 'Message conference:',
                            type: 'list',
                            choices: msgConfs,
                            pageSize: 10,
                            when: !confTag,
                        },
                        {
                            name: 'networkName',
                            message: 'FTN network name:',
                            type: 'list',
                            choices: ['-None-'].concat(existingNetworkNames),
                            pageSize: 10,
                            when: !networkName && existingNetworkNames.length > 0,
                            filter: choice => {
                                return '-None-' === choice ? undefined : choice;
                            },
                        },
                    ],
                    answers => {
                        confTag = confTag || answers.confTag;
                        networkName = networkName || answers.networkName;
                        uplinks = uplinks || answers.uplinks;

                        importEntries.forEach(ie => {
                            ie.areaTag = localAreaTagFor(ie.ftnTag);
                        });

                        return callback(null);
                    }
                );
            },
            function collectUplinks(callback) {
                if (!networkName || uplinks || 'bbs' === importType) {
                    return callback(null);
                }

                getAnswers(
                    [
                        {
                            name: 'uplinks',
                            message: 'Uplink(s) (comma separated):',
                            type: 'input',
                            validate: input => {
                                const inputUplinks = input.split(/[\s,]+/);
                                return validateUplinks(inputUplinks)
                                    ? true
                                    : 'Invalid uplink(s)';
                            },
                        },
                    ],
                    answers => {
                        uplinks = answers.uplinks;
                        return callback(null);
                    }
                );
            },
            function confirmWithUser(callback) {
                const sysConfig = require('../../core/config.js').get();

                console.info(`Importing the following for "${confTag}"`);
                console.info(
                    `(${sysConfig.messageConferences[confTag].name} - ${sysConfig.messageConferences[confTag].desc})`
                );
                console.info('');
                importEntries.forEach(ie => {
                    console.info(`  ${ie.ftnTag} - ${ie.name}`);
                });

                if (importSkipped.length > 0) {
                    console.info('');
                    console.info(
                        `${importSkipped.length} line(s) skipped and NOT imported:`
                    );
                    importSkipped.forEach(sk => {
                        console.info(`  line ${sk.lineNumber}: ${sk.reason}`);
                        console.info(`    ${sk.text}`);
                    });
                }

                if (networkName) {
                    console.info('');
                    console.info(`For FTN network: ${networkName}`);
                    console.info(`Uplinks: ${uplinks}`);
                    console.info('');
                    console.info(
                        'Importing will NOT create required FTN network configurations.'
                    );
                    console.info(
                        'If you have not yet done this, you will need to complete additional steps after importing.'
                    );
                    console.info('See Message Networks docs for details.');
                    console.info('');
                }

                getAnswers(
                    [
                        {
                            name: 'proceed',
                            message: 'Proceed?',
                            type: 'confirm',
                        },
                    ],
                    answers => {
                        return callback(
                            answers.proceed ? null : Errors.General('User canceled')
                        );
                    }
                );
            },
            function loadConfigHjson(callback) {
                const configPath = getConfigPath();
                fs.readFile(configPath, 'utf8', (err, confData) => {
                    if (err) {
                        return callback(err);
                    }

                    let config;
                    try {
                        config = hjson.parse(confData, { keepWsc: true });
                    } catch (e) {
                        return callback(e);
                    }
                    return callback(null, config);
                });
            },
            function performImport(config, callback) {
                //	AREAS.BBS carries per-area uplinks; everything else uses |uplinks|
                const records = buildAreaImportRecords(importEntries, {
                    confTag,
                    networkName,
                    uplinks,
                });

                const newConfig = _.defaultsDeep(
                    config,
                    { messageConferences: records.messageConferences },
                    { messageNetworks: records.messageNetworks }
                );
                const configPath = getConfigPath();

                if (!writeConfig(newConfig, configPath)) {
                    return callback(
                        Errors.UnexpectedState('Failed writing configuration')
                    );
                }

                return callback(null);
            },
        ],
        err => {
            if (err) {
                console.error(err.reason ? err.reason : err.message);
            } else {
                const addFieldUpd = 'bbs' === importType ? '"name" and "desc"' : '"desc"';
                console.info('Import complete.');
                console.info(
                    `You may wish to validate changes made to ${getConfigPath()}`
                );
                console.info(`as well as update ${addFieldUpd} fields, sorting, etc.`);
                console.info('');
            }
        }
    );
}

//
//	oputil.js mb auto-areas init
//
//	Bootstraps automatic area creation.  The order matters: a referenced but
//	missing include fails the entire config load, so the generated file has to
//	exist before config.hjson points at it or the board will not start.
//
function autoAreas() {
    const action = argv._[2];
    if ('init' !== action) {
        return printUsageAndSetExitCode(getHelpFor('MessageBase'), ExitCodes.ERROR);
    }

    const {
        GeneratedIncludeFileName,
        emptyGenerated,
        writeGenerated,
        addIncludeEntry,
    } = require('../auto_area_create.js');

    const configPath = getConfigPath();
    const generatedPath = paths.join(paths.dirname(configPath), GeneratedIncludeFileName);

    async.waterfall(
        [
            function createGeneratedFile(callback) {
                if (fs.existsSync(generatedPath)) {
                    console.info(`Already present: ${generatedPath}`);
                    return callback(null);
                }

                writeGenerated(generatedPath, emptyGenerated(), err => {
                    if (!err) {
                        console.info(`Created: ${generatedPath}`);
                    }
                    return callback(err);
                });
            },
            function loadConfigHjson(callback) {
                fs.readFile(configPath, 'utf8', (err, confData) => {
                    return callback(err, confData);
                });
            },
            function addInclude(confData, callback) {
                let config;
                try {
                    config = hjson.parse(confData);
                } catch (e) {
                    return callback(e);
                }

                const includes = Array.isArray(config.includes) ? config.includes : [];
                if (
                    includes.some(inc => paths.basename(inc) === GeneratedIncludeFileName)
                ) {
                    console.info(
                        `Already included from ${configPath}: ${GeneratedIncludeFileName}`
                    );
                    return callback(null);
                }

                const updated = addIncludeEntry(confData, GeneratedIncludeFileName);
                if (!updated) {
                    //
                    //	Refuse rather than fall back to a full rewrite: this is
                    //	somebody's live configuration and a one line addition is
                    //	not worth reformatting it.
                    //
                    console.info('');
                    console.info(`Could not safely add the include to ${configPath}.`);
                    console.info('Please add it by hand:');
                    console.info('');
                    console.info('    includes: [');
                    console.info(`        ${GeneratedIncludeFileName}`);
                    console.info('    ]');
                    console.info('');
                    return callback(Errors.General('Could not update configuration'));
                }

                try {
                    fs.writeFileSync(configPath, updated, 'utf8');
                } catch (e) {
                    return callback(e);
                }

                console.info(
                    `Added to "includes" in ${configPath}: ${GeneratedIncludeFileName}`
                );
                return callback(null);
            },
        ],
        err => {
            if (err) {
                process.exitCode = ExitCodes.ERROR;
                return console.error(err.reason ? err.reason : err.message);
            }

            console.info('');
            console.info(
                'Automatic area creation can now be configured per FTN network under'
            );
            console.info(
                'messageNetworks.ftn.networks.<network>.autoAreas -- it stays off until you do.'
            );
            console.info('See the Message Networks documentation for details.');
        }
    );
}

function dumpQWKPacket() {
    const packetPath = argv._[argv._.length - 1];
    if (argv._.length < 3 || !packetPath || 0 === packetPath.length) {
        return printUsageAndSetExitCode(getHelpFor('MessageBase'), ExitCodes.ERROR);
    }

    async.waterfall(
        [
            callback => {
                return initConfigAndDatabases(callback);
            },
            callback => {
                const { QWKPacketReader } = require('../qwk_mail_packet');
                const reader = new QWKPacketReader(packetPath);

                reader.on('error', err => {
                    console.error(`ERROR: ${err.message}`);
                    return callback(err);
                });

                reader.on('done', () => {
                    return callback(null);
                });

                reader.on('archive type', archiveType => {
                    console.info(`-> Archive type: ${archiveType}`);
                });

                reader.on('creator', creator => {
                    console.info(`-> Creator: ${creator}`);
                });

                reader.on('message', message => {
                    console.info('--- message ---');
                    console.info(`To:      ${message.toUserName}`);
                    console.info(`From:    ${message.fromUserName}`);
                    console.info(`Subject: ${message.subject}`);
                    console.info(`Message:\r\n${message.message}`);
                });

                reader.read();
            },
        ],
        err => {
            if (err) {
                console.error(`QWK dump failed: ${err.message}`);
            }
        }
    );
}

function exportQWKPacket() {
    let packetPath = argv._[argv._.length - 1];
    if (argv._.length < 3 || !packetPath || 0 === packetPath.length) {
        return printUsageAndSetExitCode(getHelpFor('MessageBase'), ExitCodes.ERROR);
    }

    //  oputil mb qwk-export TAGS PATH [--user USER] [--after TIMESTAMP]
    //  [areaTag1,areaTag2,...] PATH --user USER --after TIMESTAMP
    let bbsID = 'ENIGMA';
    const filename = paths.basename(packetPath);
    if (filename) {
        const ext = paths.extname(filename);
        bbsID = paths.basename(filename, ext);
    }

    packetPath = paths.dirname(packetPath);

    const posArgLen = argv._.length;

    let areaTags;
    if (4 === posArgLen) {
        areaTags = argv._[posArgLen - 2].split(',');
    } else {
        areaTags = [];
    }

    let newerThanTimestamp = null;
    if (argv.after) {
        const ts = moment(argv.after);
        if (ts.isValid()) {
            newerThanTimestamp = ts.format();
        }
    }

    const userName = argv.user || '-';

    const writerOptions = {
        enableQWKE: !(false === argv.qwke),
        enableHeadersExtension: !(false === argv.synchronet),
        enableAtKludges: !(false === argv.synchronet),
        archiveFormat: argv.format || 'application/zip',
    };

    let totalExported = 0;
    async.waterfall(
        [
            callback => {
                return initConfigAndDatabases(callback);
            },
            callback => {
                const User = require('../../core/user.js');

                User.getUserIdAndName(userName, (err, userId) => {
                    if (err) {
                        if ('-' === userName) {
                            userId = 1;
                        } else {
                            return callback(err);
                        }
                    }
                    return User.getUser(userId, callback);
                });
            },
            (user, callback) => {
                //  populate area tags with all available to user
                //  if they were not explicitly supplied
                if (!areaTags.length) {
                    const {
                        getAllAvailableMessageAreaTags,
                    } = require('../../core/message_area');

                    areaTags = getAllAvailableMessageAreaTags();
                }
                return callback(null, user);
            },
            (user, callback) => {
                const Message = require('../message');

                const filter = {
                    resultType: 'id',
                    areaTag: areaTags,
                    newerThanTimestamp,
                };

                //  public
                Message.findMessages(filter, (err, publicMessageIds) => {
                    if (err) {
                        return callback(err);
                    }

                    delete filter.areaTag;
                    filter.privateTagUserId = user.userId;

                    Message.findMessages(filter, (err, privateMessageIds) => {
                        return callback(
                            err,
                            user,
                            Message,
                            privateMessageIds.concat(publicMessageIds)
                        );
                    });
                });
            },
            (user, Message, messageIds, callback) => {
                const { QWKPacketWriter } = require('../qwk_mail_packet');
                const writer = new QWKPacketWriter(
                    Object.assign(writerOptions, {
                        bbsID,
                        user,
                    })
                );

                writer.on('ready', () => {
                    async.eachSeries(
                        messageIds,
                        (messageId, nextMessageId) => {
                            const message = new Message();
                            message.load({ messageId }, err => {
                                if (!err) {
                                    writer.appendMessage(message);
                                    ++totalExported;
                                }
                                return nextMessageId(err);
                            });
                        },
                        err => {
                            writer.finish(packetPath);
                            if (err) {
                                console.error(
                                    `Failed to write one or more messages: ${err.message}`
                                );
                            }
                        }
                    );
                });

                writer.on('warning', err => {
                    console.warn(`!!! ${err.reason ? err.reason : err.message}`);
                });

                writer.on('finished', () => {
                    return callback(null);
                });

                writer.init();
            },
        ],
        err => {
            if (err) {
                return console.error(err.reason ? err.reason : err.message);
            }

            console.info(`-> Exported ${totalExported} messages`);
        }
    );
}

const listConferences = () => {
    initConfigAndDatabases(err => {
        if (err) {
            return console.error(err.reason ? err.reason : err.message);
        }

        const { getSortedAvailMessageConferences } = require('../../core/message_area');

        const conferences = getSortedAvailMessageConferences(null, { noClient: true });

        for (let conf of conferences) {
            console.info(`${conf.confTag} - ${conf.conf.name}`);

            if (!argv.areas) {
                continue;
            }

            for (let areaTag of Object.keys(conf.conf.areas)) {
                console.info(`  ${areaTag} - ${conf.conf.areas[areaTag].name}`);
            }
        }
    });
};

const postMessage = () => {
    const inputFile = argv._[argv._.length - 1];
    if (argv._.length < 3 || !inputFile || 0 === inputFile.length) {
        return printUsageAndSetExitCode(getHelpFor('MessageBase'), ExitCodes.ERROR);
    }

    async.waterfall(
        [
            callback => {
                return initConfigAndDatabases(callback);
            },
            callback => {
                fs.readFile(inputFile, { encoding: 'utf-8' }, (err, jsonData) => {
                    if (err) {
                        return callback(err);
                    }

                    let messageJson;
                    try {
                        messageJson = JSON.parse(jsonData);
                    } catch (e) {
                        return callback(e);
                    }

                    for (let f of ['to', 'from', 'subject', 'body', 'areaTag']) {
                        if (!_.isString(messageJson[f])) {
                            return callback(
                                Errors.MissingConfig(
                                    `Missing "${f}" field in message JSON`
                                )
                            );
                        }

                        messageJson[f] = messageJson[f].trim();
                        if (messageJson[f].length === 0 && f !== 'subject') {
                            return callback(
                                Errors.Invalid(
                                    `"${messageJson[f]}" is not a valid value for the "${f}" field`
                                )
                            );
                        }
                    }

                    const { getMessageAreaByTag } = require('../../core/message_area');

                    const area = getMessageAreaByTag(messageJson.areaTag);
                    if (!area) {
                        return callback(
                            Errors.DoesNotExist(
                                `Area "${messageJson.areaTag}" does not exist`
                            )
                        );
                    }

                    const { getAddressedToInfo } = require('../../core/mail_util');
                    const Message = require('../../core/message');

                    const toInfo = getAddressedToInfo(messageJson.to);
                    const fromInfo = getAddressedToInfo(messageJson.from);

                    if (fromInfo.flavor !== Message.AddressFlavor.Local) {
                        return callback(
                            Errors.Invalid(
                                'Only local "from" users are currently supported'
                            )
                        );
                    }

                    let modTimestamp;
                    if (_.isString(messageJson.timestamp)) {
                        modTimestamp = moment(messageJson.timestamp);
                    }

                    if (!modTimestamp || !modTimestamp.isValid()) {
                        modTimestamp = moment();
                    }

                    const message = new Message({
                        toUserName: messageJson.to,
                        fromUserName: messageJson.from,
                        subject: messageJson.subject,
                        message: messageJson.body,
                        areaTag: messageJson.areaTag,
                        modTimestamp,
                    });

                    if (toInfo.flavor !== Message.AddressFlavor.Local) {
                        message.setExternalFlavor(toInfo.flavor);
                        message.setRemoteToUser(toInfo.remote);

                        return callback(null, area, message);
                    }

                    const User = require('../../core/user');
                    User.getUserIdAndNameByLookup(
                        message.toUserName,
                        (err, toUserId, toUserName) => {
                            if (err) {
                                return callback(
                                    Errors.DoesNotExist(
                                        `User "${message.toUserName}" does not exist.`
                                    )
                                );
                            }

                            message.to = toUserName; // adjust case/etc.
                            message.setLocalToUserId(toUserId);

                            return callback(null, area, message);
                        }
                    );
                });
            },
            (area, message, callback) => {
                message.persist(err => {
                    if (!err) {
                        console.info(
                            `Message from ${message.fromUserName} to ${message.toUserName}: "${message.subject}" in ${area.name}`
                        );
                    }
                    return callback(err);
                });
            },
        ],
        err => {
            if (err) {
                return console.error(err.reason ? err.reason : err.message);
            }
        }
    );
};

function handleMessageBaseCommand() {
    function errUsage() {
        return printUsageAndSetExitCode(getHelpFor('MessageBase'), ExitCodes.ERROR);
    }

    if (true === argv.help) {
        return errUsage();
    }

    const action = argv._[1];

    return (
        {
            areafix: areaFix,
            'import-areas': importAreas,
            'auto-areas': autoAreas,
            'qwk-dump': dumpQWKPacket,
            'qwk-export': exportQWKPacket,
            'list-confs': listConferences,
            post: postMessage,
        }[action] || errUsage
    )();
}
