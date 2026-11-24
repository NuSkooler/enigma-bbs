/* jslint node: true */
'use strict';

//  ENiGMA½
const Config = require('../../config.js').get;
const baseClient = require('../../client.js');
const Log = require('../../logger.js').log;
const LoginServerModule = require('../../login_server_module.js');
const { userLogin, checkSSHPubKey } = require('../../user_login.js');
const enigVersion = require('../../../package.json').version;
const theme = require('../../theme.js');
const stringFormat = require('../../string_format.js');
const { Errors, ErrorReasons } = require('../../enig_error.js');
const { listenServer } = require('../../server_listen.js');
const User = require('../../user.js');
const ACS = require('../../acs.js');
const { stripAllControlCodes } = require('../../string_util.js');

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

//
//  Some clients report a terminal size that has nothing to do with their window;
//  see the 'untrustedTermSizeClients' config for details.
//
function isUntrustedTermSizeClient(clientIdent) {
    const untrusted = _.get(Config(), 'loginServers.ssh.untrustedTermSizeClients', []);

    //
    //  Exact match, not substring: SyncTERM reports the actual size but identifies as
    //  "SSH-2.0-cryptlib(SBBS)" on 1.9rc4 and "SSH-2.0-SyncTERM_<version>" on
    //  newer builds, so matching "cryptlib" loosely would sweep it in alongside
    //  stock "SSH-2.0-cryptlib".
    //
    const ident = clientIdent.toLowerCase();
    return untrusted.some(name => name.toLowerCase() === ident);
}

exports.isUntrustedTermSizeClient = isUntrustedTermSizeClient;

function SSHClient(clientConn, connInfo) {
    baseClient.Client.apply(this, arguments);

    //
    //  WARNING: Until we have emit 'ready', self.input, and self.output and
    //  not yet defined!
    //

    const self = this;

    self.sshClientIdent = _.get(connInfo, 'header.identRaw');

    //
    //  The connection counts against general.maxConnections from here, but
    //  the idle monitor starts only with the shell, and SSH keepalives are
    //  off (see createServer()). A caller that stops part way through key
    //  exchange or authentication would hold its node until it closed the
    //  connection itself, so it gets loginTimeoutSeconds to reach the shell
    //  (#1080). Cleared once the shell is open, or the connection is gone.
    //
    const loginTimeoutMs = SSHClient.getLoginTimeoutMs();
    if (loginTimeoutMs > 0) {
        self.loginTimer = setTimeout(() => {
            delete self.loginTimer;
            (self.log || Log).info(
                { loginTimeoutSeconds: loginTimeoutMs / 1000 },
                'SSH connection did not reach a shell in time; ending it'
            );
            return self.endAndClose();
        }, loginTimeoutMs);
        //  this timer alone must not keep the process up
        self.loginTimer.unref();
    }

    this.clearLoginTimer = function () {
        if (self.loginTimer) {
            clearTimeout(self.loginTimer);
            delete self.loginTimer;
        }
    };

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
            } catch (err) {
                self.log.trace({ error: err.message }, 'SSH context reject failed');
                return;
            }
        };

        const terminateConnection = () => {
            safeContextReject();
            return clientConn.end();
        };

        //
        //  A refused caller (see refuseConnection()) is shown why during
        //  authentication, the only point before a shell where an SSH server
        //  can put text in front of the user: keyboard-interactive with no
        //  prompts, the message as its instruction, then a disconnect once
        //  the client answers. OpenSSH shows the text and needs no key press.
        //  Other methods are steered to keyboard-interactive (a client may
        //  try a few before it gets there), then ended.
        //
        const showRefusal = () => {
            if ('keyboard-interactive' === ctx.method) {
                return ctx.prompt([], '', self.refusalMessage, () => clientConn.end());
            }

            self.refusalAttempts = (self.refusalAttempts || 0) + 1;
            if (self.refusalAttempts <= SSHClient.RefusalSteerAttempts) {
                return safeContextReject(['keyboard-interactive']);
            }

            return terminateConnection();
        };

        //
        //  Checked before anything else, so a refused new user is not
        //  accepted either, and a caller refused at login cannot try again.
        //
        if (self.refused) {
            return showRefusal();
        }

        //  slow version to thwart brute force attacks
        const slowTerminateConnection = () => {
            setTimeout(() => {
                return terminateConnection();
            }, SSHClient.SlowRefusalMs);
        };

        //
        //  A login refused for the account's state (already connected,
        //  disabled, inactive, locked) is shown the same way as a refusal at
        //  connect time: see showRefusal(). A password or public key login
        //  cannot carry text, so it is steered to keyboard-interactive, where
        //  the next attempt shows it (#1081). 'slow' holds the answer back as
        //  slowTerminateConnection() does.
        //
        //  The connection is refused at once, so any request that arrives
        //  while a slow answer waits is refused too; only this request's
        //  answer waits.
        //
        //  The caller is no longer anyone: an already connected refusal
        //  comes after the password or key checked out, with this client's
        //  User loaded, and until the connection closes (up to
        //  RefusalTimeoutMs) the client is still tracked. With that User it
        //  would count as the user online (userLogin()'s already connected
        //  check, the who's online list) and be logged off as them when it
        //  ends. It gets a fresh, unauthenticated User instead. Nothing the
        //  login stored is undone.
        //
        const refuseLogin = (msg, method = 'standard') => {
            self.user = new User();
            self.acs = new ACS({ client: self, user: self.user });
            self.refuseConnection(msg);
            if ('slow' !== method) {
                return showRefusal();
            }

            //  a keyboard-interactive request the client gave up on (it sent
            //  another) is not answered
            let abandoned = false;
            if (_.isFunction(ctx.once)) {
                ctx.once('abort', () => (abandoned = true));
            }
            setTimeout(() => {
                if (self.clientEnded || abandoned) {
                    return; //  gone while the answer waited
                }
                return showRefusal();
            }, SSHClient.SlowRefusalMs);
        };

        const accountAlreadyLoggedIn = username => {
            return refuseLogin(
                `${username} is already connected to the system. Terminating connection.`
            );
        };

        const accountDisabled = username => {
            return refuseLogin(`${username} is disabled.`);
        };

        const accountInactive = username => {
            return refuseLogin(`${username} is waiting for +op activation.`);
        };

        const accountLocked = username => {
            return refuseLogin(`${username} is locked.`, 'slow');
        };

        //  the connection ended while the login was under way (see
        //  userLogin()): there is nothing to answer, and nobody to answer
        const isClientEnded = err => ErrorReasons.ClientEnded === err.reasonCode;

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

        //
        //  A login that checked out, unless the connection was refused
        //  meanwhile: a keyboard-interactive request the client abandons for
        //  another is still being checked while the other is handled, and
        //  the other can be refused first.
        //
        const acceptLogin = () => {
            if (self.refused) {
                return showRefusal();
            }
            return ctx.accept();
        };

        //  a failed userLogin() or checkSSHPubKey()
        const handleLoginError = err => {
            if (isClientEnded(err)) {
                return;
            }

            if (isSpecialHandleError(err)) {
                return handleSpecialError(err, username);
            }

            if (Errors.BadLogin().code === err.code) {
                return slowTerminateConnection();
            }

            return safeContextReject(SSHClient.ValidAuthMethods);
        };

        const authWithPassword = () => {
            //
            //  A password change request (RFC 4252 section 8) carries the old
            //  and new passwords, an object here. Changing a password this
            //  way is not supported: refused, as no attempt at a login.
            //
            if (!_.isString(ctx.password)) {
                return safeContextReject(SSHClient.ValidAuthMethods);
            }

            const authType = User.AuthFactor1Types.Password;
            userLogin(self, ctx.username, ctx.password, { authType, ctx }, err => {
                if (err) {
                    return handleLoginError(err);
                }
                return acceptLogin();
            });
        };

        //
        //  A publickey request comes in two kinds (RFC 4252 section 7):
        //
        //  - Without a signature, a query: would this key do? Anyone may know
        //    a public key, so this is not a login. The key is only compared
        //    with the one stored for the user, and accept() answers "yes"
        //    (SSH_MSG_USERAUTH_PK_OK).
        //
        //  - With a signature, made with the key's private half over the
        //    session: that, once verified, is the proof. Only then is the
        //    user logged in (the key compared again, account status, and so
        //    on), and accept() lets them in. A client need not have asked
        //    first.
        //
        //  ssh2 verifies nothing itself: accept() on a signed request lets
        //  the caller in whatever the signature is.
        //
        const authWithPubKey = () => {
            if (!ctx.signature) {
                return checkSSHPubKey(self, ctx.username, ctx, err => {
                    if (err) {
                        return handleLoginError(err);
                    }
                    return acceptLogin();
                });
            }

            if (!SSHClient.isValidPubKeySignature(ctx)) {
                self.log.warn(
                    {
                        username,
                        algo: _.get(ctx, 'key.algo'),
                        ip: self.remoteAddress,
                    },
                    'SSH public key signature did not verify'
                );
                return slowTerminateConnection();
            }

            const authType = User.AuthFactor1Types.SSHPubKey;
            userLogin(self, ctx.username, ctx.password, { authType, ctx }, err => {
                if (err) {
                    return handleLoginError(err);
                }
                return acceptLogin();
            });
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
                //
                //  ssh2 calls back with an Error, not answers, when the
                //  client abandons the prompt for another request: there is
                //  no password, so no login attempt, and nothing to answer.
                //
                if (!Array.isArray(answers)) {
                    return;
                }

                userLogin(self, username, answers[0] || '', err => {
                    if (err) {
                        if (isClientEnded(err)) {
                            return;
                        }

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
                        acceptLogin();
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
                return authWithPassword();

            case 'publickey':
                return authWithPubKey();

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
        //  The size in characters is rows and cols. ssh2 also passes width
        //  and height, but those are the window in pixels (RFC 4254 6.2;
        //  ssh2's own client sends 640x480), not a size in characters, so
        //  they are not used: a client that sends 0 rows and cols leaves the
        //  size alone, and connect.js finds it (see below) (#1081).
        //
        let termHeight;
        let termWidth;

        if (info.rows > 0 && info.cols > 0) {
            termHeight = info.rows;
            termWidth = info.cols;
        }

        assert(_.isObject(self.term));

        //
        //  Leaving the size at 0 hands the job to connect.js, which asks the
        //  terminal directly via CPR (the only trustworthy answer from these
        //  clients) and otherwise assumes 80x25. See #414. There is nothing
        //  worth keeping from the reported size: it is a constant compiled into
        //  the client's SSH library, so it says nothing about the real window.
        //
        if (isUntrustedTermSizeClient(self.sshClientIdent)) {
            self.log.debug(
                { clientIdent: self.sshClientIdent, termHeight, termWidth },
                'Ignoring terminal size reported by untrusted SSH client'
            );
            termHeight = 0;
            termWidth = 0;
        }

        //
        //  Note that if we fail here, connect.js attempts some non-standard
        //  queries/etc., and ultimately will default to 80x25 if all else fails
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

    //
    //  Until the shell is open there is no terminal to apply pty or
    //  window-change info to, so it is kept for then. Merged, not replaced: a
    //  window-change carries only the size, and must not throw away the
    //  terminal type an earlier pty request brought (#1017). Nor does a size
    //  of 0, which says nothing (see updateTermInfo()), replace an earlier
    //  one (#1081).
    //
    this.cacheTermInfo = function (info) {
        const cached = Object.assign({}, self.cachedTermInfo, info);
        if (self.cachedTermInfo && !(info.rows > 0 && info.cols > 0)) {
            cached.rows = self.cachedTermInfo.rows;
            cached.cols = self.cachedTermInfo.cols;
        }
        self.cachedTermInfo = cached;
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
                    self.cacheTermInfo(info);
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

                self.clearLoginTimer();

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
                    self.cacheTermInfo(info);
                }
            });
        });
    });

    //  Guard against both 'end' and 'close' firing for the same disconnect
    let endEmitted = false;
    const emitEnd = () => {
        self.clearLoginTimer();
        if (!endEmitted) {
            endEmitted = true;
            self.emit('end'); //  remove client connection/tracking
        }
    };

    clientConn.on('end', emitEnd);
    clientConn.on('close', () => {
        //
        //  Only once the socket has closed is endAndClose()'s timer no longer
        //  needed: 'end' is the caller's FIN alone, and a socket can stay
        //  half open after it.
        //
        clearTimeout(self.closeGraceTimer);
        return emitEnd(); //  'close' alone on abrupt disconnects where 'end' is not emitted
    });

    clientConn.on('error', err => {
        (self.log || Log).warn(
            { error: err.message, code: err.code },
            'SSH connection error'
        );
        emitEnd();
    });

    this.disconnect = function () {
        return clientConn.end();
    };

    //
    //  End the client (Client.prototype.end(): its teardown, then a
    //  disconnect), and close the socket outright shortly after if the
    //  caller has not closed its side: ending sends a disconnect and a FIN,
    //  and a caller that never answers would leave the socket half closed.
    //  Used where this side gives up on a connection that has not reached a
    //  shell: a refusal (see refuseConnection()) and the login timeout.
    //
    this.endAndClose = function () {
        self.end();

        clearTimeout(self.closeGraceTimer);
        self.closeGraceTimer = setTimeout(() => {
            if (self.rawSocket && !self.rawSocket.destroyed) {
                self.rawSocket.destroy();
            }
        }, SSHClient.EndCloseGraceMs);
        //  this timer alone must not keep the process up
        self.closeGraceTimer.unref();
    };

    //
    //  Called instead of tracking the client when every node is busy, and
    //  for a login refused for the account's state (see refuseLogin()).
    //  There is no terminal yet (that comes with the shell), so the message
    //  is shown during authentication; see showRefusal(). The
    //  timer ends the connection whatever state it is in, and closes the
    //  socket outright shortly after if the caller has not closed its side,
    //  so a refused caller cannot hold a socket open.
    //
    //  The client's own teardown (Client.prototype.end(), which releases
    //  what the constructor registered) runs when the connection closes, or
    //  when the timer fires, whichever comes first; end() does it once.
    //  Not before: ending the client is what disconnects it.
    //
    //  A connection is refused once; a later call changes nothing.
    //
    this.refuseConnection = function (message) {
        if (self.refused) {
            return;
        }
        self.refused = true;

        //  only an art file (the busy message's) can leave nothing to show
        self.refusalMessage =
            SSHClient.toInstructionText(message) || LoginServerModule.AllNodesBusyMessage;

        //  the refusal has its own, shorter, timer
        self.clearLoginTimer();

        const refusalTimer = setTimeout(() => {
            self.log.debug('Refused SSH connection still open; ending it');
            return self.endAndClose();
        }, SSHClient.RefusalTimeoutMs);

        clientConn.once('close', () => {
            clearTimeout(refusalTimer);
            self.end();
        });
    };
}

util.inherits(SSHClient, baseClient.Client);

SSHClient.ValidAuthMethods = ['password', 'keyboard-interactive', 'publickey'];

//  How long a refused connection may stay open to be shown why, and how many
//  other authentication methods it may try before keyboard-interactive
SSHClient.RefusalTimeoutMs = 10000;
SSHClient.RefusalSteerAttempts = 3;

//
//  |message| as the instruction text of a keyboard-interactive request, the
//  form a refusal is shown in. That is plain text: OpenSSH shows a control
//  character in it as an escape (ESC as "\033"), so ANSI sequences and pipe
//  codes are removed, as is any other control character but a line feed or
//  tab: C0, DEL and C1, and the Unicode format characters that change how
//  text around them is ordered or shown (bidi embeddings, overrides and
//  isolates, zero width characters, the BOM), so the text reads as written.
//  OSC, DCS, APC, PM and SOS strings go whole, up to their terminator (BEL
//  or ESC backslash), or to the end if there is none. A line ends with a
//  line feed alone, and trailing blank lines go.
//  The busy refusal's message can come from an art file (see
//  getAllNodesBusyMessage() in core/login_server_module.js).
//
SSHClient.toInstructionText = function (message) {
    const text = String(message || '').replace(
        /\x1b[\]P^_X][\s\S]*?(?:\x07|\x1b\\|$)/g, //  eslint-disable-line no-control-regex
        ''
    );
    return stripAllControlCodes(text)
        .replace(/\r\n?/g, '\n')
        .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '') //  eslint-disable-line no-control-regex
        .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, '')
        .trimEnd();
};

//  How long a bad login, or a login refused for a locked account, waits for
//  its answer, to slow down brute force attempts
SSHClient.SlowRefusalMs = 2000;

//  How long a caller has to close its side after endAndClose() (a refusal or
//  the login timeout) before the socket is closed outright
SSHClient.EndCloseGraceMs = 2000;

//
//  How long a connection may take to reach the shell (key exchange,
//  authentication, the session and shell requests), from
//  loginServers.ssh.loginTimeoutSeconds. 0 turns the limit off; anything
//  else that is not a positive number gets the default, as OpenSSH's
//  LoginGraceTime.
//
//  A Node timer holds at most 2^31 - 1 ms (about 24.8 days); a longer one
//  fires after 1 ms instead, which would end every connection at once. A
//  larger value is therefore held to that.
//
SSHClient.DefaultLoginTimeoutSeconds = 120;
SSHClient.MaxLoginTimeoutSeconds = Math.floor((2 ** 31 - 1) / 1000); //  2147483

SSHClient.getLoginTimeoutMs = function () {
    const seconds = _.get(Config(), 'loginServers.ssh.loginTimeoutSeconds');
    if (0 === seconds) {
        return 0;
    }
    if (_.isFinite(seconds) && seconds > 0) {
        const clamped = Math.min(seconds, SSHClient.MaxLoginTimeoutSeconds);
        return Math.max(1, Math.round(clamped * 1000));
    }
    return SSHClient.DefaultLoginTimeoutSeconds * 1000;
};

//
//  Is |data| shaped as an SSH public key blob (RFC 4253 section 6.6) for
//  |algo|: a length-prefixed string naming the key type, then the key? Only
//  the shape is checked, so that a caller's bytes reach ssh2's binary key
//  parser and none of its text formats (PEM, PPK, RFC 4716), and within a
//  bound. ssh2 hands over 'ssh-rsa' as |algo| for an rsa-sha2-256/512
//  request, as the blob says.
//
//  The bound leaves room for the largest keys there are (a 16384-bit RSA key
//  is about 2 KiB).
//
SSHClient.MaxPubKeyBlobBytes = 16 * 1024;
SSHClient.MaxPubKeyAlgoBytes = 64;

SSHClient.isPubKeyBlobFor = function (data, algo) {
    if (
        !Buffer.isBuffer(data) ||
        !_.isString(algo) ||
        data.length > SSHClient.MaxPubKeyBlobBytes
    ) {
        return false;
    }

    const algoLen = Buffer.byteLength(algo);
    if (0 === algoLen || algoLen > SSHClient.MaxPubKeyAlgoBytes) {
        return false;
    }

    //  the length, the type, and something after it
    if (data.length <= 4 + algoLen || data.readUInt32BE(0) !== algoLen) {
        return false;
    }

    return data.subarray(4, 4 + algoLen).equals(Buffer.from(algo));
};

//
//  Is the signature on a signed publickey request (ssh2's |ctx|) a good one,
//  made over the request (|ctx.blob|: the session identifier and the request)
//  with the private half of the key offered in it? With an RSA key, the hash
//  is the one the client named (rsa-sha2-256, rsa-sha2-512; SHA-1 for plain
//  ssh-rsa).
//
//  Whether the key is the user's own is for userLogin() to say, after this.
//
SSHClient.isValidPubKeySignature = function (ctx) {
    const key = _.get(ctx, 'key');
    if (
        !key ||
        !Buffer.isBuffer(key.data) ||
        !Buffer.isBuffer(ctx.signature) ||
        !Buffer.isBuffer(ctx.blob)
    ) {
        return false;
    }

    if (!SSHClient.isPubKeyBlobFor(key.data, key.algo)) {
        return false;
    }

    try {
        //  the caller's bytes: parsing them must not be able to throw us out
        const pubKey = ssh2.utils.parseKey(key.data);
        if (!pubKey || pubKey instanceof Error || Array.isArray(pubKey)) {
            return false;
        }

        //  the key is what the request says it is
        if (pubKey.type !== key.algo) {
            return false;
        }

        //  verify() returns an Error, not false, for some bad signatures
        return true === pubKey.verify(ctx.blob, ctx.signature, ctx.hashAlgo);
    } catch (err) {
        return false;
    }
};

exports.SSHClient = SSHClient; //  for tests

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
            this.handleNewClient(new SSHClient(conn, info), conn._sock, ModuleInfo);
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

        const address = config.loginServers.ssh.address;

        return listenServer(
            this.server,
            { name: 'ssh', port, address, log: Log },
            err => {
                if (!err) {
                    Log.info(
                        { server: ModuleInfo.name, port, address },
                        'Listening for connections'
                    );
                }
                return cb(err);
            }
        );
    }
};
