/* jslint node: true */
'use strict';

const stringFormat      = require('./string_format.js');
const { Errors }        = require('./enig_error.js');

//  deps
const pty               = require('node-pty');
const decode            = require('iconv-lite').decode;
const createServer      = require('net').createServer;
const paths             = require('path');
const sanatizeFilename  = require('sanitize-filename');

module.exports = class Door {
    constructor(client) {
        this.client     = client;
        this.restored   = false;
    }

    prepare(ioType, cb) {
        this.io = ioType;

        //  we currently only have to do any real setup for 'socket'
        if('socket' !== ioType) {
            return cb(null);
        }

        this.sockServer = createServer(conn => {
            conn.once('end', () => {
                return this.restoreIo(conn);
            });

            conn.once('error', err => {
                this.client.log.info( { error : err.message }, 'Door socket server connection');
                return this.restoreIo(conn);
            });

            this.sockServer.getConnections( (err, count) => {
                //  We expect only one connection from our DOOR/emulator/etc.
                if(!err && count <= 1) {
                    this.client.term.output.pipe(conn);
                    conn.on('data', this.doorDataHandler.bind(this));
                }
            });
        });

        this.sockServer.listen(0, () => {
            return cb(null);
        });
    }

    run(exeInfo, cb) {
        this.encoding = (exeInfo.encoding || 'cp437').toLowerCase();

        if('socket' === this.io && !this.sockServer) {
            return cb(Errors.UnexpectedState('Socket server is not running'));
        }

        const cwd = exeInfo.cwd || paths.dirname(exeInfo.cmd);

        const formatObj = {
            dropFile        : exeInfo.dropFile,
            dropFilePath    : exeInfo.dropFilePath,
            node            : exeInfo.node.toString(),
            srvPort         : this.sockServer ? this.sockServer.address().port.toString() : '-1',
            userId          : this.client.user.userId.toString(),
            userName        : sanatizeFilename(this.client.user.username),
            userNameRaw     : this.client.user.username,
            cwd             : cwd,
        };

        const args = exeInfo.args.map( arg => stringFormat(arg, formatObj) );

        this.client.log.debug(
            { cmd : exeInfo.cmd, args, io : this.io },
            'Executing door'
        );

        let door;
        try {
            door = pty.spawn(exeInfo.cmd, args, {
                cols        : this.client.term.termWidth,
                rows        : this.client.term.termHeight,
                cwd         : cwd,
                env         : exeInfo.env,
                encoding    : null, //  we want to handle all encoding ourself
            });
        } catch(e) {
            return cb(e);
        }

        if('stdio' === this.io) {
            this.client.log.debug('Using stdio for door I/O');

            this.client.term.output.pipe(door);

            door.on('data', this.doorDataHandler.bind(this));

            door.once('close', () => {
                return this.restoreIo(door);
            });
        } else if('socket' === this.io) {
            this.client.log.debug(
                { srvPort : this.sockServer.address().port, srvSocket : this.sockServerSocket },
                'Using temporary socket server for door I/O'
            );
        }

        door.once('exit', exitCode => {
            this.client.log.info( { exitCode : exitCode }, 'Door exited');

            if(this.sockServer) {
                this.sockServer.close();
            }

            //  we may not get a close
            if('stdio' === this.io) {
                this.restoreIo(door);
            }

            door.removeAllListeners();

            return cb(null);
        });
    }

    doorDataHandler(data) {
        this.client.term.write(decode(data, this.encoding));
    }

    restoreIo(piped) {
        if(!this.restored && this.client.term.output) {
            this.client.term.output.unpipe(piped);
            this.client.term.output.resume();
            this.restored = true;
        }
    }
};
