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
    TelnetSpec: { Commands, Options, SubNegotiationCommands },
} = require('telnet-socket');

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
        this.bridgeConnection = net.createConnection(connectOpts, () => {
            this.emit('connected');

            this.pipeRestored = false;
            this.client.setTemporaryDirectDataHandler(data => {
                this.updateActivity();
                this.bridgeConnection.write(data);
            });
        });

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

        this.bridgeConnection.once('end', () => {
            this.restorePipe();
            this.emit('end');
        });

        this.bridgeConnection.once('error', err => {
            this.restorePipe();
            this.emit('end', err);
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
