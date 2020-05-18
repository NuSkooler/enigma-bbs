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
    desc        : 'Telnet Server',
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
            this.clientReady();
        }, 3000);

        this.dataHandler = function(data) {
            this.emit('data', data);
        }.bind(this);

        this.socket.on('data', this.dataHandler);

        this.socket.on('error', err => {
            //  :TODO: Log me
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
            //  :TODO: Log me
        });

        this.socket.on('WILL', command => {
            switch (command.option) {
                case Options.LINEMODE :
                    return this.socket.dont.linemode();

                case Options.TTYPE :
                    return this.socket.sb.send.ttype();

                case Options.NEW_ENVIRON :
                    return this.socket.sb.send.new_environ();

                default :
                    break;
            }
        });

        this.socket.on('WONT', command => {
            switch (command.option) {
                case Options.NEW_ENVIRON :
                    return this.socket.dont.new_environ();

                    default :
                        //  :TODO: Log me
                        break;
            }
        });

        this.socket.on('SB', command => {
            switch (command.option) {
                case Options.TTYPE :
                    this.setTermType(command.optionData.ttype);
                    this.clientReady();
                    break;

                case Options.NEW_ENVIRON :
                    {
                        if ('unknown' === this.term.termType) {
                            const term =
                                command.optionData.vars.find(nv => nv.TERM) ||
                                command.optionData.userVars.find(nv => nv.TERM);
                            if (term) {
                                this.setTermType(term);
                            }
                        }

                        command.optionData.vars.forEach(nv => {
                            console.log(nv);
                        });
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

                        //  :TODO: Log negotiation
                    }
                    break;
            }
        });

        this.socket.on('IP', command => {
            //  :TODO: Log me
            return this.disconnect();
        });

        this.socket.on('AYT', () => {
            //  :TODO: Log me
            return this.socket.write('\b');
        });

        //  kick off negotiations
        this.banner();
    }

    // dataHandler(data) {
    //     this.emit('data', data);
    // }

    clientReady() {
        if (this.clientReadyHandled) {
            return; //  already processed
        }

        this.clientReadyHandled = true;
        this.emit('ready', { firstMenu : Config().loginServers.telnet.firstMenu } );
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
};

inherits(TelnetClient, Client);

exports.getModule = class TelnetServerModule extends LoginServerModule {
    constructor() {
        super();
    }

    createServer(cb) {
        this.server = net.createServer( socket => {
            const client = new TelnetClient(socket);
            this.handleNewClient(client, socket, ModuleInfo);
        });

        this.server.on('error', err => {
            Log.info( { error : err.message }, 'Telnet server error');
        });

        return cb(null);
    }

    listen(cb) {
        const config = Config();
        //const port = parseInt(config.loginServers.telnet.port);
        const port = 8810;  //  :TODO: Put me back ;)
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
