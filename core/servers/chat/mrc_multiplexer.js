/* jslint node: true */
'use strict';

//  ENiGMA½
const Log                   = require('../../logger.js').log;
const { ServerModule }      = require('../../server_module.js');
const Config                = require('../../config.js').get;
const { Errors }            = require('../../enig_error.js');
const SysProps              = require('../../system_property.js');
const StatLog               = require('../../stat_log.js');

//  deps
const net                   = require('net');
const _                     = require('lodash');
const os                    = require('os');


// MRC
const PROTOCOL_VERSION = '1.2.9';

const ModuleInfo = exports.moduleInfo = {
    name        : 'MRC',
    desc        : 'An MRC Chat Multiplexer',
    author      : 'RiPuk',
    packageName : 'codes.l33t.enigma.mrc.server',
    notes       : 'https://bbswiki.bottomlessabyss.net/index.php?title=MRC_Chat_platform',
};

const connectedSockets = new Set();
let mrcCentralConnection = '';

exports.getModule = class MrcModule extends ServerModule {
    constructor() {
        super();
        this.log        = Log.child( { server : 'MRC' } );
    }

    createServer(cb) {
        if (!this.enabled) {
            return cb(null);
        }

        const self = this;

        const config = Config();
        const boardName  = config.general.prettyBoardName || config.general.boardName;
        const enigmaVersion = 'ENiGMA-BBS_' + require('../../../package.json').version;

        const mrcConnectOpts = {
            host    : config.chatServers.mrc.serverHostname || 'mrc.bottomlessabyss.net',
            port    : config.chatServers.mrc.serverPort || 5000
        };

        const handshake = `${boardName}~${enigmaVersion}/${os.platform()}-${os.arch()}/${PROTOCOL_VERSION}`;
        this.log.debug({ handshake : handshake }, 'Handshaking with MRC server');

        // create connection to MRC server
        this.mrcClient = net.createConnection(mrcConnectOpts, () => {
            this.mrcClient.write(handshake);
            this.log.info(mrcConnectOpts, 'Connected to MRC server');
            mrcCentralConnection = this.mrcClient;
        });

        // do things when we get data from MRC central
        this.mrcClient.on('data', (data) => {
            // split on \n to deal with getting messages in batches
            data.toString().split('\n').forEach( item => {
                if (item == '') return;

                this.log.debug( { data : item } , 'Received data');
                let message = this.parseMessage(item);
                this.log.debug(message, 'Parsed data');
                if (message) {
                    this.receiveFromMRC(this.mrcClient, message);
                }
            });
        });

        this.mrcClient.on('end', () => {
            this.log.info(mrcConnectOpts, 'Disconnected from MRC server');
        });

        this.mrcClient.on('error', err => {
            this.log.info( { error : err.message }, 'MRC server error');
        });

        // start a local server for clients to connect to
        this.server = net.createServer( function(socket) {
            socket.setEncoding('ascii');

            socket.on('data', data => {
                // split on \n to deal with getting messages in batches
                data.toString().split('\n').forEach( item => {
                    if (item == '') return;

                    // save username with socket
                    if(item.startsWith('--DUDE-ITS--')) {
                        connectedSockets.add(socket);
                        socket.username = item.split('|')[1];
                        Log.debug( { server : 'MRC', user: socket.username } , 'User connected');
                    } else {
                        self.receiveFromClient(socket.username, item);
                    }
                });
            });

            socket.on('end', function() {
                connectedSockets.delete(socket);
            });

            socket.on('error', err => {
                if('ECONNRESET' !== err.code) { //  normal
                    this.log.error( { error: err.message }, 'MRC error' );
                }
            });
        });

        return cb(null);
    }

    listen(cb) {
        if (!this.enabled) {
            return cb(null);
        }

        const config = Config();

        const port = parseInt(config.chatServers.mrc.multiplexerPort);
        if(isNaN(port)) {
            this.log.warn( { port : config.chatServers.mrc.multiplexerPort, server : ModuleInfo.name }, 'Invalid port' );
            return cb(Errors.Invalid(`Invalid port: ${config.chatServers.mrc.multiplexerPort}`));
        }
        Log.info( { server : ModuleInfo.name, port : config.chatServers.mrc.multiplexerPort }, 'MRC multiplexer local listener starting up');
        return this.server.listen(port, cb);
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
        connectedSockets.forEach( (client) => {
            if (message.to_user == '' || message.to_user == client.username || message.to_user == 'CLIENT' || message.from_user == client.username || message.to_user == 'NOTME' ) {
                this.log.debug({ server : 'MRC', username : client.username, message : message }, 'Forwarding message to connected user');
                client.write(JSON.stringify(message) + '\n');
            } else {
                this.log.debug({ server : 'MRC', username : client.username, message : message }, 'Not forwarding message');
            }
        });
    }

    /**
     * Processes messages received     // split raw data received into an object we can work withfrom the central MRC server
     */
    receiveFromMRC(socket, message) {

        const config = Config();
        const siteName = slugify(config.general.boardName);

        if (message.from_user == 'SERVER' && message.body == 'HELLO') {
            // reply with extra bbs info
            this.sendToMrcServer(socket, 'CLIENT', '', 'SERVER', 'ALL', '', `INFOSYS:${StatLog.getSystemStat(SysProps.SysOpUsername)}`);

        } else if (message.from_user == 'SERVER' && message.body.toUpperCase() == 'PING') {
            // reply to heartbeat
            // this.log.debug('Respond to heartbeat');
            this.sendToMrcServer(socket, 'CLIENT', '', 'SERVER', 'ALL', '', `IMALIVE:${siteName}`);

        } else {
            // if not a heartbeat, and we have clients then we need to send something to them
            this.sendToClient(message);
        }
    }

    /**
     * Takes an MRC message and parses it into something usable
     */
    parseMessage(line) {
        const msg = line.split('~');
        if (msg.length < 7) {
            return;
        }

        return {
            from_user: msg[0],
            from_site: msg[1],
            from_room: msg[2],
            to_user: msg[3],
            to_site: msg[4],
            to_room: msg[5],
            body: msg[6]
        };
    }

    /**
     * Receives a message from a local client and sanity checks before sending on to the central MRC server
     */
    receiveFromClient(username, message) {
        try {
            message = JSON.parse(message);
        } catch (e) {
            Log.debug({ server : 'MRC', user : username, message : message }, 'Dodgy message received from client');
        }

        this.sendToMrcServer(mrcCentralConnection, message.from_user, message.from_room, message.to_user, message.to_site, message.to_room, message.body);
    }

    /**
     * Converts a message back into the MRC format and sends it to the central MRC server
     */
    sendToMrcServer(socket, fromUser, fromRoom, toUser, toSite, toRoom, messageBody) {
        const config = Config();
        const siteName = slugify(config.general.boardName);

        const line = [
            fromUser,
            siteName,
            sanitiseRoomName(fromRoom),
            sanitiseName(toUser || ''),
            sanitiseName(toSite || ''),
            sanitiseRoomName(toRoom || ''),
            sanitiseMessage(messageBody)
        ].join('~') + '~';

        Log.debug({ server : 'MRC', data : line }, 'Sending data');
        return socket.write(line + '\n');
    }
};

/**
 * User / site name must be ASCII 33-125, no MCI, 30 chars max, underscores
 */
function sanitiseName(str) {
    return str.replace(
        /\s/g, '_'
    ).replace(
        /[^\x21-\x7D]|(\|\w\w)/g, '' // Non-printable & MCI
    ).substr(
        0, 30
    );
}

function sanitiseRoomName(message) {
    return message.replace(/[^\x21-\x7D]|(\|\w\w)/g, '').substr(0, 30);
}

function sanitiseMessage(message) {
    return message.replace(/[^\x20-\x7D]/g, '');
}

/**
 * SLugifies the BBS name for use as an MRC "site name"
 */
function slugify(text) {
    return text.toString()
        .replace(/\s+/g, '_')           // Replace spaces with _
        .replace(/[^\w\-]+/g, '')       // Remove all non-word chars
        .replace(/\-\-+/g, '_')         // Replace multiple - with single -
        .replace(/^-+/, '')             // Trim - from start of text
        .replace(/-+$/, '');            // Trim - from end of text
}