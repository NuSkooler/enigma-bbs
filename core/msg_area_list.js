/* jslint node: true */
'use strict';

//  ENiGMA½
const { MenuModule } = require('./menu_module.js');
const messageArea = require('./message_area.js');
const { Errors } = require('./enig_error.js');
const UserProps = require('./user_property.js');

//  deps
const async = require('async');
const _ = require('lodash');

exports.moduleInfo = {
    name: 'Message Area List',
    desc: 'Module for listing / choosing message areas',
    author: 'NuSkooler',
};

//    :TODO: Obv/2 others can show # of messages in area

const MciViewIds = {
    areaList: 1,
    areaDesc: 2, //  area desc updated @ index update
    customRangeStart: 10, //  updated @ index update
};

exports.getModule = class MessageAreaListModule extends MenuModule {
    constructor(options) {
        super(options);

        this.initList();

        this.menuMethods = {
            changeArea: (formData, extraArgs, cb) => {
                if (1 === formData.submitId) {
                    const area = this.messageAreas[formData.value.area];

                    messageArea.changeMessageArea(this.client, area.areaTag, err => {
                        if (err) {
                            this.client.term.pipeWrite(
                                `\n|00Cannot change area: ${err.message}\n`
                            );
                            return this.prevMenuOnTimeout(1000, cb);
                        }

                        if (area.hasArt) {
                            const menuOpts = {
                                extraArgs: {
                                    areaTag: area.areaTag,
                                },
                                menuFlags: ['popParent', 'noHistory'],
                            };

                            return this.gotoMenu(
                                this.menuConfig.config.changeAreaPreArtMenu ||
                                    'changeMessageAreaPreArt',
                                menuOpts,
                                cb
                            );
                        }

                        return this.prevMenu(cb);
                    });
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
                        return this.prepViewController('areaList', 0, mciData.menu, next);
                    },
                    next => {
                        const areaListView = this.viewControllers.areaList.getView(
                            MciViewIds.areaList
                        );
                        if (!areaListView) {
                            return cb(
                                Errors.MissingMci(
                                    `Missing area list MCI ${MciViewIds.areaList}`
                                )
                            );
                        }

                        areaListView.on('index update', idx => {
                            this.selectionIndexUpdate(idx);
                        });

                        areaListView.setItems(this.messageAreas);
                        areaListView.redraw();
                        this.selectionIndexUpdate(0);
                        return next(null);
                    },
                ],
                err => {
                    if (err) {
                        this.client.log.error(
                            { error: err.message },
                            'Failed loading message area list'
                        );
                    }
                    return cb(err);
                }
            );
        });
    }

    selectionIndexUpdate(idx) {
        const area = this.messageAreas[idx];
        if (!area) {
            return;
        }
        this.setViewText('areaList', MciViewIds.areaDesc, area.desc);
        this.updateCustomViewTextsWithFilter(
            'areaList',
            MciViewIds.customRangeStart,
            area
        );
    }

    initList() {
        let index = 1;
        this.messageAreas = messageArea
            .getSortedAvailMessageAreasByConfTag(
                this.client.user.properties[UserProps.MessageConfTag],
                { client: this.client }
            )
            .map(area => {
                return {
                    index: index++,
                    areaTag: area.areaTag,
                    name: area.area.name,
                    text: area.area.name, //  standard
                    desc: area.area.desc,
                    hasArt: _.isString(area.area.art),
                };
            });
    }
};
