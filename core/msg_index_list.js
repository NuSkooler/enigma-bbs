/* jslint node: true */
'use strict';

//  ENiGMA½
const { MenuModule, MenuFlags } = require('./menu_module.js');
const messageArea = require('./message_area.js');
const { Errors } = require('./enig_error.js');
const { SystemInternalConfTags } = require('./message_const.js');
const Message = require('./message.js');

//  deps
const async = require('async');

exports.moduleInfo = {
    name: 'Message Index List',
    desc: 'Flat index of all message conferences/areas with new message counts',
    author: 'ENiGMA½ Community',
};

//
//  A "Mystic-like" message index: a single flat list of every accessible
//  conference/area together with the user's new + total message counts.
//  Selecting an entry switches to that conf/area and opens its message list.
//
//  Item format fields available to the list view (config.itemFormat):
//      {confTag} {confName} {areaTag} {name}/{text} {desc}
//      {newMessageCount} {totalMessageCount} {index}
//
const MciViewIds = {
    indexList: 1,
    selConfName: 2, //  selected conf name  (updated @ index update)
    selAreaName: 3, //  selected area name  (updated @ index update)
    selAreaDesc: 4, //  selected area desc  (updated @ index update)
    customRangeStart: 10, //  10+ = custom fields, updated @ index update
};

exports.getModule = class MessageIndexListModule extends MenuModule {
    constructor(options) {
        super(options);

        //  no history so ESC/quit returns to the calling menu cleanly
        this.setMergedFlag(MenuFlags.NoHistory);

        this.menuMethods = {
            selectArea: (formData, extraArgs, cb) => {
                if (1 !== formData.submitId) {
                    return cb(null);
                }

                const entry = this.indexEntries[formData.value.index];
                if (!entry) {
                    return cb(null);
                }

                //  Switch conference first (also sets a default area), then the
                //  specific area, mirroring the standard browse navigation.
                messageArea.changeMessageConference(
                    this.client,
                    entry.confTag,
                    () => {
                        messageArea.changeMessageArea(
                            this.client,
                            entry.areaTag,
                            err => {
                                if (err) {
                                    this.client.term.pipeWrite(
                                        `\n|00Cannot open area: ${err.message}\n`
                                    );
                                    return this.prevMenuOnTimeout(1000, cb);
                                }

                                return this.gotoMenu(
                                    this.menuConfig.config.messageListMenu ||
                                        'messageBaseMessageList',
                                    { menuFlags: [MenuFlags.NoHistory] },
                                    cb
                                );
                            }
                        );
                    }
                );
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
                    next => this.buildIndex(next),
                    next =>
                        this.prepViewController('indexList', 0, mciData.menu, next),
                    next => {
                        const listView = this.viewControllers.indexList.getView(
                            MciViewIds.indexList
                        );
                        if (!listView) {
                            return next(
                                Errors.MissingMci(
                                    `Missing index list MCI ${MciViewIds.indexList}`
                                )
                            );
                        }

                        listView.on('index update', idx =>
                            this.selectionIndexUpdate(idx)
                        );

                        listView.setItems(this.indexEntries);
                        listView.redraw();
                        this.selectionIndexUpdate(0);
                        return next(null);
                    },
                ],
                err => {
                    if (err) {
                        this.client.log.error(
                            { error: err.message },
                            'Failed loading message index list'
                        );
                    }
                    return cb(err);
                }
            );
        });
    }

    selectionIndexUpdate(idx) {
        const entry = this.indexEntries[idx];
        if (!entry) {
            return;
        }
        this.setViewText('indexList', MciViewIds.selConfName, entry.confName);
        this.setViewText('indexList', MciViewIds.selAreaName, entry.name);
        this.setViewText('indexList', MciViewIds.selAreaDesc, entry.desc);
        this.updateCustomViewTextsWithFilter(
            'indexList',
            MciViewIds.customRangeStart,
            entry
        );
    }

    buildIndex(cb) {
        //  Collect every (conf, area) the user may read, excluding the
        //  system-internal conference (private mail) and honoring read ACS.
        const confs = messageArea.getSortedAvailMessageConferences(this.client) || [];
        const pairs = [];
        confs.forEach(c => {
            if (SystemInternalConfTags.includes(c.confTag)) {
                return;
            }
            const areas =
                messageArea.getSortedAvailMessageAreasByConfTag(c.confTag, {
                    client: this.client,
                }) || [];
            areas.forEach(a => pairs.push({ conf: c, area: a }));
        });

        async.mapLimit(
            pairs,
            4,
            (pair, next) => {
                const areaTag = pair.area.areaTag;
                messageArea.getNewMessageCountInAreaForUser(
                    this.client.user,
                    areaTag,
                    {},
                    (err, newCount) => {
                        Message.findMessages(
                            {
                                areaTag,
                                newerThanMessageId: 0,
                                resultType: 'count',
                            },
                            (err2, totalCount) => {
                                return next(null, {
                                    confTag: pair.conf.confTag,
                                    confName: pair.conf.conf.name,
                                    areaTag: areaTag,
                                    name: pair.area.area.name,
                                    text: pair.area.area.name, //  standard {text}
                                    desc: pair.area.area.desc || '',
                                    newMessageCount: newCount || 0,
                                    totalMessageCount: totalCount || 0,
                                });
                            }
                        );
                    }
                );
            },
            (err, results) => {
                if (err) {
                    return cb(err);
                }
                //  async.mapLimit preserves input order; assign 1-based index now
                results.forEach((r, i) => {
                    r.index = i + 1;
                });
                this.indexEntries = results;
                return cb(null);
            }
        );
    }
};
