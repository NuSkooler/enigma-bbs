/* jslint node: true */
'use strict';

//  ENiGMA½
const MenuModule = require('./menu_module.js').MenuModule;
const ViewController = require('./view_controller.js').ViewController;
const messageArea = require('./message_area.js');
const MessageAreaConfTempSwitcher =
    require('./mod_mixins.js').MessageAreaConfTempSwitcher;
const Errors = require('./enig_error.js').Errors;
const Message = require('./message.js');
const UserProps = require('./user_property.js');

//  deps
const async = require('async');
const _ = require('lodash');
const moment = require('moment');

/*
    Available itemFormat/focusItemFormat members for |msgList|

    msgNum          : Message number
    to              : To username/handle
    from            : From username/handle
    subj            : Subject
    ts              : Message mod timestamp (format with config.dateTimeFormat)
    newIndicator    : New mark/indicator (config.newIndicator)
*/
exports.moduleInfo = {
    name: 'Message List',
    desc: 'Module for listing/browsing available messages',
    author: 'NuSkooler',
};

const FormIds = {
    allViews: 0,
    delPrompt: 1,
};

const MciViewIds = {
    allViews: {
        msgList: 1, //  VM1 - see above
        delPromptXy: 2, //  %XY2, e.g: delete confirmation
        customRangeStart: 10, //  Everything |msgList| has plus { msgNumSelected, msgNumTotal }
    },

    delPrompt: {
        prompt: 1,
    },
};

exports.getModule = class MessageListModule extends (
    MessageAreaConfTempSwitcher(MenuModule)
) {
    constructor(options) {
        super(options);

        //  :TODO: consider this pattern in base MenuModule - clean up code all over
        this.config = Object.assign(
            {},
            _.get(options, 'menuConfig.config'),
            options.extraArgs
        );

        this.lastMessageReachedExit = _.get(
            options,
            'lastMenuResult.lastMessageReached',
            false
        );

        this.menuMethods = {
            selectMessage: (formData, extraArgs, cb) => {
                if (MciViewIds.allViews.msgList === formData.submitId) {
                    //  'messageIndex' or older deprecated 'message' member
                    this.initialFocusIndex = _.get(
                        formData,
                        'value.messageIndex',
                        formData.value.message
                    );

                    const modOpts = {
                        extraArgs: {
                            messageAreaTag: this.getSelectedAreaTag(
                                this.initialFocusIndex
                            ),
                            messageList: this.config.messageList,
                            messageIndex: this.initialFocusIndex,
                            lastMessageNextExit: true,
                        },
                    };

                    if (_.isBoolean(this.config.noUpdateLastReadId)) {
                        modOpts.extraArgs.noUpdateLastReadId =
                            this.config.noUpdateLastReadId;
                    }

                    //
                    //  Provide a serializer so we don't dump *huge* bits of information to the log
                    //  due to the size of |messageList|. See https://github.com/trentm/node-bunyan/issues/189
                    //
                    const self = this;
                    modOpts.extraArgs.toJSON = function () {
                        const logMsgList =
                            self.config.messageList.length <= 4
                                ? self.config.messageList
                                : self.config.messageList
                                      .slice(0, 2)
                                      .concat(self.config.messageList.slice(-2));

                        return {
                            //  note |this| is scope of toJSON()!
                            messageAreaTag: this.messageAreaTag,
                            apprevMessageList: logMsgList,
                            messageCount: this.messageList.length,
                            messageIndex: this.messageIndex,
                        };
                    };

                    return this.gotoMenu(
                        this.config.menuViewPost || 'messageAreaViewPost',
                        modOpts,
                        cb
                    );
                } else {
                    return cb(null);
                }
            },
            fullExit: (formData, extraArgs, cb) => {
                this.menuResult = { fullExit: true };
                return this.prevMenu(cb);
            },
            deleteSelected: (formData, extraArgs, cb) => {
                if (MciViewIds.allViews.msgList != formData.submitId) {
                    return cb(null);
                }

                //  newer 'messageIndex' or older deprecated value
                const messageIndex = _.get(
                    formData,
                    'value.messageIndex',
                    formData.value.message
                );
                return this.promptDeleteMessageConfirm(messageIndex, cb);
            },
            deleteMessageYes: (formData, extraArgs, cb) => {
                const msgListView = this.viewControllers.allViews.getView(
                    MciViewIds.allViews.msgList
                );
                this.enableMessageListIndexUpdates(msgListView);
                if (this.selectedMessageForDelete) {
                    this.selectedMessageForDelete.deleteMessage(this.client.user, err => {
                        if (err) {
                            this.client.log.error(
                                `Failed to delete message: ${this.selectedMessageForDelete.messageUuid}`
                            );
                        } else {
                            this.client.log.info(
                                `User deleted message: ${this.selectedMessageForDelete.messageUuid}`
                            );
                            this.config.messageList.splice(
                                msgListView.focusedItemIndex,
                                1
                            );
                            this.updateMessageNumbersAfterDelete(
                                msgListView.focusedItemIndex
                            );
                            msgListView.setItems(this.config.messageList);
                        }
                        this.selectedMessageForDelete = null;
                        msgListView.redraw();
                        this.populateCustomLabelsForSelected(
                            msgListView.focusedItemIndex
                        );
                        return cb(null);
                    });
                } else {
                    return cb(null);
                }
            },
            deleteMessageNo: (formData, extraArgs, cb) => {
                const msgListView = this.viewControllers.allViews.getView(
                    MciViewIds.allViews.msgList
                );
                this.enableMessageListIndexUpdates(msgListView);
                return cb(null);
            },
            markAllRead: (formData, extraArgs, cb) => {
                if (this.config.noUpdateLastReadId) {
                    return cb(null);
                }

                return this.markAllMessagesAsRead(cb);
            },
        };
    }

    getSelectedAreaTag(listIndex) {
        return this.config.messageList[listIndex].areaTag || this.config.messageAreaTag;
    }

    enter() {
        if (this.lastMessageReachedExit) {
            return this.prevMenu();
        }

        super.enter();

        //
        //  Config can specify |messageAreaTag| else it comes from
        //  the user's current area. If |messageList| is supplied,
        //  each item is expected to contain |areaTag|, so we use that
        //  instead in those cases.
        //
        if (!Array.isArray(this.config.messageList)) {
            if (this.config.messageAreaTag) {
                this.tempMessageConfAndAreaSwitch(this.config.messageAreaTag);
            } else {
                this.config.messageAreaTag =
                    this.client.user.properties[UserProps.MessageAreaTag];
            }
        }
    }

    leave() {
        this.tempMessageConfAndAreaRestore();
        super.leave();
    }

    populateCustomLabelsForSelected(selectedIndex) {
        const formatObj = Object.assign(
            {
                msgNumSelected: selectedIndex + 1,
                msgNumTotal: this.config.messageList.length,
            },
            this.config.messageList[selectedIndex] //  plus, all the selected message props
        );
        return this.updateCustomViewTextsWithFilter(
            'allViews',
            MciViewIds.allViews.customRangeStart,
            formatObj
        );
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
            let configProvidedMessageList = false;

            async.series(
                [
                    function loadFromConfig(callback) {
                        const loadOpts = {
                            callingMenu: self,
                            mciMap: mciData.menu,
                        };

                        return vc.loadFromMenuConfig(loadOpts, callback);
                    },
                    function fetchMessagesInArea(callback) {
                        //
                        //  Config can supply messages else we'll need to populate the list now
                        //
                        if (_.isArray(self.config.messageList)) {
                            configProvidedMessageList = true;
                            return callback(
                                0 === self.config.messageList.length
                                    ? new Error('No messages in area')
                                    : null
                            );
                        }

                        messageArea.getMessageListForArea(
                            self.client,
                            self.config.messageAreaTag,
                            function msgs(err, msgList) {
                                if (!msgList || 0 === msgList.length) {
                                    return callback(new Error('No messages in area'));
                                }

                                self.config.messageList = msgList;
                                return callback(err);
                            }
                        );
                    },
                    function getLastReadMessageId(callback) {
                        //  messageList entries can contain |isNew| if they want to be considered new
                        if (configProvidedMessageList) {
                            self.lastReadId = 0;
                            return callback(null);
                        }

                        messageArea.getMessageAreaLastReadId(
                            self.client.user.userId,
                            self.config.messageAreaTag,
                            function lastRead(err, lastReadId) {
                                self.lastReadId = lastReadId || 0;
                                return callback(null); //  ignore any errors, e.g. missing value
                            }
                        );
                    },
                    function updateMessageListObjects(callback) {
                        const dateTimeFormat =
                            self.menuConfig.config.dateTimeFormat ||
                            self.client.currentTheme.helpers.getDateTimeFormat();
                        const newIndicator = self.menuConfig.config.newIndicator || '*';
                        const regIndicator = ' '.repeat(newIndicator.length); //  fill with space to avoid draw issues

                        let msgNum = 1;
                        self.config.messageList.forEach((listItem, index) => {
                            listItem.msgNum = msgNum++;
                            listItem.ts = moment(listItem.modTimestamp).format(
                                dateTimeFormat
                            );
                            const isNew = _.isBoolean(listItem.isNew)
                                ? listItem.isNew
                                : listItem.messageId > self.lastReadId;
                            listItem.newIndicator = isNew ? newIndicator : regIndicator;

                            if (
                                _.isUndefined(self.initialFocusIndex) &&
                                listItem.messageId > self.lastReadId
                            ) {
                                self.initialFocusIndex = index;
                            }

                            listItem.text = `${listItem.msgNum} - ${listItem.subject} from ${listItem.fromUserName}`; //  default text
                        });
                        return callback(null);
                    },
                    function populateAndDrawViews(callback) {
                        const msgListView = vc.getView(MciViewIds.allViews.msgList);
                        msgListView.setItems(self.config.messageList);
                        self.enableMessageListIndexUpdates(msgListView);

                        if (self.initialFocusIndex > 0) {
                            //  note: causes redraw()
                            msgListView.setFocusItemIndex(self.initialFocusIndex);
                        } else {
                            msgListView.redraw();
                        }

                        self.populateCustomLabelsForSelected(self.initialFocusIndex || 0);
                        return callback(null);
                    },
                ],
                err => {
                    if (err) {
                        self.client.log.error(
                            { error: err.message },
                            'Error loading message list'
                        );
                    }
                    return cb(err);
                }
            );
        });
    }

    getSaveState() {
        return { initialFocusIndex: this.initialFocusIndex };
    }

    restoreSavedState(savedState) {
        if (savedState) {
            this.initialFocusIndex = savedState.initialFocusIndex;
        }
    }

    getMenuResult() {
        return this.menuResult;
    }

    enableMessageListIndexUpdates(msgListView) {
        msgListView.on('index update', idx => this.populateCustomLabelsForSelected(idx));
    }

    markAllMessagesAsRead(cb) {
        if (!this.config.messageList || this.config.messageList.length === 0) {
            return cb(null); //  nothing to do.
        }

        //
        //  Generally we'll have a message list for a specific area,
        //  but this is not always the case. For a given area, we need
        //  to find the highest message ID in the list to set a
        //  last read pointer.
        //
        const areaHighestIds = {};
        this.config.messageList.forEach(msg => {
            const highestId = areaHighestIds[msg.areaTag];
            if (highestId) {
                if (msg.messageId > highestId) {
                    areaHighestIds[msg.areaTag] = msg.messageId;
                }
            } else {
                areaHighestIds[msg.areaTag] = msg.messageId;
            }
        });

        const regIndicator = ' '.repeat(
            (this.menuConfig.config.newIndicator || '*').length
        );
        async.forEachOf(
            areaHighestIds,
            (highestId, areaTag, nextArea) => {
                messageArea.updateMessageAreaLastReadId(
                    this.client.user.userId,
                    areaTag,
                    highestId,
                    err => {
                        if (err) {
                            this.client.log.warn(
                                { error: err.message },
                                'Failed marking area as read'
                            );
                        } else {
                            //  update newIndicator on messages
                            this.config.messageList.forEach(msg => {
                                if (areaTag === msg.areaTag) {
                                    msg.newIndicator = regIndicator;
                                }
                            });
                            const msgListView = this.viewControllers.allViews.getView(
                                MciViewIds.allViews.msgList
                            );
                            msgListView.setItems(this.config.messageList);
                            msgListView.redraw();
                            this.client.log.info(
                                { highestId, areaTag },
                                'User marked area as read'
                            );
                        }
                        return nextArea(null); //  always continue
                    }
                );
            },
            () => {
                return cb(null);
            }
        );
    }

    updateMessageNumbersAfterDelete(startIndex) {
        //  all index -= 1 from this point on.
        for (let i = startIndex; i < this.config.messageList.length; ++i) {
            const msgItem = this.config.messageList[i];
            msgItem.msgNum -= 1;
            msgItem.text = `${msgItem.msgNum} - ${msgItem.subject} from ${msgItem.fromUserName}`; //  default text
        }
    }

    promptDeleteMessageConfirm(messageIndex, cb) {
        const messageInfo = this.config.messageList[messageIndex];
        if (!_.isObject(messageInfo)) {
            return cb(Errors.Invalid(`Invalid message index: ${messageIndex}`));
        }

        //  :TODO: create static userHasDeleteRights() that takes id || uuid that doesn't require full msg load
        this.selectedMessageForDelete = new Message();
        this.selectedMessageForDelete.load({ uuid: messageInfo.messageUuid }, err => {
            if (err) {
                this.selectedMessageForDelete = null;
                return cb(err);
            }

            if (!this.selectedMessageForDelete.userHasDeleteRights(this.client.user)) {
                this.selectedMessageForDelete = null;
                return cb(
                    Errors.AccessDenied(
                        'User does not have rights to delete this message'
                    )
                );
            }

            //  user has rights to delete -- prompt/confirm then proceed
            return this.promptConfirmDelete(cb);
        });
    }

    promptConfirmDelete(cb) {
        const promptXyView = this.viewControllers.allViews.getView(
            MciViewIds.allViews.delPromptXy
        );
        if (!promptXyView) {
            return cb(
                Errors.MissingMci(
                    `Missing prompt XY${MciViewIds.allViews.delPromptXy} MCI`
                )
            );
        }

        const promptOpts = {
            clearAtSubmit: true,
        };
        if (promptXyView.dimens.width) {
            promptOpts.clearWidth = promptXyView.dimens.width;
        }

        return this.promptForInput(
            {
                formName: 'delPrompt',
                formId: FormIds.delPrompt,
                promptName:
                    this.config.deleteMessageFromListPrompt ||
                    'deleteMessageFromListPrompt',
                prevFormName: 'allViews',
                position: promptXyView.position,
            },
            promptOpts,
            err => {
                return cb(err);
            }
        );
    }
};
