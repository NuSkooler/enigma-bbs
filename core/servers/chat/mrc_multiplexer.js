/* jslint node: true */
'use strict';

//  ENiGMA½
const Log = require('../../logger.js').log;
const { ServerModule } = require('../../server_module.js');
const Config = require('../../config.js').get;
const { Errors } = require('../../enig_error.js');
const SysProps = require('../../system_property.js');
const StatLog = require('../../stat_log.js');
const { listenServer } = require('../../server_listen.js');

//  deps
const net = require('net');
const tls = require('tls');
const _ = require('lodash');
const os = require('os');

// MRC
const clientVersion = '1.3.8';
const lineDelimiter = new RegExp('\r\n|\r|\n|\n\r');

//  The multiplexer has no login: only this board's own MRC chat sessions
//  (core/mrc.js, in this process) connect to it, so it never listens beyond
//  this machine.
const MultiplexerAddress = '127.0.0.1';

//  What a chat session sends first: '--DUDE-ITS--|<username>'
const ClientHandshake = '--DUDE-ITS--';

//  Names with a meaning of their own in the MRC protocol, never a user's
const ReservedUsernames = ['SERVER', 'CLIENT', 'NOTME'];

//  An MRC line is a few hundred bytes; a local client sending far more
//  without a line break is broken
const MaxClientLineLength = 16 * 1024;

const ModuleInfo = (exports.moduleInfo = {
    name: 'MRC',
    desc: 'An MRC Chat Multiplexer',
    author: 'RiPuk and MeaTLoTioN',
    packageName: 'codes.l33t.enigma.mrc.server',
    notes: 'https://bbswiki.bottomlessabyss.net/index.php?title=MRC_Chat_platform',
});

const connectedSockets = new Set();

exports.getModule = class MrcModule extends ServerModule {
    constructor() {
        super();

        this.log = Log.child({ server: 'MRC' });

        const config = Config();
        this.boardName = config.general.boardName;

        // Use prettyBoardName only if non-default
        if (config.general.prettyBoardName != '|08XXXXX')
            this.boardName = config.general.prettyBoardName;

        this.mrcConfig = {
            host: config.chatServers.mrc.serverHostname || 'mrc.bottomlessabyss.net',
            port: config.chatServers.mrc.serverPort || 5000,
            sslport: config.chatServers.mrc.serverSslPort || 5001,
            retryDelay: config.chatServers.mrc.retryDelay || 10000,
            useSsl: config.chatServers.mrc.useSsl || false,
            verifyCertificate: config.chatServers.mrc.verifyCertificate !== false,
        };

        this.mrcConnectOpts = {
            host: this.mrcConfig.host,
            port: this.mrcConfig.port,
            retryDelay: this.mrcConfig.retryDelay,
        };
    }

    _connectionHandler() {
        const enigmaVersion =
            'ENiGMA-BBS_' + require('../../version.js').getReleaseVersion();

        const handshake = `${
            this.boardName
        }~${enigmaVersion}/${os.platform()}.${os.arch()}/${clientVersion}`;
        this.log.debug({ handshake: handshake }, 'Handshaking with MRC server');

        this.sendRaw(handshake);
        this.log.info(this.mrcConnectOpts, 'Connected to MRC server');

        this._sendBbsInfo();
    }

    _sendBbsInfo() {
        const config = Config();
        const mrcCfg = config.chatServers.mrc;
        const infoFields = [
            [
                'INFOSYS',
                mrcCfg.infoSysop || StatLog.getSystemStat(SysProps.SysOpUsername),
            ],
            ['INFOWEB', mrcCfg.infoWeb || config.general.website],
            ['INFOTEL', mrcCfg.infoTelnet || config.general.telnetHostname],
            ['INFOSSH', mrcCfg.infoSsh || config.general.sshHostname],
            ['INFODSC', mrcCfg.infoDesc || config.general.description],
        ];
        for (const [key, val] of infoFields) {
            this.sendToMrcServer('CLIENT', '', 'SERVER', 'ALL', '', `${key}:${val}`);
        }
    }

    createServer(cb) {
        if (!this.enabled) {
            return cb(null);
        }

        this.connectToMrc();
        this.createLocalListener();

        return cb(null);
    }

    listen(cb) {
        if (!this.enabled) {
            return cb(null);
        }

        const config = Config();

        const port = parseInt(config.chatServers.mrc.multiplexerPort);
        if (isNaN(port)) {
            this.log.warn(
                { port: config.chatServers.mrc.multiplexerPort, server: ModuleInfo.name },
                'Invalid port'
            );
            return cb(
                Errors.Invalid(`Invalid port: ${config.chatServers.mrc.multiplexerPort}`)
            );
        }
        Log.info(
            {
                server: ModuleInfo.name,
                address: MultiplexerAddress,
                port: config.chatServers.mrc.multiplexerPort,
            },
            'MRC multiplexer starting up'
        );
        return listenServer(
            this.server,
            { name: 'mrc', port, address: MultiplexerAddress, log: Log },
            cb
        );
    }

    /**
     * Handles connecting to to the MRC server
     */
    connectToMrc() {
        const self = this;

        if (this.mrcConfig.useSsl) {
            this.mrcConnectOpts.port = this.mrcConfig.sslport;
        }

        // Create connection
        const onConnected = self._connectionHandler.bind(self);
        if (this.mrcConfig.useSsl) {
            const { host } = this.mrcConnectOpts;
            this.mrcClient = tls.connect(
                {
                    ...this.mrcConnectOpts,
                    //  certificates name hosts; an address is checked as it is
                    servername: net.isIP(host) ? undefined : host,
                    rejectUnauthorized: this.mrcConfig.verifyCertificate,
                },
                onConnected
            );
        } else {
            this.mrcClient = net.createConnection(this.mrcConnectOpts, onConnected);
        }

        this.mrcClient.requestedDisconnect = false;

        // do things when we get data from MRC central
        let buffer = new Buffer.from('');

        function handleData(chunk) {
            if (_.isString(chunk)) {
                buffer += chunk;
            } else {
                buffer = Buffer.concat([buffer, chunk]);
            }

            let lines = buffer.toString().split(lineDelimiter);

            if (lines.pop()) {
                // if buffer is not ended with \r\n, there's more chunks.
                return;
            } else {
                // else, initialize the buffer.
                buffer = new Buffer.from('');
            }

            lines.forEach(line => {
                if (line.length) {
                    let message = self.parseMessage(line);
                    if (message) {
                        self.receiveFromMRC(message);
                    }
                }
            });
        }

        this.mrcClient.on('data', data => {
            handleData(data);
        });

        this.mrcClient.on('end', () => {
            this.log.info(this.mrcConnectOpts, 'Disconnected from MRC server');
        });

        this.mrcClient.on('close', () => {
            if (this.mrcClient && this.mrcClient.requestedDisconnect) return;

            this.log.info(
                this.mrcConnectOpts,
                'Disconnected from MRC server, reconnecting'
            );
            this.log.debug(
                'Waiting ' + this.mrcConnectOpts.retryDelay + 'ms before retrying'
            );

            setTimeout(function () {
                self.connectToMrc();
            }, this.mrcConnectOpts.retryDelay);
        });

        this.mrcClient.on('error', err => {
            if (/CERT|SELF_SIGNED|UNABLE_TO_|ALTNAME/.test(err.code || '')) {
                this.log.warn(
                    {
                        error: err.message,
                        code: err.code,
                        host: this.mrcConnectOpts.host,
                    },
                    'MRC server certificate could not be verified; not connecting'
                );
                return;
            }
            this.log.info({ error: err.message }, 'MRC server error');
        });
    }

    createLocalListener() {
        //  a local server for this board's MRC chat sessions to connect to
        this.server = net.createServer(socket => this._clientConnected(socket));
    }

    _clientConnected(socket) {
        socket.setEncoding('ascii');

        //  a line can arrive split across reads, or several in one read
        let pending = '';

        socket.on('data', data => {
            const lines = (pending + data).split(lineDelimiter);
            pending = lines.pop();

            lines.forEach(line => this._clientLine(socket, line));

            if (pending.length > MaxClientLineLength) {
                this.log.warn(
                    { user: socket.username, length: pending.length },
                    'MRC client line too long; disconnecting it'
                );
                socket.destroy();
            }
        });

        //  'close', not 'end': a connection that is reset or errors out never
        //  ends cleanly, and would otherwise stay registered
        socket.on('close', () => this._clientDisconnected(socket));

        socket.on('error', err => {
            if ('ECONNRESET' !== err.code) {
                //  normal
                this.log.error({ error: err.message }, 'MRC error');
            }
        });
    }

    _clientLine(socket, line) {
        if (!line) {
            return;
        }

        if (line.startsWith(ClientHandshake)) {
            //  a connection says who it is once, and only a user's name
            //  registers it
            const sep = line.indexOf('|');
            const username = sanitiseFromUser(sep < 0 ? '' : line.slice(sep + 1));
            if (
                socket.username ||
                !username ||
                ReservedUsernames.includes(username.toUpperCase())
            ) {
                this.log.debug(
                    { user: socket.username, given: username },
                    'Ignoring MRC client handshake'
                );
                return;
            }

            socket.username = username;
            connectedSockets.add(socket);
            this.log.debug({ user: username }, 'User connected');
            return;
        }

        if (!socket.username) {
            this.log.debug('Ignoring MRC client message before its handshake');
            return;
        }

        this.receiveFromClient(socket, line);
    }

    _clientDisconnected(socket) {
        if (!connectedSockets.delete(socket)) {
            return;
        }

        //  the user may still be here on another node, or back already: an
        //  old session closing after a quick rejoin must not log them off
        const name = socket.username.toUpperCase();
        for (const other of connectedSockets) {
            if (other.username.toUpperCase() === name) {
                return;
            }
        }

        this.sendToMrcServer(
            socket.username,
            socket.room || '',
            'SERVER',
            '',
            '',
            'LOGOFF'
        );
    }

    get enabled() {
        return _.get(Config(), 'chatServers.mrc.enabled', false) && this.isConfigured();
    }

    isConfigured() {
        const config = Config();
        return _.isNumber(_.get(config, 'chatServers.mrc.multiplexerPort'));
    }

    /**
     * Sends received messages to local clients
     */
    sendToClient(message) {
        connectedSockets.forEach(client => {
            if (!client.writable) {
                return; //  closing; 'close' unregisters it
            }

            if (
                message.to_user == '' ||
                message.to_user.toUpperCase() == client.username.toUpperCase() ||
                message.to_user.toUpperCase() == 'CLIENT' ||
                message.from_user.toUpperCase() == client.username.toUpperCase() ||
                message.to_user.toUpperCase() == 'NOTME'
            ) {
                // this.log.debug({ server : 'MRC', username : client.username, message : message }, 'Forwarding message to connected user');
                client.write(JSON.stringify(message) + '\n');
            }
        });
    }

    /**
     * Processes messages received from the central MRC server
     */
    receiveFromMRC(message) {
        if (message.from_user == 'SERVER' && message.body == 'HELLO') {
            this._sendBbsInfo();
        } else if (
            message.from_user == 'SERVER' &&
            message.body.toUpperCase() == 'PING'
        ) {
            // reply to heartbeat
            this.sendToMrcServer(
                'CLIENT',
                '',
                'SERVER',
                'ALL',
                '',
                `IMALIVE:${this.boardName}`
            );
        } else {
            // if not a heartbeat, and we have clients then we need to send something to them
            this.sendToClient(message);
        }
    }

    /**
     * Takes an MRC message and parses it into something usable
     */
    parseMessage(line) {
        const fields = line.split('~');

        //  every MRC line has all seven fields; a short one would reach the
        //  code below and the chat sessions with fields undefined
        if (fields.length < 7) {
            this.log.debug({ line }, 'Ignoring malformed line from MRC server');
            return;
        }

        // Preserve original case from the wire format; use case-insensitive comparisons elsewhere
        const [from_user, from_site, from_room, to_user, to_site, to_room, body] = fields;

        return { from_user, from_site, from_room, to_user, to_site, to_room, body };
    }

    /**
     * Receives a message from a local client and sanity checks before sending on to the central MRC server
     */
    receiveFromClient(socket, message) {
        const username = socket.username;
        try {
            message = JSON.parse(message);
            if (!_.isPlainObject(message)) {
                throw new Error('not an object');
            }

            if (_.isString(message.from_room)) {
                socket.room = message.from_room; //  for the LOGOFF on close
            }

            //  a session sends LOGOFF as it leaves; the multiplexer sends it
            //  itself when the connection closes, and only if the user is not
            //  still connected on another one (see _clientDisconnected)
            if (
                String(message.to_user).toUpperCase() === 'SERVER' &&
                String(message.body).toUpperCase() === 'LOGOFF'
            ) {
                return;
            }

            //  sent as the user this connection registered as, whatever the
            //  message claims: the multiplexer has no login of its own
            this.sendToMrcServer(
                username,
                message.from_room,
                message.to_user,
                message.to_site,
                message.to_room,
                message.body
            );
        } catch (e) {
            Log.debug(
                { error: e.message, server: 'MRC', user: username, message: message },
                'Dodgy message received from client'
            );
        }
    }

    /**
     * Converts a message back into the MRC format and sends it to the central MRC server
     */
    sendToMrcServer(fromUser, fromRoom, toUser, toSite, toRoom, messageBody) {
        const line =
            [
                sanitiseFromUser(fromUser || ''),
                this.boardName,
                sanitiseRoomName(fromRoom || ''),
                sanitiseName(toUser || ''),
                sanitiseName(toSite || ''),
                sanitiseRoomName(toRoom || ''),
                sanitiseMessage(messageBody || ''),
            ].join('~') + '~';

        // Log.debug({ server : 'MRC', data : line }, 'Sending data');
        this.sendRaw(line);
    }

    sendRaw(message) {
        // optionally log messages here
        this.mrcClient.write(message + '\n');
    }
};

//
//  The MRC protocol allows no MCI in names: these remove every '|' and two
//  code characters, known code or not, which is more than the pipe code
//  tokenizer would (it keeps an unknown |XY and |1A as text), so they stay
//  protocol filters rather than PipeCodes.strip().
//
//  Repeated until nothing changes: removing one code can join the
//  characters around it into another ('X|0|077' -> 'X|07').
//
function removeUntilStable(str, re) {
    let prev;
    do {
        prev = str;
        str = str.replace(re, '');
    } while (str !== prev);
    return str;
}

/**
 * User / site name must be ASCII 33-125, no MCI, 30 chars max, underscores
 */
function sanitiseName(str) {
    return removeUntilStable(
        str.replace(/\s/g, '_'),
        /[^\x21-\x7D]|(\|[0-9A-Z]{2})/g // Non-printable & MCI
    ).substr(0, 30);
}

function sanitiseRoomName(message) {
    return removeUntilStable(message, /[^\x21-\x7D]|(\|\w\w)/g).substr(0, 30);
}

/**
 * The sending user: as a message body, so no '~' (the field separator) or
 * control characters. Spaces are kept, as before, so the name still matches
 * the user's alias when MRC echoes it back.
 */
function sanitiseFromUser(str) {
    return sanitiseMessage(str);
}

function sanitiseMessage(message) {
    return message.replace(/[^\x20-\x7D]/g, '');
}
