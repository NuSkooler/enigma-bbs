/* jslint node: true */
'use strict';

//  enigma-bbs
const MenuModule = require('./menu_module.js').MenuModule;
const Config = require('./config.js').get;
const ViewController = require('./view_controller.js').ViewController;

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

        this.extraArgs = options.extraArgs;

        if (_.has(options, 'lastMenuResult.sentFileIds')) {
            this.sentFileIds = options.lastMenuResult.sentFileIds;
        }

        if (_.has(options, 'lastMenuResult.recvFilePaths')) {
            this.recvFilePaths = options.lastMenuResult.recvFilePaths;
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

                if ('send' === this.config.direction) {
                    return this.gotoMenu(
                        this.config.downloadFilesMenu || 'sendFilesToUser',
                        modOpts,
                        cb
                    );
                } else {
                    return this.gotoMenu(
                        this.config.uploadFilesMenu || 'recvFilesFromUser',
                        modOpts,
                        cb
                    );
                }
            },
        };
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
            //  nothing to do here; move along (we're just falling through)
            this.prevMenu();
        } else {
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
