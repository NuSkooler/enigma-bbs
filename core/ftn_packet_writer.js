/* jslint node: true */
'use strict';

const ftnMailPacket = require('./ftn_mail_packet.js');
const loggerModule = require('./logger.js');

const fs = require('graceful-fs');

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
    }

    //  Adds |message|, already prepared for this destination, as written with
    //  |exportOpts| (whose .encoding prepareMessage() set).
    append(message, exportOpts, cb) {
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

                return cb(null);
            });
        };

        if (this.packet && this.size >= this.targetSize) {
            return this._finalizePacket(add);
        }
        return add();
    }

    //  Closes the last packet, writes any held-back message into one of its
    //  own, and calls back with every file written, in order.
    finish(cb) {
        const writeRemain = () => {
            if (!this.remainBuf) {
                return cb(null, this.files);
            }

            this._openPacket(this.remainMessageId);
            this.ws.write(this.remainBuf);
            this.remainBuf = null;
            return this._finalizePacket(() => cb(null, this.files));
        };

        if (this.packet) {
            return this._finalizePacket(writeRemain);
        }
        return writeRemain();
    }

    //  Gives up on this destination: closes the open stream, if any. What was
    //  written stays where it is and is not delivered.
    abort() {
        if (this.ws) {
            this.ws.end();
        }
        this.packet = null;
        this.ws = null;
        this.remainBuf = null;
    }

    _openPacket(messageId) {
        this.packet = new ftnMailPacket.Packet();

        const pktFileName = this.allocatePacketPath(messageId);
        this.files.push(pktFileName);

        this.ws = fs.createWriteStream(pktFileName);
        this.ws.once('error', err =>
            loggerModule.log.error(
                { pktFileName, error: err.message },
                'FTN packet write error'
            )
        );

        this.size = this.packet.writeHeader(this.ws, this.createHeader());
    }

    _finalizePacket(cb) {
        const ws = this.ws;
        this.packet.writeTerminator(ws);
        this.packet = null;
        this.ws = null;
        ws.end();
        ws.once('finish', () => cb(null));
    }
};
