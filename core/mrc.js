/* jslint node: true */
'use strict';

//  ENiGMA½
const Log               = require('./logger.js').log;
const { MenuModule }    = require('./menu_module.js');
const { Errors }        = require('./enig_error.js');
const {
    pipeToAnsi
}                       = require('./color_codes.js');
const stringFormat              = require('./string_format.js');
const StringUtil                = require('./string_util.js')

//  deps
const _                 = require('lodash');
const async             = require('async');
const net                   = require('net');
const moment                = require('moment');

exports.moduleInfo = {
    name        : 'MRC Client',
    desc        : 'Connects to an MRC chat server',
    author      : 'RiPuk',
    packageName : 'codes.l33t.enigma.mrc.client',

    // Whilst this module was put together by me (RiPuk), it should be noted that a lot of the ideas (and even some code snippets) were 
    // borrowed from the Synchronet implementation of MRC by echicken. So...thanks, your code was very helpful in putting this together.
    // Source at http://cvs.synchro.net/cgi-bin/viewcvs.cgi/xtrn/mrc/.
};

const FormIds = {
    mrcChat    : 0,
};

var MciViewIds = {
    mrcChat  : {
        chatLog             : 1,
        inputArea           : 2,
        roomName            : 3,
        roomTopic           : 4,
        mrcUsers            : 5,
        mrcBbses            : 6,
        customRangeStart    : 10,   //  10+ = customs
    }
};


 
// TODO: this is a bit shit, could maybe do it with an ansi instead
const helpText = `
General Chat:
/rooms                     - List of current rooms
/join <room>               - Join a room
/pm <user> <message>       - Send a private message
/clear                     - Clear the chat log
----
/whoon                     - Who's on what BBS
/chatters                  - Who's in what room
/topic <message>           - Set the topic
/meetups                   - MRC MeetUps
/bbses                     - BBS's connected
/info <id>                 - Info about specific BBS
---
/l33t <your message>       - l337 5p34k
/kewl <your message>       - BBS KeWL SPeaK
/rainbow <your message>    - Crazy rainbow text
`;


exports.getModule = class mrcModule extends MenuModule {
    constructor(options) {
        super(options);

        this.log    = Log.child( { module : 'MRC' } );
        this.config = Object.assign({}, _.get(options, 'menuConfig.config'), { extraArgs : options.extraArgs });
        
        this.state = {
            socket: '',
            alias: this.client.user.username,
            room: '',
            room_topic: '',
            nicks: [],
            last_ping: 0
        };
        
        this.menuMethods = {

            sendChatMessage : (formData, extraArgs, cb) => {
            
                const inputAreaView = this.viewControllers.mrcChat.getView(MciViewIds.mrcChat.inputArea);
                const inputData		= inputAreaView.getData();

                this.processSentMessage(inputData);
                inputAreaView.clearText();
                
                return cb(null);
            },

            movementKeyPressed : (formData, extraArgs, cb) => {
                const bodyView = this.viewControllers.mrcChat.getView(MciViewIds.mrcChat.chatLog);  //  :TODO: use const here vs magic #
                switch(formData.key.name) {
                    case 'down arrow'   : bodyView.scrollDocumentUp(); break;
                    case 'up arrow'     : bodyView.scrollDocumentDown(); break;
                    case 'page up'      : bodyView.keyPressPageUp(); break;
                    case 'page down'    : bodyView.keyPressPageDown(); break;
                }

                this.viewControllers.mrcChat.switchFocus(MciViewIds.mrcChat.inputArea);

                return cb(null);
            }
        }
    }

    mciReady(mciData, cb) {
        super.mciReady(mciData, err => {
            if(err) {
                return cb(err);
            }

            async.series(
                [
                    (callback) => {
                        return this.prepViewController('mrcChat', FormIds.mrcChat, mciData.menu, callback);
                    },
                    (callback) => {
                        return this.validateMCIByViewIds('mrcChat', [ MciViewIds.mrcChat.chatLog, MciViewIds.mrcChat.inputArea ], callback);
                    },
                    (callback) => {
                        const connectOpts = {
                            port	: 5000,
                            host	: "localhost",
                        };

                        // connect to multiplexer
                        this.state.socket = net.createConnection(connectOpts, () => {
                            const self = this;
                            // handshake with multiplexer
                            self.state.socket.write(`--DUDE-ITS--|${self.state.alias}\n`);

                            self.clientConnect();

                            // send register to central MRC and get stats every 60s
                            setInterval(function () {
                                self.sendHeartbeat();
                                self.sendServerCommand('STATS')
                            }, 60000);
                        });

                        // when we get data, process it
                        this.state.socket.on('data', data => {
                            data = data.toString();
                            this.processReceivedMessage(data);
                        });

                        return(callback);
                    }
                ],
                err => {
                    return cb(err);
                }
           );
        });
    }

    processReceivedMessage(blob) {
        blob.split('\n').forEach( message => {

            try {
                message = JSON.parse(message)
            } catch (e) {
                return
            }

            const chatMessageView = this.viewControllers.mrcChat.getView(MciViewIds.mrcChat.chatLog);


            if (message.from_user == 'SERVER') {
                const params = message.body.split(':');

                switch (params[0]) {
                    case 'BANNER':
                        chatMessageView.addText(pipeToAnsi(params[1].replace(/^\s+/, '')));
                        break;

                    case 'ROOMTOPIC':
                        this.viewControllers.mrcChat.getView(MciViewIds.mrcChat.roomName).setText(`#${params[1]}`);
                        this.viewControllers.mrcChat.getView(MciViewIds.mrcChat.roomTopic).setText(pipeToAnsi(params[2]));
                        this.state.room = params[1];
                        break;
                        
                    case 'USERLIST':
                        this.state.nicks = params[1].split(',');
                        break;
                    
                    case 'STATS':
                        console.log("got stats back")
                        const stats = params[1].split(' ');
                        this.viewControllers.mrcChat.getView(MciViewIds.mrcChat.mrcUsers).setText(stats[2]);
                        this.viewControllers.mrcChat.getView(MciViewIds.mrcChat.mrcBbses).setText(stats[0]);
                        this.state.last_ping = stats[1];

                        break;

                    default:
                        chatMessageView.addText(pipeToAnsi(message.body));
                        break;
                }

            } else {
                if (message.from_user == this.state.alias && message.to_user == "NOTME") {
                    // don't deliver NOTME messages
                    return;
                } else {
                    // if we're here then we want to show it to the user
                    const currentTime = moment().format(this.client.currentTheme.helpers.getTimeFormat());
                    chatMessageView.addText(pipeToAnsi("|08" + currentTime + "|00 " + message.body + "|00"));
                }
            }

            this.viewControllers.mrcChat.switchFocus(MciViewIds.mrcChat.inputArea);
        });
    }

    processSentMessage(message, to_user) {
        if (message.startsWith('/')) {

            this.processSlashCommand(message)

        } else {
            if (message == '') {
                this.sendServerCommand('STATS');
                return;
            }

            // just format and send
            const textFormatObj = {
                fromUserName    : this.state.alias,
                message         : message
            };

            const messageFormat =
                this.config.messageFormat ||
                '|00|10<|02{fromUserName}|10>|00 |03{message}|00';

            try {
                this.sendChat(stringFormat(messageFormat, textFormatObj), to_user || '');
            } catch(e) {
                this.client.log.warn( { error : e.message }, 'MRC error');
            }
        }

    }

    processSlashCommand(message) {
        // get the chat log view in case we need it
        const chatLogView = this.viewControllers.mrcChat.getView(MciViewIds.mrcChat.chatLog)

        const cmd = message.split(' ');
        cmd[0] = cmd[0].substr(1).toLowerCase();

        switch (cmd[0]) {
            case 'pm':
                this.processSentMessage(cmd[2], cmd[1])
                break;
            case 'rainbow':
                // this is brutal, but i love it
                const line = message.replace(/^\/rainbow\s/, '').split(' ').reduce(function (a, c) {
                    var cc = Math.floor((Math.random() * 31) + 1).toString().padStart(2, '0');
                    a += `|${cc}${c}|00 `;
                    return a;
                }, '').substr(0, 140).replace(/\\s\|\d*$/, '');

                this.processSentMessage(line);
                break;

            case 'l33t':
                this.processSentMessage(StringUtil.stylizeString(message.substr(5), 'l33t'));
                break;

            case 'kewl':
                const text_modes = Array('f','v','V','i','M');
                const mode = text_modes[Math.floor(Math.random() * text_modes.length)];
                this.processSentMessage(StringUtil.stylizeString(message.substr(5), mode));
                break;

            case 'whoon':
                this.sendServerCommand('WHOON');
                break;

            case 'motd':
                this.sendServerCommand('MOTD');
                break;

            case 'meetups':
                this.sendServerCommand('MEETUPS');
                break;

            case 'bbses':
                this.sendServerCommand('CONNECTED');
                break;

            case 'topic':
                this.sendServerCommand(`NEWTOPIC:${this.state.room}:${message.substr(7)}`)
                break;

            case 'info':
                this.sendServerCommand(`INFO ${cmd[1]}`);
                break;

            case 'join':
                this.joinRoom(cmd[1]);
                break;

            case 'chatters':
                this.sendServerCommand('CHATTERS');
                break;

            case 'rooms':
                this.sendServerCommand('LIST');
                break;

            case 'clear':
                chatLogView.setText('');
                break;

            case '?':
                chatLogView.addText(helpText);
                break;

            default:
                
                break;
        }

        // just do something to get the cursor back to the right place ¯\_(ツ)_/¯
        this.sendServerCommand('STATS');

    };

    sendMessage(to_user, to_site, to_room, body) {

        const message = {
            from_user: this.state.alias,
            from_room: this.state.room,
            to_user: to_user,
            to_site: to_site,
            to_room: to_room,
            body: body
        };

        this.log.debug({ message: message }, 'Sending message to MRC multiplexer');
        // TODO: check socket still exists here

        this.state.socket.write(JSON.stringify(message) + '\n');
    };

    sendServerCommand(command, to_site) {
        Log.debug({ module: 'mrc', command: command }, 'Sending server command');
        this.sendMessage('SERVER', to_site || '', this.state.room, command);
    };


    sendHeartbeat() {
        this.sendServerCommand('IAMHERE');
    }

    joinRoom(room) {
        // room names are displayed with a # but referred to without. confusing.
        room = room.replace(/^#/, '');
        this.state.room = room;
        this.sendServerCommand(`NEWROOM:${this.state.room}:${room}`);
        this.sendServerCommand('USERLIST')
    }

    clientConnect() {
        this.sendServerCommand('MOTD');
        this.joinRoom('lobby');
        this.sendServerCommand('STATS');
        this.sendHeartbeat();
    }

    sendChat(message, to_user) {
        this.sendMessage(to_user || '', '', this.state.room, message)
    }
};




