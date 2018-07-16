/* jslint node: true */
'use strict';

//  enigma-bbs
const { MenuModule }    = require('../core/menu_module.js');
const { resetScreen }   = require('../core/ansi_term.js');
const { Errors }        = require('../core/enig_error.js');

//  deps
const async         = require('async');
const _             = require('lodash');
const SSHClient     = require('ssh2').Client;

exports.moduleInfo = {
    name    : 'ArchaicNET',
    desc    : 'ArchaicNET Access Module',
    author  : 'NuSkooler',
};

exports.getModule = class ArchaicNETModule extends MenuModule {
    constructor(options) {
        super(options);

        //  establish defaults
        this.config             = options.menuConfig.config;
        this.config.host        = this.config.host || 'bbs.archaicbinary.net';
        this.config.sshPort     = this.config.sshPort || 8513;
        this.config.rloginPort  = this.config.rloginPort || 2222;
    }

    initSequence() {
        let clientTerminated;
        const self = this;

        async.series(
            [
                function validateConfig(callback) {
                    const reqConfs = [ 'username', 'password', 'bbsTag' ];
                    for(let req of reqConfs) {
                        if(!_.isString(_.get(self, [ 'config', req ]))) {
                            return callback(Errors.MissingConfig(`Config requires "${req}"`));
                        }
                    }
                    return callback(null);
                },
                function establishSecureConnection(callback) {
                    self.client.term.write(resetScreen());
                    self.client.term.write('Connecting to ArchaicNET, please wait...\n');

                    const sshClient = new SSHClient();

                    let pipeRestored = false;
                    let pipedStream;
                    const restorePipe = function() {
                        if(pipedStream && !pipeRestored && !clientTerminated) {
                            self.client.term.output.unpipe(pipedStream);
                            self.client.term.output.resume();
                        }
                    };

                    sshClient.on('ready', () => {
                        //  track client termination so we can clean up early
                        self.client.once('end', () => {
                            self.client.log.info('Connection ended. Terminating ArchaicNET connection');
                            clientTerminated = true;
                            return sshClient.end();
                        });

                        //  establish tunnel for rlogin
                        const fwdPort = self.config.rloginPort + self.client.node;
                        sshClient.forwardOut('127.0.0.1', fwdPort, self.config.host,  self.config.rloginPort, (err, stream) => {
                            if(err) {
                                return sshClient.end();
                            }

                            //
                            //  Send rlogin - [<bbsTag>]<userName> e.g. [Xibalba]NuSkooler
                            //
                            const rlogin = `\x00${self.client.user.username}\x00[${self.config.bbsTag}]${self.client.user.username}\x00${self.client.term.termType}\x00`;
                            stream.write(rlogin);

                            pipedStream = stream;
                            self.client.term.output.pipe(stream);

                            stream.on('data', d => {
                                return self.client.term.rawWrite(d);
                            });

                            stream.on('close', () => {
                                restorePipe();
                                return sshClient.end();
                            });
                        });
                    });

                    sshClient.on('error', err => {
                        return self.client.log.info(`ArchaicNET SSH client error: ${err.message}`);
                    });

                    sshClient.on('close', hadError => {
                        if(hadError) {
                            self.client.warn('Closing ArchaicNET SSH due to error');
                        }
                        restorePipe();
                        return callback(null);
                    });

                    sshClient.connect( {
                        host        : self.config.host,
                        port        : self.config.sshPort,
                        username    : self.config.username,
                        password    : self.config.password,
                    });
                }
            ],
            err => {
                if(err) {
                    self.client.log.warn( { error : err.message }, 'ArchaicNET error');
                }

                //  if the client is stil here, go to previous
                if(!clientTerminated) {
                    self.prevMenu();
                }
            }
        );
    }
};

