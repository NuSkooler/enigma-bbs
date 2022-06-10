/* jslint node: true */
'use strict';

//  enigma-bbs
const { MenuModule } = require('../core/menu_module.js');
const { resetScreen } = require('../core/ansi_term.js');
const { Errors } = require('./enig_error.js');
const { trackDoorRunBegin, trackDoorRunEnd } = require('./door_util.js');

//  deps
const async = require('async');
const RLogin = require('rlogin');

exports.moduleInfo = {
    name: 'CombatNet',
    desc: 'CombatNet Access Module',
    author: 'Dave Stephens',
};

exports.getModule = class CombatNetModule extends MenuModule {
    constructor(options) {
        super(options);

        //  establish defaults
        this.config = options.menuConfig.config;
        this.config.host = this.config.host || 'bbs.combatnet.us';
        this.config.rloginPort = this.config.rloginPort || 4513;
    }

    initSequence() {
        const self = this;

        async.series(
            [
                function validateConfig(callback) {
                    return self.validateConfigFields(
                        {
                            host: 'string',
                            password: 'string',
                            bbsTag: 'string',
                            rloginPort: 'number',
                        },
                        callback
                    );
                },
                function establishRloginConnection(callback) {
                    self.client.term.write(resetScreen());
                    self.client.term.write('Connecting to CombatNet, please wait...\n');

                    let doorTracking;

                    const restorePipeToNormal = function () {
                        if (self.client.term.output) {
                            self.client.term.output.removeListener(
                                'data',
                                sendToRloginBuffer
                            );

                            if (doorTracking) {
                                trackDoorRunEnd(doorTracking);
                            }
                        }
                    };

                    const rlogin = new RLogin({
                        clientUsername: self.config.password,
                        serverUsername: `${self.config.bbsTag}${self.client.user.username}`,
                        host: self.config.host,
                        port: self.config.rloginPort,
                        terminalType: self.client.term.termClient,
                        terminalSpeed: 57600,
                    });

                    // If there was an error ...
                    rlogin.on('error', err => {
                        self.client.log.info(
                            `CombatNet rlogin client error: ${err.message}`
                        );
                        restorePipeToNormal();
                        return callback(err);
                    });

                    // If we've been disconnected ...
                    rlogin.on('disconnect', () => {
                        self.client.log.info('Disconnected from CombatNet');
                        restorePipeToNormal();
                        return callback(null);
                    });

                    function sendToRloginBuffer(buffer) {
                        rlogin.send(buffer);
                    }

                    rlogin.on(
                        'connect',
                        /*  The 'connect' event handler will be supplied with one argument,
                            a boolean indicating whether or not the connection was established. */

                        function (state) {
                            if (state) {
                                self.client.log.info('Connected to CombatNet');
                                self.client.term.output.on('data', sendToRloginBuffer);

                                doorTracking = trackDoorRunBegin(self.client);
                            } else {
                                return callback(
                                    Errors.General(
                                        'Failed to establish establish CombatNet connection'
                                    )
                                );
                            }
                        }
                    );

                    // If data (a Buffer) has been received from the server ...
                    rlogin.on('data', data => {
                        self.client.term.rawWrite(data);
                    });

                    // connect...
                    rlogin.connect();

                    //  note: no explicit callback() until we're finished!
                },
            ],
            err => {
                if (err) {
                    self.client.log.warn({ error: err.message }, 'CombatNet error');
                }

                //  if the client is still here, go to previous
                self.prevMenu();
            }
        );
    }
};
