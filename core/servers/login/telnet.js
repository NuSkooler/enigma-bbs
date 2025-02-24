//  ENiGMA½
const LoginServerModule = require('../../login_server_module');
const { Client } = require('../../client');
const Config = require('../../config').get;
const { log: Log } = require('../../logger');
const { Errors } = require('../../enig_error');

//  deps
const COLOUR_CODES = require('../../constants/ansi/colour_codes').COLOUR_CODES;
const net = require('net');
const {
    TelnetSocket,
    TelnetSpec: { Options, Commands },
} = require('telnet-socket');
const { inherits } = require('util');
const tcpPortUsed = require('tcp-port-used');
const { log } = require('easy-table');

const ModuleInfo = (exports.moduleInfo = {
    name: 'Telnet',
    desc: 'Telnet Server v2',
    author: 'NuSkooler',
    isSecure: false,
    packageName: 'codes.l33t.enigma.telnet.server.v2',
});

class TelnetClient {
    constructor(socket) {
        Client.apply(this, socket, socket);

        this.socket = new TelnetSocket(socket);
        this.setInputOutput(this.socket, this.socket);

        //
        //  Wait up to 3s to hear about from our terminal type request
        //  then go ahead and move on...
        //
        setTimeout(() => {
            this._clientReady();
        }, 3000);

        this.dataHandler = function (data) {
            this.emit('data', data);
        }.bind(this);

        this.socket.on('data', this.dataHandler);

        this.socket.on('error', err => {
            this._logDebug({ error: err.message }, 'Socket error');
            return this.emit('end');
        });

        this.socket.on('end', () => {
            this.emit('end');
        });

        this.socket.on('command error', (command, err) => {
            this._logDebug({ command, error: err.message }, 'Command error');
        });

        this.socket.on('DO', command => {
            switch (command.option) {
                //  We've already stated we WILL do the following via
                //  the banner - some terminals will ask over and over
                //  if we respond to a DO with a WILL, so just don't
                //  do anything...
                case Options.SGA:
                case Options.ECHO:
                case Options.TRANSMIT_BINARY:
                    break;

                default:
                    return this.socket.command(Commands.WONT, command.option);
            }
        });

        this.socket.on('DONT', command => {
            this._logTrace(command, 'DONT');
        });

        this.socket.on('WILL', command => {
            switch (command.option) {
                case Options.TTYPE:
                    return this.socket.sb.send.ttype();

                case Options.NEW_ENVIRON:
                    return this.socket.sb.send.new_environ([
                        'ROWS',
                        'COLUMNS',
                        'TERM',
                        'TERM_PROGRAM',
                    ]);

                default:
                    break;
            }
        });

        this.socket.on('WONT', command => {
            return this._logTrace(command, 'WONT');
        });

        this.socket.on('SB', command => {
            switch (command.option) {
                case Options.TTYPE:
                    this.setTermType(command.optionData.ttype);
                    return this._clientReady();

                case Options.NEW_ENVIRON:
                    {
                        this._logDebug(
                            {
                                vars: command.optionData.vars,
                                uservars: command.optionData.uservars,
                            },
                            'New environment received'
                        );

                        //  get a value from vars with fallback of user vars
                        const getValue = name => {
                            return (
                                command.optionData.vars &&
                                (command.optionData.vars.find(nv => nv.name === name) ||
                                    command.optionData.uservars.find(
                                        nv => nv.name === name
                                    ))
                            );
                        };

                        if ('unknown' === this.term.termType) {
                            //  allow from vars or user vars
                            const term = getValue('TERM') || getValue('TERM_PROGRAM');
                            if (term) {
                                this.setTermType(term.value);
                            }
                        }

                        if (0 === this.term.termHeight || 0 === this.term.termWidth) {
                            const updateTermSize = what => {
                                const value = parseInt(getValue(what));
                                if (value) {
                                    this.term[
                                        what === 'ROWS' ? 'termHeight' : 'termWidth'
                                    ] = value;

                                    this._logDebug(
                                        { [what]: value, source: 'NEW-ENVIRON' },
                                        'Window size updated'
                                    );
                                }
                            };

                            updateTermSize('ROWS');
                            updateTermSize('COLUMNS');
                        }
                    }
                    break;

                case Options.NAWS:
                    {
                        const { width, height } = command.optionData;

                        this.term.termWidth = width;
                        this.term.termHeight = height;

                        if (width) {
                            this.term.env.COLUMNS = width;
                        }

                        if (height) {
                            this.term.env.ROWS = height;
                        }

                        this._logDebug(
                            { width, height, source: 'NAWS' },
                            'Windows size updated'
                        );
                    }
                    break;

                default:
                    return this._logTrace(command, 'SB');
            }
        });

        this.socket.on('IP', command => {
            this._logDebug(command, 'Interrupt Process (IP) - Ending session');
            return this.disconnect();
        });

        this.socket.on('AYT', command => {
            this.socket.write('\b');
            return this._logTrace(command, 'Are You There (AYT) - Replied');
        });
    }

    get dataPassthrough() {
        return this.socket.passthrough;
    }

    set dataPassthrough(passthrough) {
        this.socket.passthrough = passthrough;
    }

    disconnect() {
        try {
            return this.socket.rawSocket.end();
        } catch (e) {
            //  ignored
        }
    }

    banner() {
        this.socket.dont.echo(); //  don't echo characters
        this.socket.will.echo(); //  ...we'll echo them back

        this.socket.will.sga();
        this.socket.do.sga();

        this.socket.do.transmit_binary();
        this.socket.will.transmit_binary();

        this.socket.do.ttype();
        this.socket.do.naws();
        this.socket.do.new_environ();
    }

    _logTrace(info, msg) {
        if (Config().loginServers.telnet.traceConnections) {
            const log = this.log || Log;
            return log.trace(info, `Telnet: ${msg}`);
        }
    }

    _logDebug(info, msg) {
        const log = this.log || Log;
        return log.debug(info, `Telnet: ${msg}`);
    }

    _clientReady() {
        if (this.clientReadyHandled) {
            return; //  already processed
        }

        this.clientReadyHandled = true;
        this.emit('ready', { firstMenu: Config().loginServers.telnet.firstMenu });
    }
}

inherits(TelnetClient, Client);

exports.getModule = class TelnetServerModule extends LoginServerModule {
    constructor() {
        super();
    }

    createServer(cb) {
        this.server = net.createServer(socket => {
            const client = new TelnetClient(socket);
            client.banner(); //  start negotiations
            this.handleNewClient(client, socket, ModuleInfo);
        });

        this.server.on('error', err => {
            Log.info({ error: err.message }, 'Telnet server error');
        });

        return cb(null);
    }

    listen(cb) {
        const config = Config();
        const port = parseInt(config.loginServers.telnet.port);
        if (isNaN(port)) {
            Log.error(
                { server: ModuleInfo.name, port: config.loginServers.telnet.port },
                'Cannot load server (invalid port)'
            );
            return cb(Errors.Invalid(`Invalid port: ${config.loginServers.telnet.port}`));
        }

        const address = config.loginServers.telnet.address;

        tcpPortUsed
            .check(port, address)
            .then(function(inUse) {
                if (inUse) {
                    console.error(`${COLOUR_CODES.BRIGHT_RED}LOGIN SERVER: ${COLOUR_CODES.RED}${ModuleInfo.name} Cannot Start! Port is in use: ${COLOUR_CODES.BRIGHT_WHITE}${port} at address ${address}${COLOUR_CODES.WHITE}`)

                    return cb(Errors.UnexpectedState(`Port is in use: ${port} at address ${address}`))
                }
            },
            function(err) {
                return cb(err);
            }
        );

        Log.info(
            { server: ModuleInfo.name, port: port, address: address },
            'Telnet starting up'
        );

        this.server.listen(port, address, err => {
            if (!err) {
                console.info(`${COLOUR_CODES.BRIGHT_GREEN}LOGIN SERVER: ${COLOUR_CODES.GREEN}${ModuleInfo.name} Listening on Port ${COLOUR_CODES.BRIGHT_WHITE}${port} at address ${config.loginServers.telnet.address}${COLOUR_CODES.WHITE}`)

                Log.info(
                    { server: ModuleInfo.name, port: port, address: address },
                    'Listening for connections'
                );
            }
            return cb(err);
        });

    }
};

exports.TelnetClient = TelnetClient; //  WebSockets is a wrapper on top of this
