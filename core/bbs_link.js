/* jslint node: true */
'use strict';

const { MenuModule } = require('./menu_module.js');
const { resetScreen } = require('./ansi_term.js');
const { Errors } = require('./enig_error.js');
const { trackDoorRunBegin, trackDoorRunEnd } = require('./door_util.js');

//  deps
const async = require('async');
const http = require('http');
const net = require('net');
const crypto = require('crypto');

const packageJson = require('../package.json');

/*
    Expected configuration block:

    {
        module: bbs_link
        ...
        config: {
            sysCode: XXXXX
            authCode: XXXXX
            schemeCode: XXXX
            door: lord

            //  default hoss: games.bbslink.net
            host: games.bbslink.net

            //  defualt port: 23
            port: 23
        }
    }
*/

//  :TODO: BUG: When a client disconnects, it's not handled very well -- the log is spammed with tons of errors
//  :TODO: ENH: Support nodeMax and tooManyArt

exports.moduleInfo = {
    name: 'BBSLink',
    desc: 'BBSLink Access Module',
    author: 'NuSkooler',
};

exports.getModule = class BBSLinkModule extends MenuModule {
    constructor(options) {
        super(options);

        this.config = options.menuConfig.config;
        this.config.host = this.config.host || 'games.bbslink.net';
        this.config.port = this.config.port || 23;
    }

    initSequence() {
        let token;
        let randomKey;
        let clientTerminated;
        const self = this;

        async.series(
            [
                function validateConfig(callback) {
                    return self.validateConfigFields(
                        {
                            host: 'string',
                            sysCode: 'string',
                            authCode: 'string',
                            schemeCode: 'string',
                            door: 'string',
                            port: 'number',
                        },
                        callback
                    );
                },
                function acquireToken(callback) {
                    //
                    //  Acquire an authentication token
                    //
                    crypto.randomBytes(16, function rand(ex, buf) {
                        if (ex) {
                            callback(ex);
                        } else {
                            randomKey = buf.toString('base64').substr(0, 6);
                            self.simpleHttpRequest(
                                '/token.php?key=' + randomKey,
                                null,
                                function resp(err, body) {
                                    if (err) {
                                        callback(err);
                                    } else {
                                        token = body.trim();
                                        self.client.log.trace(
                                            { token: token },
                                            'BBSLink token'
                                        );
                                        callback(null);
                                    }
                                }
                            );
                        }
                    });
                },
                function authenticateToken(callback) {
                    //
                    //  Authenticate the token we acquired previously
                    //
                    const headers = {
                        'X-User': self.client.user.userId.toString(),
                        'X-System': self.config.sysCode,
                        'X-Auth': crypto
                            .createHash('md5')
                            .update(self.config.authCode + token)
                            .digest('hex'),
                        'X-Code': crypto
                            .createHash('md5')
                            .update(self.config.schemeCode + token)
                            .digest('hex'),
                        'X-Rows': self.client.term.termHeight.toString(),
                        'X-Key': randomKey,
                        'X-Door': self.config.door,
                        'X-Token': token,
                        'X-Type': 'enigma-bbs',
                        'X-Version': packageJson.version,
                    };

                    self.simpleHttpRequest(
                        '/auth.php?key=' + randomKey,
                        headers,
                        function resp(err, body) {
                            const status = body.trim();

                            if ('complete' === status) {
                                return callback(null);
                            }
                            return callback(
                                Errors.AccessDenied(
                                    `Bad authentication status: ${status}`
                                )
                            );
                        }
                    );
                },
                function createTelnetBridge(callback) {
                    //
                    //  Authentication with BBSLink successful. Now, we need to create a telnet
                    //  bridge from us to them
                    //
                    const connectOpts = {
                        port: self.config.port,
                        host: self.config.host,
                    };

                    let dataOut;

                    self.client.term.write(resetScreen());
                    self.client.term.write(
                        `  Connecting to ${self.config.host}, please wait...\n`
                    );

                    const doorTracking = trackDoorRunBegin(
                        self.client,
                        `bbslink_${self.config.door}`
                    );

                    const bridgeConnection = net.createConnection(
                        connectOpts,
                        function connected() {
                            self.client.log.info(
                                connectOpts,
                                'BBSLink bridge connection established'
                            );

                            dataOut = data => {
                                return bridgeConnection.write(data);
                            };

                            self.client.term.output.on('data', dataOut);

                            self.client.once('end', function clientEnd() {
                                self.client.log.info(
                                    'Connection ended. Terminating BBSLink connection'
                                );
                                clientTerminated = true;
                                bridgeConnection.end();
                            });
                        }
                    );

                    const restore = () => {
                        if (dataOut && self.client.term.output) {
                            self.client.term.output.removeListener('data', dataOut);
                            dataOut = null;
                        }

                        trackDoorRunEnd(doorTracking);
                    };

                    bridgeConnection.on('data', function incomingData(data) {
                        //  pass along
                        //  :TODO: just pipe this as well
                        self.client.term.rawWrite(data);
                    });

                    bridgeConnection.on('end', function connectionEnd() {
                        restore();
                        return callback(
                            clientTerminated
                                ? Errors.General('Client connection terminated')
                                : null
                        );
                    });

                    bridgeConnection.on('error', function error(err) {
                        self.client.log.info(
                            'BBSLink bridge connection error: ' + err.message
                        );
                        restore();
                        return callback(err);
                    });
                },
            ],
            function complete(err) {
                if (err) {
                    self.client.log.warn(
                        { error: err.toString() },
                        'BBSLink connection error'
                    );
                }

                if (!clientTerminated) {
                    self.prevMenu();
                }
            }
        );
    }

    simpleHttpRequest(path, headers, cb) {
        const getOpts = {
            host: this.config.host,
            path: path,
            headers: headers,
        };

        const req = http.get(getOpts, function response(resp) {
            let data = '';

            resp.on('data', function chunk(c) {
                data += c;
            });

            resp.on('end', function respEnd() {
                cb(null, data);
                req.end();
            });
        });

        req.on('error', function reqErr(err) {
            cb(err);
        });
    }
};
