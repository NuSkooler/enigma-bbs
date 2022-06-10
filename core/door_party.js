/* jslint node: true */
'use strict';

//  enigma-bbs
const { MenuModule } = require('./menu_module.js');
const { resetScreen } = require('./ansi_term.js');
const { Errors } = require('./enig_error.js');
const { trackDoorRunBegin, trackDoorRunEnd } = require('./door_util.js');

//  deps
const async = require('async');
const SSHClient = require('ssh2').Client;

exports.moduleInfo = {
    name: 'DoorParty',
    desc: 'DoorParty Access Module',
    author: 'NuSkooler',
};

exports.getModule = class DoorPartyModule extends MenuModule {
    constructor(options) {
        super(options);

        //  establish defaults
        this.config = options.menuConfig.config;
        this.config.host = this.config.host || 'dp.throwbackbbs.com';
        this.config.sshPort = this.config.sshPort || 2022;
        this.config.rloginPort = this.config.rloginPort || 513;
    }

    initSequence() {
        let clientTerminated;
        const self = this;

        async.series(
            [
                function validateConfig(callback) {
                    return self.validateConfigFields(
                        {
                            host: 'string',
                            username: 'string',
                            password: 'string',
                            bbsTag: 'string',
                            sshPort: 'number',
                            rloginPort: 'number',
                        },
                        callback
                    );
                },
                function establishSecureConnection(callback) {
                    self.client.term.write(resetScreen());
                    self.client.term.write('Connecting to DoorParty, please wait...\n');

                    const sshClient = new SSHClient();

                    let pipeRestored = false;
                    let pipedStream;
                    let doorTracking;

                    const restorePipe = function () {
                        if (pipedStream && !pipeRestored && !clientTerminated) {
                            self.client.term.output.unpipe(pipedStream);
                            self.client.term.output.resume();

                            if (doorTracking) {
                                trackDoorRunEnd(doorTracking);
                                doorTracking = null;
                            }
                        }
                    };

                    sshClient.on('ready', () => {
                        //  track client termination so we can clean up early
                        self.client.once('end', () => {
                            self.client.log.info(
                                'Connection ended. Terminating DoorParty connection'
                            );
                            clientTerminated = true;
                            sshClient.end();
                        });

                        //  establish tunnel for rlogin
                        sshClient.forwardOut(
                            '127.0.0.1',
                            self.config.sshPort,
                            self.config.host,
                            self.config.rloginPort,
                            (err, stream) => {
                                if (err) {
                                    return callback(
                                        Errors.General('Failed to establish tunnel')
                                    );
                                }

                                doorTracking = trackDoorRunBegin(self.client);

                                //
                                //  Send rlogin
                                //  DoorParty wants the "server username" portion to be in the format of [BBS_TAG]USERNAME, e.g.
                                //  [XA]nuskooler
                                //
                                const rlogin = `\x00${self.client.user.username}\x00[${self.config.bbsTag}]${self.client.user.username}\x00${self.client.term.termType}\x00`;
                                stream.write(rlogin);

                                pipedStream = stream; //  :TODO: this is hacky...
                                self.client.term.output.pipe(stream);

                                stream.on('data', d => {
                                    //  :TODO: we should just pipe this...
                                    self.client.term.rawWrite(d);
                                });

                                stream.on('end', () => {
                                    sshClient.end();
                                });

                                stream.on('close', () => {
                                    restorePipe();
                                    sshClient.end();
                                });
                            }
                        );
                    });

                    sshClient.on('error', err => {
                        self.client.log.info(
                            `DoorParty SSH client error: ${err.message}`
                        );
                        trackDoorRunEnd(doorTracking);
                    });

                    sshClient.on('close', () => {
                        restorePipe();
                        callback(null);
                    });

                    sshClient.connect({
                        host: self.config.host,
                        port: self.config.sshPort,
                        username: self.config.username,
                        password: self.config.password,
                    });

                    //  note: no explicit callback() until we're finished!
                },
            ],
            err => {
                if (err) {
                    self.client.log.warn({ error: err.message }, 'DoorParty error');
                }

                //  if the client is still here, go to previous
                if (!clientTerminated) {
                    self.prevMenu();
                }
            }
        );
    }
};
