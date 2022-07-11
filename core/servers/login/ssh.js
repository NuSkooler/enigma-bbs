/* jslint node: true */
'use strict';

//  ENiGMA½
const Config = require('../../config.js').get;
const baseClient = require('../../client.js');
const Log = require('../../logger.js').log;
const LoginServerModule = require('../../login_server_module.js');
const userLogin = require('../../user_login.js').userLogin;
const enigVersion = require('../../../package.json').version;
const theme = require('../../theme.js');
const stringFormat = require('../../string_format.js');
const { Errors, ErrorReasons } = require('../../enig_error.js');
const User = require('../../user.js');
const UserProps = require('../../user_property.js');

//  deps
const ssh2 = require('ssh2');
const fs = require('graceful-fs');
const util = require('util');
const _ = require('lodash');
const assert = require('assert');

const ModuleInfo = (exports.moduleInfo = {
    name: 'SSH',
    desc: 'SSH Server',
    author: 'NuSkooler',
    isSecure: true,
    packageName: 'codes.l33t.enigma.ssh.server',
});

function SSHClient(clientConn) {
    baseClient.Client.apply(this, arguments);

    //
    //  WARNING: Until we have emit 'ready', self.input, and self.output and
    //  not yet defined!
    //

    const self = this;

    clientConn.on('authentication', function authAttempt(ctx) {
        const username = ctx.username || '';
        const config = Config();
        self.isNewUser = (config.users.newUserNames || []).indexOf(username) > -1;

        self.log.trace(
            { method: ctx.method, username: username, newUser: self.isNewUser },
            'SSH authentication attempt'
        );

        const safeContextReject = param => {
            try {
                return ctx.reject(param);
            } catch (e) {
                return;
            }
        };

        const terminateConnection = () => {
            safeContextReject();
            return clientConn.end();
        };

        //  slow version to thwart brute force attacks
        const slowTerminateConnection = () => {
            setTimeout(() => {
                return terminateConnection();
            }, 2000);
        };

        const promptAndTerm = (msg, method = 'standard') => {
            if ('keyboard-interactive' === ctx.method) {
                ctx.prompt(msg);
            }
            return 'slow' === method ? slowTerminateConnection() : terminateConnection();
        };

        const accountAlreadyLoggedIn = username => {
            return promptAndTerm(
                `${username} is already connected to the system. Terminating connection.\n(Press any key to continue)`
            );
        };

        const accountDisabled = username => {
            return promptAndTerm(`${username} is disabled.\n(Press any key to continue)`);
        };

        const accountInactive = username => {
            return promptAndTerm(
                `${username} is waiting for +op activation.\n(Press any key to continue)`
            );
        };

        const accountLocked = username => {
            return promptAndTerm(
                `${username} is locked.\n(Press any key to continue)`,
                'slow'
            );
        };

        const isSpecialHandleError = err => {
            return [
                ErrorReasons.AlreadyLoggedIn,
                ErrorReasons.Disabled,
                ErrorReasons.Inactive,
                ErrorReasons.Locked,
            ].includes(err.reasonCode);
        };

        const handleSpecialError = (err, username) => {
            switch (err.reasonCode) {
                case ErrorReasons.AlreadyLoggedIn:
                    return accountAlreadyLoggedIn(username);
                case ErrorReasons.Inactive:
                    return accountInactive(username);
                case ErrorReasons.Disabled:
                    return accountDisabled(username);
                case ErrorReasons.Locked:
                    return accountLocked(username);
                default:
                    return terminateConnection();
            }
        };

        const authWithPasswordOrPubKey = authType => {
            if (
                User.AuthFactor1Types.SSHPubKey !== authType ||
                !self.user.isAuthenticated() ||
                !ctx.signature
            ) {
                //  step 1: login/auth using PubKey
                userLogin(self, ctx.username, ctx.password, { authType, ctx }, err => {
                    if (err) {
                        if (isSpecialHandleError(err)) {
                            return handleSpecialError(err, username);
                        }

                        if (Errors.BadLogin().code === err.code) {
                            return slowTerminateConnection();
                        }

                        return safeContextReject(SSHClient.ValidAuthMethods);
                    }

                    ctx.accept();
                });
            } else {
                //  step 2: verify signature
                const pubKeyActual = ssh2.utils.parseKey(
                    self.user.getProperty(UserProps.AuthPubKey)
                );
                if (!pubKeyActual || !pubKeyActual.verify(ctx.blob, ctx.signature)) {
                    return slowTerminateConnection();
                }
                return ctx.accept();
            }
        };

        const authKeyboardInteractive = () => {
            if (0 === username.length) {
                return safeContextReject();
            }

            const interactivePrompt = {
                prompt: `${ctx.username}'s password: `,
                echo: false,
            };

            ctx.prompt(interactivePrompt, function retryPrompt(answers) {
                userLogin(self, username, answers[0] || '', err => {
                    if (err) {
                        if (isSpecialHandleError(err)) {
                            return handleSpecialError(err, username);
                        }

                        if (Errors.BadLogin().code === err.code) {
                            return slowTerminateConnection();
                        }

                        const artOpts = {
                            client: self,
                            name: 'SSHPMPT.ASC',
                            readSauce: false,
                        };

                        theme.getThemeArt(artOpts, (err, artInfo) => {
                            if (err) {
                                interactivePrompt.prompt = `Access denied\n${ctx.username}'s password: `;
                            } else {
                                const newUserNameList =
                                    _.has(config, 'users.newUserNames') &&
                                    config.users.newUserNames.length > 0
                                        ? config.users.newUserNames
                                              .map(newName => '"' + newName + '"')
                                              .join(', ')
                                        : '(No new user names enabled!)';

                                interactivePrompt.prompt = `Access denied\n${stringFormat(
                                    artInfo.data,
                                    { newUserNames: newUserNameList }
                                )}\n${ctx.username}'s password:`;
                            }
                            return ctx.prompt(interactivePrompt, retryPrompt);
                        });
                    } else {
                        ctx.accept();
                    }
                });
            });
        };

        //
        //  If the system is open and |isNewUser| is true, the login
        //  sequence is hijacked in order to start the application process.
        //
        if (false === config.general.closedSystem && self.isNewUser) {
            return ctx.accept();
        }

        switch (ctx.method) {
            case 'password':
                return authWithPasswordOrPubKey(User.AuthFactor1Types.Password);
            //return authWithPassword();

            case 'publickey':
                return authWithPasswordOrPubKey(User.AuthFactor1Types.SSHPubKey);
            //return authWithPubKey();

            case 'keyboard-interactive':
                return authKeyboardInteractive();

            default:
                return safeContextReject(SSHClient.ValidAuthMethods);
        }
    });

    this.dataHandler = function (data) {
        self.emit('data', data);
    };

    this.updateTermInfo = function (info) {
        //
        //  From ssh2 docs:
        //  "rows and cols override width and height when rows and cols are non-zero."
        //
        let termHeight;
        let termWidth;

        if (info.rows > 0 && info.cols > 0) {
            termHeight = info.rows;
            termWidth = info.cols;
        } else if (info.width > 0 && info.height > 0) {
            termHeight = info.height;
            termWidth = info.width;
        }

        assert(_.isObject(self.term));

        //
        //  Note that if we fail here, connect.js attempts some non-standard
        //  queries/etc., and ultimately will default to 80x24 if all else fails
        //
        if (termHeight > 0 && termWidth > 0) {
            self.term.termHeight = termHeight;
            self.term.termWidth = termWidth;
        }

        if (
            _.isString(info.term) &&
            info.term.length > 0 &&
            'unknown' === self.term.termType
        ) {
            self.setTermType(info.term);
        }
    };

    clientConn.once('ready', function clientReady() {
        self.log.info('SSH authentication success');

        clientConn.on('session', accept => {
            const session = accept();

            session.on('pty', function pty(accept, reject, info) {
                self.log.debug(info, 'SSH pty event');

                if (_.isFunction(accept)) {
                    accept();
                }

                if (self.input) {
                    //  do we have I/O?
                    self.updateTermInfo(info);
                } else {
                    self.cachedTermInfo = info;
                }
            });

            session.on('env', (accept, reject, info) => {
                self.log.debug(info, 'SSH env event');

                if (_.isFunction(accept)) {
                    accept();
                }
            });

            session.on('shell', accept => {
                self.log.debug('SSH shell event');

                const channel = accept();

                self.setInputOutput(channel.stdin, channel.stdout);

                channel.stdin.on('data', self.dataHandler);

                if (self.cachedTermInfo) {
                    self.updateTermInfo(self.cachedTermInfo);
                    delete self.cachedTermInfo;
                }

                //  we're ready!
                const firstMenu = self.isNewUser
                    ? Config().loginServers.ssh.firstMenuNewUser
                    : Config().loginServers.ssh.firstMenu;
                self.emit('ready', { firstMenu: firstMenu });
            });

            session.on('window-change', (accept, reject, info) => {
                self.log.debug(info, 'SSH window-change event');

                if (self.input) {
                    self.updateTermInfo(info);
                } else {
                    self.cachedTermInfo = info;
                }
            });
        });
    });

    clientConn.once('end', () => {
        return self.emit('end'); //  remove client connection/tracking
    });

    clientConn.on('error', err => {
        self.log.warn({ error: err.message, code: err.code }, 'SSH connection error');
    });

    this.disconnect = function () {
        return clientConn.end();
    };
}

util.inherits(SSHClient, baseClient.Client);

SSHClient.ValidAuthMethods = ['password', 'keyboard-interactive', 'publickey'];

exports.getModule = class SSHServerModule extends LoginServerModule {
    constructor() {
        super();
    }

    createServer(cb) {
        const config = Config();
        if (true != config.loginServers.ssh.enabled) {
            return cb(null);
        }

        const serverConf = {
            hostKeys: [
                {
                    key: fs.readFileSync(config.loginServers.ssh.privateKeyPem),
                    passphrase: config.loginServers.ssh.privateKeyPass,
                },
            ],
            ident: 'enigma-bbs-' + enigVersion + '-srv',

            //  Note that sending 'banner' breaks at least EtherTerm!

            debug: sshDebugLine => {
                if (true === config.loginServers.ssh.traceConnections) {
                    Log.trace(`SSH: ${sshDebugLine}`);
                }
            },
            algorithms: config.loginServers.ssh.algorithms,
        };

        //
        //  This is a terrible hack, and we should not have to do it;
        //  However, as of this writing, NetRunner and SyncTERM both
        //  fail to respond to OpenSSH keep-alive pings (keepalive@openssh.com)
        //
        //  See also #399
        //
        ssh2.Server.KEEPALIVE_CLIENT_INTERVAL = 0;

        this.server = new ssh2.Server(serverConf);
        this.server.on('connection', (conn, info) => {
            Log.info(info, 'New SSH connection');
            this.handleNewClient(new SSHClient(conn), conn._sock, ModuleInfo);
        });

        return cb(null);
    }

    listen(cb) {
        const config = Config();
        if (true != config.loginServers.ssh.enabled) {
            return cb(null);
        }

        const port = parseInt(config.loginServers.ssh.port);
        if (isNaN(port)) {
            Log.error(
                { server: ModuleInfo.name, port: config.loginServers.ssh.port },
                'Cannot load server (invalid port)'
            );
            return cb(Errors.Invalid(`Invalid port: ${config.loginServers.ssh.port}`));
        }

        this.server.listen(port, config.loginServers.ssh.address, err => {
            if (!err) {
                Log.info(
                    { server: ModuleInfo.name, port: port },
                    'Listening for connections'
                );
            }
            return cb(err);
        });
    }
};
