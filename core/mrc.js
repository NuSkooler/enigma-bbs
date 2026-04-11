/* jslint node: true */
'use strict';

//  ENiGMA½
const Log = require('./logger.js').log;
const { MenuModule } = require('./menu_module.js');
const { pipeToAnsi } = require('./color_codes.js');
const stringFormat = require('./string_format.js');
const StringUtil = require('./string_util.js');
const Config = require('./config.js').get;
const { loadDatabaseForMod } = require('./database.js');

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

const CTCP_ROOM = 'ctcp_echo_channel';

// TODO: this is a bit shit, could maybe do it with an ansi instead
const helpText = `
|15General Chat|08:
|03/|11rooms |08& |03/|11join |03<room>      |08- |07List all or join a room
|03/|11pm |03<user> <message>       |08- |07Send a private message |08(/t /tell /msg)
----
|03/|11whoon                     |08- |07Who's on what BBS
|03/|11chatters                  |08- |07Who's in what room
|03/|11clear                     |08- |07Clear back buffer
|03/|11topic |03<message>           |08- |07Set the room topic
|03/|11bbses |08& |03/|11info <id>        |08- |07Info about BBS's connected
|03/|11meetups                   |08- |07Info about MRC MeetUps
|03/|11quote                     |08- |07Send raw command to server
|03/|11help                      |08- |07Server-side commands help
|03/|11quit                      |08- |07Quit MRC |08(/q)
---
|03/|11me |03<action>               |08- |07Perform an action
|03/|11b |03<message>               |08- |07Broadcast to all rooms
|03/|11r                         |08- |07Reply to last DM
---
|03/|11l33t |03<your message>       |08- |07l337 5p34k
|03/|11kewl |03<your message>       |08- |07BBS KeWL SPeaK
|03/|11rainbow |03<your message>    |08- |07Crazy rainbow text
---
|03/|11mentions                  |08- |07Review messages where you were mentioned
|03/|11twit |03<add|del|list|clear> |08- |07Manage your twit (ignore) list
|03/|11welcome                   |08- |07Show welcome and status summary
|03/|11set |03<option> <value>      |08- |07Personalise your MRC experience |08(/set help)
|03/|11ctcp |03<target> <command>   |08- |07Send a CTCP request |08(/ctcp help)
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
            inputHistory: [],
            historyIndex: -1,
            pendingInput: '',
            lastDmSender: null,
            lastDmSenderSite: null,
            userSiteMap: {}, // username.toUpperCase() → from_site for DM routing
            pendingPasswordCommand: null,
            tabBase: '',
            tabPrefix: null,
            tabMatches: [],
            tabIndex: -1,
            mentionsLog: [],
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

        this.userPrefs = this._defaultPrefs();

        this.menuMethods = {
            sendChatMessage: (formData, extraArgs, cb) => {
                const inputAreaView = this.viewControllers.mrcChat.getView(
                    MciViewIds.mrcChat.inputArea
                );
                const inputData = inputAreaView.getData();

                // If we're waiting for a masked password input, handle it now
                if (this.state.pendingPasswordCommand) {
                    const cmd = this.state.pendingPasswordCommand;
                    this.state.pendingPasswordCommand = null;
                    this._setInputPasswordMode(false);
                    if (inputData) {
                        this.sendServerMessage(`${cmd} ${inputData}`);
                    }
                    inputAreaView.clearText();
                    this.state.historyIndex = -1;
                    this.state.pendingInput = '';
                    return cb(null);
                }

                // Don't save password commands to history
                const isPasswordCmd =
                    inputData &&
                    /^\/(?:identify|register|roompass|update\s+password)\b/i.test(
                        inputData
                    );
                if (inputData && !isPasswordCmd) {
                    this.state.inputHistory.push(inputData);
                    if (this.state.inputHistory.length > 50) {
                        this.state.inputHistory.shift();
                    }
                }
                this.state.historyIndex = -1;
                this.state.pendingInput = '';

                this.processOutgoingMessage(inputData);
                inputAreaView.clearText();

                return cb(null);
            },

            movementKeyPressed: (formData, extraArgs, cb) => {
                const bodyView = this.viewControllers.mrcChat.getView(
                    MciViewIds.mrcChat.chatLog
                );
                const inputAreaView = this.viewControllers.mrcChat.getView(
                    MciViewIds.mrcChat.inputArea
                );

                switch (formData.key.name) {
                    case 'tab':
                        this.tabComplete();
                        break;
                    case 'page up':
                        bodyView.keyPressPageUp();
                        break;
                    case 'page down':
                        bodyView.keyPressPageDown();
                        break;
                    case 'up arrow': {
                        if (this.state.inputHistory.length === 0) break;
                        if (this.state.historyIndex === -1) {
                            this.state.pendingInput = inputAreaView.getData();
                            this.state.historyIndex = this.state.inputHistory.length - 1;
                        } else {
                            this.state.historyIndex = Math.max(
                                0,
                                this.state.historyIndex - 1
                            );
                        }
                        this.setViewText(
                            'mrcChat',
                            MciViewIds.mrcChat.inputArea,
                            this.state.inputHistory[this.state.historyIndex]
                        );
                        break;
                    }
                    case 'down arrow': {
                        if (this.state.historyIndex === -1) break;
                        this.state.historyIndex++;
                        if (this.state.historyIndex >= this.state.inputHistory.length) {
                            this.state.historyIndex = -1;
                            this.setViewText(
                                'mrcChat',
                                MciViewIds.mrcChat.inputArea,
                                this.state.pendingInput
                            );
                        } else {
                            this.setViewText(
                                'mrcChat',
                                MciViewIds.mrcChat.inputArea,
                                this.state.inputHistory[this.state.historyIndex]
                            );
                        }
                        break;
                    }
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
                        // Load mod database and user prefs asynchronously
                        loadDatabaseForMod(exports.moduleInfo, (err, db) => {
                            if (err) {
                                this.log.warn(
                                    { error: err.message },
                                    'Failed to open MRC mod database; using defaults'
                                );
                                return callback(null);
                            }
                            this._db = db;
                            this._loadUserPrefsFromDb(callback);
                        });
                    },
                    callback => {
                        // Hook input view onKeyPress to enable inline password masking.
                        // When the user types the trailing space that completes a password
                        // command prefix (e.g. "/identify "), intercept it, clear the field,
                        // and switch to masked input — subsequent chars show as *.
                        const inputView = this.viewControllers.mrcChat.getView(
                            MciViewIds.mrcChat.inputArea
                        );
                        if (inputView) {
                            // Apply saved message colour to the input bar
                            inputView.styleSGR2 = pipeToAnsi(
                                this.userPrefs.messageColor || '|03'
                            );

                            const origOnKeyPress = inputView.onKeyPress.bind(inputView);
                            inputView.onKeyPress = (ch, key) => {
                                // Delete key — show mentions
                                if (key && key.name === 'delete') {
                                    this._showMentions();
                                    this.viewControllers.mrcChat.switchFocus(
                                        MciViewIds.mrcChat.inputArea
                                    );
                                    return; // consume — don't pass to view
                                }

                                // Colour cycling: left/right arrow keys cycle message text colour
                                if (
                                    key &&
                                    (key.name === 'left arrow' ||
                                        key.name === 'right arrow')
                                ) {
                                    const colours = [
                                        '|01',
                                        '|02',
                                        '|03',
                                        '|04',
                                        '|05',
                                        '|06',
                                        '|07',
                                        '|08',
                                        '|09',
                                        '|10',
                                        '|11',
                                        '|12',
                                        '|13',
                                        '|14',
                                        '|15',
                                    ];
                                    const current = this.userPrefs.messageColor || '|03';
                                    let idx = colours.indexOf(current);
                                    if (idx === -1) idx = 2;
                                    idx =
                                        key.name === 'left arrow'
                                            ? (idx - 1 + colours.length) % colours.length
                                            : (idx + 1) % colours.length;
                                    this.userPrefs.messageColor = colours[idx];
                                    this._saveUserPrefs();
                                    inputView.styleSGR2 = pipeToAnsi(colours[idx]);
                                    if (
                                        inputView.getData() &&
                                        typeof inputView.setFocus === 'function'
                                    ) {
                                        inputView.setFocus(true);
                                    }
                                    return; // consume — don't pass to view
                                }

                                if (!this.state.pendingPasswordCommand && ch) {
                                    const current = inputView.getData() || '';
                                    const withChar = current + ch;
                                    const triggers = [
                                        ['/identify ', 'IDENTIFY'],
                                        ['/register ', 'REGISTER'],
                                        ['/roompass ', 'ROOMPASS'],
                                        ['/update password ', 'UPDATE password'],
                                    ];
                                    const hit = triggers.find(
                                        ([p]) => withChar.toLowerCase() === p
                                    );
                                    if (hit) {
                                        this.state.pendingPasswordCommand = hit[1];
                                        inputView.clearText(); // clear before masking
                                        this._setInputPasswordMode(true);
                                        inputView.setFocus(true); // reposition cursor to start
                                        return; // consume the space; don't pass to view
                                    }
                                }
                                origOnKeyPress(ch, key);
                            };
                        }
                        return callback(null);
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
                                this.sendServerMessage('USERLIST');
                            }, 60000);

                            //  MRC is a chat module - disable idle timeout by default
                            //  so users are not kicked mid-conversation.
                            //  Sysops can set idleLogoutSeconds in menu config to
                            //  enforce a specific timeout (>= 60s) if desired.
                            const idleLogoutSeconds = parseInt(
                                this.config.idleLogoutSeconds
                            );
                            if (!isNaN(idleLogoutSeconds) && idleLogoutSeconds >= 60) {
                                this.log.debug(
                                    { idleLogoutSeconds },
                                    'Temporary override idle logout seconds due to config'
                                );
                                this.client.overrideIdleLogoutSeconds(idleLogoutSeconds);
                            } else {
                                this.log.debug(
                                    'Disabling idle monitor while in MRC chat'
                                );
                                this.client.stopIdleMonitor();
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
            this.state.socket.end();
            delete this.state.socket;
        }
    }

    /**
     * Adds a message to the chat log on screen.
     * Accepts a string, an array of strings, or strings containing embedded
     * newlines — all are normalised to individual lines before display.
     */
    addMessageToChatLog(message) {
        if (!Array.isArray(message)) {
            message = [message];
        }

        // Flatten embedded newlines so each visual line is added separately.
        // This handles multi-line server messages (MOTD, BANNER, etc.) that
        // arrive as a single body string with \n-delimited content.
        const lines = [];
        message.forEach(msg => {
            (msg || '').split(/\r\n|\r|\n/).forEach(line => lines.push(line));
        });

        const chatLogView = this.viewControllers.mrcChat.getView(
            MciViewIds.mrcChat.chatLog
        );
        lines.forEach(line => {
            const converted =
                this.userPrefs && this.userPrefs.showSmilies
                    ? line
                          .replace(/:D/g, '\x02')
                          .replace(/=\)/g, '\x02')
                          .replace(/:\)/g, '\x01')
                    : line;
            chatLogView.addText(pipeToAnsi(converted), { scrollMode: 'end' });

            if (chatLogView.getLineCount() > this.config.maxScrollbackLines) {
                chatLogView.deleteLine(0);
            }
        });
    }

    /**
     * Processes data received from the MRC multiplexer
     */
    processReceivedMessage(blob) {
        blob.split('\n')
            .filter(Boolean)
            .forEach(message => {
                try {
                    message = JSON.parse(message);
                } catch (e) {
                    this.log.debug(
                        { error: e.message },
                        'Failed parsing received message JSON'
                    );
                    return;
                }

                if (message.from_user == 'SERVER') {
                    const params = message.body.split(':');

                    switch (params[0]) {
                        case 'BANNER':
                            this.addMessageToChatLog(
                                params.slice(1).join(':').replace(/^\s+/, '')
                            );
                            break;

                        case 'ROOMTOPIC': {
                            const roomTopic = params.slice(2).join(':');
                            this.setText(MciViewIds.mrcChat.roomName, `#${params[1]}`);
                            this.setText(MciViewIds.mrcChat.roomTopic, roomTopic);

                            this.customFormatObj.roomName = params[1];
                            this.customFormatObj.roomTopic = roomTopic;
                            this.updateCustomViews();

                            this.state.room = params[1];
                            break;
                        }

                        case 'USERLIST':
                            if (!message.to_room || message.to_room === this.state.room) {
                                this.state.nicks = params[1].split(',');
                                this.customFormatObj.roomUserCount =
                                    this.state.nicks.length;
                                this.setText(
                                    MciViewIds.mrcChat.mrcUsers,
                                    this.customFormatObj.roomUserCount
                                );
                                this.updateCustomViews();
                            }
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

                            this.setText(
                                MciViewIds.mrcChat.mrcUsers,
                                this.customFormatObj.roomUserCount
                            );
                            this.setText(MciViewIds.mrcChat.mrcBbses, boardCount);

                            this.updateCustomViews();
                            break;
                        }

                        case 'PING':
                        case 'PONG':
                        case 'IMALIVE':
                        case 'ROOM_OPEN':
                        case 'ROOM_CLOSE':
                            break;

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

                    // Intercept CTCP messages regardless of current room
                    if (message.to_room === CTCP_ROOM) {
                        this._inboundCTCP(message);
                        this.viewControllers.mrcChat.switchFocus(
                            MciViewIds.mrcChat.inputArea
                        );
                        return;
                    }

                    // Track sender BBS for targeted DM routing (/msg, /r)
                    if (message.from_user && message.from_site) {
                        this.state.userSiteMap[message.from_user.toUpperCase()] =
                            message.from_site;
                    }

                    // Deliver PrivMsg — check FIRST: non-empty to_user matching alias is always a DM
                    // regardless of what to_room contains (Mystic sets to_room = sender's room)
                    if (
                        message.to_user &&
                        message.to_user.toUpperCase() == this.state.alias.toUpperCase()
                    ) {
                        this.state.lastDmSender = message.from_user;
                        this.state.lastDmSenderSite = message.from_site;
                        this.client.term.rawWrite('\x07');
                        const timeStr = this._formatTimestamp();
                        this.addMessageToChatLog(
                            (timeStr ? '|08' + timeStr + '|00 ' : '') +
                                message.body +
                                '|00'
                        );
                    } else if (message.to_room == this.state.room) {
                        // Track sender for tab completion
                        if (
                            message.from_user &&
                            !this.state.nicks.includes(message.from_user)
                        ) {
                            this.state.nicks.push(message.from_user);
                        }
                        // Twit filter — silently drop messages from twitted users
                        if (this._isTwit(message.from_user)) {
                            return;
                        }
                        // Highlight timestamp if our nick is mentioned
                        const isMention =
                            message.from_user.toUpperCase() !==
                                this.state.alias.toUpperCase() &&
                            message.body
                                .toLowerCase()
                                .includes(this.state.alias.toLowerCase());
                        const timeColour = isMention ? '|14' : '|08';
                        const indicator = isMention ? '|24|14» |00' : '';
                        const timeStr = this._formatTimestamp();
                        const line =
                            (timeStr ? timeColour + timeStr + '|00 ' : '') +
                            indicator +
                            message.body +
                            '|00';
                        if (isMention) {
                            this.state.mentionsLog.push(line);
                            if (this.state.mentionsLog.length > 200) {
                                this.state.mentionsLog.shift();
                            }
                            this.client.term.rawWrite('\x07'); // BEL — fire once, not stored in line
                        }
                        this.addMessageToChatLog(line);
                    }

                    // Broadcast (to_room is empty — sent to all rooms)
                    else if (message.to_room === '' && message.from_user !== 'SERVER') {
                        if (!this.userPrefs.shield) {
                            const timeStr = this._formatTimestamp();
                            this.addMessageToChatLog(
                                (timeStr ? '|08' + timeStr + '|00 ' : '') +
                                    message.body +
                                    '|00'
                            );
                        }
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
    processOutgoingMessage(message, to_user, to_site) {
        if (message.startsWith('/')) {
            this.processSlashCommand(message);
        } else {
            if (message == '') {
                // don't do anything if message is blank, just update stats
                this.sendServerMessage('STATS');
                return;
            }

            // Tilde filter — ~ is the MRC field separator, replace to prevent packet corruption
            message = message.replace(/~/g, ' ');

            // else just format and send
            const textFormatObj = {
                fromUserName: this.state.alias,
                toUserName: to_user,
                message: message,
            };

            const lt = this.userPrefs.ltBracket;
            const rt = this.userPrefs.rtBracket;
            const nc = this.userPrefs.nickColor;
            const mc = this.userPrefs.messageColor;

            const messageFormat =
                this.config.messageFormat ||
                `|00${lt}${nc}{fromUserName}${rt}|00 ${mc}{message}`;

            const privateMessageFormat =
                this.config.outgoingPrivateMessageFormat ||
                `|15* |08(|14DirectMsg|08->|15{toUserName}|00 ${mc}{message}`;

            let formattedMessage = '';
            if (to_user == undefined) {
                // normal message
                formattedMessage = stringFormat(messageFormat, textFormatObj);
            } else {
                // pm
                formattedMessage = stringFormat(privateMessageFormat, textFormatObj);

                // Echo PrivMSG to chat log (the server does not echo it back)
                const currentTime = moment().format(
                    this.client.currentTheme.helpers.getTimeFormat()
                );
                this.addMessageToChatLog(
                    '|08' + currentTime + '|00 ' + formattedMessage + '|00'
                );
            }

            try {
                this.state.lastSentMsg = {
                    msg: formattedMessage,
                    time: moment(),
                };
                this.sendMessageToMultiplexer(
                    to_user || '',
                    to_site ||
                        this.state.userSiteMap[(to_user || '').toUpperCase()] ||
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
            case 't':
            case 'tell':
            case 'msg':
            case 'pm': {
                const newmsg = cmd.slice(2).join(' ');
                const pmSite = this.state.userSiteMap[(cmd[1] || '').toUpperCase()] || '';
                this.processOutgoingMessage(newmsg, cmd[1], pmSite);
                break;
            }

            case 'me': {
                const action = cmd.slice(1).join(' ');
                if (action) {
                    const meMsg = `|15* |13${this.state.alias} ${action.replace(/~/g, ' ')}`;
                    try {
                        this.state.lastSentMsg = { msg: meMsg, time: moment() };
                        this.sendMessageToMultiplexer('', '', this.state.room, meMsg);
                    } catch (e) {
                        this.client.log.warn({ error: e.message }, 'MRC error');
                    }
                }
                break;
            }

            case 'b':
            case 'broadcast': {
                const text = cmd.slice(1).join(' ');
                if (text) {
                    const broadcastMsg = `|15* |08(|15${this.state.alias}|08/|14Broadcast|08) |07${text.replace(/~/g, ' ')}`;
                    try {
                        this.sendMessageToMultiplexer('', '', '', broadcastMsg);
                    } catch (e) {
                        this.client.log.warn({ error: e.message }, 'MRC error');
                    }
                }
                break;
            }

            case 'r': {
                if (!this.state.lastDmSender) {
                    this.addMessageToChatLog('|08No recent DM to reply to.|00');
                } else {
                    const reply = cmd.slice(1).join(' ');
                    if (reply) {
                        this.processOutgoingMessage(
                            reply,
                            this.state.lastDmSender,
                            this.state.lastDmSenderSite
                        );
                    }
                }
                break;
            }

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
                this.sendServerMessage(
                    cmd.length > 1 ? 'WHOON ' + cmd.slice(1).join(' ') : 'WHOON'
                );
                break;

            case 'motd':
                this.sendServerMessage('MOTD');
                break;

            case 'meetups':
                this.sendServerMessage('MEETUPS');
                break;

            case 'bbses':
                this.sendServerMessage(
                    cmd.length > 1 ? 'BBSES ' + cmd.slice(1).join(' ') : 'CONNECTED'
                );
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
            case 'j':
                this.joinRoom(cmd[1]);
                break;

            case 'chatters':
                this.sendServerMessage(
                    cmd.length > 1 ? 'CHATTERS ' + cmd.slice(1).join(' ') : 'CHATTERS'
                );
                break;

            case 'rooms':
                this.sendServerMessage('LIST');
                break;

            // Allow support for new server commands without change to client
            case 'quote':
                this.sendServerMessage(`${message.substr(7)}`);
                break;

            /**
             * Process known additional server commands directly
             */

            case 'afk':
                this.sendServerMessage(`AFK ${message.substr(5)}`);
                break;

            case 'roomconfig':
                this.sendServerMessage(`ROOMCONFIG ${message.substr(12)}`);
                break;

            case 'roompass':
                if (cmd.length > 1) {
                    this.sendServerMessage(`ROOMPASS ${cmd.slice(1).join(' ')}`);
                } else {
                    this.addMessageToChatLog('|08Enter room password:|00');
                    this.state.pendingPasswordCommand = 'ROOMPASS';
                    this._setInputPasswordMode(true);
                }
                break;

            case 'status':
                this.sendServerMessage(`STATUS ${message.substr(8)}`);
                break;

            case 'topics':
                this.sendServerMessage(`TOPICS ${message.substr(8)}`);
                break;

            case 'lastseen':
                this.sendServerMessage(`LASTSEEN ${message.substr(10)}`);
                break;

            case 'help':
                this.sendServerMessage(message.substr(1));
                break;

            case 'statistics':
            case 'changelog':
            case 'listbans':
            case 'listmutes':
            case 'routing':
                this.sendServerMessage(cmd[0].toUpperCase());
                break;

            /**
             * MRC Trust commands
             */

            case 'trust':
                this.sendServerMessage(`TRUST ${message.substr(7)}`);
                break;

            case 'register':
                if (cmd.length > 1) {
                    this.sendServerMessage(`REGISTER ${cmd.slice(1).join(' ')}`);
                } else {
                    this.addMessageToChatLog('|08Enter password to register:|00');
                    this.state.pendingPasswordCommand = 'REGISTER';
                    this._setInputPasswordMode(true);
                }
                break;

            case 'identify':
                if (cmd.length > 1) {
                    this.sendServerMessage(`IDENTIFY ${cmd.slice(1).join(' ')}`);
                } else {
                    this.addMessageToChatLog('|08Enter your password:|00');
                    this.state.pendingPasswordCommand = 'IDENTIFY';
                    this._setInputPasswordMode(true);
                }
                break;

            case 'update': {
                const subCmd = (cmd[1] || '').toLowerCase();
                if (subCmd === 'password') {
                    if (cmd.length > 2) {
                        this.sendServerMessage(
                            `UPDATE password ${cmd.slice(2).join(' ')}`
                        );
                    } else {
                        this.addMessageToChatLog('|08Enter new password:|00');
                        this.state.pendingPasswordCommand = 'UPDATE password';
                        this._setInputPasswordMode(true);
                    }
                } else {
                    this.sendServerMessage(`UPDATE ${message.substr(8)}`);
                }
                break;
            }

            /**
             * Local client commands
             */

            case 'q':
            case 'quit':
                return this.prevMenu();

            case 'clear':
                this.clearMessages();
                break;

            case 'set':
                this._handleSetCommand(cmd.slice(1));
                break;

            case '?':
                this.addMessageToChatLog(helpText.split(/\n/g));
                break;

            case 'mentions':
                this._showMentions();
                break;

            case 'twit':
                this._handleTwit(cmd.slice(1));
                break;

            case 'welcome':
                this._showWelcome();
                break;

            case 'ctcp':
                if (!cmd[1]) {
                    this._showCtcpHelp();
                } else {
                    const target = cmd[1];
                    const toUser = target === '*' || target.startsWith('#') ? '' : target;
                    const restOfLine = message.replace(/^\/ctcp\s+/i, '');
                    this._sendToCTCP(toUser, '[CTCP]', restOfLine);
                }
                break;

            default:
                this.sendServerMessage(message.substr(1));
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

    tabComplete() {
        const inputAreaView = this.viewControllers.mrcChat.getView(
            MciViewIds.mrcChat.inputArea
        );
        const currentText = inputAreaView.getData() || '';

        // Check if we're continuing a previous tab cycle
        if (this.state.tabMatches.length > 0 && this.state.tabIndex >= 0) {
            const prevNick = this.state.tabMatches[this.state.tabIndex];
            const sep = this.state.tabBase.trim() === '' ? ': ' : ' ';
            if (currentText === this.state.tabBase + prevNick + sep) {
                this.state.tabIndex =
                    (this.state.tabIndex + 1) % this.state.tabMatches.length;
                const nick = this.state.tabMatches[this.state.tabIndex];
                this.setViewText(
                    'mrcChat',
                    MciViewIds.mrcChat.inputArea,
                    this.state.tabBase + nick + sep
                );
                return;
            }
        }

        // New completion — find word being typed and build match list
        const lastSpace = currentText.lastIndexOf(' ');
        this.state.tabBase =
            lastSpace === -1 ? '' : currentText.substring(0, lastSpace + 1);
        const word =
            lastSpace === -1 ? currentText : currentText.substring(lastSpace + 1);
        this.state.tabPrefix = word.toLowerCase();
        this.state.tabMatches = (this.state.nicks || []).filter(
            n =>
                n.toLowerCase().startsWith(this.state.tabPrefix) &&
                n.toLowerCase() !== (this.state.alias || '').toLowerCase()
        );
        this.state.tabIndex = -1;

        if (this.state.tabMatches.length === 0) {
            if (this.state.tabPrefix) {
                this.addMessageToChatLog(
                    '|08No nicks matching "' + this.state.tabPrefix + '"|00'
                );
            }
            return;
        }

        this.state.tabIndex = 0;
        const nick = this.state.tabMatches[0];
        const sep = this.state.tabBase.trim() === '' ? ': ' : ' ';
        this.setViewText(
            'mrcChat',
            MciViewIds.mrcChat.inputArea,
            this.state.tabBase + nick + sep
        );
    }

    _setInputPasswordMode(enabled) {
        try {
            const inputAreaView = this.viewControllers.mrcChat.getView(
                MciViewIds.mrcChat.inputArea
            );
            if (inputAreaView) {
                inputAreaView.textMaskChar = enabled ? '*' : null;
                if (typeof inputAreaView.redraw === 'function') {
                    inputAreaView.redraw();
                }
            }
        } catch (e) {
            this.log.debug({ error: e.message }, 'Password mask toggle failed');
        }
    }

    _defaultPrefs() {
        return {
            ltBracket: '|10<',
            rtBracket: '|10>',
            nickColor: '|02',
            messageColor: '|03',
            defaultRoom: 'lobby',
            useClock: true,
            clockFormat: null,
            shield: false,
            hideCTCPReq: false,
            showSmilies: false,
            twitList: [],
            twitFilter: false,
            joinMsg: null,
            leaveMsg: null,
        };
    }

    _loadUserPrefsFromDb(callback) {
        try {
            this._db.exec(
                'CREATE TABLE IF NOT EXISTS user_prefs (username TEXT PRIMARY KEY, prefs_json TEXT NOT NULL)'
            );

            const row = this._db
                .prepare('SELECT prefs_json FROM user_prefs WHERE username = ?')
                .get(this.state.alias);

            if (row) {
                try {
                    this.userPrefs = Object.assign(
                        this._defaultPrefs(),
                        JSON.parse(row.prefs_json)
                    );
                } catch (e) {
                    // keep defaults already set
                }
            }
        } catch (err) {
            this.log.warn({ error: err.message }, 'Failed to load MRC user prefs');
        }
        return callback(null);
    }

    _saveUserPrefs() {
        if (!this._db) return;
        const json = JSON.stringify(this.userPrefs);
        try {
            this._db
                .prepare(
                    'INSERT OR REPLACE INTO user_prefs (username, prefs_json) VALUES (?, ?)'
                )
                .run(this.state.alias, json);
        } catch (err) {
            this.log.warn({ error: err.message }, 'Failed to save MRC user prefs');
        }
    }

    _formatTimestamp() {
        if (!this.userPrefs.useClock) return '';
        const fmt =
            this.userPrefs.clockFormat ||
            this.client.currentTheme.helpers.getTimeFormat();
        return moment().format(fmt);
    }

    _handleSetCommand(args) {
        if (!args || args.length === 0 || args[0].toLowerCase() === 'help') {
            return this._showSetHelp();
        }
        if (args[0].toLowerCase() === 'list') {
            return this._showSetList();
        }

        const key = args[0].toUpperCase();
        const val = args.slice(1).join(' ');

        switch (key) {
            case 'NICKCOLOR':
                this.userPrefs.nickColor = val || '|02';
                break;
            case 'MESSAGECOLOR':
                this.userPrefs.messageColor = val || '|03';
                break;
            case 'LTBRACKET':
                this.userPrefs.ltBracket = val || '|10<';
                break;
            case 'RTBRACKET':
                this.userPrefs.rtBracket = val || '|10>';
                break;
            case 'DEFAULTROOM':
                this.userPrefs.defaultRoom = val.replace(/^#/, '') || 'lobby';
                break;
            case 'USECLOCK':
                this.userPrefs.useClock = val.toLowerCase() !== 'off';
                break;
            case 'CLOCKFORMAT':
                this.userPrefs.clockFormat =
                    !val || val.toLowerCase() === 'default' ? null : val;
                break;
            case 'SHIELD':
                this.userPrefs.shield = val.toLowerCase() !== 'off';
                break;
            case 'HIDECTCPREQ':
                this.userPrefs.hideCTCPReq = val.toLowerCase() !== 'off';
                break;
            case 'SHOWSMILIES':
                this.userPrefs.showSmilies = val.toLowerCase() !== 'off';
                break;
            case 'TWITFILTER':
                this.userPrefs.twitFilter = val.toLowerCase() !== 'off';
                break;
            case 'JOINMSG':
                this.userPrefs.joinMsg =
                    !val || val.toLowerCase() === 'none' ? null : val;
                break;
            case 'LEAVEMSG':
                this.userPrefs.leaveMsg =
                    !val || val.toLowerCase() === 'none' ? null : val;
                break;
            default:
                this.addMessageToChatLog(
                    `|08Unknown option: |07${key}|08. Type |03/set help|08 for options.|00`
                );
                return;
        }

        this._saveUserPrefs();
        this.addMessageToChatLog(
            `|08Set |03${key}|08 \u2192 |07${val || '(default)'}|00`
        );
    }

    _showSetHelp() {
        this.addMessageToChatLog([
            '|15/set options|08:',
            '|03/|11set NICKCOLOR |03<pipe-code>    |08- |07Nick colour (e.g. |0202|07 for green)',
            '|03/|11set MESSAGECOLOR |03<pipe-code> |08- |07Message colour (|11left|08/|11right|08 to cycle)',
            '|03/|11set LTBRACKET |03<str>          |08- |07Left bracket around nick (e.g. |10<|07)',
            '|03/|11set RTBRACKET |03<str>          |08- |07Right bracket around nick (e.g. |10>|07)',
            '|03/|11set DEFAULTROOM |03<room>       |08- |07Room to join on connect',
            '|03/|11set USECLOCK on|08/|03off          |08- |07Show timestamp on messages',
            '|03/|11set CLOCKFORMAT |03<fmt>        |08- |14hh:mm |0712hr|08/|14HH:mm |0724hr (|03default|07 to reset)',
            '|03/|11set SHIELD on|08/|03off            |08- |07Suppress broadcast messages',
            '|03/|11set HIDECTCPREQ on|08/|03off       |08- |07Hide CTCP request messages',
            '|03/|11set SHOWSMILIES on|08/|03off       |08- |07Convert :) :D =) to smiley characters',
            '|03/|11set TWITFILTER on|08/|03off        |08- |07Enable your twit filter (see |03/twit|07)',
            '|03/|11set JOINMSG |03<message>        |08- |07Message sent on room join (|03%1|08 = nick)',
            '|03/|11set LEAVEMSG |03<message>       |08- |07Message sent on room leave (|03%1|08 = nick)',
            '|03/|11set list                     |08- |07Show current settings',
        ]);
    }

    _showSetList() {
        const p = this.userPrefs;
        this.addMessageToChatLog([
            '|15Current /set values|08:',
            `|14NICKCOLOR         |07${p.nickColor}|16|07`,
            `|14MESSAGECOLOR      |07${p.messageColor}|16|07`,
            `|14LTBRACKET         |07${p.ltBracket}|16|07`,
            `|14RTBRACKET         |07${p.rtBracket}|16|07`,
            `|14DEFAULTROOM       |07${p.defaultRoom}|16|07`,
            `|14USECLOCK          |07${p.useClock ? 'on' : 'off'}|16|07`,
            `|14CLOCKFORMAT       |07${p.clockFormat || '(theme default)'}|16|07`,
            `|14SHIELD            |07${p.shield ? 'on' : 'off'}|16|07`,
            `|14HIDECTCPREQ       |07${p.hideCTCPReq ? 'on' : 'off'}|16|07`,
            `|14SHOWSMILIES       |07${p.showSmilies ? 'on' : 'off'}|16|07`,
            `|14TWITFILTER        |07${p.twitFilter ? 'on' : 'off'} |08(${(p.twitList || []).length} user(s))|16|07`,
            `|14JOINMSG           |07${p.joinMsg || '(none)'}|16|07`,
            `|14LEAVEMSG          |07${p.leaveMsg || '(none)'}|16|07`,
        ]);
    }

    _showWelcome() {
        const p = this.userPrefs;
        const twitCount = (p.twitList || []).length;
        const twitStatus = p.twitFilter ? '|15on' : '|08off';
        const shieldStatus = p.shield ? '|15on' : '|08off';
        this.addMessageToChatLog([
            `|07- |08[|10::|08] |10Welcome to ENiGMA½ MRC Chat`,
            `|07- |08[|10::|08] |10|15UP|10/|15DN|10 history |15LEFT|10/|15RIGHT|10 msg colour`,
            `|07- |08[|10::|08] |15TAB|10 nick complete |15DEL|10 mentions`,
            `|07- |08[|10::|08] |10Type |15/help|10 for a list of commands`,
            `|07- |08[|10::|08] |14Broadcast Shield: ${shieldStatus}|14  Twit Filter: ${twitStatus}|14 (${twitCount} user(s))|07`,
        ]);
    }

    _isTwit(username) {
        if (!this.userPrefs.twitFilter) return false;
        const list = this.userPrefs.twitList || [];
        return list.includes(username.toUpperCase());
    }

    _handleTwit(args) {
        const sub = (args[0] || '').toUpperCase();
        const target = (args[1] || '').toUpperCase();
        const reserved = ['SERVER', 'CLIENT', 'NOTME'];
        const list = this.userPrefs.twitList || [];

        switch (sub) {
            case 'ADD': {
                if (!target) {
                    this.addMessageToChatLog('|08Usage: |03/twit add <user>|00');
                    return;
                }
                if (reserved.includes(target)) {
                    this.addMessageToChatLog(
                        `|12Cannot add |15${target}|12 to twit list|00`
                    );
                    return;
                }
                if (!list.includes(target)) {
                    list.push(target);
                    this.userPrefs.twitList = list;
                    this._saveUserPrefs();
                }
                this.addMessageToChatLog(`|11Added |15${target}|11 to your twit list|00`);
                break;
            }
            case 'DEL': {
                if (!target) {
                    this.addMessageToChatLog('|08Usage: |03/twit del <user>|00');
                    return;
                }
                const idx = list.indexOf(target);
                if (idx === -1) {
                    this.addMessageToChatLog(
                        `|11Cannot find |15${target}|11 in your twit list|00`
                    );
                } else {
                    list.splice(idx, 1);
                    this.userPrefs.twitList = list;
                    this._saveUserPrefs();
                    this.addMessageToChatLog(
                        `|11Removed |15${target}|11 from your twit list|00`
                    );
                }
                break;
            }
            case 'LIST': {
                if (list.length === 0) {
                    this.addMessageToChatLog('|11Your twit list is |15empty|00');
                } else {
                    const filterStatus = this.userPrefs.twitFilter ? '|15on' : '|08off';
                    this.addMessageToChatLog(
                        `|11Twit list (${list.length}): |15${list.join(', ')}`
                    );
                    this.addMessageToChatLog(
                        `|11Twit filter is ${filterStatus}|11 — see |15/set TWITFILTER|00`
                    );
                }
                break;
            }
            case 'CLEAR':
                this.userPrefs.twitList = [];
                this._saveUserPrefs();
                this.addMessageToChatLog('|11Your twit list has been cleared|00');
                break;
            default:
                this.addMessageToChatLog([
                    '|15/twit commands|08:',
                    '|03/|11twit add |03<user>  |08- |07Add user to twit list',
                    '|03/|11twit del |03<user>  |08- |07Remove user from twit list',
                    '|03/|11twit list         |08- |07Show your twit list',
                    '|03/|11twit clear        |08- |07Clear your twit list',
                    '|08Use |03/set TWITFILTER on|08/|03off |08to enable/disable filtering',
                ]);
        }
    }

    _showMentions() {
        if (this.state.mentionsLog.length === 0) {
            this.addMessageToChatLog('|08No mentions this session.|00');
        } else {
            this.addMessageToChatLog(
                `|08-- |15Mentions |08(${this.state.mentionsLog.length}) --`
            );
            this.addMessageToChatLog(
                this.state.mentionsLog.map(l => l.replace(/\x07/g, ''))
            );
            this.addMessageToChatLog('|08-- |15End of Mentions |08--');
        }
    }

    _showCtcpHelp() {
        this.addMessageToChatLog([
            '|15CTCP commands|08:',
            '|03/|11ctcp |03<target> <command>',
            '',
            '|10[target] |07can be:',
            '  |15*          |07All users',
            '  |15#room      |07All users in a room',
            '  |15user       |07A specific user',
            '',
            '|10[command] |07can be:',
            '  |15VERSION    |07Request client version',
            '  |15TIME       |07Request local time',
            '  |15PING       |07Latency check',
            '  |15CLIENTINFO |07Request supported commands',
        ]);
    }

    /**
     * Sends a CTCP message via the ctcp_echo_channel
     */
    _sendToCTCP(toUser, type, params) {
        const body = `${type} ${this.state.alias} ${params}`;
        const msg = {
            to_user: toUser,
            to_site: '',
            to_room: CTCP_ROOM,
            body,
            from_user: this.state.alias,
            from_room: CTCP_ROOM,
        };
        if (this.state.socket) {
            this.state.socket.write(JSON.stringify(msg) + '\n');
        }
    }

    /**
     * Handles inbound CTCP messages (to_room === ctcp_echo_channel)
     */
    _inboundCTCP(message) {
        // Ignore our own echoed requests
        if (message.from_user.toUpperCase() === this.state.alias.toUpperCase()) {
            return;
        }

        const words = message.body.split(' ');
        const type = (words[0] || '').toUpperCase();
        const sender = words[1] || ''; // user who sent the request/reply
        const target = words[2] || ''; // target (* / #room / username)
        const cmd = (words[3] || '').toUpperCase();

        if (type === '[CTCP]') {
            if (!this.userPrefs.hideCTCPReq) {
                this.addMessageToChatLog(
                    `* |14[CTCP-REQUEST] |15${cmd} |07on |15${target} |07from |10${message.from_user}|00`
                );
            }

            // Respond only if we are the target
            const myAlias = this.state.alias.toUpperCase();
            const myRoom = '#' + this.state.room.toUpperCase();
            const targeted =
                target === '*' ||
                target.toUpperCase() === myAlias ||
                target.toUpperCase() === myRoom;

            if (targeted) {
                switch (cmd) {
                    case 'VERSION':
                        this._sendToCTCP(
                            sender,
                            '[CTCP-REPLY]',
                            `VERSION ENiGMA½-BBS MRC Client`
                        );
                        break;
                    case 'TIME':
                        this._sendToCTCP(
                            sender,
                            '[CTCP-REPLY]',
                            `TIME ${new Date().toString()}`
                        );
                        break;
                    case 'PING': {
                        // Echo back everything after type+sender+target+cmd
                        const pingParams = words.slice(4).join(' ');
                        this._sendToCTCP(sender, '[CTCP-REPLY]', `PING ${pingParams}`);
                        break;
                    }
                    case 'CLIENTINFO':
                        this._sendToCTCP(
                            sender,
                            '[CTCP-REPLY]',
                            'CLIENTINFO VERSION TIME PING CLIENTINFO'
                        );
                        break;
                }
            }
        } else if (type === '[CTCP-REPLY]') {
            // Only display if the reply is addressed to us
            if (message.to_user.toUpperCase() === this.state.alias.toUpperCase()) {
                // body: [CTCP-REPLY] <responder> <cmd> <rest>
                const responder = sender;
                const rest = words.slice(2).join(' ');
                this.addMessageToChatLog(
                    `* |14[CTCP-REPLY] |10${responder} |15${rest}|00`
                );
            }
        }
    }

    /**
     * MRC Server flood protection requires messages to be spaced in time
     */
    msgDelay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
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
    async joinRoom(room) {
        // room names are displayed with a # but referred to without. confusing.
        room = room.replace(/^#/, '');
        const oldRoom = this.state.room;

        // Send custom leave message to the room being left
        if (oldRoom && this.userPrefs.leaveMsg) {
            const msg = this.userPrefs.leaveMsg
                .replace(/%1/g, this.state.alias)
                .replace(/~/g, ' ');
            this.sendMessageToMultiplexer('', '', oldRoom, msg);
            await this.msgDelay(100);
        }

        this.state.room = room;
        this.sendServerMessage(`NEWROOM:${oldRoom || room}:${room}`);

        await this.msgDelay(100);
        this.sendServerMessage('USERLIST');

        // Send custom join message to the room being entered
        if (this.userPrefs.joinMsg) {
            await this.msgDelay(100);
            const msg = this.userPrefs.joinMsg
                .replace(/%1/g, this.state.alias)
                .replace(/~/g, ' ');
            this.sendMessageToMultiplexer('', '', room, msg);
        }
    }

    /**
     * Things that happen when a local user connects to the MRC multiplexer
     */
    async clientConnect() {
        this._showWelcome();
        this.sendHeartbeat();
        await this.msgDelay(100);

        this.joinRoom(this.userPrefs.defaultRoom || 'lobby');
        await this.msgDelay(100);

        this.sendServerMessage('STATS');
        await this.msgDelay(100);

        this.sendServerMessage('MOTD');
    }
};
