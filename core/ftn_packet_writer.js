/* jslint node: true */
'use strict';

const ftnMailPacket = require('./ftn_mail_packet.js');
const loggerModule = require('./logger.js');

const fs = require('graceful-fs');
const { finished } = require('stream');

//
//  Packs one destination's outgoing EchoMail into packets of about
//  |targetSize| bytes, a message at a time.
//
//  This is the state the exporter used to keep in locals for a single uplink
//  -- the open packet and its stream, the running size, the message carried
//  over to the next packet, the files written -- so that several destinations
//  can be fed one message at a time, each into its own packets. The packing
//  is unchanged, quirks included:
//
//  * a packet is closed when the *next* message arrives, not when it fills;
//  * the message that takes a packet to |targetSize| or over is held back and
//    written first into the next packet, which is named from the message that
//    arrives after it (or from the held-back message itself, at the end);
//  * so a message larger than a packet, arriving first, leaves an empty packet
//    (header and terminator only) ahead of the one that carries it.
//
//  |createHeader()| returns the PacketHeader for a new packet;
//  |allocatePacketPath(messageId)| returns the path to write it to.
//
module.exports = class FtnPacketWriter {
    constructor({ targetSize, createHeader, allocatePacketPath }) {
        this.targetSize = targetSize;
        this.createHeader = createHeader;
        this.allocatePacketPath = allocatePacketPath;

        this.files = [];
        this.packet = null;
        this.ws = null;
        this.size = targetSize; //  so the first message opens a packet
        this.remainBuf = null;
        this.remainMessageId = null;

        //  The first error any of this writer's streams reported: a packet
        //  that could not be opened or written (ENOENT, EACCES, ENOSPC,
        //  EMFILE...). Such a stream never finishes, and its packet is not
        //  whole, so it fails the destination at the next append() or at
        //  finish().
        this.error = null;
    }

    //  Adds |message|, already prepared for this destination, as written with
    //  |exportOpts| (whose .encoding prepareMessage() set).
    append(message, exportOpts, cb) {
        if (this.error) {
            return cb(this.error);
        }

        const add = () => {
            if (this.size >= this.targetSize) {
                this._openPacket(message.messageId);

                if (this.remainBuf) {
                    this.size += this.packet.writeMessageEntry(this.ws, this.remainBuf);
                    this.remainBuf = null;
                }
            }

            this.packet.getMessageEntryBuffer(message, exportOpts, (err, msgBuf) => {
                if (err) {
                    return cb(err);
                }

                this.size += msgBuf.length;

                if (this.size >= this.targetSize) {
                    this.remainBuf = msgBuf; //  save for next packet
                    this.remainMessageId = message.messageId;
                } else {
                    this.ws.write(msgBuf);
                }

                return cb(this.error);
            });
        };

        if (this.packet && this.size >= this.targetSize) {
            return this._finalizePacket(err => (err ? cb(err) : add()));
        }
        return add();
    }

    //  Closes the last packet, writes any held-back message into one of its
    //  own, and calls back with every file written, in order -- or with the
    //  first error any of them had.
    finish(cb) {
        if (this.error) {
            return cb(this.error);
        }

        const writeRemain = () => {
            if (!this.remainBuf) {
                return cb(this.error, this.files);
            }

            this._openPacket(this.remainMessageId);
            this.ws.write(this.remainBuf);
            this.remainBuf = null;
            return this._finalizePacket(err => cb(err, this.files));
        };

        if (this.packet) {
            return this._finalizePacket(err => (err ? cb(err) : writeRemain()));
        }
        return writeRemain();
    }

    //  Gives up on this destination: closes the open stream, if any, and
    //  removes every packet this writer wrote, none of which will be
    //  delivered. Best effort: a file that cannot be removed is logged and
    //  left. Calls back once it is done, never with an error.
    discard(cb) {
        const ws = this.ws;
        this.packet = null;
        this.ws = null;
        this.remainBuf = null;

        const unlinkAll = () => {
            const files = this.files;
            this.files = [];
            let pending = files.length;
            if (0 === pending) {
                return cb();
            }
            files.forEach(file => {
                fs.unlink(file, err => {
                    if (err && 'ENOENT' !== err.code) {
                        loggerModule.log.warn(
                            { path: file, error: err.message },
                            'Could not remove an undelivered FTN packet'
                        );
                    }
                    if (0 === --pending) {
                        return cb();
                    }
                });
            });
        };

        if (!ws) {
            return unlinkAll();
        }
        //  closed first, so the removal is not racing an open descriptor
        ws.destroy();
        return finishedOnce(ws, () => unlinkAll());
    }

    _openPacket(messageId) {
        this.packet = new ftnMailPacket.Packet();

        const pktFileName = this.allocatePacketPath(messageId);
        this.files.push(pktFileName);

        this.ws = fs.createWriteStream(pktFileName);
        //  on, not once: a stream that has failed can report again when it is
        //  written to, and an unhandled 'error' would take the process down
        this.ws.on('error', err => {
            if (!this.error) {
                loggerModule.log.error(
                    { pktFileName, error: err.message },
                    'FTN packet write error'
                );
                this.error = err;
            }
        });

        this.size = this.packet.writeHeader(this.ws, this.createHeader());
    }

    //  Calls back exactly once, when the stream has finished or failed.
    _finalizePacket(cb) {
        const ws = this.ws;
        this.packet.writeTerminator(ws);
        this.packet = null;
        this.ws = null;
        ws.end();
        finishedOnce(ws, err => cb(this.error || err || null));
    }
};

//  stream.finished(), calling back once whatever the stream does afterwards,
//  and also for a stream that has already failed or closed.
function finishedOnce(stream, cb) {
    let called = false;
    finished(stream, err => {
        if (called) {
            return;
        }
        called = true;
        return cb(err);
    });
}
