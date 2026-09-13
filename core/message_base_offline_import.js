/* jslint node: true */
'use strict';

//  ENiGMA½
const { MenuModule, MenuFlags } = require('./menu_module.js');
const Message = require('./message.js');
const { Errors } = require('./enig_error.js');
const {
    hasMessageConfAndAreaWrite,
    getMessageAreaByTag,
    getAllAvailableMessageAreaTags,
} = require('./message_area.js');
const { BlueWavePacketReader, buildEchoTagMap } = require('./bluewave_mail_packet.js');
const { QWKPacketReader, buildConferenceMap } = require('./qwk_mail_packet.js');
const ArchiveUtil = require('./archive_util.js');
const User = require('./user.js');
const StatLog = require('./stat_log.js');
const SysProps = require('./system_property.js');
const UserProps = require('./user_property.js');
const Events = require('./events.js');
const { pathWithTerminatingSeparator } = require('./file_util.js');

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
            const echoTagMap = buildEchoTagMap(
                getAllAvailableMessageAreaTags(client).concat([
                    Message.WellKnownAreaTags.Private,
                ])
            );

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

        this.setMergedFlag(MenuFlags.NoHistory);
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

        this.summary = { imported: 0, rejected: 0 };

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

        return this._receivePacket(err => {
            if (err) {
                this.client.log.warn(
                    { error: err.message },
                    'Could not start an offline mail upload'
                );
                return this._finish();
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
                    },
                },
                cb
            );
        });
    }

    _updateStatus(status) {
        const statusView =
            _.get(this.viewControllers, 'main') &&
            this.viewControllers.main.getView(MciViewIds.main.status);
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

        source.reader.on('packet user', user => (packetUser = user));
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

            return this._persistMessages(pending, cb);
        });
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

    _finish() {
        this.client.log.info(this.summary, 'Offline mail import complete');
        this.temptmp.cleanup();
        if (this.tempRecvDirectory) {
            fse.remove(this.tempRecvDirectory, () => {});
        }
        return this.prevMenu();
    }
};
