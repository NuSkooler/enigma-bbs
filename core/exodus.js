/* jslint node: true */
'use strict';

//  ENiGMA½
const { MenuModule } = require('./menu_module.js');
const { resetScreen } = require('./ansi_term.js');
const Config = require('./config.js').get;
const { Errors } = require('./enig_error.js');
const Log = require('./logger.js').log;
const { getEnigmaUserAgent } = require('./misc_util.js');
const { trackDoorRunBegin, trackDoorRunEnd } = require('./door_util.js');

//  deps
const async = require('async');
const _ = require('lodash');
const joinPath = require('path').join;
const crypto = require('crypto');
const moment = require('moment');
const https = require('https');
const querystring = require('querystring');
const fs = require('fs-extra');
const SSHClient = require('ssh2').Client;

/*
    Configuration block:


    someDoor: {
        module: exodus
        config: {
            //  defaults
            ticketHost: oddnetwork.org
            ticketPort: 1984
            ticketPath: /exodus
            rejectUnauthorized: false // set to true to allow untrusted CA's (dangerous!)
            sshHost: oddnetwork.org
            sshPort: 22
            sshUser: exodus
            sshKeyPem: /path/to/enigma-bbs/misc/exodus.id_rsa

            //  optional
            caPem: /path/to/cacerts.pem // see https://curl.haxx.se/docs/caextract.html

            //  required
            board: XXXX
            key: XXXX
            door: some_door
        }
    }
*/

exports.moduleInfo = {
    name: 'Exodus',
    desc: 'Exodus Door Server Access Module - https://oddnetwork.org/exodus/',
    author: 'NuSkooler',
};

exports.getModule = class ExodusModule extends MenuModule {
    constructor(options) {
        super(options);

        this.config = options.menuConfig.config || {};
        this.config.ticketHost = this.config.ticketHost || 'oddnetwork.org';
        (this.config.ticketPort = this.config.ticketPort || 1984),
            (this.config.ticketPath = this.config.ticketPath || '/exodus');
        this.config.rejectUnauthorized = _.get(this.config, 'rejectUnauthorized', true);
        this.config.sshHost = this.config.sshHost || this.config.ticketHost;
        this.config.sshPort = this.config.sshPort || 22;
        this.config.sshUser = this.config.sshUser || 'exodus_server';
        this.config.sshKeyPem =
            this.config.sshKeyPem || joinPath(Config().paths.misc, 'exodus.id_rsa');
    }

    initSequence() {
        const self = this;
        let clientTerminated = false;

        async.waterfall(
            [
                function validateConfig(callback) {
                    //  very basic validation on optionals
                    async.each(
                        ['board', 'key', 'door'],
                        (key, next) => {
                            return _.isString(self.config[key])
                                ? next(null)
                                : next(Errors.MissingConfig(`Config requires "${key}"!`));
                        },
                        callback
                    );
                },
                function loadCertAuthorities(callback) {
                    if (!_.isString(self.config.caPem)) {
                        return callback(null, null);
                    }

                    fs.readFile(self.config.caPem, (err, certAuthorities) => {
                        return callback(err, certAuthorities);
                    });
                },
                function getTicket(certAuthorities, callback) {
                    const now = moment.utc().unix();
                    const sha256 = crypto
                        .createHash('sha256')
                        .update(`${self.config.key}${now}`)
                        .digest('hex');
                    const token = `${sha256}|${now}`;

                    const postData = querystring.stringify({
                        token: token,
                        board: self.config.board,
                        user: self.client.user.username,
                        door: self.config.door,
                    });

                    const reqOptions = {
                        hostname: self.config.ticketHost,
                        port: self.config.ticketPort,
                        path: self.config.ticketPath,
                        rejectUnauthorized: self.config.rejectUnauthorized,
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/x-www-form-urlencoded',
                            'Content-Length': postData.length,
                            'User-Agent': getEnigmaUserAgent(),
                        },
                    };

                    if (certAuthorities) {
                        reqOptions.ca = certAuthorities;
                    }

                    let ticket = '';
                    const req = https.request(reqOptions, res => {
                        res.on('data', data => {
                            ticket += data;
                        });

                        res.on('end', () => {
                            if (ticket.length !== 36) {
                                return callback(
                                    Errors.Invalid(`Invalid Exodus ticket: ${ticket}`)
                                );
                            }

                            return callback(null, ticket);
                        });
                    });

                    req.on('error', err => {
                        return callback(Errors.General(`Exodus error: ${err.message}`));
                    });

                    req.write(postData);
                    req.end();
                },
                function loadPrivateKey(ticket, callback) {
                    fs.readFile(self.config.sshKeyPem, (err, privateKey) => {
                        return callback(err, ticket, privateKey);
                    });
                },
                function establishSecureConnection(ticket, privateKey, callback) {
                    let pipeRestored = false;
                    let pipedStream;
                    let doorTracking;

                    function restorePipe() {
                        if (pipedStream && !pipeRestored && !clientTerminated) {
                            self.client.term.output.unpipe(pipedStream);
                            self.client.term.output.resume();

                            if (doorTracking) {
                                trackDoorRunEnd(doorTracking);
                            }
                        }
                    }

                    self.client.term.write(resetScreen());
                    self.client.term.write(
                        'Connecting to Exodus server, please wait...\n'
                    );

                    const sshClient = new SSHClient();

                    const window = {
                        rows: self.client.term.termHeight,
                        cols: self.client.term.termWidth,
                        width: 0,
                        height: 0,
                        term: 'vt100', //  Want to pass |self.client.term.termClient| here, but we end up getting hung up on :(
                    };

                    const options = {
                        env: {
                            exodus: ticket,
                        },
                    };

                    sshClient.on('ready', () => {
                        self.client.once('end', () => {
                            self.client.log.info(
                                'Connection ended. Terminating Exodus connection'
                            );
                            clientTerminated = true;
                            return sshClient.end();
                        });

                        sshClient.shell(window, options, (err, stream) => {
                            doorTracking = trackDoorRunBegin(
                                self.client,
                                `exodus_${self.config.door}`
                            );

                            pipedStream = stream; //  :TODO: ewwwwwwwww hack
                            self.client.term.output.pipe(stream);

                            stream.on('data', d => {
                                return self.client.term.rawWrite(d);
                            });

                            stream.on('close', () => {
                                restorePipe();
                                return sshClient.end();
                            });

                            stream.on('error', err => {
                                Log.warn(
                                    { error: err.message },
                                    'Exodus SSH client stream error'
                                );
                            });
                        });
                    });

                    sshClient.on('close', () => {
                        restorePipe();
                        return callback(null);
                    });

                    sshClient.connect({
                        host: self.config.sshHost,
                        port: self.config.sshPort,
                        username: self.config.sshUser,
                        privateKey: privateKey,
                    });
                },
            ],
            err => {
                if (err) {
                    self.client.log.warn({ error: err.message }, 'Exodus error');
                }

                if (!clientTerminated) {
                    self.prevMenu();
                }
            }
        );
    }
};
