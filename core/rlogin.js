/* jslint node: true */
'use strict';

//  enigma-bbs
const { MenuModule }    = require('../core/menu_module.js');
const { resetScreen }   = require('../core/ansi_term.js');
const { Errors }        = require('./enig_error.js');
const {
    trackDoorRunBegin,
    trackDoorRunEnd
}                       = require('./door_util.js');

//  deps
const async         = require('async');
const RLogin        = require('rlogin');

exports.moduleInfo = {
    name    : 'RloginBridge',
    desc    : 'Rlogin Bridge Module',
    author  : 'Dave Stephens w/Modifications by Tony Toon',
};

exports.getModule = class RloginModule extends MenuModule {
    constructor(options) {
        super(options);

        //  establish defaults
        this.config             = options.menuConfig.config;
        this.config.host        = this.config.host || 'localhost';
        this.config.rloginPort  = this.config.rloginPort || 513;
    }

    initSequence() {
        const self = this;


        /*  
            rlogin is getting abused by bbs's to handle remote authentication where it was never meant to do so via passing a plaintext password.
            never the less, it works and that's what we support. we use synchronet's handling of rlogin as listed at http://wiki.synchro.net/module:rlogin
        */

        async.series(
            [
                function validateConfig(callback) {
                    return self.validateConfigFields(
                        {
                            host        : 'string',
                            password    : 'string',
                            username    : 'string',
                            rloginPort  : 'number',
                            xtrn        : 'string',
                        },
                        callback
                    );
                },
                function establishRloginConnection(callback) {
                    self.client.term.write(resetScreen());
                    //self.client.term.write('Connecting via rlogin, please wait...\n');

                    let doorTracking;

                    const restorePipeToNormal = function() {
                        if(self.client.term.output) {
                            self.client.term.output.removeListener('data', sendToRloginBuffer);

                            if(doorTracking) {
                                trackDoorRunEnd(doorTracking);
                            }
                        }
                    };

                    const rlogin = new RLogin(
                        {
                            clientUsername  : self.config.password,
                            serverUsername  : self.config.username,
                            host            : self.config.host,
                            port            : self.config.rloginPort,
                            terminalType    : self.config.xtrn || self.client.term.termClient, // if the xtrn parameter is specified, use it. otherwise send the term client.
                            terminalSpeed   : 57600
                        }
                    );

                    // If there was an error ...
                    rlogin.on('error', err => {
                        self.client.log.info(`rlogin client error: ${err.message}`);
                        restorePipeToNormal();
                        return callback(err);
                    });

                    // If we've been disconnected ...
                    rlogin.on('disconnect', () => {
                        self.client.log.info('Disconnected from remote');
                        restorePipeToNormal();
                        return callback(null);
                    });

                    function sendToRloginBuffer(buffer) {
                        rlogin.send(buffer);
                    }

                    rlogin.on('connect',
                        /*  The 'connect' event handler will be supplied with one argument,
                            a boolean indicating whether or not the connection was established. */

                        function(state) {
                            if(state) {
                                self.client.log.info('Connected to rlogin server');
                                self.client.term.output.on('data', sendToRloginBuffer);

                                doorTracking = trackDoorRunBegin(self.client);
                            } else {
                                return callback(Errors.General('Failed to establish establish rlogin connection'));
                            }
                        }
                    );

                    // If data (a Buffer) has been received from the server ...
                    rlogin.on('data', (data) => {
                        self.client.term.rawWrite(data);
                    });

                    // connect...
                    rlogin.connect();

                    //  note: no explicit callback() until we're finished!
                }
            ],
            err => {
                if(err) {
                    self.client.log.warn( { error : err.message }, 'rlogin error');
                }

                //  if the client is still here, go to previous
                self.prevMenu();
            }
        );
    }
};
