/* jslint node: true */
'use strict';

//  ENiGMA½
const Log = require('./logger.js').log;
const { MenuModule } = require('./menu_module.js');
const { pipeToAnsi, stripMciColorCodes } = require('./color_codes.js');
const stringFormat = require('./string_format.js');
const StringUtil = require('./string_util.js');
const Config = require('./config.js').get;

//  deps
const _ = require('lodash');
const async = require('async');
const net = require('net');
const moment = require('moment');

exports.moduleInfo = {
    name: 'MRC Client',
    desc: 'Connects to an MRC chat server',
    author: 'RiPuk',
    packageName: 'codes.l33t.enigma.mrc.client',

    // Whilst this module was put together by me (RiPuk), it should be noted that a lot of the ideas (and even some code snippets) were
    // borrowed from the Synchronet implementation of MRC by echicken. So...thanks, your code was very helpful in putting this together.
    // Source at http://cvs.synchro.net/cgi-bin/viewcvs.cgi/xtrn/mrc/.
};

const FormIds = {
    mrcChat: 0,
};

const MciViewIds = {
    mrcChat: {
        chatLog: 1,
        inputArea: 2,
        roomName: 3,
        roomTopic: 4,
        mrcUsers: 5,
        mrcBbses: 6,

        customRangeStart: 20, //  20+ = customs
    },
};

// TODO: this is a bit shit, could maybe do it with an ansi instead
const helpText = `
|15General Chat|08:
|03/|11rooms |08& |03/|11join |03<room>      |08- |07List all or join a room
|03/|11pm |03<user> <message>       |08- |07Send a private message
----
|03/|11whoon                     |08- |07Who's on what BBS
|03/|11chatters                  |08- |07Who's in what room
|03/|11clear                     |08- |07Clear back buffer
|03/|11topic |03<message>           |08- |07Set the room topic
|03/|11bbses |08& |03/|11info <id>        |08- |07Info about BBS's connected
|03/|11meetups                   |08- |07Info about MRC MeetUps
---
|03/|11l33t |03<your message>       |08- |07l337 5p34k
|03/|11kewl |03<your message>       |08- |07BBS KeWL SPeaK
|03/|11rainbow |03<your message>    |08- |07Crazy rainbow text
`;

exports.getModule = class mrcModule extends MenuModule {
    constructor(options) {
        super(options);

        this.log = Log.child({ module: 'MRC' });
        this.config = Object.assign({}, _.get(options, 'menuConfig.config'), {
            extraArgs: options.extraArgs,
        });

        this.config.maxScrollbackLines = this.config.maxScrollbackLines || 500;

        this.state = {
            socket: '',
            alias: this.client.user.username,
            room: '',
            room_topic: '',
            nicks: [],
            lastSentMsg: {}, //  used for latency est.
        };

        this.customFormatObj = {
            roomName: '',
            roomTopic: '',
            roomUserCount: 0,
            userCount: 0,
            boardCount: 0,
            roomCount: 0,
            latencyMs: 0,
            activityLevel: 0,
            activityLevelIndicator: ' ',
        };

        this.menuMethods = {
            sendChatMessage: (formData, extraArgs, cb) => {
                const inputAreaView = this.viewControllers.mrcChat.getView(
                    MciViewIds.mrcChat.inputArea
                );
                const inputData = inputAreaView.getData();

                this.processOutgoingMessage(inputData);
                inputAreaView.clearText();

                return cb(null);
            },

            movementKeyPressed: (formData, extraArgs, cb) => {
                const bodyView = this.viewControllers.mrcChat.getView(
                    MciViewIds.mrcChat.chatLog
                );
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

                this.viewControllers.mrcChat.switchFocus(MciViewIds.mrcChat.inputArea);

                return cb(null);
            },

            quit: (formData, extraArgs, cb) => {
                return this.prevMenu(cb);
            },

            clearMessages: (formData, extraArgs, cb) => {
                this.clearMessages();
                return cb(null);
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
                    callback => {
                        return this.prepViewController(
                            'mrcChat',
                            FormIds.mrcChat,
                            mciData.menu,
                            callback
                        );
                    },
                    callback => {
                        return this.validateMCIByViewIds(
                            'mrcChat',
                            [MciViewIds.mrcChat.chatLog, MciViewIds.mrcChat.inputArea],
                            callback
                        );
                    },
                    callback => {
                        const connectOpts = {
                            port: _.get(
                                Config(),
                                'chatServers.mrc.multiplexerPort',
                                5000
                            ),
                            host: 'localhost',
                        };

                        // connect to multiplexer
                        this.state.socket = net.createConnection(connectOpts, () => {
                            this.client.once('end', () => {
                                this.quitServer();
                            });

                            // handshake with multiplexer
                            this.state.socket.write(`--DUDE-ITS--|${this.state.alias}\n`);

                            this.clientConnect();

                            // send register to central MRC and get stats every 60s
                            this.heartbeat = setInterval(() => {
                                this.sendHeartbeat();
                                this.sendServerMessage('STATS');
                            }, 60000);

                            //  override idle logout seconds if configured
                            const idleLogoutSeconds = parseInt(
                                this.config.idleLogoutSeconds
                            );
                            if (0 === idleLogoutSeconds) {
                                this.log.debug(
                                    'Temporary disable idle monitor due to config'
                                );
                                this.client.stopIdleMonitor();
                            } else if (
                                !isNaN(idleLogoutSeconds) &&
                                idleLogoutSeconds >= 60
                            ) {
                                this.log.debug(
                                    { idleLogoutSeconds },
                                    'Temporary override idle logout seconds due to config'
                                );
                                this.client.overrideIdleLogoutSeconds(idleLogoutSeconds);
                            }
                        });

                        // when we get data, process it
                        this.state.socket.on('data', data => {
                            data = data.toString();
                            this.processReceivedMessage(data);
                        });

                        this.state.socket.once('error', err => {
                            this.log.warn(
                                { error: err.message },
                                'MRC multiplexer socket error'
                            );
                            this.state.socket.destroy();
                            delete this.state.socket;

                            //  bail with error - fall back to prev menu
                            return callback(err);
                        });

                        return callback;
                    },
                ],
                err => {
                    return cb(err);
                }
            );
        });
    }

    leave() {
        this.quitServer();

        //  restore idle monitor to previous state
        this.log.debug('Restoring idle monitor to previous state');
        this.client.restoreIdleLogoutSeconds();
        this.client.startIdleMonitor();

        return super.leave();
    }

    quitServer() {
        clearInterval(this.heartbeat);

        if (this.state.socket) {
            this.sendServerMessage('LOGOFF');
            this.state.socket.destroy();
            delete this.state.socket;
        }
    }

    /**
     * Adds a message to the chat log on screen
     */
    addMessageToChatLog(message) {
        if (!Array.isArray(message)) {
            message = [message];
        }

        message.forEach(msg => {
            const chatLogView = this.viewControllers.mrcChat.getView(
                MciViewIds.mrcChat.chatLog
            );
            const messageLength = stripMciColorCodes(msg).length;
            const chatWidth = chatLogView.dimens.width;
            let padAmount = 0;
            let spaces = 2;

            if (messageLength > chatWidth) {
                padAmount = chatWidth - (messageLength % chatWidth) - spaces;
            } else {
                padAmount = chatWidth - messageLength - spaces;
            }

            if (padAmount < 0) padAmount = 0;

            const padding = ' |00' + ' '.repeat(padAmount);
            chatLogView.addText(pipeToAnsi(msg + padding));

            if (chatLogView.getLineCount() > this.config.maxScrollbackLines) {
                chatLogView.deleteLine(0);
            }
        });
    }

    /**
     * Processes data received from the MRC multiplexer
     */
    processReceivedMessage(blob) {
        blob.split('\n').forEach(message => {
            try {
                message = JSON.parse(message);
            } catch (e) {
                return;
            }

            if (message.from_user == 'SERVER') {
                const params = message.body.split(':');

                switch (params[0]) {
                    case 'BANNER':
                        this.addMessageToChatLog(params[1].replace(/^\s+/, ''));
                        break;

                    case 'ROOMTOPIC':
                        this.setText(MciViewIds.mrcChat.roomName, `#${params[1]}`);
                        this.setText(MciViewIds.mrcChat.roomTopic, params[2]);

                        this.customFormatObj.roomName = params[1];
                        this.customFormatObj.roomTopic = params[2];
                        this.updateCustomViews();

                        this.state.room = params[1];
                        break;

                    case 'USERLIST':
                        this.state.nicks = params[1].split(',');

                        this.customFormatObj.roomUserCount = this.state.nicks.length;
                        this.updateCustomViews();
                        break;

                    case 'STATS': {
                        const [boardCount, roomCount, userCount, activityLevel] =
                            params[1].split(' ').map(v => parseInt(v));

                        const activityLevelIndicator =
                            this.getActivityLevelIndicator(activityLevel);

                        Object.assign(this.customFormatObj, {
                            boardCount,
                            roomCount,
                            userCount,
                            activityLevel,
                            activityLevelIndicator,
                        });

                        this.setText(MciViewIds.mrcChat.mrcUsers, userCount);
                        this.setText(MciViewIds.mrcChat.mrcBbses, boardCount);

                        this.updateCustomViews();
                        break;
                    }

                    default:
                        this.addMessageToChatLog(message.body);
                        break;
                }
            } else {
                if (message.body === this.state.lastSentMsg.msg) {
                    this.customFormatObj.latencyMs = moment
                        .duration(moment().diff(this.state.lastSentMsg.time))
                        .asMilliseconds();
                    delete this.state.lastSentMsg.msg;
                }

                if (message.to_room == this.state.room) {
                    // if we're here then we want to show it to the user
                    const currentTime = moment().format(
                        this.client.currentTheme.helpers.getTimeFormat()
                    );
                    this.addMessageToChatLog(
                        '|08' + currentTime + '|00 ' + message.body + '|00'
                    );
                }
            }

            this.viewControllers.mrcChat.switchFocus(MciViewIds.mrcChat.inputArea);
        });
    }

    getActivityLevelIndicator(level) {
        let indicators = this.config.activityLevelIndicators;
        if (!Array.isArray(indicators) || indicators.length < level + 1) {
            indicators = [' ', '░', '▒', '▓'];
        }
        return indicators[level];
    }

    setText(mciId, text) {
        return this.setViewText('mrcChat', mciId, text);
    }

    updateCustomViews() {
        return this.updateCustomViewTextsWithFilter(
            'mrcChat',
            MciViewIds.mrcChat.customRangeStart,
            this.customFormatObj
        );
    }

    /**
     * Receives the message input from the user and does something with it based on what it is
     */
    processOutgoingMessage(message, to_user) {
        if (message.startsWith('/')) {
            this.processSlashCommand(message);
        } else {
            if (message == '') {
                // don't do anything if message is blank, just update stats
                this.sendServerMessage('STATS');
                return;
            }

            // else just format and send
            const textFormatObj = {
                fromUserName: this.state.alias,
                toUserName: to_user,
                message: message,
            };

            const messageFormat =
                this.config.messageFormat ||
                '|00|10<|02{fromUserName}|10>|00 |03{message}|00';

            const privateMessageFormat =
                this.config.outgoingPrivateMessageFormat ||
                '|00|10<|02{fromUserName}|10|14->|02{toUserName}>|00 |03{message}|00';

            let formattedMessage = '';
            if (to_user == undefined) {
                // normal message
                formattedMessage = stringFormat(messageFormat, textFormatObj);
            } else {
                // pm
                formattedMessage = stringFormat(privateMessageFormat, textFormatObj);
            }

            try {
                this.state.lastSentMsg = {
                    msg: formattedMessage,
                    time: moment(),
                };
                this.sendMessageToMultiplexer(
                    to_user || '',
                    '',
                    this.state.room,
                    formattedMessage
                );
            } catch (e) {
                this.client.log.warn({ error: e.message }, 'MRC error');
            }
        }
    }

    /**
     * Processes a message that begins with a slash
     */
    processSlashCommand(message) {
        const cmd = message.split(' ');
        cmd[0] = cmd[0].substr(1).toLowerCase();

        switch (cmd[0]) {
            case 'pm':
                const newmsg = cmd.slice(2).join(' ');
                this.processOutgoingMessage(newmsg, cmd[1]);
                break;

            case 'rainbow': {
                // this is brutal, but i love it
                const line = message
                    .replace(/^\/rainbow\s/, '')
                    .split(' ')
                    .reduce(function (a, c) {
                        const cc = Math.floor(Math.random() * 31 + 1)
                            .toString()
                            .padStart(2, '0');
                        a += `|${cc}${c}|00 `;
                        return a;
                    }, '')
                    .substr(0, 140)
                    .replace(/\\s\|\d*$/, '');

                this.processOutgoingMessage(line);
                break;
            }

            case 'l33t':
                this.processOutgoingMessage(
                    StringUtil.stylizeString(message.substr(6), 'l33t')
                );
                break;

            case 'kewl': {
                const text_modes = Array('f', 'v', 'V', 'i', 'M');
                const mode = text_modes[Math.floor(Math.random() * text_modes.length)];
                this.processOutgoingMessage(
                    StringUtil.stylizeString(message.substr(6), mode)
                );
                break;
            }

            case 'whoon':
                this.sendServerMessage('WHOON');
                break;

            case 'motd':
                this.sendServerMessage('MOTD');
                break;

            case 'meetups':
                this.sendServerMessage('MEETUPS');
                break;

            case 'bbses':
                this.sendServerMessage('CONNECTED');
                break;

            case 'topic':
                this.sendServerMessage(
                    `NEWTOPIC:${this.state.room}:${message.substr(7)}`
                );
                break;

            case 'info':
                this.sendServerMessage(`INFO ${cmd[1]}`);
                break;

            case 'join':
                this.joinRoom(cmd[1]);
                break;

            case 'chatters':
                this.sendServerMessage('CHATTERS');
                break;

            case 'rooms':
                this.sendServerMessage('LIST');
                break;

            case 'quit':
                return this.prevMenu();

            case 'clear':
                this.clearMessages();
                break;

            case '?':
                this.addMessageToChatLog(helpText.split(/\n/g));
                break;

            default:
                break;
        }

        // just do something to get the cursor back to the right place ¯\_(ツ)_/¯
        //  :TODO: fix me!
        this.sendServerMessage('STATS');
    }

    clearMessages() {
        const chatLogView = this.viewControllers.mrcChat.getView(
            MciViewIds.mrcChat.chatLog
        );
        chatLogView.setText('');
    }

    /**
     * Creates a json object, stringifies it and sends it to the MRC multiplexer
     */
    sendMessageToMultiplexer(to_user, to_site, to_room, body) {
        const message = {
            to_user,
            to_site,
            to_room,
            body,
            from_user: this.state.alias,
            from_room: this.state.room,
        };

        if (this.state.socket) {
            this.state.socket.write(JSON.stringify(message) + '\n');
        }
    }

    /**
     * Sends an MRC 'server' message
     */
    sendServerMessage(command, to_site) {
        Log.debug({ module: 'mrc', command: command }, 'Sending server command');
        this.sendMessageToMultiplexer('SERVER', to_site || '', this.state.room, command);
    }

    /**
     * Sends a heartbeat to the MRC server
     */
    sendHeartbeat() {
        this.sendServerMessage('IAMHERE');
    }

    /**
     * Joins a room, unsurprisingly
     */
    joinRoom(room) {
        // room names are displayed with a # but referred to without. confusing.
        room = room.replace(/^#/, '');
        this.state.room = room;
        this.sendServerMessage(`NEWROOM:${this.state.room}:${room}`);
        this.sendServerMessage('USERLIST');
    }

    /**
     * Things that happen when a local user connects to the MRC multiplexer
     */
    clientConnect() {
        this.sendServerMessage('MOTD');
        this.joinRoom('lobby');
        this.sendServerMessage('STATS');
        this.sendHeartbeat();
    }
};
