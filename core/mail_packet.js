/* jslint node: true */
'use strict';

var events = require('events');
var assert = require('assert');
var _ = require('lodash');

module.exports = MailPacket;

function MailPacket(options) {
    events.EventEmitter.call(this);

    //  map of network name -> address obj ( { zone, net, node, point, domain } )
    this.nodeAddresses = options.nodeAddresses || {};
}

require('util').inherits(MailPacket, events.EventEmitter);

MailPacket.prototype.read = function (options) {
    //
    //  options.packetPath | opts.packetBuffer: supplies a path-to-file
    //  or a buffer containing packet data
    //
    //  emits 'message' event per message read
    //
    assert(_.isString(options.packetPath) || Buffer.isBuffer(options.packetBuffer));
};

MailPacket.prototype.write = function (options) {
    //
    //  options.messages[]: array of message(s) to create packets from
    //
    //  emits 'packet' event per packet constructed
    //
    assert(_.isArray(options.messages));
};
