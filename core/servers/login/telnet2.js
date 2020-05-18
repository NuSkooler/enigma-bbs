//  ENiGMA½
const LoginServerModule = require('../../login_server_module');
const Client = require('../../client');

//  deps
const net = require('net');
const { TelnetSocket, TelnetSpec } = require('telnet-socket');

const ModuleInfo = exports.moduleInfo = {
    name        : 'Telnet',
    desc        : 'Telnet Server',
    author      : 'NuSkooler',
    isSecure    : false,
    packageName : 'codes.l33t.enigma.telnet.server.v2',
};



class TelnetClient extends Client {
    constructor(socket) {
        super();

        this.setInputOutput(socket, socket);
        this.telnetSocket = new TelnetSocket(socket);

        //  :TODO: banner
    }
};

exports.getModule = class TelnetServerModule extends LoginServerModule {
    constructor() {
        super();
    }

    createServer(cb) {
        this.server = net.createServer( socket => {
            const client = new TelnetClient(socket);
            this.handleNewClient(client, socket, ModuleInfo);
        });

        return cb(null);
    }
};
