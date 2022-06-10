/* jslint node: true */
'use strict';

//  ENiGMA½
const MenuModule = require('./menu_module.js').MenuModule;
const {
    getSortedAvailMessageConferences,
    getAvailableMessageAreasByConfTag,
    getSortedAvailMessageAreasByConfTag,
    hasMessageConfAndAreaRead,
    filterMessageListByReadACS,
} = require('./message_area.js');
const Errors = require('./enig_error.js').Errors;
const Message = require('./message.js');

//  deps
const _ = require('lodash');

exports.moduleInfo = {
    name: 'Message Base Search',
    desc: 'Module for quickly searching the message base',
    author: 'NuSkooler',
};

const MciViewIds = {
    search: {
        searchTerms: 1,
        search: 2,
        conf: 3,
        area: 4,
        to: 5,
        from: 6,
        advSearch: 7,
    },
};

exports.getModule = class MessageBaseSearch extends MenuModule {
    constructor(options) {
        super(options);

        this.menuMethods = {
            search: (formData, extraArgs, cb) => {
                return this.searchNow(formData, cb);
            },
        };
    }

    mciReady(mciData, cb) {
        super.mciReady(mciData, err => {
            if (err) {
                return cb(err);
            }

            this.prepViewController('search', 0, mciData.menu, (err, vc) => {
                if (err) {
                    return cb(err);
                }

                const confView = vc.getView(MciViewIds.search.conf);
                const areaView = vc.getView(MciViewIds.search.area);

                if (!confView || !areaView) {
                    return cb(Errors.DoesNotExist('Missing one or more required views'));
                }

                const availConfs = [{ text: '-ALL-', data: '' }].concat(
                    getSortedAvailMessageConferences(this.client).map(conf =>
                        Object.assign(conf, { text: conf.conf.name, data: conf.confTag })
                    ) || []
                );

                let availAreas = [{ text: '-ALL-', data: '' }]; //  note: will populate if conf changes from ALL

                confView.setItems(availConfs);
                areaView.setItems(availAreas);

                confView.setFocusItemIndex(0);
                areaView.setFocusItemIndex(0);

                confView.on('index update', idx => {
                    availAreas = [{ text: '-ALL-', data: '' }].concat(
                        getSortedAvailMessageAreasByConfTag(availConfs[idx].confTag, {
                            client: this.client,
                        }).map(area =>
                            Object.assign(area, {
                                text: area.area.name,
                                data: area.areaTag,
                            })
                        )
                    );
                    areaView.setItems(availAreas);
                    areaView.setFocusItemIndex(0);
                });

                vc.switchFocus(MciViewIds.search.searchTerms);
                return cb(null);
            });
        });
    }

    searchNow(formData, cb) {
        const isAdvanced = formData.submitId === MciViewIds.search.advSearch;
        const value = formData.value;

        const filter = {
            resultType: 'messageList',
            sort: 'modTimestamp',
            terms: value.searchTerms,
            //extraFields       : [ 'area_tag', 'message_uuid', 'reply_to_message_id', 'to_user_name', 'from_user_name', 'subject', 'modified_timestamp' ],
            limit: 2048, //  :TODO: best way to handle this? we should probably let the user know if some results are returned
        };

        const returnNoResults = () => {
            return this.gotoMenu(
                this.menuConfig.config.noResultsMenu || 'messageSearchNoResults',
                { menuFlags: ['popParent'] },
                cb
            );
        };

        if (isAdvanced) {
            filter.toUserName = value.toUserName;
            filter.fromUserName = value.fromUserName;

            if (value.confTag && !value.areaTag) {
                //  areaTag may be a string or array of strings
                //  getAvailableMessageAreasByConfTag() returns a obj - we only need tags
                filter.areaTag = _.map(
                    getAvailableMessageAreasByConfTag(value.confTag, {
                        client: this.client,
                    }),
                    (area, areaTag) => areaTag
                );
            } else if (value.areaTag) {
                if (hasMessageConfAndAreaRead(this.client, value.areaTag)) {
                    filter.areaTag = value.areaTag; //  specific conf + area
                } else {
                    return returnNoResults();
                }
            }
        }

        Message.findMessages(filter, (err, messageList) => {
            if (err) {
                return cb(err);
            }

            //  don't include results without ACS -- if the user searched by
            //  explicit conf/area tag, we should have already filtered (above)
            if (!value.confTag && !value.areaTag) {
                messageList = filterMessageListByReadACS(this.client, messageList);
            }

            if (0 === messageList.length) {
                return returnNoResults();
            }

            const menuOpts = {
                extraArgs: {
                    messageList,
                    noUpdateLastReadId: true,
                },
                menuFlags: ['popParent'],
            };

            return this.gotoMenu(
                this.menuConfig.config.messageListMenu || 'messageAreaMessageList',
                menuOpts,
                cb
            );
        });
    }
};
