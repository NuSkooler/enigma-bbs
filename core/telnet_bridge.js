/* jslint node: true */
'use strict';

//  ENiGMA½
const MenuModule = require('./menu_module.js').MenuModule;
const resetScreen = require('./ansi_term.js').resetScreen;
const setSyncTermFontWithAlias = require('./ansi_term.js').setSyncTermFontWithAlias;

//  deps
const async = require('async');
const _ = require('lodash');
const net = require('net');
const EventEmitter = require('events');

const {
    TelnetSocket,
    TelnetSpec: { Commands, CommandNames, Options, SubNegotiationCommands },
} = require('telnet-socket');

const { isTelnetBasedClient } = require('./telnet_iac.js');

/*
    Expected configuration block:

    {
        module: telnet_bridge
        ...
        config: {
            host: somehost.net
            port: 23
        }
    }
*/

//  :TODO: ENH: Support nodeMax and tooManyArt
exports.moduleInfo = {
    name: 'Telnet Bridge',
    desc: 'Connect to other Telnet Systems',
    author: 'Andrew Pamment',
};

const IAC_DO_TERM_TYPE = TelnetSocket.commandBuffer(Commands.DO, Options.TTYPE);

//
//  Which options we are prepared to run when *we* are the Telnet endpoint, which
//  is only the case for a caller whose own transport is not Telnet (SSH).
//
//  TRANSMIT_BINARY matters most: a file transfer through the bridge needs an
//  8-bit clean path, and refusing it invites the remote to stay in NVT mode. SGA
//  is the norm for anything interactive. TTYPE we answer because we know the
//  caller's terminal type. Everything else is refused rather than guessed at --
//  a bridge has no business claiming NAWS or LINEMODE on the caller's behalf.
//
const BridgeWillingToDo = [Options.TRANSMIT_BINARY, Options.SGA, Options.TTYPE];
const BridgeWillingToAccept = [Options.TRANSMIT_BINARY, Options.SGA, Options.ECHO];

//
//  Pure so it can be tested without a socket. Returns the reply to send, or null
//  when none is owed.
//
function bridgeNegotiationReply(commandCode, option) {
    switch (commandCode) {
        case Commands.DO:
            return {
                code: BridgeWillingToDo.includes(option) ? Commands.WILL : Commands.WONT,
                option,
            };

        case Commands.WILL:
            return {
                code: BridgeWillingToAccept.includes(option)
                    ? Commands.DO
                    : Commands.DONT,
                option,
            };

        //
        //  DONT and WONT acknowledge a refusal. RFC 854 wants no reply, and
        //  answering one is how negotiation loops start.
        //
        default:
            return null;
    }
}

class TelnetClientConnection extends EventEmitter {
    constructor(client) {
        super();

        this.client = client;

        this.dataHits = 0;
    }

    updateActivity() {
        if (0 === this.dataHits++ % 4) {
            this.client.explicitActivityTimeUpdate();
        }
    }

    restorePipe() {
        if (!this.pipeRestored) {
            this.pipeRestored = true;

            this.client.restoreDataHandler();

            //  client may have bailed
            if (null !== _.get(this, 'client.term.output', null)) {
                if (this.bridgeConnection) {
                    this.client.term.output.unpipe(this.bridgeConnection);
                }
                this.client.term.output.resume();
            }
        }
    }

    connect(connectOpts) {
        //
        //  Who terminates Telnet for this session?
        //
        //  For a Telnet or WebSocket caller, the caller's own client does. Their
        //  connection is a TelnetSocket that setTemporaryDirectDataHandler() has
        //  put in passthrough mode, so raw piping makes us genuinely transparent:
        //  escaped IACs and negotiation travel end to end and the two real Telnet
        //  stacks agree with each other. That path is left exactly as it was.
        //
        //  For an SSH caller there is no Telnet stack on their side at all. Piping
        //  raw hands them the remote's doubled 0xFF bytes and its negotiation as
        //  literal garbage in the stream, which is #266 -- a download dies a few
        //  chunks in. So we become the Telnet endpoint ourselves: wrap the remote
        //  connection so the library de-escapes data and parses commands, and
        //  answer the negotiation the caller cannot.
        //
        this.bridgeIsTelnetEndpoint = !isTelnetBasedClient(this.client);

        this.bridgeConnection = net.createConnection(connectOpts, () => {
            this.emit('connected');

            this.pipeRestored = false;
            this.client.setTemporaryDirectDataHandler(data => {
                this.updateActivity();
                //  Writing through the TelnetSocket escapes IACs on the way out;
                //  writing to the raw socket does not. Either is correct for its
                //  own path.
                this.remote.write(data);
            });
        });

        if (this.bridgeIsTelnetEndpoint) {
            this.remote = new TelnetSocket(this.bridgeConnection);
            this._wireTelnetEndpoint();
        } else {
            this.remote = this.bridgeConnection;
            this._wirePassthrough();
        }

        this.bridgeConnection.once('end', () => {
            this.restorePipe();
            this.emit('end');
        });

        this.bridgeConnection.once('error', err => {
            this.restorePipe();
            this.emit('end', err);
        });
    }

    //
    //  Telnet/WebSocket caller: unchanged. Raw bytes both ways, and the one
    //  negotiation the bridge has always answered for itself.
    //
    _wirePassthrough() {
        this.bridgeConnection.on('data', data => {
            this.updateActivity();

            this.client.term.rawWrite(data);

            //
            //  Wait for a terminal type request, and send it exactly once.
            //  This is enough (in additional to other negotiations handled in telnet.js)
            //  to get us in on most systems
            //
            if (!this.termSent && data.indexOf(IAC_DO_TERM_TYPE) > -1) {
                this.termSent = true;
                this.bridgeConnection.write(this.getTermTypeNegotiationBuffer());
            }
        });
    }

    //
    //  SSH caller: we terminate Telnet. Data arriving on |remote| has had IAC IAC
    //  collapsed and commands stripped by the library, so it is safe to hand to a
    //  caller with no Telnet stack of its own.
    //
    _wireTelnetEndpoint() {
        this.remote.on('data', data => {
            this.updateActivity();
            this.client.term.rawWrite(data);
        });

        //
        //  The library parses negotiation but only emits it -- it never answers.
        //  In the passthrough case the caller's own Telnet stack does that; here
        //  nothing else will, and a remote waiting on a reply simply stalls.
        //
        const answer = command => {
            const reply = bridgeNegotiationReply(command.code, command.option);
            if (reply) {
                //  command() writes to the raw socket, so this is not itself escaped
                this.remote.command(reply.code, reply.option);
            }
        };

        [Commands.DO, Commands.DONT, Commands.WILL, Commands.WONT].forEach(code => {
            this.remote.on(CommandNames[code], answer);
        });

        //
        //  RFC 1091: having said WILL TTYPE above, the remote asks for the type
        //  with SB TTYPE SEND and we answer SB TTYPE IS <type>.
        //
        this.remote.on(CommandNames[Commands.SB], command => {
            if (Options.TTYPE === command.option && !this.termSent) {
                this.termSent = true;
                this.bridgeConnection.write(this.getTermTypeNegotiationBuffer());
            }
        });
    }

    disconnect() {
        if (this.bridgeConnection) {
            this.bridgeConnection.end();
        }
    }

    destroy() {
        if (this.bridgeConnection) {
            this.bridgeConnection.destroy();
            this.bridgeConnection.removeAllListeners();
            //  when we wrapped the socket, the data/negotiation listeners are on
            //  the wrapper rather than on the socket underneath it
            if (this.remote && this.remote !== this.bridgeConnection) {
                this.remote.removeAllListeners();
            }
            this.restorePipe();
            this.emit('end');
        }
    }

    getTermTypeNegotiationBuffer() {
        //
        //  Create a TERMINAL-TYPE sub negotiation buffer using the
        //  actual/current terminal type.
        //
        const sendTermType = TelnetSocket.commandBuffer(Commands.SB, Options.TTYPE, [
            SubNegotiationCommands.IS,
            ...Buffer.from(this.client.term.termType), //  e.g. "ansi"
            Commands.IAC,
            Commands.SE,
        ]);
        return sendTermType;
    }
}

exports.getModule = class TelnetBridgeModule extends MenuModule {
    constructor(options) {
        super(options);

        this.config = Object.assign(
            {},
            _.get(options, 'menuConfig.config'),
            options.extraArgs
        );
        this.config.port = this.config.port || 23;
    }

    initSequence() {
        let clientTerminated;
        const self = this;

        async.series(
            [
                function validateConfig(callback) {
                    if (_.isString(self.config.host) && _.isNumber(self.config.port)) {
                        callback(null);
                    } else {
                        callback(
                            new Error('Configuration is missing required option(s)')
                        );
                    }
                },
                function createTelnetBridge(callback) {
                    const connectOpts = {
                        port: self.config.port,
                        host: self.config.host,
                    };

                    self.client.term.write(resetScreen());
                    self.client.term.write(
                        `  Connecting to ${connectOpts.host}, please wait...\n  (Press ESC to cancel)\n`
                    );

                    const telnetConnection = new TelnetClientConnection(self.client);

                    const connectionKeyPressHandler = (ch, key) => {
                        if ('escape' === key.name) {
                            self.client.removeListener(
                                'key press',
                                connectionKeyPressHandler
                            );
                            telnetConnection.destroy();
                        }
                    };

                    self.client.on('key press', connectionKeyPressHandler);

                    telnetConnection.on('connected', () => {
                        self.client.removeListener(
                            'key press',
                            connectionKeyPressHandler
                        );
                        self.client.log.info(
                            connectOpts,
                            'Telnet bridge connection established'
                        );

                        //  put the font back how it was prior, if fonts are enabled
                        if (self.client.term.syncTermFontsEnabled && self.config.font) {
                            self.client.term.rawWrite(
                                setSyncTermFontWithAlias(self.config.font)
                            );
                        }

                        self.client.once('end', () => {
                            self.client.log.info(
                                'Connection ended. Terminating connection'
                            );
                            clientTerminated = true;
                            telnetConnection.disconnect();
                        });
                    });

                    telnetConnection.on('end', err => {
                        self.client.removeListener(
                            'key press',
                            connectionKeyPressHandler
                        );

                        if (err) {
                            self.client.log.warn(
                                `Telnet bridge connection error: ${err.message}`
                            );
                        }

                        callback(
                            clientTerminated
                                ? new Error('Client connection terminated')
                                : null
                        );
                    });

                    telnetConnection.connect(connectOpts);
                },
            ],
            err => {
                if (err) {
                    self.client.log.warn(
                        { error: err.message },
                        'Telnet connection error'
                    );
                }

                if (!clientTerminated) {
                    self.prevMenu();
                }
            }
        );
    }
};

//
//  Exported for tests. The negotiation policy and the connection's wiring are the
//  two pieces worth pinning, and neither is reachable through getModule().
//
exports.bridgeNegotiationReply = bridgeNegotiationReply;
exports.TelnetClientConnection = TelnetClientConnection;
