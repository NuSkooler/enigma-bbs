/* jslint node: true */
'use strict';

//  ENiGMA½
const MessageScanTossModule = require('../msg_scan_toss_module.js').MessageScanTossModule;
const Config = require('../config.js').get;
const ftnMailPacket = require('../ftn_mail_packet.js');
const ftnUtil = require('../ftn_util.js');
const Address = require('../ftn_address.js');
const Log = require('../logger.js').log;
const ArchiveUtil = require('../archive_util.js');
const msgDb = require('../database.js').dbs.message;
const Message = require('../message.js');
const TicFileInfo = require('../tic_file_info.js');
const Errors = require('../enig_error.js').Errors;
const FileEntry = require('../file_entry.js');
const scanFile = require('../file_base_area.js').scanFile;
const getFileAreaByTag = require('../file_base_area.js').getFileAreaByTag;
const getDescFromFileName = require('../file_base_area.js').getDescFromFileName;
const copyFileWithCollisionHandling =
    require('../file_util.js').copyFileWithCollisionHandling;
const getAreaStorageDirectoryByTag =
    require('../file_base_area.js').getAreaStorageDirectoryByTag;
const isValidStorageTag = require('../file_base_area.js').isValidStorageTag;
const User = require('../user.js');
const StatLog = require('../stat_log.js');
const SysProps = require('../system_property.js');

//  deps
const moment = require('moment');
const _ = require('lodash');
const paths = require('path');
const async = require('async');
const fs = require('graceful-fs');
const later = require('@breejs/later');
const temptmp = require('temptmp').createTrackedSession('ftn_bso');
const assert = require('assert');
const sane = require('sane');
const fse = require('fs-extra');
const iconv = require('iconv-lite');
const { v4: UUIDv4 } = require('uuid');

exports.moduleInfo = {
    name: 'FTN BSO',
    desc: 'BSO style message scanner/tosser for FTN networks',
    author: 'NuSkooler',
};

/*
    :TODO:
    * Support (approx) max bundle size
    * Validate packet passwords!!!!
        => secure vs insecure landing areas
*/

exports.getModule = FTNMessageScanTossModule;

const SCHEDULE_REGEXP = /(?:^|or )?(@watch:|@immediate)([^\0]+)?$/;

function FTNMessageScanTossModule() {
    MessageScanTossModule.call(this);

    const self = this;

    this.archUtil = ArchiveUtil.getInstance();

    const config = Config();
    if (_.has(config, 'scannerTossers.ftn_bso')) {
        this.moduleConfig = config.scannerTossers.ftn_bso;
    }

    this.getDefaultNetworkName = function () {
        if (this.moduleConfig.defaultNetwork) {
            return this.moduleConfig.defaultNetwork.toLowerCase();
        }

        const networkNames = Object.keys(config.messageNetworks.ftn.networks);
        if (1 === networkNames.length) {
            return networkNames[0].toLowerCase();
        }
    };

    this.getDefaultZone = function (networkName) {
        const config = Config();
        if (_.isNumber(config.messageNetworks.ftn.networks[networkName].defaultZone)) {
            return config.messageNetworks.ftn.networks[networkName].defaultZone;
        }

        //  non-explicit: default to local address zone
        const networkLocalAddress =
            config.messageNetworks.ftn.networks[networkName].localAddress;
        if (networkLocalAddress) {
            const addr = Address.fromString(networkLocalAddress);
            return addr.zone;
        }
    };

    /*
    this.isDefaultDomainZone = function(networkName, address) {
        const defaultNetworkName    = this.getDefaultNetworkName();
        return(networkName === defaultNetworkName && address.zone === this.moduleConfig.defaultZone);
    };
    */

    this.getNetworkNameByAddress = function (remoteAddress) {
        return _.findKey(Config().messageNetworks.ftn.networks, network => {
            const localAddress = Address.fromString(network.localAddress);
            return !_.isUndefined(localAddress) && localAddress.isEqual(remoteAddress);
        });
    };

    this.getNetworkNameByAddressPattern = function (remoteAddressPattern) {
        return _.findKey(Config().messageNetworks.ftn.networks, network => {
            const localAddress = Address.fromString(network.localAddress);
            return (
                !_.isUndefined(localAddress) &&
                localAddress.isPatternMatch(remoteAddressPattern)
            );
        });
    };

    this.getLocalAreaTagByFtnAreaTag = function (ftnAreaTag) {
        ftnAreaTag = ftnAreaTag.toUpperCase(); //  always compare upper
        return _.findKey(Config().messageNetworks.ftn.areas, areaConf => {
            return _.isString(areaConf.tag) && areaConf.tag.toUpperCase() === ftnAreaTag;
        });
    };

    this.getExportType = function (nodeConfig) {
        return _.isString(nodeConfig.exportType)
            ? nodeConfig.exportType.toLowerCase()
            : 'crash';
    };

    /*
    this.getSeenByAddresses = function(messageSeenBy) {
        if(!_.isArray(messageSeenBy)) {
            messageSeenBy = [ messageSeenBy ];
        }

        let seenByAddrs = [];
        messageSeenBy.forEach(sb => {
            seenByAddrs = seenByAddrs.concat(ftnUtil.parseAbbreviatedNetNodeList(sb));
        });
        return seenByAddrs;
    };
    */

    this.messageHasValidMSGID = function (msg) {
        return (
            _.isString(msg.meta.FtnKludge.MSGID) && msg.meta.FtnKludge.MSGID.length > 0
        );
    };

    /*
    this.getOutgoingEchoMailPacketDir = function(networkName, destAddress) {
        let dir = this.moduleConfig.paths.outbound;
        if(!this.isDefaultDomainZone(networkName, destAddress)) {
            const hexZone = `000${destAddress.zone.toString(16)}`.substr(-3);
            dir = paths.join(dir, `${networkName.toLowerCase()}.${hexZone}`);
        }
        return dir;
    };
    */

    this.getOutgoingEchoMailPacketDir = function (networkName, destAddress) {
        networkName = networkName.toLowerCase();

        let dir = this.moduleConfig.paths.outbound;

        const defaultNetworkName = this.getDefaultNetworkName();
        const defaultZone = this.getDefaultZone(networkName);

        let zoneExt;
        if (defaultZone !== destAddress.zone) {
            zoneExt = '.' + `000${destAddress.zone.toString(16)}`.substr(-3);
        } else {
            zoneExt = '';
        }

        if (defaultNetworkName === networkName) {
            dir = paths.join(dir, `outbound${zoneExt}`);
        } else {
            dir = paths.join(dir, `${networkName}${zoneExt}`);
        }

        return dir;
    };

    this.getOutgoingPacketFileName = function (basePath, messageId, isTemp, fileCase) {
        //
        //  Generating an outgoing packet file name comes with a few issues:
        //  *   We must use DOS 8.3 filenames due to legacy systems that receive
        //      the packet not understanding LFNs
        //  *   We need uniqueness; This is especially important with packets that
        //      end up in bundles and on the receiving/remote system where conflicts
        //      with other systems could also occur
        //
        //  There are a lot of systems in use here for the name:
        //  *   HEX CRC16/32 of data
        //  *   HEX UNIX timestamp
        //  *   Mystic at least at one point, used Hex8(day of month + seconds past midnight + hundredths of second)
        //      See https://groups.google.com/forum/#!searchin/alt.bbs.mystic/netmail$20filename/alt.bbs.mystic/m1xLnY8i1pU/YnG2excdl6MJ
        //  *   SBBSEcho uses DDHHMMSS - see https://github.com/ftnapps/pkg-sbbs/blob/master/docs/fidonet.txt
        //  *   We already have a system for 8-character serial number gernation that is
        //      used for e.g. in FTS-0009.001 MSGIDs... let's use that!
        //
        const name = ftnUtil.getMessageSerialNumber(messageId);
        const ext = true === isTemp ? 'pk_' : 'pkt';

        let fileName = `${name}.${ext}`;
        if ('upper' === fileCase) {
            fileName = fileName.toUpperCase();
        }

        return paths.join(basePath, fileName);
    };

    this.getOutgoingFlowFileExtension = function (
        destAddress,
        flowType,
        exportType,
        fileCase
    ) {
        let ext;

        switch (flowType) {
            case 'mail':
                ext = `${exportType.toLowerCase()[0]}ut`;
                break;
            case 'ref':
                ext = `${exportType.toLowerCase()[0]}lo`;
                break;
            case 'busy':
                ext = 'bsy';
                break;
            case 'request':
                ext = 'req';
                break;
            case 'requests':
                ext = 'hrq';
                break;
        }

        if ('upper' === fileCase) {
            ext = ext.toUpperCase();
        }

        return ext;
    };

    this.getOutgoingFlowFileName = function (
        basePath,
        destAddress,
        flowType,
        exportType,
        fileCase
    ) {
        //
        //  Refs
        //  * http://ftsc.org/docs/fts-5005.003
        //  * http://wiki.synchro.net/ref:fidonet_files#flow_files
        //
        let controlFileBaseName;
        let pointDir;

        const ext = self.getOutgoingFlowFileExtension(
            destAddress,
            flowType,
            exportType,
            fileCase
        );

        const netComponent = `0000${destAddress.net.toString(16)}`.substr(-4);
        const nodeComponent = `0000${destAddress.node.toString(16)}`.substr(-4);

        if (destAddress.point) {
            //  point's go in an extra subdir, e.g. outbound/NNNNnnnn.pnt/00000001.pnt (for a point of 1)
            pointDir = `${netComponent}${nodeComponent}.pnt`;
            controlFileBaseName = `00000000${destAddress.point.toString(16)}`.substr(-8);
        } else {
            pointDir = '';

            //
            //  Use |destAddress| nnnnNNNN.??? where nnnn is dest net and NNNN is dest
            //  node. This seems to match what Mystic does
            //
            controlFileBaseName = `${netComponent}${nodeComponent}`;
        }

        //
        //  From FTS-5005.003: "Lower case filenames are prefered if supported by the file system."
        //  ...but we let the user override.
        //
        if ('upper' === fileCase) {
            controlFileBaseName = controlFileBaseName.toUpperCase();
            pointDir = pointDir.toUpperCase();
        }

        return paths.join(basePath, pointDir, `${controlFileBaseName}.${ext}`);
    };

    this.flowFileAppendRefs = function (filePath, fileRefs, directive, cb) {
        //
        //  We have to ensure the *directory* of |filePath| exists here esp.
        //  for cases such as point destinations where a subdir may be
        //  present in the path that doesn't yet exist.
        //
        const flowFileDir = paths.dirname(filePath);
        fse.mkdirs(flowFileDir, () => {
            //  note not checking err; let's try appendFile
            const appendLines = fileRefs.reduce((content, ref) => {
                return content + `${directive}${ref}\n`;
            }, '');

            fs.appendFile(filePath, appendLines, err => {
                return cb(err);
            });
        });
    };

    this.getOutgoingBundleFileName = function (basePath, sourceAddress, destAddress, cb) {
        //
        //  Base filename is constructed as such:
        //  *   If this |destAddress| is *not* a point address, we use NNNNnnnn where
        //      NNNN is 0 padded hex of dest net - source net and and nnnn is 0 padded
        //      hex of dest node - source node.
        //  *   If |destAddress| is a point, NNNN becomes 0000 and nnnn becomes 'p' +
        //      3 digit 0 padded hex point
        //
        //  Extension is dd? where dd is Su...Mo and ? is 0...Z as collisions arise
        //
        let basename;
        if (destAddress.point) {
            const pointHex = `000${destAddress.point}`.substr(-3);
            basename = `0000p${pointHex}`;
        } else {
            basename =
                `0000${Math.abs(sourceAddress.net - destAddress.net).toString(
                    16
                )}`.substr(-4) +
                `0000${Math.abs(sourceAddress.node - destAddress.node).toString(
                    16
                )}`.substr(-4);
        }

        //
        //  We need to now find the first entry that does not exist starting
        //  with dd0 to ddz
        //
        const EXT_SUFFIXES = '0123456789abcdefghijklmnopqrstuvwxyz'.split('');
        let fileName = `${basename}.${moment().format('dd').toLowerCase()}`;
        async.detectSeries(
            EXT_SUFFIXES,
            (suffix, callback) => {
                const checkFileName = fileName + suffix;
                fs.stat(paths.join(basePath, checkFileName), err => {
                    callback(null, err && 'ENOENT' === err.code ? true : false);
                });
            },
            (err, finalSuffix) => {
                if (finalSuffix) {
                    return cb(null, paths.join(basePath, fileName + finalSuffix));
                }

                return cb(new Error('Could not acquire a bundle filename!'));
            }
        );
    };

    this.prepareMessage = function (message, options) {
        //
        //  Set various FTN kludges/etc.
        //
        const localAddress = new Address(options.network.localAddress); //  ensure we have an Address obj not a string version

        //  :TODO: create Address.toMeta() / similar
        message.meta.FtnProperty = message.meta.FtnProperty || {};
        message.meta.FtnKludge = message.meta.FtnKludge || {};

        message.meta.FtnProperty.ftn_orig_node = localAddress.node;
        message.meta.FtnProperty.ftn_orig_network = localAddress.net;
        message.meta.FtnProperty.ftn_cost = 0;
        message.meta.FtnProperty.ftn_msg_orig_node = localAddress.node;
        message.meta.FtnProperty.ftn_msg_orig_net = localAddress.net;

        const destAddress = options.routeAddress || options.destAddress;
        message.meta.FtnProperty.ftn_dest_node = destAddress.node;
        message.meta.FtnProperty.ftn_dest_network = destAddress.net;

        if (destAddress.zone) {
            message.meta.FtnProperty.ftn_dest_zone = destAddress.zone;
        }
        if (destAddress.point) {
            message.meta.FtnProperty.ftn_dest_point = destAddress.point;
        }

        //  tear line and origin can both go in EchoMail & NetMail
        message.meta.FtnProperty.ftn_tear_line = ftnUtil.getTearLine();
        message.meta.FtnProperty.ftn_origin = ftnUtil.getOrigin(localAddress);

        let ftnAttribute = ftnMailPacket.Packet.Attribute.Local; //  message from our system

        const config = Config();
        if (self.isNetMailMessage(message)) {
            //
            //  Set route and message destination properties -- they may differ
            //
            message.meta.FtnProperty.ftn_msg_dest_node = options.destAddress.node;
            message.meta.FtnProperty.ftn_msg_dest_net = options.destAddress.net;

            ftnAttribute |= ftnMailPacket.Packet.Attribute.Private;

            //
            //  NetMail messages need a FRL-1005.001 "Via" line
            //  http://ftsc.org/docs/frl-1005.001
            //
            //  :TODO:  We need to do this when FORWARDING NetMail
            /*
            if(_.isString(message.meta.FtnKludge.Via)) {
                message.meta.FtnKludge.Via = [ message.meta.FtnKludge.Via ];
            }
            message.meta.FtnKludge.Via = message.meta.FtnKludge.Via || [];
            message.meta.FtnKludge.Via.push(ftnUtil.getVia(options.network.localAddress));
            */

            //
            //  We need to set INTL, and possibly FMPT and/or TOPT
            //  See http://retro.fidoweb.ru/docs/index=ftsc&doc=FTS-4001&enc=mac
            //
            message.meta.FtnKludge.INTL = ftnUtil.getIntl(
                options.destAddress,
                localAddress
            );

            if (_.isNumber(localAddress.point) && localAddress.point > 0) {
                message.meta.FtnKludge.FMPT = localAddress.point;
            }

            if (_.isNumber(options.destAddress.point) && options.destAddress.point > 0) {
                message.meta.FtnKludge.TOPT = options.destAddress.point;
            }
        } else {
            //
            //  Set appropriate attribute flag for export type
            //
            switch (this.getExportType(options.nodeConfig)) {
                case 'crash':
                    ftnAttribute |= ftnMailPacket.Packet.Attribute.Crash;
                    break;
                case 'hold':
                    ftnAttribute |= ftnMailPacket.Packet.Attribute.Hold;
                    break;
                //  :TODO: Others?
            }

            //
            //  EchoMail requires some additional properties & kludges
            //
            message.meta.FtnProperty.ftn_area =
                config.messageNetworks.ftn.areas[message.areaTag].tag;

            //
            //  When exporting messages, we should create/update SEEN-BY
            //  with remote address(s) we are exporting to.
            //
            const seenByAdditions = [`${localAddress.net}/${localAddress.node}`].concat(
                config.messageNetworks.ftn.areas[message.areaTag].uplinks
            );
            message.meta.FtnProperty.ftn_seen_by = ftnUtil.getUpdatedSeenByEntries(
                message.meta.FtnProperty.ftn_seen_by,
                seenByAdditions
            );

            //
            //  And create/update PATH for ourself
            //
            message.meta.FtnKludge.PATH = ftnUtil.getUpdatedPathEntries(
                message.meta.FtnKludge.PATH,
                localAddress
            );
        }

        message.meta.FtnProperty.ftn_attr_flags = ftnAttribute;

        //
        //  Additional kludges
        //
        //  Check for existence of MSGID as we may already have stored it from a previous
        //  export that failed to finish
        //
        if (!message.meta.FtnKludge.MSGID) {
            message.meta.FtnKludge.MSGID = ftnUtil.getMessageIdentifier(
                message,
                localAddress,
                message.isPrivate() // true = isNetMail
            );
        }

        message.meta.FtnKludge.TZUTC = ftnUtil.getUTCTimeZoneOffset();

        //
        //  According to FSC-0046:
        //
        //  "When a Conference Mail processor adds a TID to a message, it may not
        //  add a PID. An existing TID should, however, be replaced. TIDs follow
        //  the same format used for PIDs, as explained above."
        //
        message.meta.FtnKludge.TID = ftnUtil.getProductIdentifier();

        //
        //  Determine CHRS and actual internal encoding name. If the message has an
        //  explicit encoding set, use it. Otherwise, try to preserve any CHRS/encoding already set.
        //
        let encoding =
            options.nodeConfig.encoding ||
            config.scannerTossers.ftn_bso.packetMsgEncoding ||
            'utf8';
        const explicitEncoding = _.get(message.meta, 'System.explicit_encoding');
        if (explicitEncoding) {
            encoding = explicitEncoding;
        } else if (message.meta.FtnKludge.CHRS) {
            const encFromChars = ftnUtil.getEncodingFromCharacterSetIdentifier(
                message.meta.FtnKludge.CHRS
            );
            if (encFromChars) {
                encoding = encFromChars;
            }
        }

        //
        //  Ensure we ended up with something useable. If not, back to utf8!
        //
        if (!iconv.encodingExists(encoding)) {
            Log.debug({ encoding: encoding }, 'Unknown encoding. Falling back to utf8');
            encoding = 'utf8';
        }

        options.encoding = encoding; //  save for later
        message.meta.FtnKludge.CHRS =
            ftnUtil.getCharacterSetIdentifierByEncoding(encoding);
    };

    this.setReplyKludgeFromReplyToMsgId = function (message, cb) {
        //
        //  Look up MSGID kludge for |message.replyToMsgId|, if any.
        //  If found, we can create a REPLY kludge with the previously
        //  discovered MSGID.
        //

        if (0 === message.replyToMsgId) {
            return cb(null); //  nothing to do
        }

        Message.getMetaValuesByMessageId(
            message.replyToMsgId,
            'FtnKludge',
            'MSGID',
            (err, msgIdVal) => {
                if (!err) {
                    assert(
                        _.isString(msgIdVal),
                        'Expected string but got ' +
                            typeof msgIdVal +
                            ' (' +
                            msgIdVal +
                            ')'
                    );
                    //  got a MSGID - create a REPLY
                    message.meta.FtnKludge.REPLY = msgIdVal;
                }

                cb(null); //  this method always passes
            }
        );
    };

    //  check paths, Addresses, etc.
    this.isAreaConfigValid = function (areaConfig) {
        if (
            !areaConfig ||
            !_.isString(areaConfig.tag) ||
            !_.isString(areaConfig.network)
        ) {
            return false;
        }

        if (_.isString(areaConfig.uplinks)) {
            areaConfig.uplinks = areaConfig.uplinks.split(' ');
        }

        return _.isArray(areaConfig.uplinks);
    };

    this.hasValidConfiguration = function ({ shouldLog = false } = {}) {
        const hasNodes = _.has(this, 'moduleConfig.nodes');
        const hasAreas = _.has(Config(), 'messageNetworks.ftn.areas');

        if (!hasNodes && !hasAreas) {
            if (shouldLog) {
                Log.warn(
                    {
                        'scannerTossers.ftn_bso.nodes': hasNodes,
                        'messageNetworks.ftn.areas': hasAreas,
                    },
                    'Missing one or more required configuration blocks'
                );
            }
            return false;
        }

        //  :TODO: need to check more!

        return true;
    };

    this.parseScheduleString = function (schedStr) {
        if (!schedStr) {
            return; //  nothing to parse!
        }

        let schedule = {};

        const m = SCHEDULE_REGEXP.exec(schedStr);
        if (m) {
            schedStr = schedStr.substr(0, m.index).trim();

            if ('@watch:' === m[1]) {
                schedule.watchFile = m[2];
            } else if ('@immediate' === m[1]) {
                schedule.immediate = true;
            }
        }

        if (schedStr.length > 0) {
            const sched = later.parse.text(schedStr);
            if (-1 === sched.error) {
                schedule.sched = sched;
            }
        }

        //  return undefined if we couldn't parse out anything useful
        if (!_.isEmpty(schedule)) {
            return schedule;
        }
    };

    this.getAreaLastScanId = function (areaTag, cb) {
        const sql = `SELECT area_tag, message_id
            FROM message_area_last_scan
            WHERE scan_toss = "ftn_bso" AND area_tag = ?
            LIMIT 1;`;

        msgDb.get(sql, [areaTag], (err, row) => {
            return cb(err, row ? row.message_id : 0);
        });
    };

    this.setAreaLastScanId = function (areaTag, lastScanId, cb) {
        const sql = `REPLACE INTO message_area_last_scan (scan_toss, area_tag, message_id)
            VALUES ("ftn_bso", ?, ?);`;

        msgDb.run(sql, [areaTag, lastScanId], err => {
            return cb(err);
        });
    };

    this.getNodeConfigByAddress = function (addr) {
        addr = _.isString(addr) ? Address.fromString(addr) : addr;

        //  :TODO: sort wildcard nodes{} entries by most->least explicit according to FTN hierarchy
        return _.find(this.moduleConfig.nodes, (node, nodeAddrWildcard) => {
            return addr.isPatternMatch(nodeAddrWildcard);
        });
    };

    this.exportNetMailMessagePacket = function (message, exportOpts, cb) {
        //
        //  For NetMail, we always create a *single* packet per message.
        //
        async.series(
            [
                function generalPrep(callback) {
                    self.prepareMessage(message, exportOpts);

                    return self.setReplyKludgeFromReplyToMsgId(message, callback);
                },
                function createPacket(callback) {
                    const packet = new ftnMailPacket.Packet();

                    const packetHeader = new ftnMailPacket.PacketHeader(
                        exportOpts.network.localAddress,
                        exportOpts.routeAddress,
                        exportOpts.nodeConfig.packetType
                    );

                    packetHeader.password = exportOpts.nodeConfig.packetPassword || '';

                    //  use current message ID for filename seed
                    exportOpts.pktFileName = self.getOutgoingPacketFileName(
                        self.exportTempDir,
                        message.messageId,
                        false, //  createTempPacket=false
                        exportOpts.fileCase
                    );

                    const ws = fs.createWriteStream(exportOpts.pktFileName);

                    packet.writeHeader(ws, packetHeader);

                    packet.getMessageEntryBuffer(message, exportOpts, (err, msgBuf) => {
                        if (err) {
                            return callback(err);
                        }

                        ws.write(msgBuf);

                        packet.writeTerminator(ws);

                        ws.end();
                        ws.once('finish', () => {
                            return callback(null);
                        });
                    });
                },
            ],
            err => {
                return cb(err);
            }
        );
    };

    this.exportMessagesByUuid = function (messageUuids, exportOpts, cb) {
        //
        //  This method has a lot of madness going on:
        //  - Try to stuff messages into packets until we've hit the target size
        //  - We need to wait for write streams to finish before proceeding in many cases
        //    or data will be cut off when closing and creating a new stream
        //
        let exportedFiles = [];
        let currPacketSize = self.moduleConfig.packetTargetByteSize;
        let packet;
        let ws;
        let remainMessageBuf;
        let remainMessageId;
        const createTempPacket =
            !_.isString(exportOpts.nodeConfig.archiveType) ||
            0 === exportOpts.nodeConfig.archiveType.length;

        function finalizePacket(cb) {
            packet.writeTerminator(ws);
            ws.end();
            ws.once('finish', () => {
                return cb(null);
            });
        }

        async.each(
            messageUuids,
            (msgUuid, nextUuid) => {
                let message = new Message();

                async.series(
                    [
                        function finalizePrevious(callback) {
                            if (
                                packet &&
                                currPacketSize >= self.moduleConfig.packetTargetByteSize
                            ) {
                                return finalizePacket(callback);
                            } else {
                                callback(null);
                            }
                        },
                        function loadMessage(callback) {
                            message.load({ uuid: msgUuid }, err => {
                                if (err) {
                                    return callback(err);
                                }

                                //  General preperation
                                self.prepareMessage(message, exportOpts);

                                self.setReplyKludgeFromReplyToMsgId(message, err => {
                                    callback(err);
                                });
                            });
                        },
                        function createNewPacket(callback) {
                            if (
                                currPacketSize >= self.moduleConfig.packetTargetByteSize
                            ) {
                                packet = new ftnMailPacket.Packet();

                                const packetHeader = new ftnMailPacket.PacketHeader(
                                    exportOpts.network.localAddress,
                                    exportOpts.destAddress,
                                    exportOpts.nodeConfig.packetType
                                );

                                packetHeader.password =
                                    exportOpts.nodeConfig.packetPassword || '';

                                //  use current message ID for filename seed
                                const pktFileName = self.getOutgoingPacketFileName(
                                    self.exportTempDir,
                                    message.messageId,
                                    createTempPacket,
                                    exportOpts.fileCase
                                );

                                exportedFiles.push(pktFileName);

                                ws = fs.createWriteStream(pktFileName);

                                currPacketSize = packet.writeHeader(ws, packetHeader);

                                if (remainMessageBuf) {
                                    currPacketSize += packet.writeMessageEntry(
                                        ws,
                                        remainMessageBuf
                                    );
                                    remainMessageBuf = null;
                                }
                            }

                            callback(null);
                        },
                        function appendMessage(callback) {
                            packet.getMessageEntryBuffer(
                                message,
                                exportOpts,
                                (err, msgBuf) => {
                                    if (err) {
                                        return callback(err);
                                    }

                                    currPacketSize += msgBuf.length;

                                    if (
                                        currPacketSize >=
                                        self.moduleConfig.packetTargetByteSize
                                    ) {
                                        remainMessageBuf = msgBuf; //  save for next packet
                                        remainMessageId = message.messageId;
                                    } else {
                                        ws.write(msgBuf);
                                    }

                                    return callback(null);
                                }
                            );
                        },
                        function storeStateFlags0Meta(callback) {
                            message.persistMetaValue(
                                'System',
                                'state_flags0',
                                Message.StateFlags0.Exported.toString(),
                                err => {
                                    callback(err);
                                }
                            );
                        },
                        function storeMsgIdMeta(callback) {
                            //
                            //  We want to store some meta as if we had imported
                            //  this message for later reference
                            //
                            if (message.meta.FtnKludge.MSGID) {
                                message.persistMetaValue(
                                    'FtnKludge',
                                    'MSGID',
                                    message.meta.FtnKludge.MSGID,
                                    err => {
                                        callback(err);
                                    }
                                );
                            } else {
                                callback(null);
                            }
                        },
                    ],
                    err => {
                        nextUuid(err);
                    }
                );
            },
            err => {
                if (err) {
                    cb(err);
                } else {
                    async.series(
                        [
                            function terminateLast(callback) {
                                if (packet) {
                                    return finalizePacket(callback);
                                } else {
                                    callback(null);
                                }
                            },
                            function writeRemainPacket(callback) {
                                if (remainMessageBuf) {
                                    //  :TODO: DRY this with the code above -- they are basically identical
                                    packet = new ftnMailPacket.Packet();

                                    const packetHeader = new ftnMailPacket.PacketHeader(
                                        exportOpts.network.localAddress,
                                        exportOpts.destAddress,
                                        exportOpts.nodeConfig.packetType
                                    );

                                    packetHeader.password =
                                        exportOpts.nodeConfig.packetPassword || '';

                                    //  use current message ID for filename seed
                                    const pktFileName = self.getOutgoingPacketFileName(
                                        self.exportTempDir,
                                        remainMessageId,
                                        createTempPacket,
                                        exportOpts.filleCase
                                    );

                                    exportedFiles.push(pktFileName);

                                    ws = fs.createWriteStream(pktFileName);

                                    packet.writeHeader(ws, packetHeader);
                                    ws.write(remainMessageBuf);
                                    return finalizePacket(callback);
                                } else {
                                    callback(null);
                                }
                            },
                        ],
                        err => {
                            cb(err, exportedFiles);
                        }
                    );
                }
            }
        );
    };

    this.getNetMailRoute = function (dstAddr) {
        //
        //  Route full|wildcard -> full adddress/network lookup
        //
        const routes = _.get(Config(), 'scannerTossers.ftn_bso.netMail.routes');
        if (!routes) {
            return;
        }

        return _.find(routes, (route, addrWildcard) => {
            return dstAddr.isPatternMatch(addrWildcard);
        });
    };

    this.getNetMailRouteInfoFromAddress = function (destAddress, cb) {
        //
        //  Attempt to find route information for |destAddress|:
        //
        //  1) Routes: scannerTossers.ftn_bso.netMail.routes{} -> scannerTossers.ftn_bso.nodes{} -> config
        //      - Where we send may not be where destAddress is (it's routed!)
        //  2) Direct to nodes: scannerTossers.ftn_bso.nodes{} -> config
        //      - Where we send is direct to destAddress
        //
        //  In both cases, attempt to look up Zone:Net/* to discover local "from" network/address
        //  falling back to Config.scannerTossers.ftn_bso.defaultNetwork
        //
        const route = this.getNetMailRoute(destAddress);

        let routeAddress;
        let networkName;
        let isRouted;
        if (route) {
            routeAddress = Address.fromString(route.address);
            networkName = route.network;
            isRouted = true;
        } else {
            routeAddress = destAddress;
            isRouted = false;
        }

        networkName = networkName || this.getNetworkNameByAddress(routeAddress);

        const config = _.find(this.moduleConfig.nodes, (node, nodeAddrWildcard) => {
            return routeAddress.isPatternMatch(nodeAddrWildcard);
        }) || {
            packetType: '2+',
            encoding: Config().scannerTossers.ftn_bso.packetMsgEncoding,
        };

        //  we should never be failing here; we may just be using defaults.
        return cb(
            networkName
                ? null
                : Errors.DoesNotExist(`No NetMail route for ${destAddress.toString()}`),
            { destAddress, routeAddress, networkName, config, isRouted }
        );
    };

    this.exportNetMailMessagesToUplinks = function (messagesOrMessageUuids, cb) {
        //  for each message/UUID, find where to send the thing
        async.each(
            messagesOrMessageUuids,
            (msgOrUuid, nextMessageOrUuid) => {
                const exportOpts = {};
                const message = new Message();

                async.series(
                    [
                        function loadMessage(callback) {
                            if (_.isString(msgOrUuid)) {
                                message.load({ uuid: msgOrUuid }, err => {
                                    return callback(err, message);
                                });
                            } else {
                                return callback(null, msgOrUuid);
                            }
                        },
                        function discoverUplink(callback) {
                            const dstAddr = new Address(
                                message.meta.System[Message.SystemMetaNames.RemoteToUser]
                            );

                            self.getNetMailRouteInfoFromAddress(
                                dstAddr,
                                (err, routeInfo) => {
                                    if (err) {
                                        return callback(err);
                                    }

                                    exportOpts.nodeConfig = routeInfo.config;
                                    exportOpts.destAddress = dstAddr;
                                    exportOpts.routeAddress = routeInfo.routeAddress;
                                    exportOpts.fileCase =
                                        routeInfo.config.fileCase || 'lower';
                                    exportOpts.network =
                                        Config().messageNetworks.ftn.networks[
                                            routeInfo.networkName
                                        ];
                                    exportOpts.networkName = routeInfo.networkName;
                                    exportOpts.outgoingDir =
                                        self.getOutgoingEchoMailPacketDir(
                                            exportOpts.networkName,
                                            exportOpts.destAddress
                                        );
                                    exportOpts.exportType = self.getExportType(
                                        routeInfo.config
                                    );

                                    if (!exportOpts.network) {
                                        return callback(
                                            Errors.DoesNotExist(
                                                `No configuration found for network ${routeInfo.networkName}`
                                            )
                                        );
                                    }

                                    return callback(null);
                                }
                            );
                        },
                        function createOutgoingDir(callback) {
                            //  ensure outgoing NetMail directory exists
                            return fse.mkdirs(exportOpts.outgoingDir, callback);
                        },
                        function exportPacket(callback) {
                            return self.exportNetMailMessagePacket(
                                message,
                                exportOpts,
                                callback
                            );
                        },
                        function moveToOutgoing(callback) {
                            const newExt =
                                exportOpts.fileCase === 'lower' ? '.pkt' : '.PKT';
                            exportOpts.exportedToPath = paths.join(
                                exportOpts.outgoingDir,
                                `${paths.basename(
                                    exportOpts.pktFileName,
                                    paths.extname(exportOpts.pktFileName)
                                )}${newExt}`
                            );

                            return fse.move(
                                exportOpts.pktFileName,
                                exportOpts.exportedToPath,
                                callback
                            );
                        },
                        function prepareFloFile(callback) {
                            const flowFilePath = self.getOutgoingFlowFileName(
                                exportOpts.outgoingDir,
                                exportOpts.routeAddress,
                                'ref',
                                exportOpts.exportType,
                                exportOpts.fileCase
                            );

                            return self.flowFileAppendRefs(
                                flowFilePath,
                                [exportOpts.exportedToPath],
                                '^',
                                callback
                            );
                        },
                        function storeStateFlags0Meta(callback) {
                            return message.persistMetaValue(
                                'System',
                                'state_flags0',
                                Message.StateFlags0.Exported.toString(),
                                callback
                            );
                        },
                        function storeMsgIdMeta(callback) {
                            //  Store meta as if we had imported this message -- for later reference
                            if (message.meta.FtnKludge.MSGID) {
                                return message.persistMetaValue(
                                    'FtnKludge',
                                    'MSGID',
                                    message.meta.FtnKludge.MSGID,
                                    callback
                                );
                            }

                            return callback(null);
                        },
                    ],
                    err => {
                        if (err) {
                            Log.warn({ error: err.message }, 'Error exporting message');
                        }
                        return nextMessageOrUuid(null);
                    }
                );
            },
            err => {
                if (err) {
                    Log.warn({ error: err.message }, 'Error(s) during NetMail export');
                }
                return cb(err);
            }
        );
    };

    this.exportEchoMailMessagesToUplinks = function (messageUuids, areaConfig, cb) {
        const config = Config();
        async.each(
            areaConfig.uplinks,
            (uplink, nextUplink) => {
                const nodeConfig = self.getNodeConfigByAddress(uplink);
                if (!nodeConfig) {
                    return nextUplink();
                }

                const exportOpts = {
                    nodeConfig,
                    network: config.messageNetworks.ftn.networks[areaConfig.network],
                    destAddress: Address.fromString(uplink),
                    networkName: areaConfig.network,
                    fileCase: nodeConfig.fileCase || 'lower',
                };

                if (_.isString(exportOpts.network.localAddress)) {
                    exportOpts.network.localAddress = Address.fromString(
                        exportOpts.network.localAddress
                    );
                }

                const outgoingDir = self.getOutgoingEchoMailPacketDir(
                    exportOpts.networkName,
                    exportOpts.destAddress
                );
                const exportType = self.getExportType(exportOpts.nodeConfig);

                async.waterfall(
                    [
                        function createOutgoingDir(callback) {
                            fse.mkdirs(outgoingDir, err => {
                                callback(err);
                            });
                        },
                        function exportToTempArea(callback) {
                            self.exportMessagesByUuid(messageUuids, exportOpts, callback);
                        },
                        function createArcMailBundle(exportedFileNames, callback) {
                            if (
                                self.archUtil.haveArchiver(
                                    exportOpts.nodeConfig.archiveType
                                )
                            ) {
                                //  :TODO: support bundleTargetByteSize:
                                //
                                //  Compress to a temp location then we'll move it in the next step
                                //
                                //  Note that we must use the *final* output dir for getOutgoingBundleFileName()
                                //  as it checks for collisions in bundle names!
                                //
                                self.getOutgoingBundleFileName(
                                    outgoingDir,
                                    exportOpts.network.localAddress,
                                    exportOpts.destAddress,
                                    (err, bundlePath) => {
                                        if (err) {
                                            return callback(err);
                                        }

                                        //  adjust back to temp path
                                        const tempBundlePath = paths.join(
                                            self.exportTempDir,
                                            paths.basename(bundlePath)
                                        );

                                        self.archUtil.compressTo(
                                            exportOpts.nodeConfig.archiveType,
                                            tempBundlePath,
                                            exportedFileNames,
                                            err => {
                                                callback(err, [tempBundlePath]);
                                            }
                                        );
                                    }
                                );
                            } else {
                                callback(null, exportedFileNames);
                            }
                        },
                        function moveFilesToOutgoing(exportedFileNames, callback) {
                            async.each(
                                exportedFileNames,
                                (oldPath, nextFile) => {
                                    const ext = paths.extname(oldPath).toLowerCase();
                                    if ('.pk_' === ext.toLowerCase()) {
                                        //
                                        //  For a given temporary .pk_ file, we need to move it to the outoing
                                        //  directory with the appropriate BSO style filename.
                                        //
                                        const newExt = self.getOutgoingFlowFileExtension(
                                            exportOpts.destAddress,
                                            'mail',
                                            exportType,
                                            exportOpts.fileCase
                                        );

                                        const newPath = paths.join(
                                            outgoingDir,
                                            `${paths.basename(oldPath, ext)}${newExt}`
                                        );

                                        fse.move(oldPath, newPath, nextFile);
                                    } else {
                                        const newPath = paths.join(
                                            outgoingDir,
                                            paths.basename(oldPath)
                                        );
                                        fse.move(oldPath, newPath, err => {
                                            if (err) {
                                                Log.warn(
                                                    {
                                                        oldPath: oldPath,
                                                        newPath: newPath,
                                                        error: err.toString(),
                                                    },
                                                    'Failed moving temporary bundle file!'
                                                );

                                                return nextFile();
                                            }

                                            //
                                            //  For bundles, we need to append to the appropriate flow file
                                            //
                                            const flowFilePath =
                                                self.getOutgoingFlowFileName(
                                                    outgoingDir,
                                                    exportOpts.destAddress,
                                                    'ref',
                                                    exportType,
                                                    exportOpts.fileCase
                                                );

                                            //  directive of '^' = delete file after transfer
                                            self.flowFileAppendRefs(
                                                flowFilePath,
                                                [newPath],
                                                '^',
                                                err => {
                                                    if (err) {
                                                        Log.warn(
                                                            { path: flowFilePath },
                                                            'Failed appending flow reference record!'
                                                        );
                                                    }
                                                    nextFile();
                                                }
                                            );
                                        });
                                    }
                                },
                                callback
                            );
                        },
                    ],
                    err => {
                        //  :TODO: do something with |err| ?
                        if (err) {
                            Log.warn(err.message);
                        }
                        nextUplink();
                    }
                );
            },
            cb
        ); //  complete
    };

    this.setReplyToMsgIdFtnReplyKludge = function (message, cb) {
        //
        //  Given a FTN REPLY kludge, set |message.replyToMsgId|, if possible,
        //  by looking up an associated MSGID kludge meta.
        //
        //  See also: http://ftsc.org/docs/fts-0009.001
        //
        if (!_.isString(message.meta.FtnKludge.REPLY)) {
            //  nothing to do
            return cb();
        }

        Message.getMessageIdsByMetaValue(
            'FtnKludge',
            'MSGID',
            message.meta.FtnKludge.REPLY,
            (err, msgIds) => {
                if (msgIds && msgIds.length > 0) {
                    //  expect a single match, but dupe checking is not perfect - warn otherwise
                    if (1 === msgIds.length) {
                        message.replyToMsgId = msgIds[0];
                    } else {
                        Log.warn(
                            { msgIds: msgIds, replyKludge: message.meta.FtnKludge.REPLY },
                            'Found 2:n MSGIDs matching REPLY kludge!'
                        );
                    }
                }
                cb();
            }
        );
    };

    this.getLocalUserNameFromAlias = function (lookup) {
        lookup = lookup.toLowerCase();

        const aliases = _.get(Config(), 'messageNetworks.ftn.netMail.aliases');
        if (!aliases) {
            return lookup; //  keep orig
        }

        const alias = _.find(aliases, (localName, alias) => {
            return alias.toLowerCase() === lookup;
        });

        return alias || lookup;
    };

    this.getAddressesFromNetMailMessage = function (message) {
        const intlKludge = _.get(message, 'meta.FtnKludge.INTL');

        if (!intlKludge) {
            return {};
        }

        let [to, from] = intlKludge.split(' ');
        if (!to || !from) {
            return {};
        }

        const fromPoint = _.get(message, 'meta.FtnKludge.FMPT');
        const toPoint = _.get(message, 'meta.FtnKludge.TOPT');

        if (fromPoint) {
            from += `.${fromPoint}`;
        }

        if (toPoint) {
            to += `.${toPoint}`;
        }

        return { to: Address.fromString(to), from: Address.fromString(from) };
    };

    this.importMailToArea = function (config, header, message, cb) {
        async.series(
            [
                function validateDestinationAddress(callback) {
                    const localNetworkPattern = `${message.meta.FtnProperty.ftn_dest_network}/${message.meta.FtnProperty.ftn_dest_node}`;
                    const localNetworkName =
                        self.getNetworkNameByAddressPattern(localNetworkPattern);

                    return callback(
                        _.isString(localNetworkName)
                            ? null
                            : new Error('Packet destination is not us')
                    );
                },
                function checkForDupeMSGID(callback) {
                    //
                    //  If we have a MSGID, don't allow a dupe
                    //
                    if (!_.has(message.meta, 'FtnKludge.MSGID')) {
                        return callback(null);
                    }

                    Message.getMessageIdsByMetaValue(
                        'FtnKludge',
                        'MSGID',
                        message.meta.FtnKludge.MSGID,
                        (err, msgIds) => {
                            if (msgIds && msgIds.length > 0) {
                                const err = new Error('Duplicate MSGID');
                                err.code = 'DUPE_MSGID';
                                return callback(err);
                            }

                            return callback(null);
                        }
                    );
                },
                function basicSetup(callback) {
                    message.areaTag = config.localAreaTag;

                    //  indicate this was imported from FTN
                    message.meta.System[Message.SystemMetaNames.ExternalFlavor] =
                        Message.AddressFlavor.FTN;

                    //
                    //  If we *allow* dupes (disabled by default), then just generate
                    //  a random UUID. Otherwise, don't assign the UUID just yet. It will be
                    //  generated at persist() time and should be consistent across import/exports
                    //
                    if (
                        true ===
                        _.get(
                            Config(),
                            [
                                'messageNetworks',
                                'ftn',
                                'areas',
                                config.localAreaTag,
                                'allowDupes',
                            ],
                            false
                        )
                    ) {
                        //  just generate a UUID & therefor always allow for dupes
                        message.messageUuid = UUIDv4();
                    }

                    return callback(null);
                },
                function setReplyToMessageId(callback) {
                    self.setReplyToMsgIdFtnReplyKludge(message, () => {
                        return callback(null);
                    });
                },
                function setupPrivateMessage(callback) {
                    //
                    //  If this is a private message (e.g. NetMail) we set the local user ID
                    //
                    if (Message.WellKnownAreaTags.Private !== config.localAreaTag) {
                        return callback(null);
                    }

                    //
                    //  Create a meta value for the *remote* from user. In the case here with FTN,
                    //  their fully qualified FTN from address
                    //
                    const { from } = self.getAddressesFromNetMailMessage(message);

                    if (!from) {
                        return callback(
                            Errors.Invalid(
                                'Cannot import FTN NetMail without valid INTL line'
                            )
                        );
                    }

                    message.meta.System[Message.SystemMetaNames.RemoteFromUser] =
                        from.toString();

                    const lookupName = self.getLocalUserNameFromAlias(message.toUserName);

                    User.getUserIdAndNameByLookup(
                        lookupName,
                        (err, localToUserId, localUserName) => {
                            if (err) {
                                //
                                //  Couldn't find a local username. If the toUserName itself is a FTN address
                                //  we can only assume the message is to the +op, else we'll have to fail.
                                //
                                const toUserNameAsAddress = Address.fromString(
                                    message.toUserName
                                );
                                if (
                                    toUserNameAsAddress &&
                                    toUserNameAsAddress.isValid()
                                ) {
                                    Log.info(
                                        {
                                            toUserName: message.toUserName,
                                            fromUserName: message.fromUserName,
                                        },
                                        'No local "to" username for FTN message. Appears to be a FTN address only; assuming addressed to SysOp'
                                    );

                                    User.getUserName(
                                        User.RootUserID,
                                        (err, sysOpUserName) => {
                                            if (err) {
                                                return callback(
                                                    Errors.UnexpectedState(
                                                        'Failed to get SysOp user information'
                                                    )
                                                );
                                            }

                                            message.meta.System[
                                                Message.SystemMetaNames.LocalToUserID
                                            ] = User.RootUserID;
                                            message.toUserName = sysOpUserName;
                                            return callback(null);
                                        }
                                    );
                                } else {
                                    return callback(
                                        Errors.DoesNotExist(
                                            `Could not get local user ID for "${message.toUserName}": ${err.message}`
                                        )
                                    );
                                }
                            }

                            //  we do this after such that error cases can be preserved above
                            if (lookupName !== message.toUserName) {
                                message.toUserName = localUserName;
                            }

                            //  set the meta information - used elsewhere for retrieval
                            message.meta.System[Message.SystemMetaNames.LocalToUserID] =
                                localToUserId;
                            return callback(null);
                        }
                    );
                },
                function persistImport(callback) {
                    //  mark as imported
                    message.meta.System.state_flags0 =
                        Message.StateFlags0.Imported.toString();

                    //  save to disc
                    message.persist(err => {
                        if (!message.isPrivate()) {
                            StatLog.incrementNonPersistentSystemStat(
                                SysProps.MessageTotalCount,
                                1
                            );
                            StatLog.incrementNonPersistentSystemStat(
                                SysProps.MessagesToday,
                                1
                            );
                        }
                        return callback(err);
                    });
                },
            ],
            err => {
                cb(err);
            }
        );
    };

    this.appendTearAndOrigin = function (message) {
        if (message.meta.FtnProperty.ftn_tear_line) {
            message.message += `\r\n${message.meta.FtnProperty.ftn_tear_line}\r\n`;
        }

        if (message.meta.FtnProperty.ftn_origin) {
            message.message += `${message.meta.FtnProperty.ftn_origin}\r\n`;
        }
    };

    //
    //  Ref. implementations on import:
    //  *   https://github.com/larsks/crashmail/blob/26e5374710c7868dab3d834be14bf4041041aae5/crashmail/pkt.c
    //      https://github.com/larsks/crashmail/blob/26e5374710c7868dab3d834be14bf4041041aae5/crashmail/handle.c
    //
    this.importMessagesFromPacketFile = function (packetPath, password, cb) {
        let packetHeader;

        const packetOpts = { keepTearAndOrigin: false }; //  needed so we can calc message UUID without these; we'll add later

        let importStats = {
            areaSuccess: {}, //  areaTag->count
            areaFail: {}, //  areaTag->count
            otherFail: 0,
        };

        new ftnMailPacket.Packet(packetOpts).read(
            packetPath,
            (entryType, entryData, next) => {
                if ('header' === entryType) {
                    packetHeader = entryData;

                    const localNetworkName = self.getNetworkNameByAddress(
                        packetHeader.destAddress
                    );
                    if (!_.isString(localNetworkName)) {
                        const addrString = new Address(
                            packetHeader.destAddress
                        ).toString();
                        return next(
                            new Error(
                                `No local configuration for packet addressed to ${addrString}`
                            )
                        );
                    } else {
                        //  :TODO: password needs validated - need to determine if it will use the same node config (which can have wildcards) or something else?!
                        return next(null);
                    }
                } else if ('message' === entryType) {
                    const message = entryData;
                    const areaTag = message.meta.FtnProperty.ftn_area;

                    let localAreaTag;
                    if (areaTag) {
                        localAreaTag = self.getLocalAreaTagByFtnAreaTag(areaTag);

                        if (!localAreaTag) {
                            //
                            //  No local area configured for this import
                            //
                            //  :TODO: Handle the "catch all" area bucket case if configured
                            Log.warn(
                                { areaTag: areaTag },
                                'No local area configured for this packet file!'
                            );

                            //  bump generic failure
                            importStats.otherFail += 1;

                            return next(null);
                        }
                    } else {
                        //
                        //  No area tag: If marked private in attributes, this is a NetMail
                        //
                        if (
                            message.meta.FtnProperty.ftn_attr_flags &
                            ftnMailPacket.Packet.Attribute.Private
                        ) {
                            localAreaTag = Message.WellKnownAreaTags.Private;
                        } else {
                            Log.warn('Non-private message without area tag');
                            importStats.otherFail += 1;
                            return next(null);
                        }
                    }

                    message.messageUuid = Message.createMessageUUID(
                        localAreaTag,
                        message.modTimestamp,
                        message.subject,
                        message.message
                    );

                    self.appendTearAndOrigin(message);

                    const importConfig = {
                        localAreaTag: localAreaTag,
                    };

                    self.importMailToArea(importConfig, packetHeader, message, err => {
                        if (err) {
                            //  bump area fail stats
                            importStats.areaFail[localAreaTag] =
                                (importStats.areaFail[localAreaTag] || 0) + 1;

                            if (
                                'SQLITE_CONSTRAINT' === err.code ||
                                'DUPE_MSGID' === err.code
                            ) {
                                const msgId = _.has(message.meta, 'FtnKludge.MSGID')
                                    ? message.meta.FtnKludge.MSGID
                                    : 'N/A';
                                Log.info(
                                    {
                                        area: localAreaTag,
                                        subject: message.subject,
                                        uuid: message.messageUuid,
                                        MSGID: msgId,
                                    },
                                    'Not importing non-unique message'
                                );

                                return next(null);
                            }
                        } else {
                            //  bump area success
                            importStats.areaSuccess[localAreaTag] =
                                (importStats.areaSuccess[localAreaTag] || 0) + 1;
                        }

                        return next(err);
                    });
                }
            },
            err => {
                //
                //  try to produce something helpful in the log
                //
                const finalStats = Object.assign(importStats, { packetPath: packetPath });
                if (err || Object.keys(finalStats.areaFail).length > 0) {
                    if (err) {
                        Object.assign(finalStats, { error: err.message });
                    }

                    Log.warn(finalStats, 'Import completed with error(s)');
                } else {
                    Log.info(finalStats, 'Import complete');
                }

                cb(err);
            }
        );
    };

    this.maybeArchiveImportFile = function (origPath, type, status, cb) {
        //
        //  type    : pkt|tic|bundle
        //  status  : good|reject
        //
        //  Status of "good" is only applied to pkt files & placed
        //  in |retain| if set. This is generally used for debugging only.
        //
        let archivePath;
        const ts = moment().format('YYYY-MM-DDTHH.mm.ss.SSS');
        const fn = paths.basename(origPath);

        if ('good' === status && type === 'pkt') {
            if (!_.isString(self.moduleConfig.paths.retain)) {
                return cb(null);
            }

            archivePath = paths.join(
                self.moduleConfig.paths.retain,
                `good-pkt-${ts}--${fn}`
            );
        } else if ('good' !== status) {
            archivePath = paths.join(
                self.moduleConfig.paths.reject,
                `${status}-${type}--${ts}-${fn}`
            );
        } else {
            return cb(null); //  don't archive non-good/pkt files
        }

        Log.debug(
            { origPath: origPath, archivePath: archivePath, type: type, status: status },
            'Archiving import file'
        );

        fse.copy(origPath, archivePath, err => {
            if (err) {
                Log.warn(
                    {
                        error: err.message,
                        origPath: origPath,
                        archivePath: archivePath,
                        type: type,
                        status: status,
                    },
                    'Failed to archive packet file'
                );
            }

            return cb(null); //  never fatal
        });
    };

    this.importPacketFilesFromDirectory = function (importDir, password, cb) {
        async.waterfall(
            [
                function getPacketFiles(callback) {
                    fs.readdir(importDir, (err, files) => {
                        if (err) {
                            return callback(err);
                        }
                        callback(
                            null,
                            files.filter(f => '.pkt' === paths.extname(f).toLowerCase())
                        );
                    });
                },
                function importPacketFiles(packetFiles, callback) {
                    let rejects = [];
                    async.eachSeries(
                        packetFiles,
                        (packetFile, nextFile) => {
                            self.importMessagesFromPacketFile(
                                paths.join(importDir, packetFile),
                                '',
                                err => {
                                    if (err) {
                                        Log.debug(
                                            {
                                                path: paths.join(importDir, packetFile),
                                                error: err.toString(),
                                            },
                                            'Failed to import packet file'
                                        );

                                        rejects.push(packetFile);
                                    }
                                    nextFile();
                                }
                            );
                        },
                        err => {
                            //  :TODO: Handle err! we should try to keep going though...
                            callback(err, packetFiles, rejects);
                        }
                    );
                },
                function handleProcessedFiles(packetFiles, rejects, callback) {
                    async.each(
                        packetFiles,
                        (packetFile, nextFile) => {
                            //  possibly archive, then remove original
                            const fullPath = paths.join(importDir, packetFile);
                            self.maybeArchiveImportFile(
                                fullPath,
                                'pkt',
                                rejects.includes(packetFile) ? 'reject' : 'good',
                                () => {
                                    fs.unlink(fullPath, () => {
                                        return nextFile(null);
                                    });
                                }
                            );
                        },
                        err => {
                            callback(err);
                        }
                    );
                },
            ],
            err => {
                cb(err);
            }
        );
    };

    this.importFromDirectory = function (inboundType, importDir, cb) {
        async.waterfall(
            [
                //  start with .pkt files
                function importPacketFiles(callback) {
                    self.importPacketFilesFromDirectory(importDir, '', err => {
                        callback(err);
                    });
                },
                function discoverBundles(callback) {
                    fs.readdir(importDir, (err, files) => {
                        //  :TODO: if we do much more of this, probably just use the glob module
                        const bundleRegExp = /\.(su|mo|tu|we|th|fr|sa)[0-9a-z]/i;
                        files = files.filter(f => {
                            const fext = paths.extname(f);
                            return bundleRegExp.test(fext);
                        });

                        async.map(
                            files,
                            (file, transform) => {
                                const fullPath = paths.join(importDir, file);
                                self.archUtil.detectType(fullPath, (err, archName) => {
                                    transform(null, {
                                        path: fullPath,
                                        archName: archName,
                                    });
                                });
                            },
                            (err, bundleFiles) => {
                                callback(err, bundleFiles);
                            }
                        );
                    });
                },
                function importBundles(bundleFiles, callback) {
                    let rejects = [];

                    async.each(
                        bundleFiles,
                        (bundleFile, nextFile) => {
                            if (_.isUndefined(bundleFile.archName)) {
                                Log.warn(
                                    { fileName: bundleFile.path },
                                    'Unknown bundle archive type'
                                );

                                rejects.push(bundleFile.path);

                                return nextFile(); //  unknown archive type
                            }

                            Log.debug({ bundleFile: bundleFile }, 'Processing bundle');

                            self.archUtil.extractTo(
                                bundleFile.path,
                                self.importTempDir,
                                bundleFile.archName,
                                err => {
                                    if (err) {
                                        Log.warn(
                                            { path: bundleFile.path, error: err.message },
                                            'Failed to extract bundle'
                                        );

                                        rejects.push(bundleFile.path);
                                    }

                                    nextFile();
                                }
                            );
                        },
                        err => {
                            if (err) {
                                return callback(err);
                            }

                            //
                            //  All extracted - import .pkt's
                            //
                            self.importPacketFilesFromDirectory(
                                self.importTempDir,
                                '',
                                () => {
                                    //  :TODO: handle |err|
                                    callback(null, bundleFiles, rejects);
                                }
                            );
                        }
                    );
                },
                function handleProcessedBundleFiles(bundleFiles, rejects, callback) {
                    async.each(
                        bundleFiles,
                        (bundleFile, nextFile) => {
                            self.maybeArchiveImportFile(
                                bundleFile.path,
                                'bundle',
                                rejects.includes(bundleFile.path) ? 'reject' : 'good',
                                () => {
                                    fs.unlink(bundleFile.path, err => {
                                        if (err) {
                                            Log.error(
                                                {
                                                    path: bundleFile.path,
                                                    error: err.message,
                                                },
                                                'Failed unlinking bundle'
                                            );
                                        }
                                        return nextFile(null);
                                    });
                                }
                            );
                        },
                        err => {
                            callback(err);
                        }
                    );
                },
                function importTicFiles(callback) {
                    self.processTicFilesInDirectory(importDir, err => {
                        return callback(err);
                    });
                },
            ],
            err => {
                cb(err);
            }
        );
    };

    this.createTempDirectories = function (cb) {
        temptmp.mkdir({ prefix: 'enigftnexport-' }, (err, tempDir) => {
            if (err) {
                return cb(err);
            }

            self.exportTempDir = tempDir;

            temptmp.mkdir({ prefix: 'enigftnimport-' }, (err, tempDir) => {
                self.importTempDir = tempDir;

                cb(err);
            });
        });
    };

    //  Starts an export block - returns true if we can proceed
    this.exportingStart = function () {
        if (!this.exportRunning) {
            this.exportRunning = true;
            return true;
        }

        return false;
    };

    //  ends an export block
    this.exportingEnd = function (cb) {
        this.exportRunning = false;

        if (cb) {
            return cb(null);
        }
    };

    this.copyTicAttachment = function (src, dst, isUpdate, cb) {
        if (isUpdate) {
            fse.copy(src, dst, { overwrite: true }, err => {
                return cb(err, dst);
            });
        } else {
            copyFileWithCollisionHandling(src, dst, (err, finalPath) => {
                return cb(err, finalPath);
            });
        }
    };

    this.getLocalAreaTagsForTic = function () {
        const config = Config();
        return _.union(
            Object.keys(config.scannerTossers.ftn_bso.ticAreas || {}),
            Object.keys(config.fileBase.areas)
        );
    };

    this.processSingleTicFile = function (ticFileInfo, cb) {
        Log.debug(
            { tic: ticFileInfo.path, file: ticFileInfo.getAsString('File') },
            'Processing TIC file'
        );

        async.waterfall(
            [
                function generalValidation(callback) {
                    const sysConfig = Config();
                    const config = {
                        nodes: sysConfig.scannerTossers.ftn_bso.nodes,
                        defaultPassword: sysConfig.scannerTossers.ftn_bso.tic.password,
                        localAreaTags: self.getLocalAreaTagsForTic(),
                    };

                    ticFileInfo.validate(config, (err, localInfo) => {
                        if (err) {
                            Log.trace({ reason: err.message }, 'Validation failure');
                            return callback(err);
                        }

                        //  We may need to map |localAreaTag| back to real areaTag if it's a mapping/alias
                        const mappedLocalAreaTag = _.get(
                            Config().scannerTossers.ftn_bso,
                            ['ticAreas', localInfo.areaTag]
                        );

                        if (mappedLocalAreaTag) {
                            if (_.isString(mappedLocalAreaTag.areaTag)) {
                                localInfo.areaTag = mappedLocalAreaTag.areaTag;
                                localInfo.hashTags = mappedLocalAreaTag.hashTags; //  override default for node
                                localInfo.storageTag = mappedLocalAreaTag.storageTag; //  override default
                            } else if (_.isString(mappedLocalAreaTag)) {
                                localInfo.areaTag = mappedLocalAreaTag;
                            }
                        }

                        return callback(null, localInfo);
                    });
                },
                function findExistingItem(localInfo, callback) {
                    //
                    //  We will need to look for an existing item to replace/update if:
                    //  a) The TIC file has a "Replaces" field
                    //  b) The general or node specific |allowReplace| is true
                    //
                    //  Replace specifies a DOS 8.3 *pattern* which is allowed to have
                    //  ? and * characters. For example, RETRONET.*
                    //
                    //  Lastly, we will only replace if the item is in the same/specified area
                    //  and that come from the same origin as a previous entry.
                    //
                    const allowReplace = _.get(
                        Config().scannerTossers.ftn_bso.nodes,
                        [localInfo.node, 'tic', 'allowReplace'],
                        Config().scannerTossers.ftn_bso.tic.allowReplace
                    );
                    const replaces = ticFileInfo.getAsString('Replaces');

                    if (!allowReplace || !replaces) {
                        return callback(null, localInfo);
                    }

                    const metaPairs = [
                        {
                            name: 'short_file_name',
                            value: replaces.toUpperCase(), //  we store upper as well
                            wildcards: true, //  value may contain wildcards
                        },
                        {
                            name: 'tic_origin',
                            value: ticFileInfo.getAsString('Origin'),
                        },
                    ];

                    FileEntry.findFiles(
                        { metaPairs: metaPairs, areaTag: localInfo.areaTag },
                        (err, fileIds) => {
                            if (err) {
                                return callback(err);
                            }

                            //  0:1 allowed
                            if (1 === fileIds.length) {
                                localInfo.existingFileId = fileIds[0];

                                //  fetch old filename - we may need to remove it if replacing with a new name
                                FileEntry.loadBasicEntry(
                                    localInfo.existingFileId,
                                    {},
                                    (err, info) => {
                                        if (info) {
                                            Log.trace(
                                                {
                                                    fileId: localInfo.existingFileId,
                                                    oldFileName: info.fileName,
                                                    oldStorageTag: info.storageTag,
                                                },
                                                'Existing TIC file target to be replaced'
                                            );

                                            localInfo.oldFileName = info.fileName;
                                            localInfo.oldStorageTag = info.storageTag;
                                        }
                                        return callback(null, localInfo); //  continue even if we couldn't find an old match
                                    }
                                );
                            } else if (fileIds.length > 1) {
                                return callback(
                                    Errors.General(
                                        `More than one existing entry for TIC in ${
                                            localInfo.areaTag
                                        } ([${fileIds.join(', ')}])`
                                    )
                                );
                            } else {
                                return callback(null, localInfo);
                            }
                        }
                    );
                },
                function scan(localInfo, callback) {
                    const scanOpts = {
                        sha256: localInfo.sha256, //  *may* have already been calculated
                        meta: {
                            //  some TIC-related metadata we always want
                            short_file_name: ticFileInfo
                                .getAsString('File')
                                .toUpperCase(), //  upper to ensure no case issues later; this should be a DOS 8.3 name
                            tic_origin: ticFileInfo.getAsString('Origin'),
                            tic_desc: ticFileInfo.getAsString('Desc'),
                            upload_by_username: _.get(
                                Config().scannerTossers.ftn_bso.nodes,
                                [localInfo.node, 'tic', 'uploadBy'],
                                Config().scannerTossers.ftn_bso.tic.uploadBy
                            ),
                        },
                    };

                    const ldesc = ticFileInfo.getAsString('Ldesc', '\n');
                    if (ldesc) {
                        scanOpts.meta.tic_ldesc = ldesc;
                    }

                    //
                    //  We may have TIC auto-tagging for this node and/or specific (remote) area
                    //
                    const hashTags =
                        localInfo.hashTags ||
                        _.get(Config().scannerTossers.ftn_bso.nodes, [
                            localInfo.node,
                            'tic',
                            'hashTags',
                        ]); //  catch-all*/

                    if (hashTags) {
                        scanOpts.hashTags = new Set(hashTags.split(/[\s,]+/));
                    }

                    if (localInfo.crc32) {
                        scanOpts.meta.file_crc32 = localInfo.crc32.toString(16); //  again, *may* have already been calculated
                    }

                    scanFile(ticFileInfo.filePath, scanOpts, (err, fileEntry) => {
                        if (err) {
                            Log.trace({ reason: err.message }, 'Scanning failed');
                        }

                        localInfo.fileEntry = fileEntry;
                        return callback(err, localInfo);
                    });
                },
                function store(localInfo, callback) {
                    //
                    //  Move file to final area storage and persist to DB
                    //
                    const areaInfo = getFileAreaByTag(localInfo.areaTag);
                    if (!areaInfo) {
                        return callback(
                            Errors.UnexpectedState(
                                `Could not get area for tag ${localInfo.areaTag}`
                            )
                        );
                    }

                    const storageTag = localInfo.storageTag || areaInfo.storageTags[0];
                    if (!isValidStorageTag(storageTag)) {
                        return callback(
                            Errors.Invalid(`Invalid storage tag: ${storageTag}`)
                        );
                    }

                    localInfo.fileEntry.storageTag = storageTag;
                    localInfo.fileEntry.areaTag = localInfo.areaTag;
                    localInfo.fileEntry.fileName = ticFileInfo.longFileName;

                    //
                    //  We may now have two descriptions: from .DIZ/etc. or the TIC itself.
                    //  Determine which one to use using |descPriority| and availability.
                    //
                    //  We will still fallback as needed from <priority1> -> <priority2> -> <fromFileName>
                    //
                    const descPriority = _.get(
                        Config().scannerTossers.ftn_bso.nodes,
                        [localInfo.node, 'tic', 'descPriority'],
                        Config().scannerTossers.ftn_bso.tic.descPriority
                    );

                    if ('tic' === descPriority) {
                        const origDesc = localInfo.fileEntry.desc;
                        localInfo.fileEntry.desc =
                            ticFileInfo.getAsString('Ldesc') ||
                            origDesc ||
                            getDescFromFileName(ticFileInfo.filePath);
                    } else {
                        //  see if we got desc from .DIZ/etc.
                        const fromDescFile = 'descFile' === localInfo.fileEntry.descSrc;
                        localInfo.fileEntry.desc = fromDescFile
                            ? localInfo.fileEntry.desc
                            : ticFileInfo.getAsString('Ldesc');
                        localInfo.fileEntry.desc =
                            localInfo.fileEntry.desc ||
                            getDescFromFileName(ticFileInfo.filePath);
                    }

                    const areaStorageDir = getAreaStorageDirectoryByTag(storageTag);
                    if (!areaStorageDir) {
                        return callback(
                            Errors.UnexpectedState(
                                `Could not get storage directory for tag ${localInfo.areaTag}`
                            )
                        );
                    }

                    const isUpdate = localInfo.existingFileId ? true : false;

                    if (isUpdate) {
                        //  we need to *update* an existing record/file
                        localInfo.fileEntry.fileId = localInfo.existingFileId;
                    }

                    const dst = paths.join(areaStorageDir, localInfo.fileEntry.fileName);

                    self.copyTicAttachment(
                        ticFileInfo.filePath,
                        dst,
                        isUpdate,
                        (err, finalPath) => {
                            if (err) {
                                Log.info(
                                    { reason: err.message },
                                    'Failed to copy TIC attachment'
                                );
                                return callback(err);
                            }

                            if (dst !== finalPath) {
                                localInfo.fileEntry.fileName = paths.basename(finalPath);
                            }

                            localInfo.newPath = dst;

                            localInfo.fileEntry.persist(isUpdate, err => {
                                return callback(err, localInfo);
                            });
                        }
                    );
                },
                //  :TODO: from here, we need to re-toss files if needed, before they are removed
                function cleanupOldFile(localInfo, callback) {
                    if (!localInfo.existingFileId) {
                        return callback(null, localInfo);
                    }

                    const oldStorageDir = getAreaStorageDirectoryByTag(
                        localInfo.oldStorageTag
                    );
                    const oldPath = paths.join(oldStorageDir, localInfo.oldFileName);

                    //  if we updated a file in place, don't delete it!
                    if (localInfo.newPath === oldPath) {
                        Log.trace(
                            { path: oldPath },
                            'TIC file replaced in place. Nothing to remove.'
                        );
                        return callback(null, localInfo);
                    }

                    fs.unlink(oldPath, err => {
                        if (err) {
                            Log.warn(
                                { error: err.message, oldPath: oldPath },
                                'Failed removing old physical file during TIC replacement'
                            );
                        } else {
                            Log.trace(
                                { oldPath: oldPath },
                                'Removed old physical file during TIC replacement'
                            );
                        }
                        return callback(null, localInfo); //  continue even if err
                    });
                },
            ],
            (err, localInfo) => {
                if (err) {
                    Log.error(
                        {
                            error: err.message,
                            reason: err.reason,
                            tic: ticFileInfo.filePath,
                        },
                        'Failed to import/update TIC'
                    );
                } else {
                    Log.info(
                        {
                            tic: ticFileInfo.path,
                            file: ticFileInfo.filePath,
                            area: localInfo.areaTag,
                        },
                        'TIC imported successfully'
                    );
                }
                return cb(err);
            }
        );
    };

    this.removeAssocTicFiles = function (ticFileInfo, cb) {
        async.each(
            [ticFileInfo.path, ticFileInfo.filePath],
            (path, nextPath) => {
                fs.unlink(path, err => {
                    if (err && 'ENOENT' !== err.code) {
                        //  don't log when the file doesn't exist
                        Log.warn(
                            { error: err.message, path: path },
                            'Failed unlinking TIC file'
                        );
                    }
                    return nextPath(null);
                });
            },
            err => {
                return cb(err);
            }
        );
    };

    this.performEchoMailExport = function (cb) {
        //
        //  Select all messages with a |message_id| > |lastScanId|.
        //  Additionally exclude messages with the System state_flags0 which will be present for
        //  imported or already exported messages
        //
        //  NOTE: If StateFlags0 starts to use additional bits, we'll likely need to check them here!
        //
        const getNewUuidsSql = `SELECT message_id, message_uuid
            FROM message m
            WHERE area_tag = ? AND message_id > ? AND
                (SELECT COUNT(message_id)
                FROM message_meta
                WHERE message_id = m.message_id AND meta_category = 'System' AND meta_name = 'state_flags0') = 0
            ORDER BY message_id;`;
        //  we shouldn't, but be sure we don't try to pick up private mail here
        const config = Config();
        const areaTags = Object.keys(config.messageNetworks.ftn.areas).filter(
            areaTag => Message.WellKnownAreaTags.Private !== areaTag
        );

        async.each(
            areaTags,
            (areaTag, nextArea) => {
                const areaConfig = config.messageNetworks.ftn.areas[areaTag];
                if (!this.isAreaConfigValid(areaConfig)) {
                    return nextArea();
                }

                //
                //  For each message that is newer than that of the last scan
                //  we need to export to each configured associated uplink(s)
                //
                async.waterfall(
                    [
                        function getLastScanId(callback) {
                            self.getAreaLastScanId(areaTag, callback);
                        },
                        function getNewUuids(lastScanId, callback) {
                            msgDb.all(
                                getNewUuidsSql,
                                [areaTag, lastScanId],
                                (err, rows) => {
                                    if (err) {
                                        callback(err);
                                    } else {
                                        if (0 === rows.length) {
                                            let nothingToDoErr = new Error(
                                                'Nothing to do!'
                                            );
                                            nothingToDoErr.noRows = true;
                                            callback(nothingToDoErr);
                                        } else {
                                            callback(null, rows);
                                        }
                                    }
                                }
                            );
                        },
                        function exportToConfiguredUplinks(msgRows, callback) {
                            const uuidsOnly = msgRows.map(r => r.message_uuid); //  convert to array of UUIDs only
                            self.exportEchoMailMessagesToUplinks(
                                uuidsOnly,
                                areaConfig,
                                err => {
                                    const newLastScanId =
                                        msgRows[msgRows.length - 1].message_id;

                                    Log.info(
                                        {
                                            areaTag: areaTag,
                                            messagesExported: msgRows.length,
                                            newLastScanId: newLastScanId,
                                        },
                                        'Export complete'
                                    );

                                    callback(err, newLastScanId);
                                }
                            );
                        },
                        function updateLastScanId(newLastScanId, callback) {
                            self.setAreaLastScanId(areaTag, newLastScanId, callback);
                        },
                    ],
                    () => {
                        return nextArea();
                    }
                );
            },
            err => {
                return cb(err);
            }
        );
    };

    this.performNetMailExport = function (cb) {
        //
        //  Select all messages with a |message_id| > |lastScanId| in the private area
        //  that are schedule for export to FTN-style networks.
        //
        //  Just like EchoMail, we additionally exclude messages with the System state_flags0
        //  which will be present for imported or already exported messages
        //
        //
        //  :TODO: fill out the rest of the consts here
        //  :TODO: this statement is crazy ugly -- use JOIN / NOT EXISTS for state_flags & 0x02
        const getNewUuidsSql = `SELECT message_id, message_uuid
            FROM message m
            WHERE area_tag = '${Message.WellKnownAreaTags.Private}' AND message_id > ? AND
                (SELECT COUNT(message_id)
                FROM message_meta
                WHERE message_id = m.message_id
                    AND meta_category = 'System'
                    AND (meta_name = 'state_flags0' OR meta_name = 'local_to_user_id')
                ) = 0
            AND
                (SELECT COUNT(message_id)
                FROM message_meta
                WHERE message_id = m.message_id
                    AND meta_category = 'System'
                    AND meta_name = '${Message.SystemMetaNames.ExternalFlavor}'
                    AND meta_value = '${Message.AddressFlavor.FTN}'
                ) = 1
            ORDER BY message_id;
            `;

        async.waterfall(
            [
                function getLastScanId(callback) {
                    return self.getAreaLastScanId(
                        Message.WellKnownAreaTags.Private,
                        callback
                    );
                },
                function getNewUuids(lastScanId, callback) {
                    msgDb.all(getNewUuidsSql, [lastScanId], (err, rows) => {
                        if (err) {
                            return callback(err);
                        }

                        if (0 === rows.length) {
                            return cb(null); //  note |cb| -- early bail out!
                        }

                        return callback(null, rows);
                    });
                },
                function exportMessages(rows, callback) {
                    const messageUuids = rows.map(r => r.message_uuid);
                    return self.exportNetMailMessagesToUplinks(messageUuids, callback);
                },
            ],
            err => {
                return cb(err);
            }
        );
    };

    this.isNetMailMessage = function (message) {
        return (
            message.isPrivate() &&
            null === _.get(message, 'meta.System.LocalToUserID', null) &&
            Message.AddressFlavor.FTN ===
                _.get(message, 'meta.System.external_flavor', null)
        );
    };
}

require('util').inherits(FTNMessageScanTossModule, MessageScanTossModule);

//  :TODO: *scheduled* portion of this stuff should probably use event_scheduler - @immediate would still use record().

FTNMessageScanTossModule.prototype.processTicFilesInDirectory = function (importDir, cb) {
    //  :TODO: pass in 'inbound' vs 'secInbound' -- pass along to processSingleTicFile() where password will be checked

    const self = this;
    async.waterfall(
        [
            function findTicFiles(callback) {
                fs.readdir(importDir, (err, files) => {
                    if (err) {
                        return callback(err);
                    }

                    return callback(
                        null,
                        files.filter(f => '.tic' === paths.extname(f).toLowerCase())
                    );
                });
            },
            function gatherInfo(ticFiles, callback) {
                const ticFilesInfo = [];

                async.each(
                    ticFiles,
                    (fileName, nextFile) => {
                        const fullPath = paths.join(importDir, fileName);

                        TicFileInfo.createFromFile(fullPath, (err, ticInfo) => {
                            if (err) {
                                Log.warn(
                                    { error: err.message, path: fullPath },
                                    'Failed reading TIC file'
                                );
                            } else {
                                ticFilesInfo.push(ticInfo);
                            }

                            return nextFile(null);
                        });
                    },
                    err => {
                        return callback(err, ticFilesInfo);
                    }
                );
            },
            function process(ticFilesInfo, callback) {
                async.eachSeries(
                    ticFilesInfo,
                    (ticFileInfo, nextTicInfo) => {
                        self.processSingleTicFile(ticFileInfo, err => {
                            if (err) {
                                //  :TODO: If ENOENT -OR- failed due to CRC mismatch: create a pending state & try again later; the "attached" file may not yet be ready.

                                //  archive rejected TIC stuff (.TIC + attach)
                                async.each(
                                    [ticFileInfo.path, ticFileInfo.filePath],
                                    (path, nextPath) => {
                                        if (!path) {
                                            //  possibly rejected due to "File" not existing/etc.
                                            return nextPath(null);
                                        }

                                        self.maybeArchiveImportFile(
                                            path,
                                            'tic',
                                            'reject',
                                            () => {
                                                return nextPath(null);
                                            }
                                        );
                                    },
                                    () => {
                                        self.removeAssocTicFiles(ticFileInfo, () => {
                                            return nextTicInfo(null);
                                        });
                                    }
                                );
                            } else {
                                self.removeAssocTicFiles(ticFileInfo, () => {
                                    return nextTicInfo(null);
                                });
                            }
                        });
                    },
                    err => {
                        return callback(err);
                    }
                );
            },
        ],
        err => {
            return cb(err);
        }
    );
};

FTNMessageScanTossModule.prototype.startup = function (cb) {
    Log.info(`${exports.moduleInfo.name} Scanner/Tosser starting up`);

    this.hasValidConfiguration({ shouldLog: true }); //  just check and log

    let importing = false;

    let self = this;

    function tryImportNow(reasonDesc, extraInfo) {
        if (!importing) {
            importing = true;

            Log.info(
                Object.assign({ module: exports.moduleInfo.name }, extraInfo),
                reasonDesc
            );

            self.performImport(() => {
                importing = false;
            });
        }
    }

    this.createTempDirectories(err => {
        if (err) {
            Log.warn({ error: err.toStrong() }, 'Failed creating temporary directories!');
            return cb(err);
        }

        if (_.isObject(this.moduleConfig.schedule)) {
            const exportSchedule = this.parseScheduleString(
                this.moduleConfig.schedule.export
            );
            if (exportSchedule) {
                Log.debug(
                    {
                        schedule: this.moduleConfig.schedule.export,
                        schedOK: -1 === _.get(exportSchedule, 'sched.error'),
                        next: exportSchedule.sched
                            ? moment(later.schedule(exportSchedule.sched).next(1)).format(
                                  'ddd, MMM Do, YYYY @ h:m:ss a'
                              )
                            : 'N/A',
                        immediate: exportSchedule.immediate ? true : false,
                    },
                    'Export schedule loaded'
                );

                if (exportSchedule.sched) {
                    this.exportTimer = later.setInterval(() => {
                        if (this.exportingStart()) {
                            Log.info(
                                { module: exports.moduleInfo.name },
                                'Performing scheduled message scan/export...'
                            );

                            this.performExport(() => {
                                this.exportingEnd();
                            });
                        }
                    }, exportSchedule.sched);
                }

                if (_.isBoolean(exportSchedule.immediate)) {
                    this.exportImmediate = exportSchedule.immediate;
                }
            }

            const importSchedule = this.parseScheduleString(
                this.moduleConfig.schedule.import
            );
            if (importSchedule) {
                Log.debug(
                    {
                        schedule: this.moduleConfig.schedule.import,
                        schedOK: -1 === _.get(importSchedule, 'sched.error'),
                        next: importSchedule.sched
                            ? moment(later.schedule(importSchedule.sched).next(1)).format(
                                  'ddd, MMM Do, YYYY @ h:m:ss a'
                              )
                            : 'N/A',
                        watchFile: _.isString(importSchedule.watchFile)
                            ? importSchedule.watchFile
                            : 'None',
                    },
                    'Import schedule loaded'
                );

                if (importSchedule.sched) {
                    this.importTimer = later.setInterval(() => {
                        tryImportNow('Performing scheduled message import/toss...');
                    }, importSchedule.sched);
                }

                if (_.isString(importSchedule.watchFile)) {
                    const watcher = sane(paths.dirname(importSchedule.watchFile), {
                        glob: `**/${paths.basename(importSchedule.watchFile)}`,
                    });

                    ['change', 'add', 'delete'].forEach(event => {
                        watcher.on(event, (fileName, fileRoot) => {
                            const eventPath = paths.join(fileRoot, fileName);
                            if (
                                paths.join(fileRoot, fileName) ===
                                importSchedule.watchFile
                            ) {
                                tryImportNow('Performing import/toss due to @watch', {
                                    eventPath,
                                    event,
                                });
                            }
                        });
                    });

                    //
                    //  If the watch file already exists, kick off now
                    //  https://github.com/NuSkooler/enigma-bbs/issues/122
                    //
                    fse.exists(importSchedule.watchFile, exists => {
                        if (exists) {
                            tryImportNow('Performing import/toss due to @watch', {
                                eventPath: importSchedule.watchFile,
                                event: 'initial exists',
                            });
                        }
                    });
                }
            }
        }

        FTNMessageScanTossModule.super_.prototype.startup.call(this, cb);
    });
};

FTNMessageScanTossModule.prototype.shutdown = function (cb) {
    Log.info('FidoNet Scanner/Tosser shutting down');

    if (this.exportTimer) {
        this.exportTimer.clear();
    }

    if (this.importTimer) {
        this.importTimer.clear();
    }

    //
    //  Clean up temp dir/files we created
    //
    temptmp.cleanup(paths => {
        const fullStats = {
            exportDir: this.exportTempDir,
            importTemp: this.importTempDir,
            paths: paths,
            sessionId: temptmp.sessionId,
        };

        Log.trace(fullStats, 'Temporary directories cleaned up');

        FTNMessageScanTossModule.super_.prototype.shutdown.call(this, cb);
    });

    FTNMessageScanTossModule.super_.prototype.shutdown.call(this, cb);
};

FTNMessageScanTossModule.prototype.performImport = function (cb) {
    if (!this.hasValidConfiguration()) {
        return cb(Errors.MissingConfig('Invalid or missing configuration'));
    }

    const self = this;

    async.each(
        ['inbound', 'secInbound'],
        (inboundType, nextDir) => {
            const importDir = self.moduleConfig.paths[inboundType];
            self.importFromDirectory(inboundType, importDir, err => {
                if (err) {
                    Log.trace(
                        { importDir, error: err.message },
                        'Cannot perform FTN import for directory'
                    );
                }

                return nextDir(null);
            });
        },
        cb
    );
};

FTNMessageScanTossModule.prototype.performExport = function (cb) {
    //
    //  We're only concerned with areas related to FTN. For each area, loop though
    //  and let's find out what messages need exported.
    //
    if (!this.hasValidConfiguration()) {
        return cb(Errors.MissingConfig('Invalid or missing configuration'));
    }

    const self = this;

    async.eachSeries(
        ['EchoMail', 'NetMail'],
        (type, nextType) => {
            self[`perform${type}Export`](err => {
                if (err) {
                    Log.warn({ type, error: err.message }, 'Error(s) during export');
                }
                return nextType(null); //  try next, always
            });
        },
        () => {
            return cb(null);
        }
    );
};

FTNMessageScanTossModule.prototype.record = function (message) {
    //
    //  This module works off schedules, but we do support @immediate for export
    //
    if (true !== this.exportImmediate || !this.hasValidConfiguration()) {
        return;
    }

    const info = { uuid: message.messageUuid, subject: message.subject };

    function exportLog(err) {
        if (err) {
            Log.warn(info, 'Failed exporting message');
        } else {
            Log.info(info, 'Message exported');
        }
    }

    if (this.isNetMailMessage(message)) {
        Object.assign(info, { type: 'NetMail' });

        if (this.exportingStart()) {
            this.exportNetMailMessagesToUplinks([message.messageUuid], err => {
                this.exportingEnd(() => exportLog(err));
            });
        }
    } else if (message.areaTag) {
        Object.assign(info, { type: 'EchoMail' });

        const areaConfig = Config().messageNetworks.ftn.areas[message.areaTag];
        if (!this.isAreaConfigValid(areaConfig)) {
            return;
        }

        if (this.exportingStart()) {
            this.exportEchoMailMessagesToUplinks(
                [message.messageUuid],
                areaConfig,
                err => {
                    this.exportingEnd(() => exportLog(err));
                }
            );
        }
    }
};
