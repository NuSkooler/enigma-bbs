/* jslint node: true */
'use strict';

//  ENiGMA½
const Log               = require('./logger.js').log;
const { MenuModule }    = require('./menu_module.js');
const { Errors }        = require('./enig_error.js');
const {
    pipeToAnsi,
    stripMciColorCodes
}                       = require('./color_codes.js');
const stringFormat              = require('./string_format.js');
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
                // const message = _.get(formData.value, 'inputArea', '').trim();
            
                const inputAreaView = this.viewControllers.mrcChat.getView(MciViewIds.mrcChat.inputArea);
                const inputData		= inputAreaView.getData();
                const textFormatObj = {
                    fromUserName    : state.alias,
                    message         : inputData
                };
        
                const messageFormat =
                    this.config.messageFormat ||
                    '|00|10<|02{fromUserName}|10>|00 |03{message}|00';
        
                try {
                    sendChat(stringFormat(messageFormat, textFormatObj));
                } catch(e) {
                    self.client.log.warn( { error : e.message }, 'MRC error');
                }
                inputAreaView.clearText();
                
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

                            // send register to central MRC every 60s
                            setInterval(function () { 
                                sendHeartbeat(state.socket)
                            }, 60000); 
                        });

                        // when we get data, process it
                        state.socket.on('data', data => {
                            data = data.toString();
                            this.processReceivedMessage(data);
                            this.viewControllers.mrcChat.switchFocus(MciViewIds.mrcChat.inputArea);
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

            if (message.from_user == 'SERVER') {
                const params = message.body.split(':');

                switch (params[0]) {
                    case 'BANNER':
                        const chatMessageView = this.viewControllers.mrcChat.getView(MciViewIds.mrcChat.chatLog);
                        chatMessageView.addText(pipeToAnsi(params[1].replace(/^\s+/, '')));
                        chatMessageView.redraw();

                    case 'ROOMTOPIC':
                        this.viewControllers.mrcChat.getView(MciViewIds.mrcChat.roomName).setText(params[1]);
                        this.viewControllers.mrcChat.getView(MciViewIds.mrcChat.roomTopic).setText(params[2]);

                    case 'USERLIST':
                        state.nicks = params[1].split(',');

                    break;
                }

            } else {
                // if we're here then we want to show it to the user
                const chatMessageView = this.viewControllers.mrcChat.getView(MciViewIds.mrcChat.chatLog);
                const currentTime = moment().format(this.client.currentTheme.helpers.getTimeFormat());
                chatMessageView.addText(pipeToAnsi("|08" + currentTime + "|00 " + message.body));
                chatMessageView.redraw();
            }

            return;
    
        });
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

function sendChat(message,to_user) {
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
    joinRoom('lobby');
    sendServerCommand('BANNERS');
    sendServerCommand('MOTD');
    return;
}

function joinRoom(room) {
    sendServerCommand(`NEWROOM:${state.room}:${room}`);
}
