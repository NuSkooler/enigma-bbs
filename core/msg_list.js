/* jslint node: true */
'use strict';

//	ENiGMA½
const MenuModule					= require('./menu_module.js').MenuModule;
const ViewController				= require('./view_controller.js').ViewController;
const messageArea					= require('./message_area.js');
const stringFormat					= require('./string_format.js');
const MessageAreaConfTempSwitcher	= require('./mod_mixins.js').MessageAreaConfTempSwitcher;

//	deps
const async				= require('async');
const _					= require('lodash');
const moment			= require('moment');

/*
	Available listFormat/focusListFormat members (VM1):

	msgNum			: Message number
	to				: To username/handle
	from			: From username/handle
	subj			: Subject
	ts				: Message mod timestamp (format with config.dateTimeFormat)
	newIndicator	: New mark/indicator (config.newIndicator)

	MCI codes:

	VM1			: Message list
	TL2			: Message info 1: { msgNumSelected, msgNumTotal }
*/

exports.moduleInfo = {
    name	: 'Message List',
    desc	: 'Module for listing/browsing available messages',
    author	: 'NuSkooler',
};

const MciViewIds = {
    msgList			: 1,	//	VM1
    msgInfo1		: 2,	//	TL2
};

exports.getModule = class MessageListModule extends MessageAreaConfTempSwitcher(MenuModule) {
    constructor(options) {
        super(options);

        //	:TODO: consider this pattern in base MenuModule - clean up code all over
        this.config	= Object.assign({}, _.get(options, 'menuConfig.config'), options.extraArgs);

        this.lastMessageReachedExit = _.get(options, 'lastMenuResult.lastMessageReached', false);

        this.menuMethods = {
            selectMessage : (formData, extraArgs, cb) => {
                if(MciViewIds.msgList === formData.submitId) {
                    this.initialFocusIndex = formData.value.message;

                    const modOpts = {
                        extraArgs 	: {
                            messageAreaTag		: this.getSelectedAreaTag(formData.value.message),// this.config.messageAreaTag,
                            messageList			: this.config.messageList,
                            messageIndex		: formData.value.message,
                            lastMessageNextExit	: true,
                        }
                    };

                    if(_.isBoolean(this.config.noUpdateLastReadId)) {
                        modOpts.extraArgs.noUpdateLastReadId = this.config.noUpdateLastReadId;
                    }

                    //
                    //	Provide a serializer so we don't dump *huge* bits of information to the log
                    //	due to the size of |messageList|. See https://github.com/trentm/node-bunyan/issues/189
                    //
                    const self = this;
                    modOpts.extraArgs.toJSON = function() {
                        const logMsgList = (self.config.messageList.length <= 4) ?
                            self.config.messageList :
                            self.config.messageList.slice(0, 2).concat(self.config.messageList.slice(-2));

                        return {
                            //	note |this| is scope of toJSON()!
                            messageAreaTag		: this.messageAreaTag,
                            apprevMessageList	: logMsgList,
                            messageCount		: this.messageList.length,
                            messageIndex		: this.messageIndex,
                        };
                    };

                    return this.gotoMenu(this.config.menuViewPost || 'messageAreaViewPost', modOpts, cb);
                } else {
                    return cb(null);
                }
            },

            fullExit : (formData, extraArgs, cb) => {
                this.menuResult = { fullExit : true };
                return this.prevMenu(cb);
            }
        };
    }

    getSelectedAreaTag(listIndex) {
        return this.config.messageList[listIndex].areaTag || this.config.messageAreaTag;
    }

    enter() {
        if(this.lastMessageReachedExit) {
            return this.prevMenu();
        }

        super.enter();

        //
        //	Config can specify |messageAreaTag| else it comes from
        //	the user's current area. If |messageList| is supplied,
        //	each item is expected to contain |areaTag|, so we use that
        //	instead in those cases.
        //
        if(!Array.isArray(this.config.messageList)) {
            if(this.config.messageAreaTag) {
                this.tempMessageConfAndAreaSwitch(this.config.messageAreaTag);
            } else {
                this.config.messageAreaTag = this.client.user.properties.message_area_tag;
            }
        }
    }

    leave() {
        this.tempMessageConfAndAreaRestore();
        super.leave();
    }

    mciReady(mciData, cb) {
        super.mciReady(mciData, err => {
            if(err) {
                return cb(err);
            }

            const self	= this;
            const vc	= self.viewControllers.allViews = new ViewController( { client : self.client } );
            let configProvidedMessageList = false;

            async.series(
                [
                    function loadFromConfig(callback) {
                        const loadOpts = {
                            callingMenu		: self,
                            mciMap			: mciData.menu
                        };

                        return vc.loadFromMenuConfig(loadOpts, callback);
                    },
                    function fetchMessagesInArea(callback) {
                        //
                        //	Config can supply messages else we'll need to populate the list now
                        //
                        if(_.isArray(self.config.messageList)) {
                            configProvidedMessageList = true;
                            return callback(0 === self.config.messageList.length ? new Error('No messages in area') : null);
                        }

                        messageArea.getMessageListForArea(self.client, self.config.messageAreaTag, function msgs(err, msgList) {
                            if(!msgList || 0 === msgList.length) {
                                return callback(new Error('No messages in area'));
                            }

                            self.config.messageList = msgList;
                            return callback(err);
                        });
                    },
                    function getLastReadMesageId(callback) {
                        //	messageList entries can contain |isNew| if they want to be considered new
                        if(configProvidedMessageList) {
                            self.lastReadId = 0;
                            return callback(null);
                        }

                        messageArea.getMessageAreaLastReadId(self.client.user.userId, self.config.messageAreaTag, function lastRead(err, lastReadId) {
                            self.lastReadId = lastReadId || 0;
                            return callback(null);	//	ignore any errors, e.g. missing value
                        });
                    },
                    function updateMessageListObjects(callback) {
                        const dateTimeFormat	= self.menuConfig.config.dateTimeFormat || self.client.currentTheme.helpers.getDateTimeFormat();
                        const newIndicator		= self.menuConfig.config.newIndicator || '*';
                        const regIndicator		= new Array(newIndicator.length + 1).join(' ');	//	fill with space to avoid draw issues

                        let msgNum = 1;
                        self.config.messageList.forEach( (listItem, index) => {
                            listItem.msgNum			= msgNum++;
                            listItem.ts				= moment(listItem.modTimestamp).format(dateTimeFormat);
                            const isNew				= _.isBoolean(listItem.isNew) ? listItem.isNew : listItem.messageId > self.lastReadId;
                            listItem.newIndicator	=  isNew ? newIndicator : regIndicator;

                            if(_.isUndefined(self.initialFocusIndex) && listItem.messageId > self.lastReadId) {
                                self.initialFocusIndex = index;
                            }

                            listItem.text			= `${listItem.msgNum} - ${listItem.subject} from ${listItem.fromUserName}`;	//	default text
                        });
                        return callback(null);
                    },
                    function populateList(callback) {
                        const msgListView			= vc.getView(MciViewIds.msgList);
                        //	:TODO: replace with standard custom info MCI - msgNumSelected, msgNumTotal, areaName, areaDesc, confName, confDesc, ...
                        const messageInfo1Format	= self.menuConfig.config.messageInfo1Format || '{msgNumSelected} / {msgNumTotal}';

                        msgListView.setItems(self.config.messageList);

                        msgListView.on('index update', idx => {
                            self.setViewText(
                                'allViews',
                                MciViewIds.msgInfo1,
                                stringFormat(messageInfo1Format, { msgNumSelected : (idx + 1), msgNumTotal : self.config.messageList.length } ));
                        });

                        if(self.initialFocusIndex > 0) {
                            //	note: causes redraw()
                            msgListView.setFocusItemIndex(self.initialFocusIndex);
                        } else {
                            msgListView.redraw();
                        }

                        return callback(null);
                    },
                    function drawOtherViews(callback) {
                        const messageInfo1Format = self.menuConfig.config.messageInfo1Format || '{msgNumSelected} / {msgNumTotal}';
                        self.setViewText(
                            'allViews',
                            MciViewIds.msgInfo1,
                            stringFormat(messageInfo1Format, { msgNumSelected : self.initialFocusIndex + 1, msgNumTotal : self.config.messageList.length } ));
                        return callback(null);
                    },
                ],
                err => {
                    if(err) {
                        self.client.log.error( { error : err.message }, 'Error loading message list');
                    }
                    return cb(err);
                }
            );
        });
    }

    getSaveState() {
        return { initialFocusIndex : this.initialFocusIndex };
    }

    restoreSavedState(savedState) {
        if(savedState) {
            this.initialFocusIndex = savedState.initialFocusIndex;
        }
    }

    getMenuResult() {
        return this.menuResult;
    }
};
