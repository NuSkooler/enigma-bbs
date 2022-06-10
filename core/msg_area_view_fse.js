/* jslint node: true */
'use strict';

//  ENiGMA½
const FullScreenEditorModule = require('./fse.js').FullScreenEditorModule;
const Message = require('./message.js');

//  deps
const _ = require('lodash');

exports.moduleInfo = {
    name: 'Message Area View',
    desc: 'Module for viewing an area message',
    author: 'NuSkooler',
};

exports.getModule = class AreaViewFSEModule extends FullScreenEditorModule {
    constructor(options) {
        super(options);

        this.editorType = 'area';
        this.editorMode = 'view';

        if (_.isObject(options.extraArgs)) {
            this.messageList = options.extraArgs.messageList;
            this.messageIndex = options.extraArgs.messageIndex;
            this.lastMessageNextExit = options.extraArgs.lastMessageNextExit;
        }

        this.messageList = this.messageList || [];
        this.messageIndex = this.messageIndex || 0;
        this.messageTotal = this.messageList.length;

        if (this.messageList.length > 0) {
            this.messageAreaTag = this.messageList[this.messageIndex].areaTag;
        }

        const self = this;

        //  assign *additional* menuMethods
        Object.assign(this.menuMethods, {
            nextMessage: (formData, extraArgs, cb) => {
                if (self.messageIndex + 1 < self.messageList.length) {
                    self.messageIndex++;

                    this.messageAreaTag = this.messageList[this.messageIndex].areaTag;
                    this.tempMessageConfAndAreaSwitch(this.messageAreaTag, false); //  false=don't record prev; we want what we entered the module with

                    return self.loadMessageByUuid(
                        self.messageList[self.messageIndex].messageUuid,
                        cb
                    );
                }

                //  auto-exit if no more to go?
                if (self.lastMessageNextExit) {
                    self.lastMessageReached = true;
                    return self.prevMenu(cb);
                }

                return cb(null);
            },

            prevMessage: (formData, extraArgs, cb) => {
                if (self.messageIndex > 0) {
                    self.messageIndex--;

                    this.messageAreaTag = this.messageList[this.messageIndex].areaTag;
                    this.tempMessageConfAndAreaSwitch(this.messageAreaTag, false); //  false=don't record prev; we want what we entered the module with

                    return self.loadMessageByUuid(
                        self.messageList[self.messageIndex].messageUuid,
                        cb
                    );
                }

                return cb(null);
            },

            movementKeyPressed: (formData, extraArgs, cb) => {
                const bodyView = self.viewControllers.body.getView(1); //  :TODO: use const here vs magic #

                //  :TODO: Create methods for up/down vs using keyPressXXXXX
                switch (formData.key.name) {
                    case 'down arrow':
                        bodyView.scrollDocumentUp();
                        break;
                    case 'up arrow':
                        bodyView.scrollDocumentDown();
                        break;
                    case 'page up':
                        bodyView.keyPressPageUp();
                        break;
                    case 'page down':
                        bodyView.keyPressPageDown();
                        break;
                }

                //  :TODO: need to stop down/page down if doing so would push the last
                //  visible page off the screen at all .... this should be handled by MLTEV though...

                return cb(null);
            },

            replyMessage: (formData, extraArgs, cb) => {
                if (_.isString(extraArgs.menu)) {
                    const modOpts = {
                        extraArgs: {
                            messageAreaTag: self.messageAreaTag,
                            replyToMessage: self.message,
                        },
                    };

                    return self.gotoMenu(extraArgs.menu, modOpts, cb);
                }

                self.client.log(extraArgs, 'Missing extraArgs.menu');
                return cb(null);
            },
        });
    }

    loadMessageByUuid(uuid, cb) {
        const msg = new Message();
        msg.load({ uuid: uuid, user: this.client.user }, () => {
            this.setMessage(msg);

            if (cb) {
                return cb(null);
            }
        });
    }

    finishedLoading() {
        this.loadMessageByUuid(this.messageList[this.messageIndex].messageUuid);
    }

    getSaveState() {
        return {
            messageList: this.messageList,
            messageIndex: this.messageIndex,
            messageTotal: this.messageList.length,
        };
    }

    restoreSavedState(savedState) {
        this.messageList = savedState.messageList;
        this.messageIndex = savedState.messageIndex;
        this.messageTotal = savedState.messageTotal;
    }

    getMenuResult() {
        return {
            messageIndex: this.messageIndex,
            lastMessageReached: this.lastMessageReached,
        };
    }
};
