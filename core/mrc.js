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
const { getThemeArt }           = require('./theme.js');


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

const state = {
    socket: '',
    alias: '',
    room: '',
    room_topic: '',
    nicks: [],
    last_ping: 0
};
 

exports.getModule = class mrcModule extends MenuModule {
    constructor(options) {
        super(options);

        this.log    = Log.child( { module : 'MRC' } );
        this.config = Object.assign({}, _.get(options, 'menuConfig.config'), { extraArgs : options.extraArgs });
        state.alias = this.client.user.username;


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
                console.log("got arrow key");
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
                    // (callback) => {
                    //     console.log("stop idle monitor")
                    //     this.client.stopIdleMonitor();
                    //     return(callback);
                    // },
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
                        state.socket = net.createConnection(connectOpts, () => {
                            // handshake with multiplexer
                            state.socket.write(`--DUDE-ITS--|${state.alias}\n`);

                            sendClientConnect()

                            // send register to central MRC and get stats every 60s
                            setInterval(function () { 
                                sendHeartbeat(state.socket)
                                sendServerCommand('STATS')
                            }, 60000); 
                        });

                        // when we get data, process it
                        state.socket.on('data', data => {
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
                        chatMessageView.redraw();
                        break;

                    case 'ROOMTOPIC':
                        this.viewControllers.mrcChat.getView(MciViewIds.mrcChat.roomName).setText(`#${params[1]}`);
                        this.viewControllers.mrcChat.getView(MciViewIds.mrcChat.roomTopic).setText(pipeToAnsi(params[2]));
                        state.room = params[1]
                        break;
                        
                    case 'USERLIST':
                        state.nicks = params[1].split(',');
                        break;
                    
                    case 'STATS':
                        const stats = params[1].split(' ');
                        this.viewControllers.mrcChat.getView(MciViewIds.mrcChat.mrcUsers).setText(stats[2]);
                        this.viewControllers.mrcChat.getView(MciViewIds.mrcChat.mrcBbses).setText(stats[0]);

                        break;

                    default:
                        chatMessageView.addText(pipeToAnsi(message.body));
                        break;
                }

            } else {
                if (message.from_user == state.alias && message.to_user == "NOTME") {
                    // don't deliver NOTME messages
                    return;
                } else {
                    // if we're here then we want to show it to the user
                    const currentTime = moment().format(this.client.currentTheme.helpers.getTimeFormat());
                    chatMessageView.addText(pipeToAnsi("|08" + currentTime + "|00 " + message.body + "|00"));
                    chatMessageView.redraw();
                }
            }

            this.viewControllers.mrcChat.switchFocus(MciViewIds.mrcChat.inputArea);
            return;
        });
    }

    processSentMessage(message) {

        if (message.startsWith('/')) {
            const cmd = message.split(' ');
            cmd[0] = cmd[0].substr(1).toLowerCase();

            switch (cmd[0]) {
                case 'rainbow':
                    const line = message.replace(/^\/rainbow\s/, '').split(' ').reduce(function (a, c) {
                        var cc = Math.floor((Math.random() * 31) + 1).toString().padStart(2, '0');
                        a += `|${cc}${c}|00 `
                        return a;
                    }, '').substr(0, 140).replace(/\\s\|\d*$/, '');

                    this.processSentMessage(line)
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
                    sendServerCommand('WHOON');
                    break;
                
                case 'motd':
                    sendServerCommand('MOTD');
                    break;

                case 'meetups':
                    sendServerCommand('MEETUPS');
                    break;
                
                case 'bbses':
                    sendServerCommand('CONNECTED');
                    break;

                case 'topic':
                    sendServerCommand(`NEWTOPIC:${state.room}:${message.substr(7)}`)
                    break;
                
                case 'join':
                    joinRoom(cmd[1]);
                    break;

                case 'chatters':
                    sendServerCommand('CHATTERS');
                    break;

                case 'rooms':
                    sendServerCommand('LIST');
                    break;
                
                case 'clear':
                    const chatLogView = this.viewControllers.mrcChat.getView(MciViewIds.mrcChat.chatLog)
                    chatLogView.setText('');
                    sendServerCommand('STATS');
                    // chatLogView.redraw();
                    break;

                default:
                    break;
            }

        } else {
            // just format and send
            const textFormatObj = {
                fromUserName    : state.alias,
                message         : message
            };
    
            const messageFormat =
                this.config.messageFormat ||
                '|00|10<|02{fromUserName}|10>|00 |03{message}|00';
    
            try {
                sendChat(stringFormat(messageFormat, textFormatObj));
            } catch(e) {
                self.client.log.warn( { error : e.message }, 'MRC error');
            }
        }
        
        return;
    }
    
};


function sendMessage(to_user, to_site, to_room, body) {
    // drop message if user just mashes enter
    if (body == '' || body == state.alias) return;
    
    // otherwise construct message
    const message = {
        from_room: state.room,
        to_user: to_user,
        to_site: to_site,
        to_room: to_room,
        body: body
    }
    Log.debug({module: 'mrcclient', message: message}, 'Sending message to MRC multiplexer');
    // TODO: check socket still exists here
    state.socket.write(JSON.stringify(message) + '\n');
}

function sendChat(message, to_user) {
    sendMessage(to_user || '', '', state.room, message)
}

function sendServerCommand(command, to_site) {
    Log.debug({ module: 'mrc', command: command }, 'Sending server command');
    sendMessage('SERVER', to_site || '', state.room, command);
    return;
}

function sendHeartbeat() {
    sendServerCommand('IAMHERE');
    return;
}

function sendClientConnect() {
    sendHeartbeat();
    sendServerCommand('MOTD');
    sendServerCommand('STATS');
    joinRoom('lobby');
    return;
}

function joinRoom(room) {
    // room names are displayed with a # but referred to without. confusing. 
    room = room.replace(/^#/, '');
    sendServerCommand(`NEWROOM:${state.room}:${room}`);
    sendServerCommand('USERLIST')
}
