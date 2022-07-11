/* jslint node: true */
'use strict';

//  ENiGMA½
const { MenuModule } = require('./menu_module.js');
const {
    getActiveConnectionList,
    getConnectionByNodeId,
} = require('./client_connections.js');
const UserInterruptQueue = require('./user_interrupt_queue.js');
const { getThemeArt } = require('./theme.js');
const { pipeToAnsi } = require('./color_codes.js');
const stringFormat = require('./string_format.js');
const { renderStringLength } = require('./string_util.js');
const Events = require('./events.js');

//  deps
const series = require('async/series');
const _ = require('lodash');
const async = require('async');
const moment = require('moment');

exports.moduleInfo = {
    name: 'Node Message',
    desc: 'Multi-node messaging',
    author: 'NuSkooler',
};

const FormIds = {
    sendMessage: 0,
};

const MciViewIds = {
    sendMessage: {
        nodeSelect: 1,
        message: 2,
        preview: 3,

        customRangeStart: 10,
    },
};

exports.getModule = class NodeMessageModule extends MenuModule {
    constructor(options) {
        super(options);
        this.config = Object.assign({}, _.get(options, 'menuConfig.config'), {
            extraArgs: options.extraArgs,
        });

        this.menuMethods = {
            sendMessage: (formData, extraArgs, cb) => {
                const nodeId = this.nodeList[formData.value.node].node; //  index from from -> node!
                const message = _.get(formData.value, 'message', '').trim();

                if (0 === renderStringLength(message)) {
                    return this.prevMenu(cb);
                }

                this.createInterruptItem(message, (err, interruptItem) => {
                    if (-1 === nodeId) {
                        //  ALL nodes
                        UserInterruptQueue.queue(interruptItem, { omit: this.client });
                    } else {
                        const conn = getConnectionByNodeId(nodeId);
                        if (conn) {
                            UserInterruptQueue.queue(interruptItem, { clients: conn });
                        }
                    }

                    Events.emit(Events.getSystemEvents().UserSendNodeMsg, {
                        user: this.client.user,
                        global: -1 === nodeId,
                    });

                    return this.prevMenu(cb);
                });
            },
        };
    }

    mciReady(mciData, cb) {
        super.mciReady(mciData, err => {
            if (err) {
                return cb(err);
            }

            series(
                [
                    callback => {
                        return this.prepViewController(
                            'sendMessage',
                            FormIds.sendMessage,
                            mciData.menu,
                            callback
                        );
                    },
                    callback => {
                        return this.validateMCIByViewIds(
                            'sendMessage',
                            [
                                MciViewIds.sendMessage.nodeSelect,
                                MciViewIds.sendMessage.message,
                            ],
                            callback
                        );
                    },
                    callback => {
                        const nodeSelectView = this.viewControllers.sendMessage.getView(
                            MciViewIds.sendMessage.nodeSelect
                        );
                        this.prepareNodeList();

                        nodeSelectView.on('index update', idx => {
                            this.nodeListSelectionIndexUpdate(idx);
                        });

                        nodeSelectView.setItems(this.nodeList);
                        nodeSelectView.redraw();
                        this.nodeListSelectionIndexUpdate(0);
                        return callback(null);
                    },
                    callback => {
                        const previewView = this.viewControllers.sendMessage.getView(
                            MciViewIds.sendMessage.preview
                        );
                        if (!previewView) {
                            return callback(null); //  preview is optional
                        }

                        const messageView = this.viewControllers.sendMessage.getView(
                            MciViewIds.sendMessage.message
                        );
                        let timerId;
                        messageView.on(
                            'key press',
                            () => {
                                clearTimeout(timerId);
                                const focused =
                                    this.viewControllers.sendMessage.getFocusedView();
                                if (focused === messageView) {
                                    previewView.setText(messageView.getData());
                                    focused.setFocus(true);
                                }
                            },
                            500
                        );
                    },
                ],
                err => {
                    return cb(err);
                }
            );
        });
    }

    createInterruptItem(message, cb) {
        const dateTimeFormat =
            this.config.dateTimeFormat ||
            this.client.currentTheme.helpers.getDateTimeFormat();

        const textFormatObj = {
            fromUserName: this.client.user.username,
            fromRealName: this.client.user.properties.real_name,
            fromNodeId: this.client.node,
            message: message,
            timestamp: moment().format(dateTimeFormat),
        };

        const messageFormat =
            this.config.messageFormat ||
            'Message from {fromUserName} on node {fromNodeId}:\r\n{message}';

        const item = {
            text: stringFormat(messageFormat, textFormatObj),
            pause: true,
        };

        const getArt = (name, callback) => {
            const spec = _.get(this.config, `art.${name}`);
            if (!spec) {
                return callback(null);
            }
            const getArtOpts = {
                name: spec,
                client: this.client,
                random: false,
            };
            getThemeArt(getArtOpts, (err, artInfo) => {
                //  ignore errors
                return callback(artInfo ? artInfo.data : null);
            });
        };

        async.waterfall(
            [
                callback => {
                    getArt('header', headerArt => {
                        return callback(null, headerArt);
                    });
                },
                (headerArt, callback) => {
                    getArt('footer', footerArt => {
                        return callback(null, headerArt, footerArt);
                    });
                },
                (headerArt, footerArt, callback) => {
                    if (headerArt || footerArt) {
                        item.contents = `${headerArt || ''}\r\n${pipeToAnsi(
                            item.text
                        )}\r\n${footerArt || ''}`;
                    }
                    return callback(null);
                },
            ],
            err => {
                return cb(err, item);
            }
        );
    }

    prepareNodeList() {
        //  standard node list with {text} field added for compliance
        this.nodeList = [
            {
                text: '-ALL-',
                //  dummy fields:
                node: -1,
                authenticated: false,
                userId: 0,
                action: 'N/A',
                userName: 'Everyone',
                realName: 'All Users',
                location: 'N/A',
                affils: 'N/A',
                timeOn: 'N/A',
            },
        ]
            .concat(
                getActiveConnectionList(true).map(node =>
                    Object.assign(node, {
                        text: -1 == node.node ? '-ALL-' : node.node.toString(),
                    })
                )
            )
            .filter(node => node.node !== this.client.node); //  remove our client's node
        this.nodeList.sort((a, b) => a.node - b.node); //  sort by node
    }

    nodeListSelectionIndexUpdate(idx) {
        const node = this.nodeList[idx];
        if (!node) {
            return;
        }
        this.updateCustomViewTextsWithFilter(
            'sendMessage',
            MciViewIds.sendMessage.customRangeStart,
            node
        );
    }
};
