/* jslint node: true */
'use strict';

//  enigma-bbs
const { MenuModule } = require('../core/menu_module');
const { resetScreen } = require('../core/ansi_term');
const { Errors } = require('../core/enig_error');
const { trackDoorRunBegin, trackDoorRunEnd } = require('./door_util');

//  deps
const async = require('async');
const _ = require('lodash');
const RLogin = require('rlogin');

exports.moduleInfo = {
    name: 'gOLD mINE',
    desc: 'gOLD mINE Community Door Server Module',
    author: 'NuSkooler',
};

exports.getModule = class GoldmineModule extends MenuModule {
    constructor(options) {
        super(options);

        this.setConfigWithExtraArgs(options);

        //  http://goldminebbs.com/
        this.config.host = this.config.host || '165.232.153.209';
        this.config.rloginPort = this.config.rloginPort || 513;
    }

    initSequence() {
        let clientTerminated = false;

        async.series(
            [
                callback => {
                    return this.validateConfigFields(
                        {
                            host: 'string',
                            rloginPort: 'number',
                            bbsTag: 'string',
                        },
                        callback
                    );
                },
                callback => {
                    this.client.term.write(resetScreen());
                    this.client.term.write('Connecting to gOLD mINE, please wait...\n');

                    const username = this.client.user.getSanitizedName();
                    let doorTracking;
                    const rlogin = new RLogin({
                        clientUsername: username,
                        serverUsername: `${this.config.bbsTag}${username}`,
                        host: this.config.host,
                        port: this.config.rloginPort,
                        terminalType: '',
                        terminalSpeed: '',
                    });

                    if (
                        _.isString(this.config.directDoorCode) &&
                        this.config.directDoorCode.length > 0
                    ) {
                        rlogin.terminalType = `xtrn=${this.config.directDoorCode}`;
                    }

                    const rloginSend = buffer => {
                        return rlogin.send(buffer);
                    };

                    let pipeRestored = false;
                    const restorePipeAndFinish = err => {
                        if (pipeRestored) {
                            return;
                        }

                        pipeRestored = true;

                        if (this.client.term.output) {
                            this.client.term.output.removeListener('data', rloginSend);
                        }

                        if (doorTracking) {
                            trackDoorRunEnd(doorTracking);
                        }

                        return callback(err);
                    };

                    rlogin.on('error', err => {
                        //  Eat up RLogin error with terminalSpeed not being a number
                        if (err === 'RLogin: invalid terminalSpeed argument.') {
                            return;
                        }

                        this.client.log.info(
                            `gOLD mINE rlogin client error: ${err.message || err}`
                        );
                        return restorePipeAndFinish(err);
                    });

                    rlogin.on('disconnect', () => {
                        this.client.log.info('Disconnected from gOLD mINE');
                        return restorePipeAndFinish(null);
                    });

                    rlogin.on('connect', connected => {
                        if (!connected) {
                            return callback(
                                Errors.General(
                                    'Failed to establish connection to gOLD mINE'
                                )
                            );
                        }

                        this.client.log.info('Connected to gOLD mINE');
                        this.client.term.output.on('data', rloginSend);

                        doorTracking = trackDoorRunBegin(this.client);
                    });

                    rlogin.on('data', data => {
                        this.client.term.rawWrite(data);
                    });

                    // connect...
                    rlogin.connect();
                },
            ],
            err => {
                if (err) {
                    this.client.log.warn({ error: err.message }, 'gOLD mINE error');
                }

                this.prevMenu();
            }
        );
    }
};
