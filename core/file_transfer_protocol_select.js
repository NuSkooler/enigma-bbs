/* jslint node: true */
'use strict';

//  enigma-bbs
const MenuModule = require('./menu_module.js').MenuModule;
const Config = require('./config.js').get;
const ViewController = require('./view_controller.js').ViewController;
const UploadTempDir = require('./upload_temp_dir.js');
const { ErrorCodes } = require('./enig_error.js');

//  deps
const async = require('async');
const _ = require('lodash');

exports.moduleInfo = {
    name: 'File transfer protocol selection',
    desc: 'Select protocol / method for file transfer',
    author: 'NuSkooler',
};

const MciViewIds = {
    protList: 1,
};

exports.getModule = class FileTransferProtocolSelectModule extends MenuModule {
    constructor(options) {
        super(options);

        this.config = this.menuConfig.config || {};

        if (options.extraArgs) {
            if (options.extraArgs.direction) {
                this.config.direction = options.extraArgs.direction;
            }
        }

        this.config.direction = this.config.direction || 'send';

        //  a menu entry may supply none
        this.extraArgs = options.extraArgs || {};

        if (_.has(options, 'lastMenuResult.sentFileIds')) {
            this.sentFileIds = options.lastMenuResult.sentFileIds;
        }

        if (_.has(options, 'lastMenuResult.recvFilePaths')) {
            this.recvFilePaths = options.lastMenuResult.recvFilePaths;
            if (this.recvFilePaths) {
                this.client.log.debug('Protocol select received recv file paths', {
                    count: this.recvFilePaths.length,
                    paths: this.recvFilePaths,
                });
            }
        }

        this.fallbackOnly = options.lastMenuResult ? true : false;

        this.loadAvailProtocols();

        this.menuMethods = {
            selectProtocol: (formData, extraArgs, cb) => {
                const protocol = this.protocols[formData.value.protocol];
                const finalExtraArgs = this.extraArgs || {};
                Object.assign(
                    finalExtraArgs,
                    { protocol: protocol.protocol, direction: this.config.direction },
                    extraArgs
                );

                const modOpts = {
                    extraArgs: finalExtraArgs,
                };

                //  the transfer takes it from here: see leave()
                this.handedOff = true;
                const done = err => {
                    if (err) {
                        this.handedOff = false;
                    }
                    return cb(err);
                };

                if ('send' === this.config.direction) {
                    return this.gotoMenu(
                        this.config.downloadFilesMenu || 'sendFilesToUser',
                        modOpts,
                        done
                    );
                } else {
                    return this.gotoMenu(
                        this.config.uploadFilesMenu || 'recvFilesFromUser',
                        modOpts,
                        done
                    );
                }
            },
        };
    }

    leave() {
        //
        //  Left without starting a transfer -- the caller backed out, here or
        //  after a failed transfer -- so a file base upload's receive
        //  directory will not be used. (Once the upload module has taken the
        //  directory over, or for anyone else's directory, this does nothing.)
        //
        //  a reload() is this menu coming straight back, not the caller leaving
        if (!this.handedOff && !this.reloading) {
            UploadTempDir.abandon(this.client, this.extraArgs.recvDirectory);
        }
        return super.leave();
    }

    getMenuResult() {
        if (this.sentFileIds) {
            return { sentFileIds: this.sentFileIds };
        }

        if (this.recvFilePaths) {
            return { recvFilePaths: this.recvFilePaths };
        }
    }

    initSequence() {
        if (this.sentFileIds || this.recvFilePaths) {
            //  We have results from a file transfer, handle them
            if (this.recvFilePaths && this.config.direction === 'recv') {
                //  If the caller requested a direct return (e.g. FSE loading a file
                //  into the message body), hand results back via prevMenu() so the
                //  standard menu-stack round-trip delivers lastMenuResult.recvFilePaths
                //  to the originating module.  Otherwise route to the file-base upload
                //  pipeline as usual.
                if (this.extraArgs && this.extraArgs.returnToCaller) {
                    return this.prevMenu();
                }

                //
                //  The upload module takes the receive directory over: see
                //  leave(). Marked here, rather than relying on the menu stack
                //  building the upload module before it leaves this one.
                //
                this.handedOff = true;
                return this.gotoMenu(
                    'fileBaseUploadFiles',
                    {
                        lastMenuResult: {
                            recvFilePaths: this.recvFilePaths,
                            tempRecvDirectory: this.extraArgs.recvDirectory,
                            areaInfo: this.extraArgs.uploadAreaInfo,
                            uploadType: this.extraArgs.uploadType,
                        },
                    },
                    err => {
                        if (!err) {
                            return;
                        }
                        //  still ours to abandon
                        this.handedOff = false;
                        //  as the menu stack does without a callback
                        if (ErrorCodes.AccessDenied !== err.code) {
                            return this.client.defaultHandlerMissingMod()(err);
                        }
                    }
                );
            }
            this.prevMenu();
        } else {
            // No results yet, show the protocol selection menu normally
            super.initSequence();
        }
    }

    mciReady(mciData, cb) {
        super.mciReady(mciData, err => {
            if (err) {
                return cb(err);
            }

            const self = this;
            const vc = (self.viewControllers.allViews = new ViewController({
                client: self.client,
            }));

            async.series(
                [
                    function loadFromConfig(callback) {
                        const loadOpts = {
                            callingMenu: self,
                            mciMap: mciData.menu,
                        };

                        return vc.loadFromMenuConfig(loadOpts, callback);
                    },
                    function validateMci(callback) {
                        return self.validateMCIByViewIds(
                            'allViews',
                            [MciViewIds.protList],
                            callback
                        );
                    },
                    function populateList(callback) {
                        const protListView = vc.getView(MciViewIds.protList);

                        protListView.setItems(self.protocols);
                        protListView.redraw();

                        return callback(null);
                    },
                ],
                err => {
                    return cb(err);
                }
            );
        });
    }

    loadAvailProtocols() {
        this.protocols = _.map(Config().fileTransferProtocols, (protInfo, protocol) => {
            return {
                text: protInfo.name, //  standard
                protocol: protocol,
                name: protInfo.name,
                hasBatch: _.has(protInfo, 'external.recvArgs'),
                hasNonBatch: _.has(protInfo, 'external.recvArgsNonBatch'),
                sort: protInfo.sort,
            };
        });

        //  Filter out batch vs non-batch only protocols
        if (this.extraArgs.recvFileName) {
            //  non-batch aka non-blind
            this.protocols = this.protocols.filter(prot => prot.hasNonBatch);
        } else {
            this.protocols = this.protocols.filter(prot => prot.hasBatch);
        }

        //  natural sort taking explicit orders into consideration
        this.protocols.sort((a, b) => {
            if (_.isNumber(a.sort) && _.isNumber(b.sort)) {
                return a.sort - b.sort;
            } else {
                return a.name.localeCompare(b.name, {
                    sensitivity: false,
                    numeric: true,
                });
            }
        });
    }
};
