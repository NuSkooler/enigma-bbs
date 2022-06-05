/* jslint node: true */
'use strict';

//  ENiGMA½
const { MenuModule } = require('./menu_module.js');
const messageArea = require('./message_area.js');
const { Errors } = require('./enig_error.js');

//  deps
const async = require('async');
const _ = require('lodash');

exports.moduleInfo = {
    name: 'Message Conference List',
    desc: 'Module for listing / choosing message conferences',
    author: 'NuSkooler',
};

const MciViewIds = {
    confList: 1,
    confDesc: 2, //  description updated @ index update
    customRangeStart: 10, //  updated @ index update
};

exports.getModule = class MessageConfListModule extends MenuModule {
    constructor(options) {
        super(options);

        this.initList();

        this.menuMethods = {
            changeConference: (formData, extraArgs, cb) => {
                if (1 === formData.submitId) {
                    const conf = this.messageConfs[formData.value.conf];

                    messageArea.changeMessageConference(
                        this.client,
                        conf.confTag,
                        err => {
                            if (err) {
                                this.client.term.pipeWrite(
                                    `\n|00Cannot change conference: ${err.message}\n`
                                );
                                return this.prevMenuOnTimeout(1000, cb);
                            }

                            if (conf.hasArt) {
                                const menuOpts = {
                                    extraArgs: {
                                        confTag: conf.confTag,
                                    },
                                    menuFlags: ['popParent', 'noHistory'],
                                };

                                return this.gotoMenu(
                                    this.menuConfig.config.changeConfPreArtMenu ||
                                        'changeMessageConfPreArt',
                                    menuOpts,
                                    cb
                                );
                            }

                            return this.prevMenu(cb);
                        }
                    );
                } else {
                    return cb(null);
                }
            },
        };
    }

    mciReady(mciData, cb) {
        super.mciReady(mciData, err => {
            if (err) {
                return cb(err);
            }

            async.series(
                [
                    next => {
                        return this.prepViewController('confList', 0, mciData.menu, next);
                    },
                    next => {
                        const confListView = this.viewControllers.confList.getView(
                            MciViewIds.confList
                        );
                        if (!confListView) {
                            return next(
                                Errors.MissingMci(
                                    `Missing conf list MCI ${MciViewIds.confList}`
                                )
                            );
                        }

                        confListView.on('index update', idx => {
                            this.selectionIndexUpdate(idx);
                        });

                        confListView.setItems(this.messageConfs);
                        confListView.redraw();
                        this.selectionIndexUpdate(0);
                        return next(null);
                    },
                ],
                err => {
                    if (err) {
                        this.client.log.error(
                            { error: err.message },
                            'Failed loading message conference list'
                        );
                    }
                }
            );
        });
    }

    selectionIndexUpdate(idx) {
        const conf = this.messageConfs[idx];
        if (!conf) {
            return;
        }
        this.setViewText('confList', MciViewIds.confDesc, conf.desc);
        this.updateCustomViewTextsWithFilter(
            'confList',
            MciViewIds.customRangeStart,
            conf
        );
    }

    initList() {
        let index = 1;
        this.messageConfs = messageArea
            .getSortedAvailMessageConferences(this.client)
            .map(conf => {
                return {
                    index: index++,
                    confTag: conf.confTag,
                    name: conf.conf.name,
                    text: conf.conf.name,
                    desc: conf.conf.desc,
                    areaCount: Object.keys(conf.conf.areas || {}).length,
                    hasArt: _.isString(conf.conf.art),
                };
            });
    }
};
