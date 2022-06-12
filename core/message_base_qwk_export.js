//  ENiGMA½
const { MenuModule } = require('./menu_module');
const Message = require('./message');
const { Errors } = require('./enig_error');
const {
    getMessageAreaByTag,
    getMessageConferenceByTag,
    hasMessageConfAndAreaRead,
    getAllAvailableMessageAreaTags,
} = require('./message_area');
const FileArea = require('./file_base_area');
const { QWKPacketWriter } = require('./qwk_mail_packet');
const { renderSubstr } = require('./string_util');
const Config = require('./config').get;
const FileEntry = require('./file_entry');
const DownloadQueue = require('./download_queue');
const { getISOTimestampString } = require('./database');

//  deps
const async = require('async');
const _ = require('lodash');
const fse = require('fs-extra');
const temptmp = require('temptmp');
const paths = require('path');
const { v4: UUIDv4 } = require('uuid');
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

const UserProperties = {
    ExportOptions: 'qwk_export_options',
    ExportAreas: 'qwk_export_msg_areas',
};

exports.moduleInfo = {
    name: 'QWK Export',
    desc: 'Exports a QWK Packet for download',
    author: 'NuSkooler',
};

exports.getModule = class MessageBaseQWKExport extends MenuModule {
    constructor(options) {
        super(options);

        this.config = Object.assign(
            {},
            _.get(options, 'menuConfig.config'),
            options.extraArgs
        );

        this.config.progBarChar = renderSubstr(this.config.progBarChar || '▒', 0, 1);
        this.config.bbsID =
            this.config.bbsID || _.get(Config(), 'messageNetworks.qwk.bbsID', 'ENIGMA');

        this.tempName = `${UUIDv4().substr(-8).toUpperCase()}.QWK`;
        this.sysTempDownloadArea = FileArea.getFileAreaByTag(
            FileArea.WellKnownAreaTags.TempDownloads
        );
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
                        this.temptmp = temptmp.createTrackedSession('qwkuserexp');
                        this.temptmp.mkdir(
                            { prefix: 'enigqwkwriter-' },
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
                                    'qwkExportNoResults'
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

    _getUserQWKExportOptions() {
        let qwkOptions = this.client.user.getProperty(UserProperties.ExportOptions);
        try {
            qwkOptions = JSON.parse(qwkOptions);
        } catch (e) {
            qwkOptions = {
                enableQWKE: true,
                enableHeadersExtension: true,
                enableAtKludges: true,
                archiveFormat: 'application/zip',
            };
        }
        return qwkOptions;
    }

    _getUserQWKExportAreas() {
        let qwkExportAreas = this.client.user.getProperty(UserProperties.ExportAreas);
        try {
            qwkExportAreas = JSON.parse(qwkExportAreas).map(exportArea => {
                if (exportArea.newerThanTimestamp) {
                    exportArea.newerThanTimestamp = moment(exportArea.newerThanTimestamp);
                }
                return exportArea;
            });
        } catch (e) {
            //  default to all public and private without 'since'
            qwkExportAreas = getAllAvailableMessageAreaTags(this.client).map(areaTag => {
                return { areaTag };
            });

            //  Include user's private area
            qwkExportAreas.push({
                areaTag: Message.WellKnownAreaTags.Private,
            });
        }

        return qwkExportAreas;
    }

    _performExport(sysTempDownloadDir, cb) {
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

        const packetWriter = new QWKPacketWriter(
            Object.assign(this._getUserQWKExportOptions(), {
                user: this.client.user,
                bbsID: this.config.bbsID,
            })
        );

        packetWriter.on('warning', warning => {
            this.client.log.warn({ warning }, 'QWK packet writer warning');
        });

        async.waterfall(
            [
                callback => {
                    //  don't count idle monitor while processing
                    this.client.stopIdleMonitor();

                    //  let user cancel
                    this.client.on('key press', keyPressHandler);

                    packetWriter.once('ready', () => {
                        return callback(null);
                    });

                    packetWriter.once('error', err => {
                        this.client.log.error(
                            { error: err.message },
                            'QWK packet writer error'
                        );
                        cancel = true;
                    });

                    packetWriter.init();
                },
                callback => {
                    //  For each public area -> for each message
                    const userExportAreas = this._getUserQWKExportAreas();

                    const publicExportAreas = userExportAreas.filter(exportArea => {
                        return exportArea.areaTag !== Message.WellKnownAreaTags.Private;
                    });
                    async.eachSeries(
                        publicExportAreas,
                        (exportArea, nextExportArea) => {
                            const area = getMessageAreaByTag(exportArea.areaTag);
                            const conf = getMessageConferenceByTag(area.confTag);
                            if (!area || !conf) {
                                //  :TODO: remove from user properties - this area does not exist
                                this.client.log.warn(
                                    { areaTag: exportArea.areaTag },
                                    'Cannot QWK export area as it does not exist'
                                );
                                return nextExportArea(null);
                            }

                            if (!hasMessageConfAndAreaRead(this.client, area)) {
                                this.client.log.warn(
                                    { areaTag: area.areaTag },
                                    'Cannot QWK export area due to ACS'
                                );
                                return nextExportArea(null);
                            }

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

                    const filter = {
                        resultType: 'id',
                        privateTagUserId: this.client.user.userId,
                        newerThanTimestamp: privateExportArea.newerThanTimestamp,
                    };
                    return processMessagesWithFilter(filter, callback);
                },
                callback => {
                    let packetInfo;
                    packetWriter.once('packet', info => {
                        packetInfo = info;
                    });

                    packetWriter.once('finished', () => {
                        return callback(null, packetInfo);
                    });

                    packetWriter.finish(this.tempPacketDir);
                },
                (packetInfo, callback) => {
                    if (0 === totalExported) {
                        return callback(Errors.NothingToDo('No messages exported'));
                    }

                    const sysDownloadPath = paths.join(sysTempDownloadDir, this.tempName);
                    fse.move(packetInfo.path, sysDownloadPath, err => {
                        return callback(err, sysDownloadPath, packetInfo);
                    });
                },
                (sysDownloadPath, packetInfo, callback) => {
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

                    newEntry.desc = 'QWK Export';

                    newEntry.persist(err => {
                        if (!err) {
                            //  queue it!
                            DownloadQueue.get(this.client).addTemporaryDownload(newEntry);
                        }
                        return callback(err);
                    });
                },
                callback => {
                    //  update user's export area dates; they can always change/reset them again
                    const updatedUserExportAreas = this._getUserQWKExportAreas().map(
                        exportArea => {
                            return Object.assign(exportArea, {
                                newerThanTimestamp: getISOTimestampString(),
                            });
                        }
                    );

                    return this.client.user.persistProperty(
                        UserProperties.ExportAreas,
                        JSON.stringify(updatedUserExportAreas),
                        callback
                    );
                },
            ],
            err => {
                this.client.startIdleMonitor(); //  re-enable
                this.client.removeListener('key press', keyPressHandler);

                if (!err) {
                    updateStatus('A QWK packet has been placed in your download queue');
                } else if (err.code === Errors.NothingToDo().code) {
                    updateStatus('No messages to export with current criteria');
                    err = null;
                }

                return cb(err);
            }
        );
    }
};
