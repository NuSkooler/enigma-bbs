/* jslint node: true */
'use strict';

//  ENiGMA½
const { MenuModule } = require('./menu_module.js');
const Message = require('./message.js');
const { Errors } = require('./enig_error.js');
const {
    hasMessageConfAndAreaWrite,
    getMessageAreaByTag,
    getAllAvailableMessageAreaTags,
} = require('./message_area.js');
const {
    BlueWavePacketReader,
    buildEchoTagMap,
    echoTagFor,
} = require('./bluewave_mail_packet.js');
const {
    BlueWaveExportAreasProperty,
    getUserExportAreas,
    blueWaveListedAreaTags,
} = require('./offline_mail_areas.js');
const { QWKPacketReader, buildConferenceMap } = require('./qwk_mail_packet.js');
const ArchiveUtil = require('./archive_util.js');
const User = require('./user.js');
const StatLog = require('./stat_log.js');
const SysProps = require('./system_property.js');
const UserProps = require('./user_property.js');
const Events = require('./events.js');
const { pathWithTerminatingSeparator } = require('./file_util.js');
const { getISOTimestampString } = require('./database.js');

//  deps
const async = require('async');
const _ = require('lodash');
const fs = require('graceful-fs');
const paths = require('path');
const { EventEmitter } = require('events');
const temptmp = require('temptmp');
const fse = require('fs-extra');

exports.moduleInfo = {
    name: 'Offline Mail Import',
    desc: 'Imports replies from an uploaded offline mail reply packet',
    author: 'ENiGMA½ Team',
};

const FormIds = {
    main: 0,
};

const MciViewIds = {
    main: {
        status: 1,
    },
};

//
//  A reply packet says what it is from the inside, so the caller is not asked
//  to pick a format on the way back in: the archive is opened and the members
//  name the reader that wrote them. Their download is where a format gets
//  chosen.
//
//
//  A Blue Wave reply packet holds its message text in files named 00000.MSG,
//  00001.MSG and so on, so "carries a .MSG" is not on its own enough to tell
//  the two formats apart. The reply records are.
//
const isBlueWaveReply = members => members.some(m => /\.(UPL|UPI|NET)$/.test(m));

const PacketFormats = [
    {
        name: 'Blue Wave',
        detect: isBlueWaveReply,
        //
        //  Routed by the echotags this caller's own export would have
        //  written: an area they cannot see was never in their packet, so a
        //  reply naming it is not theirs to place.
        //
        createSource: (client, { packetDir, limits }) => {
            const echoTagMap = buildEchoTagMap(blueWaveListedAreaTags(client));

            const reader = new BlueWavePacketReader(null, {
                areaTagForEchoTag: echoTag =>
                    echoTagMap.get(_.toString(echoTag).toUpperCase()),
                //  refused from the records, before any message file is read
                maxMessages: limits.maxMessages,
                maxMessageLength: limits.maxMessageLength,
            });

            return {
                reader,
                start: cb => reader.readExtracted(packetDir, cb),
                //  the same map: an area this caller's packet did not list is
                //  not theirs to turn on
                planAreaChanges: (config, now) =>
                    planAreaChanges({
                        current: getUserExportAreas(client, BlueWaveExportAreasProperty),
                        requested: config.areas,
                        echoTagMap,
                        now,
                    }),
                exportAreasProperty: BlueWaveExportAreasProperty,
            };
        },
    },
    {
        name: 'QWK',
        //
        //  A reply packet holds its messages in one file named for the BBS it
        //  came from, and carries no CONTROL.DAT -- which is what separates it
        //  from the packet that was downloaded.
        //
        detect: members =>
            members.some(m => m.endsWith('.MSG')) &&
            !members.includes('CONTROL.DAT') &&
            !isBlueWaveReply(members),
        createSource: (client, { packetPath }) => {
            //
            //  Numbered the way the export numbered them, which is over every
            //  area rather than the ones this caller can see -- a map built
            //  from a shorter list would number the same areas differently
            //  and place replies in the wrong one. Access is checked per
            //  message either way.
            //
            const confMap = buildConferenceMap(getAllAvailableMessageAreaTags());
            const areaTagForConf = new Map(
                Object.keys(confMap).map(areaTag => [confMap[areaTag], areaTag])
            );

            const reader = new QWKPacketReader(packetPath, {
                mode: QWKPacketReader.Modes.REP,
            });

            //
            //  A QWK message names a conference and nothing else, so the area
            //  is resolved here rather than in the reader, which has no idea
            //  what this board calls its areas.
            //
            const source = new EventEmitter();
            reader.on('message', message => {
                const confNumber = parseInt(
                    _.get(message, 'meta.QwkProperty.qwk_conf_num'),
                    10
                );
                const areaTag = areaTagForConf.get(confNumber);
                if (!areaTag) {
                    return source.emit(
                        'warning',
                        Errors.Invalid(
                            `No message area carries QWK conference ${confNumber}`
                        )
                    );
                }

                message.areaTag = areaTag;
                return source.emit('message', message);
            });

            return {
                reader: source,
                start: cb => {
                    reader.once('error', err => cb(err));
                    reader.once('done', () => cb(null));
                    reader.read();
                },
            };
        },
    },
];

//
//  A reply packet's offline configuration is the whole list of areas the
//  caller wants in their packet -- every area that was on is turned off and
//  the ones named are turned on, as the Blue Wave door did it -- so it
//  replaces the caller's selection rather than adding to it.
//
//  |current| is the caller's stored selection and |requested| what the
//  reader sent, as [ { echoTag, scan } ]. Only an echotag in |echoTagMap|,
//  which holds exactly the areas the caller's packet listed, can be turned
//  on; any other is refused and reported rather than dropped without a word.
//
//  An area that stays on keeps where its next packet starts. One turned on
//  starts at |now|: a year of backlog arriving unasked in the next packet is
//  a worse surprise than missing what was posted before the caller wanted it.
//
//  A list that would leave the caller with no area at all is not applied. An
//  export with nothing in it delivers no packet, and nothing online edits
//  this selection, so the caller could never get a packet to undo it from.
//  The same rule catches a list in a form this board does not read --
//  Wolverine names areas by number rather than echotag -- since none of it
//  resolves.
//
//  Returns { exportAreas, added, removed, refused, notes, emptied }: the new
//  selection (null when nothing is to change) and, as echotags, what changed.
//
const planAreaChanges = ({ current, requested, echoTagMap, now }) => {
    //  what the caller saw each area called, for the report
    const echoTagOf = new Map();
    echoTagMap.forEach((areaTag, echoTag) => {
        if (!echoTagOf.has(areaTag)) {
            echoTagOf.set(areaTag, echoTag);
        }
    });
    const nameOf = areaTag => echoTagOf.get(areaTag) || echoTagFor(areaTag);

    const plan = {
        exportAreas: null,
        added: [],
        removed: [],
        refused: [],
        notes: [],
        emptied: false,
    };

    const wanted = new Set();
    requested.forEach(({ echoTag, scan }) => {
        const areaTag = echoTagMap.get(_.toString(echoTag).toUpperCase());
        if (!areaTag) {
            plan.refused.push(echoTag);
            return;
        }

        wanted.add(areaTag);

        //  the reader offered "personal mail only" and this board packs an
        //  area whole; MBSE does the same
        if ('PERSONLY' === scan) {
            plan.notes.push(
                `${nameOf(areaTag)}: personal-only is not supported; all messages will be included`
            );
        }
    });

    if (!wanted.size) {
        plan.emptied = true;
        return plan;
    }

    const currentTags = new Set(current.map(exportArea => exportArea.areaTag));
    const listed = new Set(echoTagMap.values());

    //  an area the caller can no longer see was not in their packet, so it
    //  could not have been named; it goes, and is not reported as a change
    plan.exportAreas = current.filter(exportArea => wanted.has(exportArea.areaTag));
    current.forEach(exportArea => {
        if (!wanted.has(exportArea.areaTag) && listed.has(exportArea.areaTag)) {
            plan.removed.push(nameOf(exportArea.areaTag));
        }
    });

    wanted.forEach(areaTag => {
        if (!currentTags.has(areaTag)) {
            plan.exportAreas.push({ areaTag, newerThanTimestamp: now });
            plan.added.push(nameOf(areaTag));
        }
    });

    return plan;
};
exports.planAreaChanges = planAreaChanges;

//
//  What a session will take in one packet. A reply packet is written by
//  software on the caller's machine, so neither the record count nor the
//  length of a message is anything this end should trust.
//
//  exported for the tests: what separates one reply packet from another is
//  worth checking without a session in the way
exports.PacketFormats = PacketFormats;

const Limits = {
    maxMessages: 500,
    maxMessageLength: 64 * 1024,
};

//  an area the sysop has removed since the packet was built still has to
//  produce settings for the message
const areaOrEmpty = areaTag => getMessageAreaByTag(areaTag) || {};

exports.getModule = class MessageBaseOfflineImport extends MenuModule {
    constructor(options) {
        super(options);

        //  not MenuFlags.NoHistory, unlike upload.js: goto() pops a NoHistory
        //  module, and the transfer's prevMenu() has to land back here
        this.interrupt = MenuModule.InterruptTypes.Never;

        this.config = Object.assign(
            {},
            _.get(options, 'menuConfig.config'),
            options.extraArgs
        );

        this.limits = {
            maxMessages: this.config.maxMessages || Limits.maxMessages,
            maxMessageLength: this.config.maxMessageLength || Limits.maxMessageLength,
        };

        if (_.has(options, 'lastMenuResult.recvFilePaths')) {
            this.recvFilePaths = options.lastMenuResult.recvFilePaths;
        }

        //  |byArea| is areaTag -> count imported; |areaChanges| is what a
        //  reply packet's offline configuration did, if it carried one
        this.summary = { imported: 0, rejected: 0, byArea: {}, areaChanges: null };

        //  per session: a tracked session shared between callers would have
        //  one caller's cleanup take another's packet out from under them
        this.temptmp = temptmp.createTrackedSession('offlineimport');
    }

    getSaveState() {
        return { tempRecvDirectory: this.tempRecvDirectory };
    }

    restoreSavedState(savedState) {
        this.tempRecvDirectory = savedState.tempRecvDirectory;
    }

    isFileTransferComplete() {
        return this.recvFilePaths !== undefined;
    }

    //
    //  A menu with no art produces no MCI map, and a view controller refuses
    //  to load without one -- which would fail the init sequence and drop the
    //  caller back where they came from, never reaching the upload. The
    //  module shows nothing in that case and still works.
    //
    mciReady(mciData, cb) {
        super.mciReady(mciData, err => {
            if (err) {
                return cb(err);
            }

            if (!mciData.menu) {
                return cb(null);
            }

            this.prepViewController('main', FormIds.main, mciData.menu, err => {
                return cb(err);
            });
        });
    }

    //
    //  The default sequence displays the menu's art and prepares the views
    //  first, so a theme that supplies art gets a status line; one that does
    //  not still imports.
    //
    finishedLoading() {
        if (this.isFileTransferComplete()) {
            //  a protocol that exits cleanly having received nothing
            if (!this.recvFilePaths.length) {
                return this._finish('No packet was uploaded');
            }

            return this._importReceivedPackets(err => {
                if (err) {
                    this.client.log.warn(
                        { error: err.message },
                        'Offline mail import failed'
                    );
                }
                return this._finish();
            });
        }

        //  ESC out of protocol selection pops back here with the temp dir
        //  restored; asking again would loop
        if (this.tempRecvDirectory) {
            return this._finish('No packet was uploaded');
        }

        return this._receivePacket(err => {
            if (err) {
                this.client.log.warn(
                    { error: err.message },
                    'Could not start an offline mail upload'
                );
                return this._finish('The upload could not be started -- see the log');
            }
        });
    }

    //
    //  Protocol selection, then the transfer itself. The module is re-entered
    //  afterwards with the paths of whatever arrived.
    //
    _receivePacket(cb) {
        this.temptmp.mkdir({ prefix: 'enigofflineimport-' }, (err, tempRecvDirectory) => {
            if (err) {
                return cb(err);
            }

            //  external protocols want a terminator
            this.tempRecvDirectory = pathWithTerminatingSeparator(tempRecvDirectory);

            return this.gotoMenu(
                this.config.fileTransferProtocolSelection ||
                    'fileTransferProtocolSelection',
                {
                    extraArgs: {
                        recvDirectory: this.tempRecvDirectory,
                        direction: 'recv',
                        //
                        //  Without this, protocol selection hands the upload
                        //  to the file base pipeline instead of back here --
                        //  which then finds no upload area, does nothing, and
                        //  leaves the caller on its processing screen.
                        //
                        returnToCaller: true,
                    },
                },
                cb
            );
        });
    }

    _updateStatus(status) {
        const statusView = this.getView('main', MciViewIds.main.status);
        if (statusView) {
            statusView.setText(status);
        }
        this.client.log.debug({ status }, 'Offline mail import');
    }

    _importReceivedPackets(cb) {
        async.eachSeries(
            this.recvFilePaths,
            (packetPath, nextPacket) => {
                this._importPacket(packetPath, err => {
                    if (err) {
                        //  one bad packet does not end the session
                        this.client.log.warn(
                            { error: err.message, path: packetPath },
                            'Could not import an offline mail packet'
                        );
                        this.packetError = err.message;
                        this._updateStatus(err.message);
                    }
                    return nextPacket(null);
                });
            },
            err => cb(err)
        );
    }

    _importPacket(packetPath, cb) {
        const archiveUtil = ArchiveUtil.getInstance();
        let packetDir;

        async.waterfall(
            [
                callback => {
                    archiveUtil.detectType(packetPath, (err, archiveType) => {
                        if (err) {
                            return callback(
                                Errors.Invalid(
                                    `${paths.basename(
                                        packetPath
                                    )} is not an archive this system can open`
                                )
                            );
                        }
                        return callback(null, archiveType);
                    });
                },
                (archiveType, callback) => {
                    this.temptmp.mkdir({ prefix: 'enigofflineunpack-' }, (err, dir) => {
                        packetDir = dir;
                        return callback(err, archiveType);
                    });
                },
                (archiveType, callback) => {
                    archiveUtil.extractTo(packetPath, packetDir, archiveType, err => {
                        return callback(err);
                    });
                },
                callback => {
                    fs.readdir(packetDir, (err, members) => {
                        return callback(err, members);
                    });
                },
                (members, callback) => {
                    const upper = members.map(m => m.toUpperCase());
                    const format = PacketFormats.find(f => f.detect(upper));
                    if (!format) {
                        return callback(
                            Errors.Invalid(
                                'Not a reply packet this system knows how to read'
                            )
                        );
                    }
                    return callback(null, format);
                },
                (format, callback) => {
                    this._updateStatus(`Reading ${format.name} replies`);
                    return this._readAndPersist(
                        format,
                        { packetPath, packetDir, limits: this.limits },
                        callback
                    );
                },
            ],
            err => {
                if (packetDir) {
                    fse.remove(packetDir, () => {});
                }
                return cb(err);
            }
        );
    }

    _readAndPersist(format, context, cb) {
        const source = format.createSource(this.client, context);
        const pending = [];
        let packetUser = null;
        let offlineConfig = null;

        source.reader.on('packet user', user => (packetUser = user));
        source.reader.on('offline config', config => (offlineConfig = config));
        source.reader.on('warning', warning => {
            this.summary.rejected += 1;
            this.client.log.info(
                { reason: warning.message },
                'Offline mail reply not imported'
            );
        });
        //
        //  Counted and sized here rather than per format: a reader that
        //  cannot be told a limit -- QWK takes none -- would otherwise
        //  accumulate the whole packet before anything checked it. The Blue
        //  Wave reader still refuses an oversized packet earlier, from the
        //  records, before it opens a single message file.
        //
        let overLimit = false;
        source.reader.on('message', message => {
            if (pending.length >= this.limits.maxMessages) {
                overLimit = true;
                return;
            }

            if (message.message.length > this.limits.maxMessageLength) {
                this.summary.rejected += 1;
                this.client.log.info(
                    { areaTag: message.areaTag },
                    'Offline mail reply is too long to import'
                );
                return;
            }

            pending.push(message);
        });

        source.start(err => {
            if (err) {
                return cb(err);
            }

            const identityError = this._checkPacketUser(packetUser);
            if (identityError) {
                return cb(identityError);
            }

            if (overLimit) {
                return cb(
                    Errors.Invalid(
                        `A reply packet may carry at most ${this.limits.maxMessages} messages`
                    )
                );
            }

            return this._persistMessages(pending, err => {
                if (err) {
                    return cb(err);
                }
                return this._applyOfflineConfig(source, offlineConfig, cb);
            });
        });
    }

    //
    //  Only once the packet is known to be this caller's: one built for
    //  somebody else, or refused whole, changes nothing.
    //
    _applyOfflineConfig(source, config, cb) {
        if (!config || !source.planAreaChanges) {
            return cb(null);
        }

        if (config.error) {
            this.client.log.info(
                { reason: config.error, format: config.format },
                'Offline configuration not applied'
            );
            return cb(null);
        }

        //  door settings only, none of which mean anything here
        if (!config.areaChanges) {
            return cb(null);
        }

        const plan = source.planAreaChanges(config, getISOTimestampString());
        this.summary.areaChanges = plan;

        this.client.log.info(
            {
                format: config.format,
                added: plan.added,
                removed: plan.removed,
                refused: plan.refused,
                emptied: plan.emptied,
            },
            'Offline configuration'
        );

        if (!plan.exportAreas) {
            return cb(null);
        }

        return this.client.user.persistProperty(
            source.exportAreasProperty,
            JSON.stringify(plan.exportAreas),
            err => {
                if (err) {
                    this.client.log.warn(
                        { error: err.message },
                        'Could not store the offline configuration'
                    );
                    this.packetError = 'Area changes could not be saved -- see the log';
                }
                return cb(null);
            }
        );
    }

    //
    //  The packet carries the name it was built for. A reply packet uploaded
    //  under a different login is somebody else's mail, whether by mistake or
    //  otherwise, and the messages in it would be posted over this caller's
    //  name.
    //
    _checkPacketUser(packetUser) {
        if (!packetUser || !packetUser.loginName) {
            return null;
        }

        const user = this.client.user;
        const names = [user.username, user.realName(true), user.realName(false)]
            .filter(name => name)
            .map(name => name.toLowerCase());

        if (names.includes(packetUser.loginName.toLowerCase())) {
            return null;
        }

        return Errors.AccessDenied(
            `This reply packet was built for "${packetUser.loginName}"`
        );
    }

    _persistMessages(messages, cb) {
        async.eachSeries(
            messages,
            (message, nextMessage) => {
                this._persistMessage(message, err => {
                    if (err) {
                        this.summary.rejected += 1;
                        this.client.log.info(
                            { reason: err.message, areaTag: message.areaTag },
                            'Offline mail reply not imported'
                        );
                    } else {
                        this.summary.imported += 1;
                        this.summary.byArea[message.areaTag] =
                            (this.summary.byArea[message.areaTag] || 0) + 1;
                    }

                    this._updateStatus(
                        `Imported ${this.summary.imported}, rejected ${this.summary.rejected}`
                    );
                    return nextMessage(null);
                });
            },
            err => cb(err)
        );
    }

    //
    //  A reply names the message it answers by the number the packet carried,
    //  which is that message's own ID. It is checked against the area before
    //  anything is threaded onto it: an ID that names a message somewhere
    //  else is one this caller edited, or one from a packet built before the
    //  sysop moved the area, and a wrong chain is worse than none.
    //
    _resolveReplyTo(message, cb) {
        const replyToNumber = parseInt(
            _.get(
                message,
                'meta.BlueWaveProperty.bw_reply_to_num',
                _.get(message, 'meta.QwkProperty.qwk_in_reply_to_num')
            ),
            10
        );

        if (!replyToNumber) {
            return cb(null);
        }

        const target = new Message();
        target.load({ messageId: replyToNumber }, err => {
            if (!err && target.areaTag === message.areaTag) {
                message.replyToMsgId = replyToNumber;
            }
            return cb(null);
        });
    }

    _persistMessage(message, cb) {
        const areaTag = message.areaTag;
        const isPrivate = Message.isPrivateAreaTag(areaTag);

        if (!isPrivate && !hasMessageConfAndAreaWrite(this.client, areaTag)) {
            return cb(Errors.AccessDenied(`Cannot post to "${areaTag}"`));
        }

        //
        //  The kit tells doors to validate UPL_REC.from, and there is nothing
        //  to validate it against: a reader writes whatever name it was
        //  configured with. The session owns who this is.
        //
        const area = areaOrEmpty(areaTag);
        message.fromUserName = area.realNames
            ? this.client.user.realName(true)
            : this.client.user.username;
        message.setLocalFromUserId(this.client.user.userId);

        this._resolveReplyTo(message, () => {
            if (!isPrivate) {
                message.setExternalFlavor(
                    area.addressFlavor || Message.AddressFlavor.Local
                );
                return this._persistAndCount(message, cb);
            }

            //  personal mail has to reach a real user here
            User.getUserIdAndNameByLookup(
                message.toUserName,
                (err, toUserId, toUserName) => {
                    if (err) {
                        return cb(
                            Errors.DoesNotExist(
                                `User "${message.toUserName}" does not exist`
                            )
                        );
                    }

                    message.toUserName = toUserName; //  as the user spells it
                    message.setLocalToUserId(toUserId);
                    message.setExternalFlavor(Message.AddressFlavor.Local);
                    return this._persistAndCount(message, cb);
                }
            );
        });
    }

    _persistAndCount(message, cb) {
        message.persist(err => {
            if (err) {
                return cb(err);
            }

            if (Message.isPrivateAreaTag(message.areaTag)) {
                Events.emit(Events.getSystemEvents().UserSendMail, {
                    user: this.client.user,
                });
                return cb(null);
            }

            Events.emit(Events.getSystemEvents().UserPostMessage, {
                user: this.client.user,
                areaTag: message.areaTag,
            });

            StatLog.incrementNonPersistentSystemStat(SysProps.MessageTotalCount, 1);
            StatLog.incrementNonPersistentSystemStat(SysProps.MessagesToday, 1);
            return StatLog.incrementUserStat(
                this.client.user,
                UserProps.MessagePostCount,
                1,
                () => cb(null)
            );
        });
    }

    //
    //  Every path out of finishedLoading() below moves the caller itself --
    //  to protocol selection to collect the packet, or back where they came
    //  from once the import is done. MenuModule.initSequence() calls
    //  finishedLoading() and then autoNextMenu(), and a menu carrying neither
    //  a form nor a prompt -- which is how the templates and the docs show
    //  this one -- has runtime.autoNext set for it by ThemeManager, so the
    //  automatic transition fires too.
    //
    //  It is worse here than for an export. The upload starts behind an async
    //  mkdir(), so the automatic prevMenu() always wins the race: the stack
    //  unwinds past the menu the caller came from while gotoMenu() is still in
    //  flight, and two view controllers end up attached to client keypress,
    //  echoing every character twice.
    //
    autoNextMenu() {
        //  intentionally nothing; see above
    }

    //
    //  One line, for a status view in a theme's art: the counts, as it has
    //  always said them.
    //
    _summaryHeadline() {
        const { imported, rejected } = this.summary;
        let headline = rejected
            ? `Imported ${imported} message(s); ${rejected} not imported -- see the log`
            : `Imported ${imported} message(s)`;
        if (this.packetError) {
            headline += `; ${this.packetError}`;
        }
        return headline;
    }

    //
    //  The whole of it, for the terminal: where each message went, what was
    //  refused, then what the packet's offline configuration changed. A
    //  caller who sees only a count cannot tell a reply went where they meant
    //  it to without opening the area and looking.
    //
    _summaryLines() {
        const { imported, rejected, byArea, areaChanges } = this.summary;
        const lines = [`Imported ${imported} message(s)`];

        Object.keys(byArea).forEach(areaTag => {
            const name = _.get(getMessageAreaByTag(areaTag), 'name') || areaTag;
            lines.push(`  ${name}: ${byArea[areaTag]}`);
        });

        if (rejected) {
            lines.push(`${rejected} not imported -- see the log`);
        }
        if (this.packetError) {
            lines.push(this.packetError);
        }

        if (areaChanges) {
            if (areaChanges.emptied) {
                lines.push(
                    'No areas would be left in your packet; area changes not applied'
                );
            }
            if (areaChanges.added.length) {
                lines.push(`Added to packet: ${areaChanges.added.join(', ')}`);
            }
            if (areaChanges.removed.length) {
                lines.push(`Removed from packet: ${areaChanges.removed.join(', ')}`);
            }
            if (areaChanges.refused.length) {
                lines.push(`Not available here: ${areaChanges.refused.join(', ')}`);
            }
            lines.push(...areaChanges.notes);
        }

        return lines;
    }

    //  |outcome| replaces the summary where there was nothing to import
    _finish(outcome) {
        const { imported, rejected, byArea, areaChanges } = this.summary;
        this.client.log.info(
            {
                imported,
                rejected,
                byArea,
                added: _.get(areaChanges, 'added'),
                removed: _.get(areaChanges, 'removed'),
                refused: _.get(areaChanges, 'refused'),
            },
            outcome || 'Offline mail import complete'
        );
        this.temptmp.cleanup();
        if (this.tempRecvDirectory) {
            fse.remove(this.tempRecvDirectory, () => {});
        }

        //  a status view holds a line; the terminal takes the lot
        const statusView = this.getView('main', MciViewIds.main.status);
        const summary = statusView
            ? this._summaryHeadline()
            : this._summaryLines().join('\n');

        this.showOutcome(outcome || summary, statusView);
        return this.pauseBelowArt(() => this.prevMenu());
    }
};
