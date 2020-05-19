//  ENiGMA½
const LoginServerModule = require('../../login_server_module');
const { Client } = require('../../client');
const Config = require('../../config').get;
const { log: Log } = require('../../logger');

//  deps
const net = require('net');
const {
    TelnetSocket,
    TelnetSpec: { Options, Commands }
} = require('telnet-socket');
const { inherits } = require('util');

const ModuleInfo = exports.moduleInfo = {
    name        : 'Telnet',
    desc        : 'Telnet Server v2',
    author      : 'NuSkooler',
    isSecure    : false,
    packageName : 'codes.l33t.enigma.telnet.server.v2',
};

class TelnetClient {
    constructor(socket) {
        Client.apply(this, socket, socket);

        this.setInputOutput(socket, socket);
        this.socket = new TelnetSocket(socket);

        //
        //  Wait up to 3s to hear about from our terminal type request
        //  then go ahead and move on...
        //
        setTimeout(() => {
            this._clientReady();
        }, 3000);

        this.dataHandler = function(data) {
            this.emit('data', data);
        }.bind(this);

        this.socket.on('data', this.dataHandler);

        this.socket.on('error', err => {
            this._logDebug( { error : err.message }, 'Socket error');
            return this.emit('end');
        });

        this.socket.on('end', () => {
            this.emit('end');
        });

        this.socket.on('DO', command => {
            switch (command.option) {
                case Options.ECHO :
                    return this.socket.will.echo();

                default :
                    return this.socket.command(Commands.WONT, command.option);
            }
        });

        this.socket.on('DONT', command => {
            this._logTrace(command, 'DONT');
        });

        this.socket.on('WILL', command => {
            switch (command.option) {
                case Options.LINEMODE :
                    return this.socket.dont.linemode();

                case Options.TTYPE :
                    return this.socket.sb.send.ttype();

                case Options.NEW_ENVIRON :
                    return this.socket.sb.send.new_environ(
                        [ 'ROWS', 'COLUMNS', 'TERM', 'TERM_PROGRAM' ]
                    );

                default :
                    break;
            }
        });

        this.socket.on('WONT', command => {
            switch (command.option) {
                case Options.NEW_ENVIRON :
                    return this.socket.dont.new_environ();

                    default :
                        return this._logTrace(command, 'WONT');
            }
        });

        this.socket.on('SB', command => {
            switch (command.option) {
                case Options.TTYPE :
                    this.setTermType(command.optionData.ttype);
                    return this._clientReady();

                case Options.NEW_ENVIRON :
                    {
                        this._logDebug(
                            { vars : command.optionData.vars, userVars : command.optionData.userVars },
                            'New environment received'
                        );

                        //  get a value from vars with fallback of user vars
                        const getValue = (name) => {
                            return command.optionData.vars.find(nv => nv.name === name) ||
                                command.optionData.userVars.find(nv => nv.name === name);
                        };

                        if ('unknown' === this.term.termType) {
                            //  allow from vars or user vars
                            const term = getValue('TERM') || getValue('TERM_PROGRAM');
                            if (term) {
                                this.setTermType(term.value);
                            }
                        }

                        if (0 === this.term.termHeight || 0 === this.term.termWidth) {
                            const updateTermSize = (what) => {
                                const value = parseInt(getValue(what));
                                if (value) {
                                    this.term[what === 'ROWS' ? 'termHeight' : 'termWidth'] = value;
                                    this.clearMciCache();
                                    this._logDebug(
                                        { [ what ] : value, source : 'NEW-ENVIRON' },
                                        'Window size updated'
                                    );
                                }
                            };

                            updateTermSize('ROWS');
                            updateTermSize('COLUMNS');
                        }
                    }
                    break;

                case Options.NAWS :
                    {
                        const { width, height } = command.optionData;

                        this.term.termWidth     = width;
                        this.term.termHeight    = height;

                        if (width) {
                            this.term.env.COLUMNS = width;
                        }

                        if (height) {
                            this.term.env.ROWS = height;
                        }

                        this.clearMciCache();

                        this._logDebug(
                            { width, height, source : 'NAWS' },
                            'Windows size updated'
                        );
                    }
                    break;

                default :
                    return this._logTrace(command, 'SB');
            }
        });

        this.socket.on('IP', command => {
            this._logDebug(command, 'Interrupt Process (IP) - Ending session');
            return this.disconnect();
        });

        this.socket.on('AYT', () => {
            this.socket.write('\b');
            return this._logTrace(command, 'Are You There (AYT) - Replied');
        });
    }

    disconnect() {
        try {
            return this.socket.rawSocket.end();
        } catch (e) {
            //  ignored
        }
    }

    banner() {
        this.socket.do.echo();
        this.socket.will.echo();              //  we'll echo back

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
        this.emit('ready', { firstMenu : Config().loginServers.telnet.firstMenu } );
    }
};

inherits(TelnetClient, Client);

exports.getModule = class TelnetServerModule extends LoginServerModule {
    constructor() {
        super();
    }

    createServer(cb) {
        this.server = net.createServer( socket => {
            const client = new TelnetClient(socket);
            client.banner();    //  start negotiations
            this.handleNewClient(client, socket, ModuleInfo);
        });

        this.server.on('error', err => {
            Log.info( { error : err.message }, 'Telnet server error');
        });

        return cb(null);
    }

    listen(cb) {
        const config = Config();
        const port = parseInt(config.loginServers.telnet.port);
        if(isNaN(port)) {
            Log.error( { server : ModuleInfo.name, port : config.loginServers.telnet.port }, 'Cannot load server (invalid port)' );
            return cb(Errors.Invalid(`Invalid port: ${config.loginServers.telnet.port}`));
        }

        this.server.listen(port, config.loginServers.telnet.address, err => {
            if(!err) {
                Log.info( { server : ModuleInfo.name, port : port }, 'Listening for connections' );
            }
            return cb(err);
        });
    }
};

exports.TelnetClient = TelnetClient;    //  WebSockets is a wrapper on top of this
