/* jslint node: true */
'use strict';

//  ENiGMA½
const { MenuModule } = require('./menu_module.js');
const Message = require('./message.js');
const { Errors } = require('./enig_error.js');
const {
    getMessageAreaByTag,
    getMessageConferenceByTag,
    hasMessageConfAndAreaRead,
    getEffectiveNewScanLastReadId,
    updateMessageAreaLastReadId,
} = require('./message_area.js');
const FileArea = require('./file_base_area.js');
const { renderSubstr } = require('./string_util.js');
const FileEntry = require('./file_entry.js');
const DownloadQueue = require('./download_queue.js');
const Events = require('./events.js');
const { safeMoveFile } = require('./file_util.js');
const { getUserExportAreas } = require('./offline_mail_areas.js');
const { offlineMailBulletins } = require('./offline_mail_bulletins.js');

//  deps
const async = require('async');
const _ = require('lodash');
const fse = require('fs-extra');
const temptmp = require('temptmp');
const paths = require('path');
const { randomUUID } = require('crypto');

const FormIds = {
    main: 0,
};

const MciViewIds = {
    main: {
        status: 1,
        progressBar: 2,

        customRangeStart: 10,
    },
};

//
//  The flow every offline mail packet export shares: gather the areas the
//  caller asked for, walk the new messages in each into a packet writer,
//  then hand the finished packet to their download queue.
//
//  A format supplies a writer and a few names by overriding the hooks below.
//  A writer is expected to emit 'ready', 'packet', 'finished', 'error' and
//  'warning', and to take messages through appendMessage().
//
module.exports = class MessageBaseOfflineExport extends MenuModule {
    constructor(options) {
        super(options);

        this.config = Object.assign(
            {},
            _.get(options, 'menuConfig.config'),
            options.extraArgs
        );

        this.config.progBarChar = renderSubstr(this.config.progBarChar || '▒', 0, 1);

        this.sysTempDownloadArea = FileArea.getFileAreaByTag(
            FileArea.WellKnownAreaTags.TempDownloads
        );
    }

    //  Hooks. Those with no default here are required; _missingHook()
    //  checks for them before an export touches the session.

    //  'QWK', 'Blue Wave', ... -- names the format in status text and logs
    get packetFormatName() {
        throw Errors.MissingParam('packetFormatName is required');
    }

    //  where this format keeps the caller's export options; the areas are
    //  shared by every format (see offline_mail_areas.js)
    get userProperties() {
        throw Errors.MissingParam('userProperties is required');
    }

    createPacketWriter(/*options*/) {
        throw Errors.MissingParam('createPacketWriter() is required');
    }

    //  what the caller gets before they have chosen anything
    defaultExportOptions() {
        return { archiveFormat: 'application/zip' };
    }

    //  MCI views the menu must carry; a format whose art has none returns []
    requiredViewIds() {
        return [MciViewIds.main.status, MciViewIds.main.progressBar];
    }

    //  Optional: the NORESULTS branch that consumes this is currently dead
    //  (see mciReady()), so a format need not supply one.
    noResultsMenuName() {
        return null;
    }

    //
    //  A format that lists areas in the packet declares them here, before any
    //  message is gathered -- Blue Wave lists an area that had no new mail so
    //  a reader can still post into it.
    //
    prepareAreaForExport(/*packetWriter, { areaTag, area, conf }*/) {}

    //
    //  Once, before any area is gathered, with every area the caller has
    //  selected. Blue Wave lists the areas the caller has not selected here
    //  too, so a reader can offer to turn them on.
    //
    prepareExport(/*packetWriter, { exportAreas }*/) {}

    //  the extension the writer chose is kept: it is part of what a reader
    //  recognizes
    tempDownloadFileName(packetInfo) {
        return `${randomUUID().substr(-8).toUpperCase()}${paths.extname(
            packetInfo.path
        )}`;
    }

    mciReady(mciData, cb) {
        super.mciReady(mciData, err => {
            if (err) {
                return cb(err);
            }

            async.waterfall(
                [
                    callback => {
                        //  a menu with no art (the shipped one) has no MCI
                        //  map, so no views to prepare or validate
                        if (!mciData.menu) {
                            return callback(null);
                        }

                        this.prepViewController(
                            'main',
                            FormIds.main,
                            mciData.menu,
                            err => {
                                if (err) {
                                    return callback(err);
                                }

                                const required = this.requiredViewIds();
                                if (!required.length) {
                                    return callback(null);
                                }
                                return this.validateMCIByViewIds(
                                    'main',
                                    required,
                                    callback
                                );
                            }
                        );
                    },
                    callback => {
                        this.temptmp = temptmp.createTrackedSession('offlineexport');
                        this.temptmp.mkdir(
                            { prefix: 'enigofflineexport-' },
                            (err, tempDir) => {
                                if (err) {
                                    return callback(err);
                                }

                                this.tempPacketDir = tempDir;

                                const sysTempDownloadDir =
                                    FileArea.getAreaDefaultStorageDirectory(
                                        this.sysTempDownloadArea
                                    );

                                //  ensure dir exists
                                fse.mkdirs(sysTempDownloadDir, err => {
                                    return callback(err, sysTempDownloadDir);
                                });
                            }
                        );
                    },
                    (sysTempDownloadDir, callback) => {
                        this._performExport(sysTempDownloadDir, err => {
                            return callback(err);
                        });
                    },
                ],
                err => {
                    //  an error before the session was created leaves nothing
                    //  to clean up, and cleaning it anyway threw over the top
                    //  of the real error
                    if (this.temptmp) {
                        this.temptmp.cleanup();
                    }

                    if (err) {
                        //  packetFormatName is not named here: it is a getter
                        //  the base class throws from, and an incomplete
                        //  format is one of the errors that lands here
                        this.client.log.warn(
                            { error: err.message, reasonCode: err.reasonCode },
                            'Offline mail export failed'
                        );

                        //  :TODO: doesn't do anything currently:
                        if ('NORESULTS' === err.reasonCode) {
                            return this.gotoMenu(
                                this.menuConfig.config.noResultsMenu ||
                                    this.noResultsMenuName()
                            );
                        }

                        this.finalStatus = 'The export failed -- see the log';
                    }

                    this._tellCaller();
                    return cb(null);
                }
            );
        });
    }

    //  said before the init sequence's own pause step, so a menu configured
    //  to pause holds it
    _tellCaller() {
        if (this.finalStatus) {
            this.showOutcome(
                this.finalStatus,
                this.getView('main', MciViewIds.main.status)
            );
        }
    }

    finishedLoading() {
        //  a menu that pauses of its own accord has already held it
        const menuPauses = this.shouldPause() && 'pageBreak' !== this.getPauseMode();
        if (!this.finalStatus || menuPauses) {
            return this.prevMenu();
        }

        return this.pauseBelowArt(() => this.prevMenu());
    }

    //
    //  We leave the menu ourselves, above. MenuModule.initSequence() calls
    //  finishedLoading() and then autoNextMenu(), and a menu carrying neither
    //  a form nor a prompt -- which is how the templates and the docs show
    //  this one -- has runtime.autoNext set for it by ThemeManager. That would
    //  make the automatic transition fire as well, and menuStack.prev() has no
    //  guard against being asked twice, so the caller would land two menus
    //  back rather than one.
    //
    //  Nothing is lost by refusing it: this module has always returned to the
    //  previous menu unconditionally, so a "next" on the menu was never
    //  honored either way.
    //
    autoNextMenu() {
        //  intentionally nothing; see above
    }

    _getUserExportOptions() {
        let options = this.client.user.getProperty(this.userProperties.ExportOptions);
        try {
            options = JSON.parse(options);
        } catch (e) {
            options = this.defaultExportOptions();
        }
        return options;
    }

    _getUserExportAreas(cb) {
        return getUserExportAreas(this.client, cb);
    }

    //  a writer that fails here must end the wait, not leave the caller on
    //  the export screen until their session times out
    _finishPacket(packetWriter, cb) {
        let packetInfo;
        const done = _.once(err => cb(err, packetInfo));

        packetWriter.once('packet', info => {
            packetInfo = info;
        });
        packetWriter.once('finished', () => done(null));
        packetWriter.once('error', err => done(err));

        packetWriter.finish(this.tempPacketDir);
    }

    //
    //  A hook a format forgot must be caught here rather than from inside a
    //  callback: by then the idle monitor is stopped and a key press listener
    //  is attached, and the throw leaves the session wedged with neither
    //  undone.
    //
    _missingHook() {
        try {
            void this.packetFormatName;
            void this.userProperties;
        } catch (e) {
            return e;
        }

        if (
            this.createPacketWriter ===
            MessageBaseOfflineExport.prototype.createPacketWriter
        ) {
            return Errors.MissingParam('createPacketWriter() is required');
        }

        return null;
    }

    //
    //  The finished packet into the caller's download queue, valid until
    //  their session ends. Answers with the queued FileEntry.
    //
    _deliverPacket(packetInfo, sysTempDownloadDir, cb) {
        const sysDownloadPath = paths.join(
            sysTempDownloadDir,
            this.tempDownloadFileName(packetInfo)
        );

        safeMoveFile(packetInfo.path, sysDownloadPath, err => {
            if (err) {
                return cb(err);
            }

            const newEntry = new FileEntry({
                areaTag: this.sysTempDownloadArea.areaTag,
                fileName: paths.basename(sysDownloadPath),
                storageTag: this.sysTempDownloadArea.storageTags[0],
                meta: {
                    upload_by_username: this.client.user.username,
                    upload_by_user_id: this.client.user.userId,
                    byte_size: packetInfo.stats.size,
                    session_temp_dl: 1, //  download is valid until session is over

                    //  :TODO: something like this: allow to override the displayed/downloaded as filename
                    //  separate from the actual on disk filename. E.g. we could always download as "ENIGMA.QWK"
                    //visible_filename    : paths.basename(packetInfo.path),
                },
            });

            newEntry.desc = `${this.packetFormatName} Export`;

            newEntry.persist(err => {
                if (!err) {
                    //  queue it!
                    DownloadQueue.get(this.client).addTemporaryDownload(newEntry);
                }
                return cb(err, newEntry);
            });
        });
    }

    //
    //  The caller's lastread pointers move past what a packet carried only
    //  once they have downloaded it. A packet left in the queue is deleted
    //  when the session ends, and its messages must still be new next time.
    //
    //  |highestIds| is areaTag -> the highest message ID packed there. A
    //  pointer never moves backwards, so a second packet built before the
    //  first was downloaded -- which carries everything the first did --
    //  can be downloaded in either order.
    //
    _advancePointersOnDownload(fileId, highestIds) {
        const client = this.client;
        const userId = client.user.userId;
        const sessionId = _.get(client, 'session.uniqueId');
        const SystemEvents = Events.getSystemEvents();

        const stopListening = () => {
            Events.removeListener(SystemEvents.UserDownload, onDownload);
            Events.removeListener(SystemEvents.ClientDisconnected, onDisconnect);
        };

        const onDownload = evt => {
            const files = _.get(evt, 'files');
            if (
                userId !== _.get(evt, 'user.userId') ||
                !Array.isArray(files) ||
                !files.some(file => file && fileId === file.fileId)
            ) {
                return;
            }

            stopListening();

            async.eachSeries(
                Object.keys(highestIds),
                (areaTag, nextArea) => {
                    updateMessageAreaLastReadId(
                        userId,
                        areaTag,
                        highestIds[areaTag],
                        false, //  never backwards
                        err => {
                            if (err) {
                                client.log.warn(
                                    { areaTag, error: err.message },
                                    `Could not advance the scan pointer after a ${this.packetFormatName} download`
                                );
                            }
                            return nextArea(null);
                        }
                    );
                },
                () => {
                    client.log.debug(
                        { fileId, areas: Object.keys(highestIds).length },
                        `${this.packetFormatName} packet downloaded; scan pointers advanced`
                    );
                }
            );
        };

        const onDisconnect = evt => {
            if (sessionId === _.get(evt, 'client.session.uniqueId')) {
                stopListening();
            }
        };

        Events.on(SystemEvents.UserDownload, onDownload);
        Events.on(SystemEvents.ClientDisconnected, onDisconnect);
    }

    _performExport(sysTempDownloadDir, cb) {
        const missingHook = this._missingHook();
        if (missingHook) {
            this.client.log.error(
                { error: missingHook.message },
                'Cannot export: the packet format is incomplete'
            );
            return cb(missingHook);
        }

        //  A menu with no art has no views at all, not merely missing ones --
        //  the export still runs, the caller just watches nothing happen.
        const statusView = this.getView('main', MciViewIds.main.status);
        const updateStatus = status => {
            if (statusView) {
                statusView.setText(status);
            }
        };

        //  what the caller is told at the end, and held for them
        this.finalStatus = null;
        const finalStatus = status => {
            updateStatus(status);
            this.finalStatus = status;
        };

        const progBarView = this.getView('main', MciViewIds.main.progressBar);
        const updateProgressBar = (curr, total) => {
            if (progBarView) {
                const prog = Math.floor((curr / total) * progBarView.dimens.width);
                progBarView.setText(this.config.progBarChar.repeat(prog));
            }
        };

        let cancel = false;

        let lastProgUpdate = 0;
        const progressHandler = (state, next) => {
            //  we can produce a TON of updates; only update progress at most every 3/4s
            if (Date.now() - lastProgUpdate > 750) {
                switch (state.step) {
                    case 'next_area':
                        updateStatus(state.status);
                        updateProgressBar(0, 0);
                        this.updateCustomViewTextsWithFilter(
                            'main',
                            MciViewIds.main.customRangeStart,
                            state
                        );
                        break;

                    case 'message':
                        updateStatus(state.status);
                        updateProgressBar(state.current, state.total);
                        this.updateCustomViewTextsWithFilter(
                            'main',
                            MciViewIds.main.customRangeStart,
                            state
                        );
                        break;

                    default:
                        break;
                }
                lastProgUpdate = Date.now();
            }

            return next(cancel ? Errors.UserInterrupt('User canceled') : null);
        };

        const keyPressHandler = (ch, key) => {
            if ('escape' === key.name) {
                cancel = true;
                this.client.removeListener('key press', keyPressHandler);
            }
        };

        let totalExported = 0;

        //  areaTag -> the highest message ID packed there; what the caller's
        //  lastread pointers move to once the packet is downloaded
        const highestIds = {};

        //  |pointerAreaTag| is the area whose lastread covers what |filter|
        //  finds: private mail is found by user rather than by area
        const processMessagesWithFilter = (filter, pointerAreaTag, cb) => {
            Message.findMessages(filter, (err, messageIds) => {
                if (err) {
                    return cb(err);
                }

                let current = 1;
                async.eachSeries(
                    messageIds,
                    (messageId, nextMessageId) => {
                        const message = new Message();
                        message.load({ messageId }, err => {
                            if (err) {
                                return nextMessageId(err);
                            }

                            const progress = {
                                message,
                                step: 'message',
                                total: ++totalExported,
                                areaCurrent: current,
                                areaCount: messageIds.length,
                                status: `${_.truncate(message.subject, {
                                    length: 25,
                                })} (${current} / ${messageIds.length})`,
                            };

                            progressHandler(progress, err => {
                                if (err) {
                                    return nextMessageId(err);
                                }

                                packetWriter.appendMessage(message);
                                current += 1;

                                highestIds[pointerAreaTag] = Math.max(
                                    highestIds[pointerAreaTag] || 0,
                                    messageId
                                );

                                return nextMessageId(null);
                            });
                        });
                    },
                    err => {
                        return cb(err);
                    }
                );
            });
        };

        const packetWriter = this.createPacketWriter(
            Object.assign(this._getUserExportOptions(), {
                user: this.client.user,
                bulletins: offlineMailBulletins(),
            })
        );

        packetWriter.on('warning', warning => {
            this.client.log.warn(
                { warning },
                `${this.packetFormatName} packet writer warning`
            );
        });

        async.waterfall(
            [
                callback => {
                    //  don't count idle monitor while processing
                    this.client.stopIdleMonitor();

                    //  let user cancel
                    this.client.on('key press', keyPressHandler);

                    //  a writer that fails to start ends the export here, for
                    //  the same reason a writer that fails to finish does
                    const started = _.once(callback);

                    packetWriter.once('ready', () => started(null));

                    packetWriter.on('error', err => {
                        this.client.log.error(
                            { error: err.message },
                            `${this.packetFormatName} packet writer error`
                        );
                        cancel = true;
                        started(err);
                    });

                    packetWriter.init();
                },
                callback => {
                    return this._getUserExportAreas(callback);
                },
                (userExportAreas, callback) => {
                    //  For each public area -> for each message
                    this.prepareExport(packetWriter, { exportAreas: userExportAreas });

                    const publicExportAreas = userExportAreas.filter(exportArea => {
                        return exportArea.areaTag !== Message.WellKnownAreaTags.Private;
                    });
                    async.eachSeries(
                        publicExportAreas,
                        (exportArea, nextExportArea) => {
                            const area = getMessageAreaByTag(exportArea.areaTag);
                            let conf;
                            if (area) {
                                conf = getMessageConferenceByTag(area.confTag);
                            }
                            if (!area || !conf) {
                                //  :TODO: remove from user properties - this area does not exist
                                this.client.log.warn(
                                    { areaTag: exportArea.areaTag },
                                    `Cannot ${this.packetFormatName} export area as it does not exist`
                                );
                                return nextExportArea(null);
                            }

                            if (!hasMessageConfAndAreaRead(this.client, area)) {
                                this.client.log.warn(
                                    { areaTag: area.areaTag },
                                    `Cannot ${this.packetFormatName} export area due to ACS`
                                );
                                return nextExportArea(null);
                            }

                            this.prepareAreaForExport(packetWriter, {
                                areaTag: exportArea.areaTag,
                                area,
                                conf,
                            });

                            const progress = {
                                conf,
                                area,
                                step: 'next_area',
                                status: `Gathering in ${conf.name} - ${area.name}...`,
                            };

                            progressHandler(progress, err => {
                                if (err) {
                                    return nextExportArea(err);
                                }

                                getEffectiveNewScanLastReadId(
                                    this.client.user,
                                    exportArea.areaTag,
                                    (err, lastReadId) => {
                                        const filter = {
                                            resultType: 'id',
                                            areaTag: exportArea.areaTag,
                                            newerThanMessageId: lastReadId,
                                            sort: 'messageId',
                                            order: 'ascending',
                                        };

                                        processMessagesWithFilter(
                                            filter,
                                            exportArea.areaTag,
                                            nextExportArea
                                        );
                                    }
                                );
                            });
                        },
                        err => {
                            return callback(err, userExportAreas);
                        }
                    );
                },
                (userExportAreas, callback) => {
                    //  Private messages to current user if the user has
                    //  elected to export private messages
                    const privateExportArea = userExportAreas.find(
                        exportArea =>
                            exportArea.areaTag === Message.WellKnownAreaTags.Private
                    );
                    if (!privateExportArea) {
                        return callback(null);
                    }

                    //  private mail is a real area (system_internal /
                    //  private_mail), so the hook gets the same shape it does
                    //  for public areas
                    const privateArea = getMessageAreaByTag(
                        Message.WellKnownAreaTags.Private
                    );
                    this.prepareAreaForExport(packetWriter, {
                        areaTag: Message.WellKnownAreaTags.Private,
                        area: privateArea,
                        conf:
                            privateArea && getMessageConferenceByTag(privateArea.confTag),
                    });

                    //  the same pointer reading private mail online keeps
                    const privateAreaTag = Message.WellKnownAreaTags.Private;
                    getEffectiveNewScanLastReadId(
                        this.client.user,
                        privateAreaTag,
                        (err, lastReadId) => {
                            const filter = {
                                resultType: 'id',
                                privateTagUserId: this.client.user.userId,
                                newerThanMessageId: lastReadId,
                                sort: 'messageId',
                                order: 'ascending',
                            };
                            return processMessagesWithFilter(
                                filter,
                                privateAreaTag,
                                callback
                            );
                        }
                    );
                },
                callback => {
                    return this._finishPacket(packetWriter, callback);
                },
                (packetInfo, callback) => {
                    if (0 === totalExported) {
                        return callback(Errors.NothingToDo('No messages exported'));
                    }

                    return this._deliverPacket(packetInfo, sysTempDownloadDir, callback);
                },
                (fileEntry, callback) => {
                    //  not now: only once the caller has the packet
                    this._advancePointersOnDownload(fileEntry.fileId, highestIds);
                    return callback(null);
                },
            ],
            err => {
                this.client.startIdleMonitor(); //  re-enable
                this.client.removeListener('key press', keyPressHandler);

                if (!err) {
                    finalStatus(
                        `A ${this.packetFormatName} packet has been placed in your download queue`
                    );
                } else if (err.code === Errors.NothingToDo().code) {
                    finalStatus('No messages to export with current criteria');
                    err = null;
                } else if (err.code === Errors.UserInterrupt().code) {
                    //  ESC during the export: asked for, not a failure
                    finalStatus('Export canceled');
                    err = null;
                }

                return cb(err);
            }
        );
    }
};
