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
    getAllAvailableMessageAreaTags,
} = require('./message_area.js');
const FileArea = require('./file_base_area.js');
const { renderSubstr } = require('./string_util.js');
const FileEntry = require('./file_entry.js');
const DownloadQueue = require('./download_queue.js');
const { getISOTimestampString } = require('./database.js');
const { safeMoveFile } = require('./file_util.js');

//  deps
const async = require('async');
const _ = require('lodash');
const fse = require('fs-extra');
const temptmp = require('temptmp');
const paths = require('path');
const { randomUUID } = require('crypto');
const moment = require('moment');

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

    //  where this format keeps the caller's export settings
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
                        this.prepViewController(
                            'main',
                            FormIds.main,
                            mciData.menu,
                            err => {
                                return callback(err);
                            }
                        );
                    },
                    callback => {
                        const required = this.requiredViewIds();
                        if (!required.length) {
                            return callback(null);
                        }
                        return this.validateMCIByViewIds('main', required, callback);
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
                    this.temptmp.cleanup();

                    if (err) {
                        //  :TODO: doesn't do anything currently:
                        if ('NORESULTS' === err.reasonCode) {
                            return this.gotoMenu(
                                this.menuConfig.config.noResultsMenu ||
                                    this.noResultsMenuName()
                            );
                        }

                        return this.prevMenu();
                    }
                    return cb(err);
                }
            );
        });
    }

    finishedLoading() {
        this.prevMenu();
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

    _getUserExportAreas() {
        let exportAreas = this.client.user.getProperty(this.userProperties.ExportAreas);
        try {
            exportAreas = JSON.parse(exportAreas).map(exportArea => {
                if (exportArea.newerThanTimestamp) {
                    exportArea.newerThanTimestamp = moment(exportArea.newerThanTimestamp);
                }
                return exportArea;
            });
        } catch (e) {
            //  default to all public and private without 'since'
            exportAreas = getAllAvailableMessageAreaTags(this.client).map(areaTag => {
                return { areaTag };
            });

            //  Include user's private area
            exportAreas.push({
                areaTag: Message.WellKnownAreaTags.Private,
            });
        }

        return exportAreas;
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
    //  their session ends.
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
                return cb(err);
            });
        });
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

        const statusView = this.viewControllers.main.getView(MciViewIds.main.status);
        const updateStatus = status => {
            if (statusView) {
                statusView.setText(status);
            }
        };

        const progBarView = this.viewControllers.main.getView(
            MciViewIds.main.progressBar
        );
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
        const processMessagesWithFilter = (filter, cb) => {
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
                    //  For each public area -> for each message
                    const userExportAreas = this._getUserExportAreas();

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

                                const filter = {
                                    resultType: 'id',
                                    areaTag: exportArea.areaTag,
                                    newerThanTimestamp: exportArea.newerThanTimestamp,
                                };

                                processMessagesWithFilter(filter, err => {
                                    return nextExportArea(err);
                                });
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

                    const filter = {
                        resultType: 'id',
                        privateTagUserId: this.client.user.userId,
                        newerThanTimestamp: privateExportArea.newerThanTimestamp,
                    };
                    return processMessagesWithFilter(filter, callback);
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
                callback => {
                    //  update user's export area dates; they can always change/reset them again
                    const updatedUserExportAreas = this._getUserExportAreas().map(
                        exportArea => {
                            return Object.assign(exportArea, {
                                newerThanTimestamp: getISOTimestampString(),
                            });
                        }
                    );

                    return this.client.user.persistProperty(
                        this.userProperties.ExportAreas,
                        JSON.stringify(updatedUserExportAreas),
                        callback
                    );
                },
            ],
            err => {
                this.client.startIdleMonitor(); //  re-enable
                this.client.removeListener('key press', keyPressHandler);

                if (!err) {
                    updateStatus(
                        `A ${this.packetFormatName} packet has been placed in your download queue`
                    );
                } else if (err.code === Errors.NothingToDo().code) {
                    updateStatus('No messages to export with current criteria');
                    err = null;
                }

                return cb(err);
            }
        );
    }
};
