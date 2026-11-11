//  ENiGMA½
const LoginServerModule = require('../../login_server_module');
const { Client } = require('../../client');
const Config = require('../../config').get;
const { log: Log } = require('../../logger');
const { Errors } = require('../../enig_error');
const { listenServer } = require('../../server_listen');

//  deps
const net = require('net');
const {
    TelnetSocket,
    TelnetSpec: { Options, Commands },
} = require('telnet-socket');
const { inherits } = require('util');
const _ = require('lodash');

const ModuleInfo = (exports.moduleInfo = {
    name: 'Telnet',
    desc: 'Telnet Server v2',
    author: 'NuSkooler',
    isSecure: false,
    packageName: 'codes.l33t.enigma.telnet.server.v2',
});

class TelnetClient {
    //
    //  |listener| is set only for a connection accepted on a named listener
    //  (loginServers.telnet.listeners); see resolveListeners(). WebSocketClient
    //  passes nothing and so keeps the main telnet behaviour.
    //
    constructor(socket, listener) {
        Client.apply(this, socket, socket);

        this.listener = listener;

        this.socket = new TelnetSocket(socket);
        this.setInputOutput(this.socket, this.socket);

        //
        //  Wait up to 3s to hear about from our terminal type request
        //  then go ahead and move on...
        //
        this.termTypeTimer = setTimeout(() => {
            this._clientReady();
        }, 3000);

        //  a caller that has gone is not waited for (#999)
        this.once('end', () => clearTimeout(this.termTypeTimer));

        this.dataHandler = function (data) {
            this.emit('data', data);
        }.bind(this);

        this.socket.on('data', this.dataHandler);

        //  Guard against both 'end' and 'close' firing for the same disconnect
        let endEmitted = false;
        const emitEnd = () => {
            if (!endEmitted) {
                endEmitted = true;
                this.emit('end');
            }
        };

        this.socket.on('error', err => {
            this._logDebug({ error: err.message }, 'Socket error');
            emitEnd();
        });

        this.socket.on('end', emitEnd);
        this.socket.on('close', emitEnd); //  fired on abrupt disconnects (NAT timeout, RST, etc.)

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
        if (this.clientReadyHandled || this.clientEnded) {
            return; //  already processed, or the caller has gone (#999)
        }

        clearTimeout(this.termTypeTimer);

        this.clientReadyHandled = true;
        this.emit('ready', readyOptionsFor(Config(), this.listener));
    }
}

inherits(TelnetClient, Client);

//
//  The 'ready' payload. The main listener's is exactly what it has always
//  been. A named listener adds |listener| and may name its own firstMenu.
//
//  firstMenu and emulation are read from the current configuration, by
//  listener name, so a reload changes them just as it changes the main
//  firstMenu. What was bound (port, address) cannot change without a
//  restart, and a listener removed from the configuration since start keeps
//  what it was started with.
//
function readyOptionsFor(config, listener) {
    const telnetConfig = config.loginServers.telnet;
    const mainFirstMenu = telnetConfig.firstMenu;

    if (!listener) {
        return { firstMenu: mainFirstMenu };
    }

    const current = _.get(telnetConfig, ['listeners', listener.name]);
    const entry = _.isPlainObject(current) ? current : listener.config;

    const firstMenu = entry.firstMenu || mainFirstMenu;
    return {
        firstMenu,
        listener: {
            name: listener.name,
            port: listener.port,
            address: listener.address,
            emulation: entry.emulation,
            firstMenu,
        },
    };
}

//  Unset, '0.0.0.0' and '::' all take the port on every interface
function isAnyAddress(address) {
    return !address || '0.0.0.0' === address || '::' === address;
}

function bindsOverlap(a, b) {
    if (0 === a.port || 0 === b.port) {
        return false; //  0 is a fresh ephemeral port each time
    }
    return (
        a.port === b.port &&
        (a.address === b.address || isAnyAddress(a.address) || isAnyAddress(b.address))
    );
}

function parsePort(value) {
    const port = parseInt(value);
    return Number.isInteger(port) && port >= 0 && port <= 65535 ? port : NaN;
}

//
//  Work out which named listeners (loginServers.telnet.listeners) to start.
//
//  Returns { listeners: [ { name, port, address, config } ], skipped: [
//  { name, reason, ... } ] }. Nothing here throws or fails the module: a bad
//  entry is skipped and the caller logs why.
//
function resolveListeners(telnetConfig) {
    const result = { listeners: [], skipped: [] };
    const map = _.get(telnetConfig, 'listeners');

    if (undefined === map || null === map) {
        return result;
    }

    if (!_.isPlainObject(map)) {
        result.skipped.push({
            name: '*',
            reason: 'loginServers.telnet.listeners must be a map of name to listener',
        });
        return result;
    }

    const main = {
        isMain: true,
        name: 'main',
        port: parsePort(telnetConfig.port),
        address: telnetConfig.address,
    };
    const taken = isNaN(main.port) ? [] : [main];

    Object.keys(map).forEach(name => {
        const entry = map[name];

        if (!_.isPlainObject(entry)) {
            return result.skipped.push({ name, reason: 'entry is not an object' });
        }

        if (false === entry.enabled) {
            return result.skipped.push({ name, reason: 'disabled', disabled: true });
        }

        const port = parsePort(entry.port);
        if (isNaN(port)) {
            return result.skipped.push({
                name,
                reason: 'invalid port',
                port: entry.port,
            });
        }

        const listener = {
            name,
            port,
            address: entry.address || telnetConfig.address,
            config: entry,
        };

        const clash = taken.find(other => bindsOverlap(other, listener));
        if (clash) {
            return result.skipped.push({
                name,
                reason: `port already used by the ${
                    clash.isMain ? 'main telnet' : `"${clash.name}"`
                } listener`,
                port,
                address: listener.address,
                conflictsWith: clash.isMain ? 'main' : clash.name,
            });
        }

        taken.push(listener);
        result.listeners.push(listener);
    });

    return result;
}

//
//  close() stops a server accepting at once; its callback waits for open
//  connections, so a server no longer listening counts as stopped. Mirrors
//  closeServer() in core/listening_server.js.
//
function closeServer(server, cb) {
    let called = false;
    const done = () => {
        if (!called) {
            called = true;
            return cb();
        }
    };

    try {
        server.close(() => done());
    } catch (err) {
        Log.warn(
            { err, server: ModuleInfo.name },
            'Failed to stop listening; continuing'
        );
        return done();
    }

    if (false === server.listening) {
        return done();
    }
}

exports.getModule = class TelnetServerModule extends LoginServerModule {
    constructor() {
        super();
        this.extraListeners = [];
    }

    _createNetServer(listener) {
        return net.createServer(socket => {
            const client = new TelnetClient(socket, listener);
            client.banner(); //  start negotiations
            this.handleNewClient(client, socket, ModuleInfo);
        });
    }

    createServer(cb) {
        this.server = this._createNetServer();

        const { listeners, skipped } = resolveListeners(Config().loginServers.telnet);

        skipped.forEach(skip => {
            const { name, reason } = skip;
            const info = Object.assign({ server: ModuleInfo.name, listener: name }, skip);
            delete info.name;
            delete info.reason;
            if (skip.disabled) {
                Log.info(info, `Telnet listener "${name}" is disabled; not starting it`);
            } else {
                Log.error(info, `Telnet listener "${name}" skipped: ${reason}`);
            }
        });

        this.extraListeners = listeners.map(listener =>
            Object.assign({}, listener, { server: this._createNetServer(listener) })
        );

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

        return listenServer(
            this.server,
            { name: 'telnet', port, address, log: Log },
            err => {
                if (err) {
                    return cb(err);
                }

                Log.info(
                    { server: ModuleInfo.name, port, address },
                    'Listening for connections'
                );

                return this._listenExtra(() => cb(null));
            }
        );
    }

    //
    //  Named listeners are extras: one that cannot bind is logged and left
    //  out, and never fails the module or the board's startup.
    //
    _listenExtra(cb) {
        let index = 0;
        const next = () => {
            if (index >= this.extraListeners.length) {
                return cb();
            }

            const listener = this.extraListeners[index++];
            const { name, port, address } = listener;

            //  The startup report pads names to a fixed column without a
            //  separator; a listener name can be longer than that column.
            const consoleName = `telnet:${name} `;

            return listenServer(
                listener.server,
                { name: consoleName, port, address, log: Log },
                err => {
                    if (err) {
                        Log.error(
                            {
                                server: ModuleInfo.name,
                                listener: name,
                                port,
                                address,
                                error: err.reason || err.message,
                            },
                            `Telnet listener "${name}" could not listen; continuing without it`
                        );
                        listener.failed = true;
                    } else {
                        Log.info(
                            {
                                server: ModuleInfo.name,
                                listener: name,
                                port,
                                address,
                                emulation: listener.config.emulation,
                            },
                            'Listening for connections'
                        );
                    }
                    return next();
                }
            );
        };

        return next();
    }

    //
    //  core/listening_server.js closes |server| for a module with no
    //  shutdown(); this one has more than one, so it closes its own.
    //
    shutdown(cb) {
        const servers = [this.server]
            .concat(this.extraListeners.map(l => l.server))
            .filter(server => server && _.isFunction(server.close));

        let left = servers.length;
        if (0 === left) {
            return cb(null);
        }

        servers.forEach(server =>
            closeServer(server, () => {
                if (0 === --left) {
                    return cb(null);
                }
            })
        );
    }
};

exports.TelnetClient = TelnetClient; //  WebSockets is a wrapper on top of this

//  For tests
exports.resolveListeners = resolveListeners;
exports.readyOptionsFor = readyOptionsFor;
