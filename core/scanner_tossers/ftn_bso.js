/* jslint node: true */
'use strict';

//  ENiGMA½
const MessageScanTossModule = require('../msg_scan_toss_module.js').MessageScanTossModule;
const configModule = require('../config.js');
//  Look up configModule.get on each call rather than capturing it at load
//  time. It is rebound when the Config bootstrapper runs, and swapped by
//  tests; a load-time capture freezes whichever getter happened to be
//  installed when this module was first required. Same reasoning as
//  message_area.js.
const Config = (...args) => configModule.get(...args);
const Events = require('../events.js');
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
const { copyFileWithCollisionHandling, safeCopyFile } = require('../file_util.js');
const getAreaStorageDirectoryByTag =
    require('../file_base_area.js').getAreaStorageDirectoryByTag;
const isValidStorageTag = require('../file_base_area.js').isValidStorageTag;
const User = require('../user.js');
const StatLog = require('../stat_log.js');
const SysProps = require('../system_property.js');
const {
    canonicalNetworkName,
    resolveDefaultNetworkName,
    resolveNetworkDefaultZone,
    resolveNetworkNameForZone,
    outboundDirName,
    legacyOutboundDirName,
    validateOutboundConfig,
} = require('../bso_util.js');
const { withFlowFileLock, isBusyError } = require('../bso_lock.js');
const autoAreaCreate = require('../auto_area_create.js');
const areaInfoPack = require('../area_info_pack.js');
const { AreaFixStatus, parseAreaFixReply } = require('../areafix_reply.js');

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
const { randomUUID } = require('crypto');

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

    this.getNetworkConfig = function (networkName) {
        const networks = Config().messageNetworks.ftn.networks;
        const key = Object.keys(networks).find(
            k => k.toLowerCase() === networkName.toLowerCase()
        );
        return key ? networks[key] : undefined;
    };

    //
    //  Outbound spool path resolution is shared with the native BinkP mailer
    //  (core/binkp/bso_spool.js) via core/bso_util.js. Both sides must agree on
    //  which network owns the bare "outbound" directory; see that module.
    //
    this.getNetworks = function () {
        return _.get(Config(), 'messageNetworks.ftn.networks', {});
    };

    this.getConfiguredDefaultNetwork = function () {
        return _.get(this.moduleConfig, 'defaultNetwork');
    };

    this.getDefaultNetworkName = function () {
        return resolveDefaultNetworkName(
            this.getNetworks(),
            this.getConfiguredDefaultNetwork()
        );
    };

    this.getDefaultZone = function (networkName) {
        return resolveNetworkDefaultZone(this.getNetworks(), networkName);
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
            return localAddress !== undefined && localAddress.isEqual(remoteAddress);
        });
    };

    this.getNetworkNameByAddressPattern = function (remoteAddressPattern) {
        return _.findKey(Config().messageNetworks.ftn.networks, network => {
            const localAddress = Address.fromString(network.localAddress);
            return (
                localAddress !== undefined &&
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
        if(!Array.isArray(messageSeenBy)) {
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
        return paths.join(
            this.moduleConfig.paths.outbound,
            outboundDirName(
                this.getNetworks(),
                this.getConfiguredDefaultNetwork(),
                networkName,
                destAddress.zone
            )
        );
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

    //
    //  Append reference records to a BSO flow file.
    //
    //  |fileRefs| entries may be a plain path -- taking |directive| as their
    //  disposition prefix, the long-standing behaviour -- or an object
    //  { directive, path } carrying its own. A single call may therefore mix
    //  dispositions, which matters because some pairings must be written
    //  *together*: forwarding a file echo queues the payload with no prefix
    //  ("send and keep", it lives in the file base) immediately followed by
    //  its generated TIC with '^' ("delete after send"). FSC-0087 requires the
    //  payload to precede its TIC, and adjacency only holds within one write,
    //  since the exporter appends to these same files on its own schedule.
    //
    //  The whole append is done under the flow file's FTS-5005 .bsy lock. See
    //  core/bso_lock.js for why that is mandatory rather than defensive, and
    //  why it is the same lock BinkP sessions and external mailers take.
    //
    this.flowFileAppendRefs = function (filePath, fileRefs, directive, destAddress, cb) {
        const appendLines = fileRefs.reduce((content, ref) => {
            const refDirective = _.isObject(ref) ? ref.directive || '' : directive;
            const refPath = _.isObject(ref) ? ref.path : ref;
            return content + `${refDirective}${refPath}\n`;
        }, '');

        //
        //  We have to ensure the *directory* of |filePath| exists here esp.
        //  for cases such as point destinations where a subdir may be
        //  present in the path that doesn't yet exist.
        //
        const flowFileDir = paths.dirname(filePath);
        fse.mkdirs(flowFileDir, () => {
            //  note not checking err; let's try to take the lock anyway
            withFlowFileLock(
                filePath,
                {
                    staleMaxAgeMs: _.get(
                        Config(),
                        'scannerTossers.ftn_bso.binkp.staleLockMaxAgeMs'
                    ),
                    timeoutMs: _.get(
                        Config(),
                        'scannerTossers.ftn_bso.flowLockTimeoutMs'
                    ),
                    log: Log,
                },
                done => {
                    fs.appendFile(filePath, appendLines, done);
                },
                err => {
                    if (err) {
                        //
                        //  A busy node is a deferral, not a failure: FTS-5005
                        //  §5.1 prohibits touching a flow file while its .bsy
                        //  exists, so *not* writing was the correct outcome.
                        //  Say so distinctly -- the refs did not get queued and
                        //  the caller may want to retry.
                        //
                        if (isBusyError(err)) {
                            Log.warn(
                                {
                                    path: filePath,
                                    refs: fileRefs.length,
                                    address: destAddress
                                        ? destAddress.toString()
                                        : undefined,
                                },
                                'Flow file busy; outbound not queued this pass'
                            );
                        }
                        return cb(err);
                    }

                    //  Successful append == new outbound is queued and ready to
                    //  ship. Emit so the native BinkP module can dial |destAddress|
                    //  immediately (crashmail) instead of waiting for the next
                    //  pull cycle. External mailers (binkd) are unaffected — they
                    //  poll the spool directly.
                    if (destAddress) {
                        Events.emit(Events.getSystemEvents().NewOutboundBSO, {
                            address: destAddress,
                        });
                    }
                    return cb(null);
                }
            );
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

        return Array.isArray(areaConfig.uplinks);
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

        //  Half-configured installs (only one of the two blocks present) used
        //  to silently no-op for export and could crash record() on the next
        //  posted message; surface the gap explicitly so operators can fix it.
        if (hasNodes && !hasAreas) {
            if (shouldLog) {
                Log.warn(
                    'scannerTossers.ftn_bso.nodes is configured but messageNetworks.ftn.areas is missing — EchoMail export disabled'
                );
            }
            return false;
        }
        if (!hasNodes && hasAreas) {
            if (shouldLog) {
                Log.warn(
                    'messageNetworks.ftn.areas is configured but scannerTossers.ftn_bso.nodes is missing — no uplinks available'
                );
            }
            return false;
        }

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
        const sql = `SELECT message_id
            FROM message_area_last_scan
            WHERE scan_toss = 'ftn_bso' AND area_tag = ?
            LIMIT 1;`;

        try {
            const row = msgDb.prepare(sql).get(areaTag);
            return cb(null, row ? row.message_id : 0);
        } catch (err) {
            return cb(err);
        }
    };

    this.setAreaLastScanId = function (areaTag, lastScanId, cb) {
        const sql = `REPLACE INTO message_area_last_scan (scan_toss, area_tag, message_id)
            VALUES ('ftn_bso', ?, ?);`;

        try {
            msgDb.prepare(sql).run(areaTag, lastScanId);
            return cb(null);
        } catch (err) {
            return cb(err);
        }
    };

    //
    //  Node configuration for |addr|, or undefined when none matches.
    //
    //  nodes{} keys are FTN patterns and more than one can match a given
    //  address. The *most specific* match wins -- see
    //  Address.findBestPatternMatch(). First-match-wins would let a catch-all
    //  such as "21:*" shadow a specific "21:1/100" block purely by virtue of
    //  appearing first in config.hjson, which among other things would drop
    //  that node's packetPassword.
    //
    this.getNodeConfigByAddress = function (addr) {
        addr = _.isString(addr) ? Address.fromString(addr) : addr;
        if (!addr) {
            return undefined;
        }

        const best = Address.findBestPatternMatch(this.moduleConfig.nodes, addr);
        return best ? best.value : undefined;
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
                    ws.once('error', callback);

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

        async.eachSeries(
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
                                ws.once('error', err =>
                                    Log.error(
                                        { pktFileName, error: err.message },
                                        'FTN packet write error'
                                    )
                                );

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
                                        exportOpts.fileCase
                                    );

                                    exportedFiles.push(pktFileName);

                                    ws = fs.createWriteStream(pktFileName);
                                    ws.once('error', err =>
                                        Log.error(
                                            { pktFileName, error: err.message },
                                            'FTN packet write error'
                                        )
                                    );

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

    //
    //  NetMail route for |dstAddr|, or undefined when none is configured.
    //
    //  routes{} keys are FTN patterns; the *most specific* match wins so that
    //  a catch-all "*" alongside a specific "21:*" behaves the same no matter
    //  which order they appear in config.hjson.
    //
    this.getNetMailRoute = function (dstAddr) {
        //
        //  Route full|wildcard -> full adddress/network lookup
        //
        const routes = _.get(Config(), 'scannerTossers.ftn_bso.netMail.routes');
        const best = Address.findBestPatternMatch(routes, dstAddr);
        return best ? best.value : undefined;
    };

    //
    //  Where to send NetMail for |destAddress|, and as whom.
    //
    //  1) A netMail.routes{} entry hands the message to another node for
    //     onward delivery: where we send is not where it is addressed.
    //  2) Otherwise, if |destAddress| is itself a node we are configured for,
    //     we deliver direct.
    //  3) Otherwise there is nowhere to send it. The export fails, and the
    //     sender is told rather than the message sitting unexplained.
    //
    //  Either way the *network* has to be settled, since it decides both the
    //  address we send from and the outbound directory we file under. A route
    //  may name one outright. Failing that it comes from the zone of the node
    //  being dialed, which is what picks the outbound directory anyway -- so
    //  the two cannot disagree. A nodes{} entry may also carry its own
    //  |network|, which is only needed when two networks share a zone.
    //
    this.getNetMailRouteInfoFromAddress = function (destAddress, cb) {
        const route = this.getNetMailRoute(destAddress);

        let routeAddress;
        let networkName;
        let nodeConfig;
        let isRouted;

        if (route) {
            routeAddress = Address.fromString(route.address);
            if (!routeAddress) {
                return cb(
                    Errors.Invalid(
                        `NetMail route for ${destAddress.toString()} has an unusable address: "${
                            route.address
                        }"`
                    )
                );
            }
            networkName = route.network;
            nodeConfig = this.getNodeConfigByAddress(routeAddress);
            isRouted = true;
        } else {
            //
            //  Direct delivery, but only to a node we actually carry
            //  configuration for. Anything else has nowhere to go: filing a
            //  packet for a node we know nothing about would leave it in the
            //  spool indefinitely instead of telling the sender.
            //
            nodeConfig = this.getNodeConfigByAddress(destAddress);
            if (!nodeConfig) {
                return cb(
                    Errors.DoesNotExist(
                        `No NetMail route for ${destAddress.toString()}, and it is not a configured node`
                    )
                );
            }
            routeAddress = destAddress;
            isRouted = false;
        }

        networkName = networkName || _.get(nodeConfig, 'network');

        if (networkName) {
            const canonical = canonicalNetworkName(this.getNetworks(), networkName);
            if (!canonical) {
                return cb(
                    Errors.DoesNotExist(
                        `NetMail for ${destAddress.toString()} names network "${networkName}", which is not configured`
                    )
                );
            }
            networkName = canonical;
        } else {
            const { name, candidates } = resolveNetworkNameForZone(
                this.getNetworks(),
                this.getConfiguredDefaultNetwork(),
                routeAddress.zone
            );

            if (!name) {
                return cb(
                    Errors.DoesNotExist(
                        `No network configured for zone ${routeAddress.zone}, needed to reach ${routeAddress.toString()}`
                    )
                );
            }

            if (candidates.length > 1) {
                //  Resolvable, but only by falling back on defaultNetwork --
                //  say so, since the cost of guessing wrong is mail sent from
                //  the wrong address.
                Log.debug(
                    { zone: routeAddress.zone, candidates, using: name },
                    'More than one network claims this zone; set a "network" on the node to be explicit'
                );
            }

            networkName = name;
        }

        const config = nodeConfig || {
            packetType: '2+',
            encoding: Config().scannerTossers.ftn_bso.packetMsgEncoding,
        };

        return cb(null, { destAddress, routeAddress, networkName, config, isRouted });
    };

    this.exportNetMailMessagesToUplinks = function (messagesOrMessageUuids, cb) {
        //  for each message/UUID, find where to send the thing
        //  eachSeries avoids concurrent appends to the same .flo file for the same node
        async.eachSeries(
            messagesOrMessageUuids,
            (msgOrUuid, nextMessageOrUuid) => {
                const exportOpts = {};
                let message = new Message();
                let messageLoaded = false;

                async.series(
                    [
                        function loadMessage(callback) {
                            if (_.isString(msgOrUuid)) {
                                message.load({ uuid: msgOrUuid }, err => {
                                    if (!err) {
                                        messageLoaded = true;
                                    }
                                    return callback(err, message);
                                });
                            } else {
                                //  Already-loaded Message. Adopt it -- every
                                //  step below reads |message|, so leaving the
                                //  empty placeholder in place would export a
                                //  blank message to nowhere.
                                message = msgOrUuid;
                                messageLoaded = true;
                                return callback(null, message);
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
                                    exportOpts.network = self.getNetworkConfig(
                                        routeInfo.networkName
                                    );
                                    exportOpts.networkName = routeInfo.networkName;
                                    //
                                    //  The packet is filed for the node we
                                    //  will *dial*, not the message's final
                                    //  recipient. For routed NetMail those
                                    //  differ, and when they differ by zone
                                    //  they resolve to different outbound
                                    //  directories -- so using destAddress
                                    //  here filed cross-zone routed mail in a
                                    //  directory the mailer never looks in
                                    //  when calling the uplink (issue #734).
                                    //  |routeAddress| is |destAddress| when
                                    //  the message is unrouted.
                                    //
                                    exportOpts.outgoingDir =
                                        self.getOutgoingEchoMailPacketDir(
                                            exportOpts.networkName,
                                            exportOpts.routeAddress
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

                                    if (routeInfo.isRouted) {
                                        //  Which routes{} pattern applied is
                                        //  not obvious from the outside -- a
                                        //  catch-all captures NetMail for
                                        //  every network, AreaFix to your
                                        //  uplinks included. Say where the
                                        //  message actually went.
                                        Log.debug(
                                            {
                                                dest: exportOpts.destAddress.toString(),
                                                route: exportOpts.routeAddress.toString(),
                                                network: exportOpts.networkName,
                                            },
                                            'Routing NetMail via uplink'
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
                                exportOpts.routeAddress,
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
                            const msgUuid = _.isString(msgOrUuid)
                                ? msgOrUuid
                                : msgOrUuid.messageUuid;
                            const dest = _.get(message, [
                                'meta',
                                'System',
                                Message.SystemMetaNames.RemoteToUser,
                            ]);
                            Log.warn(
                                {
                                    error: err.message,
                                    msgUuid,
                                    subject: message.subject,
                                    dest,
                                },
                                'Failed to export NetMail'
                            );

                            //  Permanent routing failure — mark as failed and notify sender
                            if (
                                messageLoaded &&
                                message.messageId &&
                                Errors.ErrorCodes.DoesNotExist === err.code
                            ) {
                                const localFromUserId = parseInt(
                                    _.get(message, [
                                        'meta',
                                        'System',
                                        Message.SystemMetaNames.LocalFromUserID,
                                    ])
                                );

                                async.series(
                                    [
                                        function markExportFailed(callback) {
                                            return message.persistMetaValue(
                                                'System',
                                                Message.SystemMetaNames.StateFlags0,
                                                Message.StateFlags0.ExportFailed.toString(),
                                                callback
                                            );
                                        },
                                        function notifySender(callback) {
                                            if (
                                                !localFromUserId ||
                                                isNaN(localFromUserId)
                                            ) {
                                                return callback(null);
                                            }

                                            const failNotice = new Message({
                                                areaTag:
                                                    Message.WellKnownAreaTags.Private,
                                                toUserName: message.fromUserName,
                                                fromUserName: 'ENiGMA½ BBS',
                                                subject: `Failed: ${message.subject}`,
                                                message:
                                                    `Your message to ${message.toUserName} could not be delivered.\r\n\r\n` +
                                                    `Reason: ${
                                                        err.reason || err.message
                                                    }\r\n\r\n` +
                                                    `The original message has been retained for your reference.` +
                                                    ` Please contact your sysop if you believe this is in error.`,
                                            });
                                            failNotice.setLocalToUserId(localFromUserId);

                                            return failNotice.persist(callback);
                                        },
                                    ],
                                    notifErr => {
                                        if (notifErr) {
                                            Log.warn(
                                                { error: notifErr.message, msgUuid },
                                                'Failed to record NetMail delivery failure'
                                            );
                                        }
                                    }
                                );
                            }
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
        async.each(
            areaConfig.uplinks,
            (uplink, nextUplink) => {
                const nodeConfig = self.getNodeConfigByAddress(uplink);
                if (!nodeConfig) {
                    return nextUplink();
                }

                const exportOpts = {
                    nodeConfig,
                    network: self.getNetworkConfig(areaConfig.network),
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
                                    //
                                    //  Un-bundled packets are written to the temp area as
                                    //  .pk_ (see |createTempPacket| in exportMessagesByUuid);
                                    //  give them their real .pkt extension on the way out.
                                    //  Bundles already carry their final name.
                                    //
                                    //  Note that we deliberately do *not* write a BSO netmail
                                    //  flow file (NNNNnnnn.?ut) for the un-bundled case:
                                    //  FTS-5005.003 §3.1 gives those a one-to-one
                                    //  correspondence with the destination address, so a node
                                    //  can hold exactly one at a time, while a single export
                                    //  may produce several packets (see packetTargetByteSize).
                                    //  Reference files have no such limit, so everything --
                                    //  bundle or bare packet -- ships as a reference.
                                    //
                                    const ext = paths.extname(oldPath);
                                    let newPath;
                                    if ('.pk_' === ext.toLowerCase()) {
                                        //  |ext| is not lower cased above: paths.basename()
                                        //  matches it case-sensitively, and a fileCase of
                                        //  'upper' produces a .PK_ we must still strip.
                                        const pktExt =
                                            'upper' === exportOpts.fileCase
                                                ? '.PKT'
                                                : '.pkt';
                                        newPath = paths.join(
                                            outgoingDir,
                                            `${paths.basename(oldPath, ext)}${pktExt}`
                                        );
                                    } else {
                                        newPath = paths.join(
                                            outgoingDir,
                                            paths.basename(oldPath)
                                        );
                                    }

                                    fse.move(oldPath, newPath, err => {
                                        if (err) {
                                            Log.warn(
                                                {
                                                    oldPath: oldPath,
                                                    newPath: newPath,
                                                    error: err.toString(),
                                                },
                                                'Failed moving temporary outbound file!'
                                            );

                                            return nextFile();
                                        }

                                        const flowFilePath = self.getOutgoingFlowFileName(
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
                                            exportOpts.destAddress,
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
                        message.messageUuid = randomUUID();
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
                function maybeAreaFixReply(callback) {
                    //
                    //  A NetMail from an uplink's AreaFix robot answering a
                    //  request we sent.  Never fatal to the import: this is
                    //  reporting, and a failure here must not reject mail
                    //  that has already been stored.
                    //
                    if (Message.WellKnownAreaTags.Private !== config.localAreaTag) {
                        return callback(null);
                    }

                    try {
                        return self.handleAreaFixReply(message, () => callback(null));
                    } catch (e) {
                        Log.warn(
                            { error: e.message },
                            'Failed handling possible AreaFix reply'
                        );
                        return callback(null);
                    }
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
            packetPath,
            areaSuccess: {}, //  areaTag->count
            areaDuplicates: {}, //  areaTag->count
            areaFail: {}, //  areaTag->count
            skipCount: 0, //  messages skipped (unknown area, non-private sans area tag)
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

                        //  hard abort — error propagates to final callback, no skipCount needed
                        return next(
                            new Error(
                                `No local configuration for packet addressed to ${addrString}`
                            )
                        );
                    } else {
                        //  Validate packet password against node config (if configured)
                        const originAddr = new Address(packetHeader.origAddress);
                        const nodeConfig = self.getNodeConfigByAddress(originAddr);
                        if (nodeConfig && nodeConfig.packetPassword) {
                            const expected = nodeConfig.packetPassword.toUpperCase();
                            const actual = (packetHeader.password || '').toUpperCase();
                            if (expected !== actual) {
                                //  hard abort — error propagates to final callback
                                Log.warn(
                                    { origin: originAddr.toString() },
                                    'Packet rejected: password mismatch'
                                );
                                return next(
                                    new Error(
                                        `Packet password mismatch from ${originAddr.toString()}`
                                    )
                                );
                            }
                        }
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
                            //  :TODO: Handle the "catch all" area bucket case if configured -> email with area info/etc.? catchAll: enabled, areaTag, prefixMsg
                            Log.warn(
                                { areaTag: areaTag },
                                `No local message area for "${areaTag}"`
                            );

                            importStats.skipCount += 1;
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
                            importStats.skipCount += 1;
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

                    const importConfig = { localAreaTag };

                    self.importMailToArea(importConfig, packetHeader, message, err => {
                        if (err) {
                            if (
                                'SQLITE_CONSTRAINT' === err.code ||
                                'DUPE_MSGID' === err.code
                            ) {
                                importStats.areaDuplicates[localAreaTag] =
                                    (importStats.areaDuplicates[localAreaTag] || 0) + 1;

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
                                    `Skipping duplicate message "${message.subject}" in ${localAreaTag}`
                                );

                                return next(null);
                            }

                            //  bump area fail stats for genuine errors
                            importStats.areaFail[localAreaTag] =
                                (importStats.areaFail[localAreaTag] || 0) + 1;
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
                const makeCount = obj => {
                    return obj
                        ? _.reduce(
                              obj,
                              (sum, c) => {
                                  return sum + c;
                              },
                              0
                          )
                        : 0;
                };

                const totalFail = makeCount(importStats.areaFail);
                const packetFileName = paths.basename(packetPath);
                if (err || totalFail > 0) {
                    if (err) {
                        Object.assign(importStats, { error: err.message });
                    }
                    Log.warn(
                        importStats,
                        `Packet ${packetFileName} import reported ${totalFail} error(s)`
                    );
                } else {
                    const totalSuccess = makeCount(importStats.areaSuccess);
                    const totalDupes = makeCount(importStats.areaDuplicates);
                    Log.info(
                        importStats,
                        `Packet ${packetFileName} imported with ${totalSuccess} new message(s)` +
                            (totalDupes > 0
                                ? `, ${totalDupes} duplicate(s) skipped`
                                : '') +
                            (importStats.skipCount > 0
                                ? `, ${importStats.skipCount} message(s) skipped (unknown area)`
                                : '')
                    );
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

        safeCopyFile(origPath, archivePath, err => {
            //  ENOENT is ordinary here: rejecting a TIC archives both the
            //  control file and the file it announced, and the whole reason for
            //  the rejection may be that the latter never arrived
            if (err && 'ENOENT' !== err.code) {
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

    //
    //  ── Automatic area creation: pass 1 ──────────────────────────────────
    //
    //  Pass 1 finds FTN area tags in inbound mail that we have no local area
    //  for, so pass 2 can import messages that would otherwise be skipped and
    //  lost (see the unknown-area branch of importMessagesFromPacketFile).
    //
    //  It has to be new, genuinely read-only code.  The import path disposes
    //  of its input as it goes: every tossed .pkt is archived and then
    //  unlinked, and bundles are extracted, tossed and unlinked one at a time
    //  so that a large backlog drains monotonically.  Running the real import
    //  as pass 1 would destroy the mail before pass 2 could see it.  The cost
    //  for bundles is a second archive extraction, paid only when the feature
    //  is switched on.
    //
    this.collectUnknownAreaTagsFromPacket = function (packetPath, cb) {
        let networkName;
        const unknown = new Set();

        new ftnMailPacket.Packet({ keepTearAndOrigin: false }).read(
            packetPath,
            (entryType, entryData, next) => {
                if ('header' === entryType) {
                    networkName = self.getNetworkNameByAddress(entryData.destAddress);
                    if (!_.isString(networkName)) {
                        //  not addressed to us; the import rejects it too
                        return next(Errors.Invalid('Packet is not addressed to us'));
                    }

                    //
                    //  Apply the same packet password check the import
                    //  applies.  A packet whose messages will be rejected must
                    //  not be able to create areas on its way past.
                    //
                    const originAddr = new Address(entryData.origAddress);
                    const nodeConfig = self.getNodeConfigByAddress(originAddr);
                    if (nodeConfig && nodeConfig.packetPassword) {
                        const expected = nodeConfig.packetPassword.toUpperCase();
                        const actual = (entryData.password || '').toUpperCase();
                        if (expected !== actual) {
                            return next(Errors.AccessDenied('Packet password mismatch'));
                        }
                    }

                    return next(null);
                }

                if ('message' === entryType) {
                    const ftnAreaTag = _.get(entryData, 'meta.FtnProperty.ftn_area');
                    if (ftnAreaTag && !self.getLocalAreaTagByFtnAreaTag(ftnAreaTag)) {
                        unknown.add(ftnAreaTag.toUpperCase());
                    }
                }

                return next(null);
            },
            err => {
                if (err) {
                    Log.debug(
                        { path: packetPath, error: err.message },
                        'Unknown area scan skipped packet'
                    );
                    return cb(null, null);
                }
                return cb(null, { networkName, ftnTags: Array.from(unknown) });
            }
        );
    };

    this.collectUnknownAreaTagsFromPacketDir = function (dir, collected, cb) {
        fs.readdir(dir, (err, files) => {
            if (err) {
                return cb(null);
            }

            const packetFiles = files.filter(
                f => '.pkt' === paths.extname(f).toLowerCase()
            );

            async.eachSeries(
                packetFiles,
                (packetFile, nextFile) => {
                    self.collectUnknownAreaTagsFromPacket(
                        paths.join(dir, packetFile),
                        (scanErr, info) => {
                            if (info && info.ftnTags.length > 0) {
                                const set =
                                    collected[info.networkName] ||
                                    (collected[info.networkName] = new Set());
                                info.ftnTags.forEach(t => set.add(t));
                            }
                            return nextFile(null);
                        }
                    );
                },
                () => cb(null)
            );
        });
    };

    //  Remove everything the scan extracted; the source bundles are untouched
    this.emptyScanTempDir = function (cb) {
        if (!_.isString(self.scanTempDir)) {
            return cb(null);
        }

        fs.readdir(self.scanTempDir, (err, files) => {
            if (err) {
                return cb(null);
            }
            async.each(
                files,
                (f, next) =>
                    fse.remove(paths.join(self.scanTempDir, f), () => next(null)),
                () => cb(null)
            );
        });
    };

    this.collectUnknownAreaTagsFromDirectory = function (importDir, collected, cb) {
        async.series(
            [
                callback =>
                    self.collectUnknownAreaTagsFromPacketDir(
                        importDir,
                        collected,
                        callback
                    ),
                callback => {
                    if (!_.isString(self.scanTempDir)) {
                        return callback(null);
                    }

                    fs.readdir(importDir, (err, files) => {
                        if (err) {
                            return callback(null);
                        }

                        const bundleRegExp = /\.(su|mo|tu|we|th|fr|sa)[0-9a-z]$/i;
                        const bundles = files.filter(f =>
                            bundleRegExp.test(paths.extname(f))
                        );

                        async.eachSeries(
                            bundles,
                            (file, nextFile) => {
                                const fullPath = paths.join(importDir, file);
                                self.archUtil.detectType(fullPath, (err, archName) => {
                                    if (undefined === archName) {
                                        return nextFile(null);
                                    }

                                    self.archUtil.extractTo(
                                        fullPath,
                                        self.scanTempDir,
                                        archName,
                                        extractErr => {
                                            if (extractErr) {
                                                Log.debug(
                                                    {
                                                        path: fullPath,
                                                        error: extractErr.message,
                                                    },
                                                    'Unknown area scan could not extract bundle'
                                                );
                                                return self.emptyScanTempDir(() =>
                                                    nextFile(null)
                                                );
                                            }

                                            self.collectUnknownAreaTagsFromPacketDir(
                                                self.scanTempDir,
                                                collected,
                                                () =>
                                                    self.emptyScanTempDir(() =>
                                                        nextFile(null)
                                                    )
                                            );
                                        }
                                    );
                                });
                            },
                            () => callback(null)
                        );
                    });
                },
            ],
            () => cb(null)
        );
    };

    //  |claimedNames| (optional): lowercased names announced by a TIC in this
    //  same directory, which must not be treated as mail. See getTicClaimedNames.
    this.importPacketFilesFromDirectory = function (
        importDir,
        password,
        claimedNames,
        cb
    ) {
        async.waterfall(
            [
                function getPacketFiles(callback) {
                    fs.readdir(importDir, (err, files) => {
                        if (err) {
                            return callback(err);
                        }
                        callback(
                            null,
                            files.filter(
                                f =>
                                    '.pkt' === paths.extname(f).toLowerCase() &&
                                    !(claimedNames && claimedNames.has(f.toLowerCase()))
                            )
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
                                            `Failed to import packet file "${paths.basename(
                                                packetFile
                                            )}"`
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
                //
                //  Work out which files a TIC in this directory has already
                //  spoken for, before any stage that consumes files runs.
                //
                function findTicClaimedNames(callback) {
                    //
                    //  Only a TIC we would actually process may reserve a name.
                    //  A .tic in the *unsecure* inbound is left unprocessed by
                    //  secureInOnly and therefore never removed, so honouring its
                    //  claim would let an unauthenticated peer permanently shield
                    //  any file it names from the packet and bundle stages.
                    //
                    if (!self.ticProcessingAllowed(inboundType)) {
                        return callback(null, new Set());
                    }

                    fs.readdir(importDir, (err, files) => {
                        if (err) {
                            //  the packet stage reports the real error
                            return callback(null, new Set());
                        }

                        self.getTicClaimedNames(importDir, files, claimed => {
                            return callback(null, claimed);
                        });
                    });
                },
                //  ...then .pkt files
                function importPacketFiles(claimedNames, callback) {
                    self.importPacketFilesFromDirectory(
                        importDir,
                        '',
                        claimedNames,
                        err => {
                            callback(err, claimedNames);
                        }
                    );
                },
                function discoverBundles(claimedNames, callback) {
                    fs.readdir(importDir, (err, files) => {
                        if (err) {
                            return callback(null, []);
                        }

                        //  :TODO: if we do much more of this, probably just use the glob module
                        //  anchored: only a *trailing* day-of-week pair plus one
                        //  character is a bundle, so ".sa1x" is not one
                        const bundleRegExp = /\.(su|mo|tu|we|th|fr|sa)[0-9a-z]$/i;
                        files = files.filter(f => {
                            const fext = paths.extname(f);
                            return (
                                bundleRegExp.test(fext) &&
                                !claimedNames.has(f.toLowerCase())
                            );
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
                    //
                    //  Process each bundle to *completion* individually:
                    //  extract -> toss its .pkt(s) -> archive + unlink the source
                    //  bundle.  Doing cleanup per-bundle (rather than once at the
                    //  very end) means partial progress is durable: if this pass is
                    //  interrupted -- e.g. the import watchdog fires on a large
                    //  backlog -- every bundle already handled stays removed and is
                    //  not re-processed next cycle.  The backlog therefore drains
                    //  monotonically instead of being re-tossed forever.
                    //
                    const finishBundle = (bundleFile, status, nextFile) => {
                        //  Archive (rejects only, per maybeArchiveImportFile) then
                        //  remove the source so it is not re-processed next cycle.
                        self.maybeArchiveImportFile(
                            bundleFile.path,
                            'bundle',
                            status,
                            () => {
                                fs.unlink(bundleFile.path, err => {
                                    //  ENOENT: an overlapping import cycle already
                                    //  removed it -- harmless, not an error.
                                    if (err && 'ENOENT' !== err.code) {
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
                    };

                    async.eachSeries(
                        bundleFiles,
                        (bundleFile, nextFile) => {
                            if (bundleFile.archName === undefined) {
                                Log.warn(
                                    { fileName: bundleFile.path },
                                    'Unknown bundle archive type'
                                );

                                //  can't extract it; archive as reject + remove
                                return finishBundle(bundleFile, 'reject', nextFile);
                            }

                            Log.debug({ bundleFile: bundleFile }, 'Processing bundle');

                            self.archUtil.extractTo(
                                bundleFile.path,
                                self.importTempDir,
                                bundleFile.archName,
                                extractErr => {
                                    if (extractErr) {
                                        Log.warn(
                                            {
                                                path: bundleFile.path,
                                                error: extractErr.message,
                                            },
                                            'Failed to extract bundle'
                                        );

                                        return finishBundle(
                                            bundleFile,
                                            'reject',
                                            nextFile
                                        );
                                    }

                                    //
                                    //  Toss the .pkt(s) this bundle produced, then
                                    //  clean up the source bundle.  importPacket-
                                    //  FilesFromDirectory removes each .pkt it
                                    //  handles, so the temp dir does not accumulate
                                    //  across bundles.
                                    //
                                    self.importPacketFilesFromDirectory(
                                        self.importTempDir,
                                        '',
                                        null, //  bundle contents are never TIC payloads
                                        importErr => {
                                            if (importErr) {
                                                Log.warn(
                                                    {
                                                        importDir: self.importTempDir,
                                                        error: importErr.message,
                                                    },
                                                    'Error importing packets from extracted bundle'
                                                );
                                            }

                                            return finishBundle(
                                                bundleFile,
                                                'good',
                                                nextFile
                                            );
                                        }
                                    );
                                }
                            );
                        },
                        err => {
                            return callback(err);
                        }
                    );
                },
                function importTicFiles(callback) {
                    self.processTicFilesInDirectory(inboundType, importDir, err => {
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
                if (err) {
                    return cb(err);
                }

                //  Kept separate from importTempDir: the read-only area scan
                //  extracts bundles here and deletes what it extracted, while
                //  the import path unlinks packets out of its own directory as
                //  it tosses them.  Sharing one would have each removing the
                //  other's work.
                temptmp.mkdir({ prefix: 'enigftnareascan-' }, (err, tempDir) => {
                    self.scanTempDir = tempDir;
                    cb(err);
                });
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
            safeCopyFile(src, dst, { overwrite: true }, err => {
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
        return [
            ...new Set([
                ...Object.keys(config.scannerTossers.ftn_bso.ticAreas || {}),
                ...Object.keys(config.fileBase.areas),
            ]),
        ];
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
                    //  a TIC missing "File" has no payload path at all; name it
                    //  by the announcement, or failing that by the TIC itself
                    const fileName =
                        ticFileInfo.getAsString('File') ||
                        paths.basename(ticFileInfo.path);

                    //
                    //  A payload that simply has not landed yet is the expected
                    //  state of a TIC announced ahead of its file, and it repeats
                    //  every pass until the file shows up. The caller decides
                    //  whether to hold or reject and says so at a useful level;
                    //  logging it as a failure here would only be noise.
                    //
                    const level = TicFileInfo.isPayloadPendingError(err)
                        ? 'debug'
                        : 'error';

                    Log[level](
                        {
                            error: err.message,
                            reason: err.reason,
                            reasonCode: err.reasonCode,
                            tic: ticFileInfo.path,
                            file: ticFileInfo.filePath,
                        },
                        `Failed to import/update TIC for "${fileName}"`
                    );
                } else {
                    Log.info(
                        {
                            tic: ticFileInfo.path,
                            file: ticFileInfo.filePath,
                            area: localInfo.areaTag,
                        },
                        `TIC imported "${paths.basename(ticFileInfo.filePath)}" -> ${
                            localInfo.areaTag
                        }`
                    );
                }
                return cb(err);
            }
        );
    };

    this.removeAssocTicFiles = function (ticFileInfo, cb) {
        //  |filePath| is undefined when the TIC has no usable "File" field --
        //  filter before unlinking rather than handing undefined to fs
        async.each(
            [ticFileInfo.path, ticFileInfo.filePath].filter(p => _.isString(p)),
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
                            let rows;
                            try {
                                rows = msgDb
                                    .prepare(getNewUuidsSql)
                                    .all(areaTag, lastScanId);
                            } catch (err) {
                                return callback(err);
                            }
                            if (0 === rows.length) {
                                let nothingToDoErr = new Error('Nothing to do!');
                                nothingToDoErr.noRows = true;
                                return callback(nothingToDoErr);
                            }
                            return callback(null, rows);
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
        //  Select outbound FTN NetMail that hasn't been exported, failed, or delivered locally.
        const getNewUuidsSql = `
            SELECT m.message_id, m.message_uuid
            FROM message m
            WHERE m.area_tag = '${Message.WellKnownAreaTags.Private}'
              AND m.message_id > ?
              AND NOT EXISTS (
                SELECT 1 FROM message_meta
                WHERE message_id = m.message_id
                  AND meta_category = 'System'
                  AND meta_name IN ('state_flags0', 'local_to_user_id')
              )
              AND EXISTS (
                SELECT 1 FROM message_meta
                WHERE message_id = m.message_id
                  AND meta_category = 'System'
                  AND meta_name = '${Message.SystemMetaNames.ExternalFlavor}'
                  AND meta_value = '${Message.AddressFlavor.FTN}'
              )
            ORDER BY m.message_id;`;

        async.waterfall(
            [
                function getLastScanId(callback) {
                    return self.getAreaLastScanId(
                        Message.WellKnownAreaTags.Private,
                        callback
                    );
                },
                function getNewUuids(lastScanId, callback) {
                    let rows;
                    try {
                        rows = msgDb.prepare(getNewUuidsSql).all(lastScanId);
                    } catch (err) {
                        return callback(err);
                    }
                    if (0 === rows.length) {
                        return cb(null); //  note |cb| -- early bail out!
                    }
                    return callback(null, rows);
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

//
//  How long a TIC whose payload has not arrived is kept before being given up on.
//  Announcement and file routinely land in *different* mailer sessions, minutes
//  or hours apart, so the window has to be generous. Set |tic.holdMaxAgeMs| to 0
//  to hold indefinitely, which is htick's behaviour with delNotReceivedTIC off.
//
const TIC_HOLD_MAX_AGE_MS = 48 * 60 * 60 * 1000;

//
//  Whether TIC files arriving in |inboundType| are processed at all.
//
//  Single source of truth for tic.secureInOnly: the name-reservation pass and
//  the import pass must agree, or a TIC we refuse to process could still reserve
//  a filename against the stages that would have consumed it.
//
FTNMessageScanTossModule.prototype.ticProcessingAllowed = function (inboundType) {
    const secureInOnly = _.get(Config(), 'scannerTossers.ftn_bso.tic.secureInOnly', true);

    return !secureInOnly || 'secInbound' === inboundType;
};

//
//  Lowercased names announced by a TIC sitting in |importDir|.
//
//  Those files are payloads waiting on their announcement, not mail. The packet
//  and bundle stages run first and would otherwise consume one whose name happens
//  to match their patterns -- a bundle extension is any day-of-week pair plus a
//  character, so an announced FOO.SA1 collides -- archiving it as a reject and
//  unlinking it while the TIC that needs it is still being held.
//
//  Names are compared lowercased, matching how TicFileInfo resolves a payload.
//
FTNMessageScanTossModule.prototype.getTicClaimedNames = function (importDir, files, cb) {
    const ticFiles = files.filter(f => '.tic' === paths.extname(f).toLowerCase());
    const claimed = new Set();

    if (0 === ticFiles.length) {
        return cb(claimed);
    }

    async.each(
        ticFiles,
        (fileName, nextFile) => {
            TicFileInfo.createFromFile(
                paths.join(importDir, fileName),
                (err, ticInfo) => {
                    const announced = err ? null : ticInfo.getAsString('File');
                    if (announced && TicFileInfo.isSafeFileName(announced)) {
                        claimed.add(announced.toLowerCase());
                    }
                    return nextFile(null);
                }
            );
        },
        () => {
            return cb(claimed);
        }
    );
};

//
//  Decide whether a TIC whose payload is not (yet) usable should be kept around
//  for another pass. Calls back with true to hold, false to reject it.
//
//  The TIC's own mtime is the "held since" stamp: it is the moment the mailer
//  finished writing it into the inbound, it costs no state of our own, and it
//  survives a restart. A TIC hand-copied in with its timestamp preserved expires
//  immediately -- which is precisely what every TIC did before this existed, so
//  nothing regresses.
//
FTNMessageScanTossModule.prototype.maybeHoldTicFile = function (ticFileInfo, err, cb) {
    const self = this;

    const hold = ageMs => {
        //
        //  Announce the hold once, then drop to debug: a weekly nodelist can sit
        //  here across many poll cycles and should not fill the log with it.
        //
        self._ticHolds = self._ticHolds || new Set();
        const level = self._ticHolds.has(ticFileInfo.path) ? 'debug' : 'info';
        self._ticHolds.add(ticFileInfo.path);

        Log[level](
            {
                tic: ticFileInfo.path,
                file: ticFileInfo.getAsString('File'),
                reason: err.message,
                reasonCode: err.reasonCode,
                heldForMs: ageMs,
            },
            `Holding TIC for "${ticFileInfo.getAsString(
                'File'
            )}"; payload not yet available`
        );

        return cb(true);
    };

    let maxAgeMs = _.get(
        Config(),
        'scannerTossers.ftn_bso.tic.holdMaxAgeMs',
        TIC_HOLD_MAX_AGE_MS
    );

    if (!_.isFinite(maxAgeMs)) {
        maxAgeMs = TIC_HOLD_MAX_AGE_MS;
    }

    if (maxAgeMs <= 0) {
        return hold(null); //  hold indefinitely
    }

    fs.stat(ticFileInfo.path, (statErr, stats) => {
        if (statErr) {
            //  no way to tell how long we have had it; expire rather than let a
            //  TIC we cannot stat wedge the directory forever
            return cb(false);
        }

        //  clamp: a timestamp in the future must not expire the hold instantly
        const ageMs = Math.max(0, Date.now() - stats.mtimeMs);
        if (ageMs <= maxAgeMs) {
            return hold(ageMs);
        }

        Log.warn(
            {
                tic: ticFileInfo.path,
                file: ticFileInfo.getAsString('File'),
                reason: err.message,
                reasonCode: err.reasonCode,
                heldForMs: ageMs,
                holdMaxAgeMs: maxAgeMs,
            },
            `Giving up on TIC for "${ticFileInfo.getAsString(
                'File'
            )}"; payload never arrived`
        );

        return cb(false);
    });
};

//  Drop the "already announced this hold" marker once a TIC is finally resolved.
FTNMessageScanTossModule.prototype.forgetTicHold = function (ticFileInfo) {
    if (this._ticHolds) {
        this._ticHolds.delete(ticFileInfo.path);
    }
};

FTNMessageScanTossModule.prototype.processTicFilesInDirectory = function (
    inboundType,
    importDir,
    cb
) {
    const self = this;
    async.waterfall(
        [
            function findTicFiles(callback) {
                fs.readdir(importDir, (err, files) => {
                    if (err) {
                        return callback(err);
                    }

                    const ticFiles = files.filter(
                        f => '.tic' === paths.extname(f).toLowerCase()
                    );

                    //
                    //  |secureInOnly| has been documented and defaulted to true
                    //  since TIC support landed, but was never enforced: TICs in
                    //  the *unsecure* inbound were imported on the strength of an
                    //  unauthenticated "From" line alone. Honour it now.
                    //
                    if (!self.ticProcessingAllowed(inboundType)) {
                        if (ticFiles.length > 0) {
                            //  say it once, then stay quiet: this repeats on
                            //  every import pass until the sysop acts on it
                            const level = self._ticUnsecureWarned ? 'debug' : 'warn';
                            self._ticUnsecureWarned = true;

                            Log[level](
                                {
                                    importDir,
                                    inboundType,
                                    count: ticFiles.length,
                                },
                                'Ignoring TIC file(s) in the unsecure inbound; set scannerTossers.ftn_bso.tic.secureInOnly to false to process them'
                            );
                        }
                        return callback(null, []);
                    }

                    return callback(null, ticFiles);
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
                                //
                                //  Values the parser could not make sense of and
                                //  dropped -- a malformed "Seenby", say. Not a
                                //  reason to reject the TIC (htick likewise logs
                                //  and carries on), but worth saying once with
                                //  the file in hand, since a peer emitting these
                                //  is a real interop problem for its downlinks.
                                //
                                ticInfo.parseWarnings.forEach(w => {
                                    Log.warn(
                                        {
                                            tic: fullPath,
                                            key: w.key,
                                            value: w.value,
                                            reason: w.reason,
                                        },
                                        'Ignoring unusable value in TIC file'
                                    );
                                });

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
                        //  archive rejected TIC stuff (.TIC + attach), then remove
                        const reject = () => {
                            self.forgetTicHold(ticFileInfo);

                            async.each(
                                [ticFileInfo.path, ticFileInfo.filePath],
                                (path, nextPath) => {
                                    if (!path) {
                                        //  no "File" field, so no payload path
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
                        };

                        self.processSingleTicFile(ticFileInfo, err => {
                            if (!err) {
                                self.forgetTicHold(ticFileInfo);
                                return self.removeAssocTicFiles(ticFileInfo, () => {
                                    return nextTicInfo(null);
                                });
                            }

                            //
                            //  The announced file may simply not be here yet: a
                            //  TIC and its payload routinely arrive in separate
                            //  mailer sessions. Leave both in place and try again
                            //  next pass rather than rejecting the announcement
                            //  and orphaning the file that follows it.
                            //
                            if (!TicFileInfo.isPayloadPendingError(err)) {
                                return reject();
                            }

                            self.maybeHoldTicFile(ticFileInfo, err, held => {
                                return held ? nextTicInfo(null) : reject();
                            });
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

//
//  Report configuration that makes outbound spool directories ambiguous or
//  unresolvable, plus any leftovers from the pre-0.5.1-beta layout. Advisory
//  only -- nothing here fails startup.
//
FTNMessageScanTossModule.prototype.logOutboundSpoolDiagnostics = function () {
    const networks = this.getNetworks();
    const defaultNetwork = this.getConfiguredDefaultNetwork();

    validateOutboundConfig(networks, defaultNetwork).forEach(issue => {
        switch (issue.code) {
            case 'unknownDefaultNetwork':
                Log.warn(
                    { defaultNetwork: issue.defaultNetwork, using: issue.using },
                    'scannerTossers.ftn_bso.defaultNetwork does not name a configured FTN network; falling back to the first configured network'
                );
                break;

            case 'unresolvableZone':
                Log.warn(
                    { network: issue.network },
                    'FTN network has neither a defaultZone nor a parsable localAddress; its outbound zone directories cannot be resolved'
                );
                break;

            case 'reservedNetworkName':
                Log.warn(
                    { network: issue.network },
                    'FTN network name collides with the default outbound directory name; please rename the network'
                );
                break;
        }
    });

    //
    //  Before the writer and the native BinkP reader were unified (issue #719)
    //  a multi-network system with no explicit |defaultNetwork| had no default
    //  network at all on the writing side, so what is now "outbound/" was
    //  written as "<network>/". BsoSpool still scans the old directory so
    //  anything queued there ships, but let the sysop know it exists.
    //
    const outboundPath = _.get(this.moduleConfig, 'paths.outbound');
    const defaultNetworkName = resolveDefaultNetworkName(networks, defaultNetwork);
    if (!_.isString(outboundPath) || !defaultNetworkName) {
        return;
    }

    const legacyBase = legacyOutboundDirName(
        networks,
        defaultNetwork,
        defaultNetworkName
    );
    const currentBase = outboundDirName(networks, defaultNetwork, defaultNetworkName);
    if (!legacyBase || legacyBase === currentBase) {
        return;
    }

    const zoneSuffixed = `${legacyBase}.`;
    fs.readdir(outboundPath, (err, entries) => {
        if (err) {
            return;
        }

        entries
            .filter(entry => {
                const lower = entry.toLowerCase();
                return (
                    lower === legacyBase ||
                    (lower.startsWith(zoneSuffixed) &&
                        /^[0-9a-f]{3}$/.test(lower.slice(zoneSuffixed.length)))
                );
            })
            .forEach(entry => {
                const legacyDir = paths.join(outboundPath, entry);
                fs.readdir(legacyDir, (readErr, files) => {
                    if (readErr || 0 === files.length) {
                        return;
                    }

                    Log.warn(
                        {
                            network: defaultNetworkName,
                            legacyDir,
                            currentDir: paths.join(outboundPath, currentBase),
                            fileCount: files.length,
                        },
                        'Outbound mail found in the pre-0.5.1-beta directory for the default network; it will still be sent, and the directory may be removed once empty. See UPGRADE.md'
                    );
                });
            });
    });
};

FTNMessageScanTossModule.prototype.startup = function (cb) {
    Log.info(`${exports.moduleInfo.name} Scanner/Tosser starting up`);

    this.hasValidConfiguration({ shouldLog: true }); //  just check and log
    this.logOutboundSpoolDiagnostics();

    //  Refresh cached top-level module config when config.hjson is hot-reloaded
    this._onConfigChanged = () => {
        const config = Config();
        if (_.has(config, 'scannerTossers.ftn_bso')) {
            this.moduleConfig = config.scannerTossers.ftn_bso;
        }

        //  so a fixed auto-areas include is noticed rather than staying quiet
        this._autoAreaIncludeWarned = false;

        //  ...likewise for a secureInOnly that has just been changed
        this._ticUnsecureWarned = false;

        //  ...and re-check what the new config says about the outbound spool:
        //  a reload can introduce a bad defaultNetwork, or move the default
        //  network and leave mail behind in the previous directory.
        this.logOutboundSpoolDiagnostics();
    };
    Events.on(Events.getSystemEvents().ConfigChanged, this._onConfigChanged);

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

    //  Immediate import when native BinkP session delivers files
    this._onNewInboundBSO = () => {
        tryImportNow('Import/toss triggered by BinkP inbound transfer');
    };
    Events.on(Events.getSystemEvents().NewInboundBSO, this._onNewInboundBSO);

    this.createTempDirectories(err => {
        if (err) {
            Log.warn({ error: err.message }, 'Failed creating temporary directories!');
            return cb(err);
        }

        //  Remove stale .bsy flag files (and legacy .bsy.lock dirs left by
        //  the previous proper-lockfile implementation) so external mailers
        //  and our own startup begin from a known-clean state.
        sweepOrphanBsyFiles([
            this.moduleConfig.paths.inbound,
            this.moduleConfig.paths.outbound,
        ]);
        [this.moduleConfig.paths.inbound, this.moduleConfig.paths.outbound].forEach(
            dir => {
                if (!_.isString(dir)) return;
                fse.remove(paths.join(dir, 'enigma.bsy.lock'), () => {});
            }
        );

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

                    const makeImportMsg = (e, path) => {
                        return `Import/toss due to @watch[${e}] "${paths.basename(
                            path
                        )}"`;
                    };

                    ['change', 'add', 'delete'].forEach(event => {
                        watcher.on(event, (fileName, fileRoot) => {
                            const eventPath = paths.join(fileRoot, fileName);
                            if (eventPath === importSchedule.watchFile) {
                                tryImportNow(makeImportMsg(event, eventPath), {
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
                    fse.access(importSchedule.watchFile, fse.constants.R_OK, err => {
                        if (!err) {
                            // exists and we can read
                            tryImportNow(
                                makeImportMsg('exists', importSchedule.watchFile),
                                {
                                    eventPath: importSchedule.watchFile,
                                    event: 'exists',
                                }
                            );
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

    if (this._onConfigChanged) {
        Events.removeListener(
            Events.getSystemEvents().ConfigChanged,
            this._onConfigChanged
        );
    }

    if (this._onNewInboundBSO) {
        Events.removeListener(
            Events.getSystemEvents().NewInboundBSO,
            this._onNewInboundBSO
        );
    }

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
};

//
//  FTN .bsy flag (FTS-5005).  A zero-content file whose *presence* in an
//  outbound directory signals external mailers (binkd, et al) that we are
//  currently writing packets and they should not grab them until it is gone.
//  It is NOT a lock; we are the only writer by design (one BBS instance per
//  mail tree).  Crash-leaked files are unlinked on startup.
//
function withFtnBsyFlag(dir, fn, cb) {
    const bsyPath = paths.join(dir, 'enigma.bsy');

    fs.writeFile(bsyPath, String(process.pid), writeErr => {
        if (writeErr) {
            Log.warn(
                { path: bsyPath, error: writeErr.message },
                'Could not create FTN .bsy flag; proceeding without it'
            );
        }

        fn(fnErr => {
            fs.unlink(bsyPath, unlinkErr => {
                if (unlinkErr && 'ENOENT' !== unlinkErr.code) {
                    Log.warn(
                        { path: bsyPath, error: unlinkErr.message },
                        'Failed to remove FTN .bsy flag'
                    );
                }
                return cb(fnErr);
            });
        });
    });
}

//
//  Watchdog wrapper: runs |fn(done)| and guarantees |cb| fires exactly once —
//  either when |done| is invoked, or after |watchdogMs| if not.  Exists so a
//  missed callback inside |fn| cannot wedge the caller forever.
//
function guardedCall(watchdogMs, label, fn, cb) {
    let called = false;
    const timer = setTimeout(() => {
        if (called) return;
        Log.error({ label, watchdogMs }, 'FTN watchdog timeout; forcing completion');
        called = true;
        cb(Errors.General(`Watchdog timeout: ${label}`));
    }, watchdogMs);

    try {
        fn(err => {
            if (called) return;
            called = true;
            clearTimeout(timer);
            cb(err);
        });
    } catch (e) {
        if (called) return;
        called = true;
        clearTimeout(timer);
        cb(e);
    }
}

//  Unlink any orphan enigma.bsy files left by a crashed prior run.  Safe because
//  only one BBS instance writes to these directories; anything we find is stale.
function sweepOrphanBsyFiles(dirs) {
    for (const dir of dirs) {
        if (!_.isString(dir)) continue;
        const bsyPath = paths.join(dir, 'enigma.bsy');
        fs.unlink(bsyPath, err => {
            if (!err) {
                Log.info({ path: bsyPath }, 'Removed orphan FTN .bsy flag');
            }
            //  ENOENT is the common case (no stale file); ignore.
        });
    }
}

const IMPORT_WATCHDOG_MS = 5 * 60 * 1000;
const EXPORT_WATCHDOG_MS = 10 * 60 * 1000;

//
//  ── Automatic area creation ──────────────────────────────────────────────
//
//  Two-pass toss.  At the unknown-area branch of the import a message is
//  skipped and the packet then disposed of, so "skipped" means lost.  Rather
//  than create inline -- which would mean writing config, reloading and
//  re-resolving inside the packet loop, with everything already iterated past
//  still lost -- the inbound directories are scanned read-only first, the
//  areas created, and the import then run normally.
//
FTNMessageScanTossModule.prototype.maybeAutoCreateAreas = function (cb) {
    const self = this;

    const networkNames = autoAreaCreate.onDemandNetworkNames();
    if (0 === networkNames.length) {
        return cb(null); //  feature off: no scan, no cost
    }

    const includeState = autoAreaCreate.getGeneratedIncludeState();
    if (!includeState.included) {
        //
        //  Warn once rather than every cycle.  The flag is cleared on
        //  ConfigChanged so fixing it is noticed.
        //
        if (!self._autoAreaIncludeWarned) {
            self._autoAreaIncludeWarned = true;
            Log.warn(
                {
                    networks: networkNames,
                    expected: includeState.path,
                },
                `Automatic area creation is enabled but "${autoAreaCreate.GeneratedIncludeFileName}" is not included from config.hjson; run "oputil.js mb auto-areas init"`
            );
        }
        return cb(null);
    }

    const collected = {};

    async.eachSeries(
        ['inbound', 'secInbound'],
        (inboundType, nextDir) => {
            const importDir = self.moduleConfig.paths[inboundType];
            if (!_.isString(importDir)) {
                return nextDir(null);
            }
            self.collectUnknownAreaTagsFromDirectory(importDir, collected, () =>
                nextDir(null)
            );
        },
        () => {
            const wanted = networkNames.filter(
                n => collected[n] && collected[n].size > 0
            );
            if (0 === wanted.length) {
                return cb(null);
            }

            async.eachSeries(
                wanted,
                (networkName, nextNetwork) => {
                    const ftnTags = Array.from(collected[networkName]);

                    autoAreaCreate.createAreas(networkName, ftnTags, (err, result) => {
                        if (err) {
                            Log.error(
                                { networkName, error: err.message },
                                'Automatic message area creation failed'
                            );
                            return nextNetwork(null);
                        }

                        self.reportAutoCreatedAreas(networkName, result, () =>
                            nextNetwork(null)
                        );
                    });
                },
                () => cb(null)
            );
        }
    );
};

//  Log what happened, tell the operator once per batch, and optionally ask
//  the uplink to rescan.
FTNMessageScanTossModule.prototype.reportAutoCreatedAreas = function (
    networkName,
    result,
    cb
) {
    const self = this;

    if (result.pruned.length > 0) {
        Log.info(
            { networkName, areaTags: result.pruned },
            `Removed ${result.pruned.length} automatically created area(s) now in the ignore list`
        );
    }

    result.rejected.forEach(r => {
        Log.warn(
            { networkName, ftnTag: r.ftnTag, areaTag: r.areaTag, reason: r.reason },
            `Refused to automatically create "${r.ftnTag}": ${r.reason}`
        );
    });

    if (0 === result.created.length) {
        return cb(null);
    }

    Log.info(
        { networkName, areas: result.created.map(c => c.areaTag) },
        `Automatically created ${result.created.length} message area(s) for "${networkName}"`
    );

    async.series(
        [
            callback => self.notifyOpOfAutoCreatedAreas(networkName, result, callback),
            callback => self.maybeRequestAreaFixRescan(networkName, result, callback),
        ],
        () => cb(null)
    );
};

//  One netmail to the operator per batch, not per area: a first pull that
//  creates 300 areas should be one message.
FTNMessageScanTossModule.prototype.notifyOpOfAutoCreatedAreas = function (
    networkName,
    result,
    cb
) {
    const lines = [
        `${result.created.length} message area(s) were automatically created for the`,
        `"${networkName}" network after EchoMail arrived for area tags that were not`,
        'configured:',
        '',
    ];

    result.created.forEach(c => {
        lines.push(`  ${c.ftnTag}  ->  ${c.areaTag}`);
    });

    lines.push('');
    lines.push(
        'These areas are read-only: they have no uplinks, so nothing is exported,'
    );
    lines.push(
        'and they carry a write-deny ACS so nothing can be posted into them either.'
    );
    lines.push('');
    lines.push(
        `They are defined in ${autoAreaCreate.GeneratedIncludeFileName}. To adopt one,`
    );
    lines.push(
        'define it in config.hjson with your own uplinks and acs -- config.hjson wins'
    );
    lines.push('over the generated file. To make one go away, add its FTN tag to the');
    lines.push(`"autoAreas.ignore" list for "${networkName}".`);

    if (result.rejected.length > 0) {
        lines.push('');
        lines.push('The following were NOT created:');
        result.rejected.forEach(r => {
            lines.push(`  ${r.ftnTag}: ${r.reason}`);
        });
    }

    const message = new Message({
        toUserName: StatLog.getSystemStat(SysProps.SysOpUsername) || 'SysOp',
        fromUserName: 'ENiGMA½',
        subject: `${result.created.length} message area(s) automatically created`,
        message: lines.join('\r\n'),
        areaTag: Message.WellKnownAreaTags.Private,
    });
    message.setLocalToUserId(User.RootUserID);

    message.persist(err => {
        if (err) {
            Log.warn(
                { error: err.message },
                'Failed to notify the operator of automatically created areas'
            );
        }
        return cb(null);
    });
};

//
//  ── AreaFix rescan ───────────────────────────────────────────────────────
//
//  Off by default, and the command has no default form.
//
//  FSC-0057's own "=TAG R=n" is spec correct but not portable: Mystic (what
//  the fsxNet hubs run) and CrashMail II implement '=', while husky and
//  SBBSecho do not.  Against husky, "=TAG, R=n" falls through to a subscribe
//  of a garbage tag and, on a hub with forwardRequests, may be sent upstream
//  as a *new area* request.  There is no safe universal syntax, so the
//  operator states the one their uplink speaks or no request is sent.
//
FTNMessageScanTossModule.prototype.maybeRequestAreaFixRescan = function (
    networkName,
    result,
    cb
) {
    const self = this;

    const autoConfig = autoAreaCreate.getAutoAreasConfig(networkName);
    const onDemand = _.get(autoConfig, 'onDemand', {});

    if (true !== onDemand.rescan) {
        return cb(null);
    }

    const uplink = Address.fromString(onDemand.rescanUplink || '');
    if (!uplink) {
        Log.warn(
            { networkName, rescanUplink: onDemand.rescanUplink },
            'autoAreas rescan is enabled but "rescanUplink" is missing or not a valid FTN address'
        );
        return cb(null);
    }

    const commandTemplate = onDemand.rescanCommand;
    if (!_.isString(commandTemplate) || 0 === commandTemplate.length) {
        Log.warn(
            { networkName },
            'autoAreas rescan is enabled but "rescanCommand" is not set; AreaFix rescan syntax differs per uplink and has no safe default'
        );
        return cb(null);
    }

    const days = _.isNumber(onDemand.rescanDays) ? onDemand.rescanDays : 0;

    const body =
        result.created
            .map(c =>
                commandTemplate
                    .replace(/%TAG%/g, c.ftnTag)
                    .replace(/%DAYS%/g, String(days))
            )
            .join('\r\n') + '\r\n';

    const toUserName = onDemand.rescanTo || 'AreaFix';

    User.getUserName(User.RootUserID, (err, fromName) => {
        const message = new Message({
            toUserName,
            fromUserName: fromName || 'SysOp',
            subject: onDemand.rescanPassword || '',
            message: body,
            areaTag: Message.WellKnownAreaTags.Private,
            meta: {
                System: {
                    [Message.SystemMetaNames.RemoteToUser]: uplink.toString(),
                    [Message.SystemMetaNames.ExternalFlavor]: Message.AddressFlavor.FTN,
                },
            },
        });

        if (!err) {
            message.setLocalFromUserId(User.RootUserID);
        }

        //
        //  persistMessage() rather than message.persist(): the latter does not
        //  record the message with the message network modules, which is what
        //  drives "@immediate" export. A system scheduling export as
        //  "@immediate" alone would otherwise queue this request and never
        //  send it.
        //
        const { persistMessage } = require('../message_area.js');
        persistMessage(message, persistErr => {
            if (persistErr) {
                Log.warn(
                    { networkName, error: persistErr.message },
                    'Failed to queue AreaFix rescan request'
                );
                return cb(null);
            }

            Log.info(
                {
                    networkName,
                    uplink: uplink.toString(),
                    areas: result.created.map(c => c.ftnTag),
                },
                `Queued AreaFix rescan request for ${result.created.length} area(s)`
            );

            //
            //  Queued is not sent. NetMail needs a route to reach an uplink,
            //  and without one the export fails with the request still sitting
            //  in the message base -- which reads as "we asked and got no
            //  answer" rather than "we never asked". Check the same way the
            //  export will, and say so now.
            //
            self.getNetMailRouteInfoFromAddress(uplink, routeErr => {
                if (routeErr) {
                    Log.warn(
                        {
                            networkName,
                            uplink: uplink.toString(),
                            error: routeErr.message,
                        },
                        'AreaFix rescan request is queued but cannot be routed; it will not be sent until "scannerTossers.ftn_bso.netMail.routes" covers this uplink'
                    );
                }
            });

            self.recordPendingAreaFixRequests(
                uplink.toString(),
                networkName,
                toUserName,
                result.created.map(c => c.ftnTag)
            );

            return cb(null);
        });
    });
};

//
//  ── AreaFix replies ──────────────────────────────────────────────────────
//
//  Only replies correlated to a request we actually sent are read, and only
//  lines naming a tag we asked about are considered.  Nothing parsed here can
//  reach config.hjson: the parser's return type is a status, so the worst a
//  mis-parse produces is a wrong log line.
//
const AreaFixPendingMaxAgeDays = 14;

FTNMessageScanTossModule.prototype.getPendingAreaFixRequests = function () {
    const raw = StatLog.getSystemStat(SysProps.FtnAreaFixPending);
    if (!raw) {
        return {};
    }

    let pending;
    try {
        pending = _.isString(raw) ? JSON.parse(raw) : raw;
    } catch (e) {
        Log.warn({ error: e.message }, 'Could not parse pending AreaFix requests');
        return {};
    }

    if (!_.isObject(pending)) {
        return {};
    }

    //  drop anything too old to still be an answer to us
    const cutoff = moment().subtract(AreaFixPendingMaxAgeDays, 'days');
    _.forEach(pending, (entry, address) => {
        _.forEach(_.get(entry, 'tags', {}), (info, tag) => {
            if (!info.timestamp || moment(info.timestamp).isBefore(cutoff)) {
                delete entry.tags[tag];
            }
        });
        if (0 === Object.keys(_.get(entry, 'tags', {})).length) {
            delete pending[address];
        }
    });

    return pending;
};

FTNMessageScanTossModule.prototype.setPendingAreaFixRequests = function (pending) {
    StatLog.setSystemStat(SysProps.FtnAreaFixPending, JSON.stringify(pending));
};

FTNMessageScanTossModule.prototype.recordPendingAreaFixRequests = function (
    address,
    networkName,
    toUserName,
    ftnTags
) {
    const pending = this.getPendingAreaFixRequests();
    const entry = pending[address] || (pending[address] = { tags: {} });

    entry.network = networkName;
    entry.toUserName = toUserName;
    entry.tags = entry.tags || {};

    const timestamp = moment().toISOString();
    ftnTags.forEach(tag => {
        entry.tags[tag.toUpperCase()] = { action: 'rescan', timestamp };
    });

    this.setPendingAreaFixRequests(pending);
};

//  Robot usernames these replies arrive from; also reserved in config_default
const AreaFixRobotNames = [
    'areafix',
    'areamgr',
    'allfix',
    'filefix',
    'filemgr',
    'echomail',
];

FTNMessageScanTossModule.prototype.handleAreaFixReply = function (message, cb) {
    const self = this;

    const remoteFrom = _.get(message, [
        'meta',
        'System',
        Message.SystemMetaNames.RemoteFromUser,
    ]);
    if (!remoteFrom) {
        return cb(null);
    }

    const pending = self.getPendingAreaFixRequests();
    const entry = pending[remoteFrom];
    const tags = Object.keys(_.get(entry, 'tags', {}));
    if (0 === tags.length) {
        return cb(null);
    }

    //  ...and from the robot we addressed, not just from that system
    const expectedNames = new Set(
        AreaFixRobotNames.concat([String(entry.toUserName || '').toLowerCase()])
    );
    const fromName = String(message.fromUserName || '').toLowerCase();
    if (!expectedNames.has(fromName)) {
        return cb(null);
    }

    const { results, unknownCount } = parseAreaFixReply(message.message, {
        tags,
        extraPhrases: _.get(Config(), 'messageNetworks.ftn.areaFixStatusPhrases'),
    });

    if (0 === results.length) {
        Log.info(
            { uplink: remoteFrom, pending: tags },
            'AreaFix reply received but nothing in it matched the areas we asked about; read the NetMail'
        );
        return cb(null);
    }

    results.forEach(r => {
        const logInfo = {
            uplink: remoteFrom,
            network: entry.network,
            areaTag: r.tag,
            status: r.status,
            raw: r.raw,
        };
        if (AreaFixStatus.Unknown === r.status) {
            Log.warn(logInfo, `AreaFix reply for "${r.tag}" was not understood`);
        } else {
            Log.info(logInfo, `AreaFix reply for "${r.tag}": ${r.status}`);
        }
    });

    //  answered tags stop being pending regardless of the answer
    results.forEach(r => delete entry.tags[r.tag]);
    if (0 === Object.keys(entry.tags).length) {
        delete pending[remoteFrom];
    }
    self.setPendingAreaFixRequests(pending);

    return self.notifyOpOfAreaFixReply(remoteFrom, entry, results, unknownCount, cb);
};

FTNMessageScanTossModule.prototype.notifyOpOfAreaFixReply = function (
    address,
    entry,
    results,
    unknownCount,
    cb
) {
    const lines = [`The AreaFix robot at ${address} answered a request we sent:`, ''];

    results.forEach(r => {
        lines.push(`  ${r.tag}: ${r.status}`);
        if (AreaFixStatus.Unknown === r.status) {
            lines.push(`    (not understood) ${r.raw}`);
        }
    });

    if (unknownCount > 0) {
        lines.push('');
        lines.push(
            `${unknownCount} line(s) were not understood. AreaFix reply wording differs`
        );
        lines.push(
            'between tossers; the raw NetMail from the robot has the full answer.'
        );
    }

    const message = new Message({
        toUserName: StatLog.getSystemStat(SysProps.SysOpUsername) || 'SysOp',
        fromUserName: 'ENiGMA½',
        subject: `AreaFix reply from ${address}`,
        message: lines.join('\r\n'),
        areaTag: Message.WellKnownAreaTags.Private,
    });
    message.setLocalToUserId(User.RootUserID);

    message.persist(err => {
        if (err) {
            Log.warn(
                { error: err.message },
                'Failed to notify the operator of an AreaFix reply'
            );
        }
        return cb(null);
    });
};

FTNMessageScanTossModule.prototype.performImport = function (cb) {
    if (!this.hasValidConfiguration()) {
        return cb(Errors.MissingConfig('Invalid or missing configuration'));
    }

    const self = this;

    guardedCall(
        IMPORT_WATCHDOG_MS,
        'FTN import',
        done => {
            //
            //  Pass 1: create areas for unknown FTN tags so pass 2 can import
            //  their mail instead of skipping it.  A failure here is never
            //  allowed to stop the import; the worst case is the messages are
            //  skipped exactly as they were before.
            //
            self.maybeAutoCreateAreas(() => {
                //
                //  ...and pick up any new info pack, so areas created above
                //  get their real names in the same cycle.  This queries the
                //  file area rather than reacting to a TIC arrival, so a pack
                //  that landed before the feature was enabled still counts and
                //  a missed trigger is picked up next pass.  An unchanged pack
                //  costs one file-area query.
                //
                areaInfoPack.ingestInfoPacks(() => {
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
                        done
                    );
                });
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
    const outboundDir = self.moduleConfig.paths.outbound;

    withFtnBsyFlag(
        outboundDir,
        done => {
            guardedCall(
                EXPORT_WATCHDOG_MS,
                'FTN export',
                innerDone => {
                    async.eachSeries(
                        ['EchoMail', 'NetMail'],
                        (type, nextType) => {
                            self[`perform${type}Export`](err => {
                                if (err) {
                                    Log.warn(
                                        { type, error: err.message },
                                        'Error(s) during export'
                                    );
                                }
                                return nextType(null); //  try next, always
                            });
                        },
                        () => {
                            return innerDone(null);
                        }
                    );
                },
                done
            );
        },
        cb
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

        //  hasValidConfiguration() passes when EITHER nodes or areas is
        //  configured, so we can land here with messageNetworks.ftn[.areas]
        //  missing entirely. Use a safe lookup; isAreaConfigValid(undefined)
        //  already short-circuits to false below.
        const areaConfig = _.get(Config(), [
            'messageNetworks',
            'ftn',
            'areas',
            message.areaTag,
        ]);
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
