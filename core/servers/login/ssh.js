/* jslint node: true */
'use strict';

//  ENiGMA½
const Config            = require('../../config.js').get;
const baseClient        = require('../../client.js');
const Log               = require('../../logger.js').log;
const LoginServerModule = require('../../login_server_module.js');
const userLogin         = require('../../user_login.js').userLogin;
const enigVersion       = require('../../../package.json').version;
const theme             = require('../../theme.js');
const stringFormat      = require('../../string_format.js');

//  deps
const ssh2          = require('ssh2');
const fs            = require('graceful-fs');
const util          = require('util');
const _             = require('lodash');
const assert        = require('assert');

const ModuleInfo = exports.moduleInfo = {
    name        : 'SSH',
    desc        : 'SSH Server',
    author      : 'NuSkooler',
    isSecure    : true,
    packageName : 'codes.l33t.enigma.ssh.server',
};

function SSHClient(clientConn) {
    baseClient.Client.apply(this, arguments);

    //
    //  WARNING: Until we have emit 'ready', self.input, and self.output and
    //  not yet defined!
    //

    const self = this;

    let loginAttempts = 0;

    clientConn.on('authentication', function authAttempt(ctx) {
        const username  = ctx.username || '';
        const password  = ctx.password || '';

        const config    = Config();
        self.isNewUser  = (config.users.newUserNames || []).indexOf(username) > -1;

        self.log.trace( { method : ctx.method, username : username, newUser : self.isNewUser }, 'SSH authentication attempt');

        function terminateConnection() {
            ctx.reject();
            return clientConn.end();
        }

        function alreadyLoggedIn(username) {
            ctx.prompt(`${username} is already connected to the system. Terminating connection.\n(Press any key to continue)`);
            return terminateConnection();
        }

        //
        //  If the system is open and |isNewUser| is true, the login
        //  sequence is hijacked in order to start the applicaiton process.
        //
        if(false === config.general.closedSystem && self.isNewUser) {
            return ctx.accept();
        }

        if(username.length > 0 && password.length > 0) {
            loginAttempts += 1;

            userLogin(self, ctx.username, ctx.password, function authResult(err) {
                if(err) {
                    if(err.existingConn) {
                        return alreadyLoggedIn(username);
                    }

                    return ctx.reject(SSHClient.ValidAuthMethods);
                }

                ctx.accept();
            });
        } else {
            if(-1 === SSHClient.ValidAuthMethods.indexOf(ctx.method)) {
                return ctx.reject(SSHClient.ValidAuthMethods);
            }

            if(0 === username.length) {
                //  :TODO: can we display something here?
                return ctx.reject();
            }

            const interactivePrompt = { prompt : `${ctx.username}'s password: `, echo : false };

            ctx.prompt(interactivePrompt, function retryPrompt(answers) {
                loginAttempts += 1;

                userLogin(self, username, (answers[0] || ''), err => {
                    if(err) {
                        if(err.existingConn) {
                            return alreadyLoggedIn(username);
                        }

                        if(loginAttempts >= config.general.loginAttempts) {
                            return terminateConnection();
                        }

                        const artOpts = {
                            client      : self,
                            name        : 'SSHPMPT.ASC',
                            readSauce   : false,
                        };

                        theme.getThemeArt(artOpts, (err, artInfo) => {
                            if(err) {
                                interactivePrompt.prompt = `Access denied\n${ctx.username}'s password: `;
                            } else {
                                const newUserNameList = _.has(config, 'users.newUserNames') && config.users.newUserNames.length > 0 ?
                                    config.users.newUserNames.map(newName => '"' + newName + '"').join(', ') :
                                    '(No new user names enabled!)';

                                interactivePrompt.prompt = `Access denied\n${stringFormat(artInfo.data, { newUserNames : newUserNameList })}\n${ctx.username}'s password'`;
                            }
                            return ctx.prompt(interactivePrompt, retryPrompt);
                        });
                    } else {
                        ctx.accept();
                    }
                });
            });
        }
    });

    this.dataHandler = function(data) {
        self.emit('data', data);
    };

    this.updateTermInfo = function(info) {
        //
        //  From ssh2 docs:
        //  "rows and cols override width and height when rows and cols are non-zero."
        //
        let termHeight;
        let termWidth;

        if(info.rows > 0 && info.cols > 0) {
            termHeight  = info.rows;
            termWidth   = info.cols;
        } else if(info.width > 0 && info.height > 0) {
            termHeight  = info.height;
            termWidth   = info.width;
        }

        assert(_.isObject(self.term));

        //
        //  Note that if we fail here, connect.js attempts some non-standard
        //  queries/etc., and ultimately will default to 80x24 if all else fails
        //
        if(termHeight > 0 && termWidth > 0) {
            self.term.termHeight = termHeight;
            self.term.termWidth = termWidth;

            self.clearMciCache();   //  term size changes = invalidate cache
        }

        if(_.isString(info.term) && info.term.length > 0 && 'unknown' === self.term.termType) {
            self.setTermType(info.term);
        }
    };

    clientConn.once('ready', function clientReady() {
        self.log.info('SSH authentication success');

        clientConn.on('session', accept => {

            const session = accept();

            session.on('pty', function pty(accept, reject, info) {
                self.log.debug(info, 'SSH pty event');

                if(_.isFunction(accept)) {
                    accept();
                }

                if(self.input) {    //  do we have I/O?
                    self.updateTermInfo(info);
                } else {
                    self.cachedTermInfo = info;
                }
            });

            session.on('shell', accept => {
                self.log.debug('SSH shell event');

                const channel = accept();

                self.setInputOutput(channel.stdin, channel.stdout);

                channel.stdin.on('data', self.dataHandler);

                if(self.cachedTermInfo) {
                    self.updateTermInfo(self.cachedTermInfo);
                    delete self.cachedTermInfo;
                }

                //  we're ready!
                const firstMenu = self.isNewUser ? Config().loginServers.ssh.firstMenuNewUser : Config().loginServers.ssh.firstMenu;
                self.emit('ready', { firstMenu : firstMenu } );
            });

            session.on('window-change', (accept, reject, info) => {
                self.log.debug(info, 'SSH window-change event');

                if(self.input) {
                    self.updateTermInfo(info);
                } else {
                    self.cachedTermInfo = info;
                }
            });

        });
    });

    clientConn.on('end', () => {
        self.emit('end');   //  remove client connection/tracking
    });

    clientConn.on('error', err => {
        self.log.warn( { error : err.message, code : err.code }, 'SSH connection error');
    });
}

util.inherits(SSHClient, baseClient.Client);

SSHClient.ValidAuthMethods = [ 'password', 'keyboard-interactive' ];

exports.getModule = class SSHServerModule extends LoginServerModule {
    constructor() {
        super();
    }

    createServer() {
        const config = Config();
        if(true != config.loginServers.ssh.enabled) {
            return;
        }

        const serverConf = {
            hostKeys : [
                {
                    key         : fs.readFileSync(config.loginServers.ssh.privateKeyPem),
                    passphrase  : config.loginServers.ssh.privateKeyPass,
                }
            ],
            ident : 'enigma-bbs-' + enigVersion + '-srv',

            //  Note that sending 'banner' breaks at least EtherTerm!

            debug : (sshDebugLine) => {
                if(true === config.loginServers.ssh.traceConnections) {
                    Log.trace(`SSH: ${sshDebugLine}`);
                }
            },
            algorithms : config.loginServers.ssh.algorithms,
        };

        this.server = ssh2.Server(serverConf);
        this.server.on('connection', (conn, info) => {
            Log.info(info, 'New SSH connection');
            this.handleNewClient(new SSHClient(conn), conn._sock, ModuleInfo);
        });
    }

    listen() {
        const config = Config();
        if(true != config.loginServers.ssh.enabled) {
            return true;    //  no server, but not an error
        }

        const port = parseInt(config.loginServers.ssh.port);
        if(isNaN(port)) {
            Log.error( { server : ModuleInfo.name, port : config.loginServers.ssh.port }, 'Cannot load server (invalid port)' );
            return false;
        }

        this.server.listen(port);
        Log.info( { server : ModuleInfo.name, port : port }, 'Listening for connections' );
        return true;
    }
};
