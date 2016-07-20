/* jslint node: true */
'use strict';

//	ENiGMA½
const MessageScanTossModule	= require('../msg_scan_toss_module.js').MessageScanTossModule;
const Config				= require('../config.js').config;
const ftnMailPacket			= require('../ftn_mail_packet.js');
const ftnUtil				= require('../ftn_util.js');
const Address				= require('../ftn_address.js');
const Log					= require('../logger.js').log;
const ArchiveUtil			= require('../archive_util.js');
const msgDb					= require('../database.js').dbs.message;
const Message				= require('../message.js');

const moment				= require('moment');
const _						= require('lodash');
const paths					= require('path');
const async					= require('async');
const fs					= require('fs');
const later					= require('later');
const temp					= require('temp').track();	//	track() cleans up temp dir/files for us
const assert				= require('assert');
const gaze					= require('gaze');
const fse					= require('fs-extra');
const iconv					= require('iconv-lite');
const uuid					= require('node-uuid');

exports.moduleInfo = {
	name	: 'FTN BSO',
	desc	: 'BSO style message scanner/tosser for FTN networks',
	author	: 'NuSkooler',
};

/*
	:TODO:
	* Support (approx) max bundle size 
	* Support NetMail
		* NetMail needs explicit isNetMail()  check
		* NetMail filename / location / etc. is still unknown - need to post on groups & get real answers
	
*/ 

exports.getModule = FTNMessageScanTossModule;

const SCHEDULE_REGEXP	= /(?:^|or )?(@watch\:|@immediate)([^\0]+)?$/;

function FTNMessageScanTossModule() {
	MessageScanTossModule.call(this);
	
	let self = this;

	this.archUtil = new ArchiveUtil();
	this.archUtil.init();
	

	if(_.has(Config, 'scannerTossers.ftn_bso')) {
		this.moduleConfig = Config.scannerTossers.ftn_bso;	
	}
	
	this.getDefaultNetworkName = function() {
		if(this.moduleConfig.defaultNetwork) {
			return this.moduleConfig.defaultNetwork.toLowerCase();
		}
		
		const networkNames = Object.keys(Config.messageNetworks.ftn.networks);
		if(1 === networkNames.length) {
			return networkNames[0].toLowerCase();
		}
	};
	
	
	this.getDefaultZone = function(networkName) {
		if(_.isNumber(Config.messageNetworks.ftn.networks[networkName].defaultZone)) {
			return Config.messageNetworks.ftn.networks[networkName].defaultZone;
		}
		
		//	non-explicit: default to local address zone
		const networkLocalAddress = Config.messageNetworks.ftn.networks[networkName].localAddress;
		if(networkLocalAddress) {
			const addr = Address.fromString(networkLocalAddress);
			return addr.zone;
		}
	};
	
	/*
	this.isDefaultDomainZone = function(networkName, address) {
		const defaultNetworkName 	= this.getDefaultNetworkName();		 
		return(networkName === defaultNetworkName && address.zone === this.moduleConfig.defaultZone);
	};
	*/
	
	this.getNetworkNameByAddress = function(remoteAddress) {
		return _.findKey(Config.messageNetworks.ftn.networks, network => {
			const localAddress = Address.fromString(network.localAddress);			
			return !_.isUndefined(localAddress) && localAddress.isEqual(remoteAddress);
		});
	};
	
	this.getNetworkNameByAddressPattern = function(remoteAddressPattern) {
		return _.findKey(Config.messageNetworks.ftn.networks, network => {
			const localAddress = Address.fromString(network.localAddress);			
			return !_.isUndefined(localAddress) && localAddress.isPatternMatch(remoteAddressPattern);
		});	
	};
	
	this.getLocalAreaTagByFtnAreaTag = function(ftnAreaTag) {
		return _.findKey(Config.messageNetworks.ftn.areas, areaConf => {
			return areaConf.tag === ftnAreaTag;
		});
	};
	
	this.getExportType = function(nodeConfig) {
		return _.isString(nodeConfig.exportType) ? nodeConfig.exportType.toLowerCase() : 'crash';	
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
	
	this.messageHasValidMSGID = function(msg) {
		return _.isString(msg.meta.FtnKludge.MSGID) && msg.meta.FtnKludge.MSGID.length > 0;	
	};
	
	/*
	this.getOutgoingPacketDir = function(networkName, destAddress) {
		let dir = this.moduleConfig.paths.outbound;
		if(!this.isDefaultDomainZone(networkName, destAddress)) {
			const hexZone = `000${destAddress.zone.toString(16)}`.substr(-3);
			dir = paths.join(dir, `${networkName.toLowerCase()}.${hexZone}`);
		}
		return dir;
	};
	*/
	
	this.getOutgoingPacketDir = function(networkName, destAddress) {
		networkName = networkName.toLowerCase();
		
		let dir = this.moduleConfig.paths.outbound;
		
		const defaultNetworkName 	= this.getDefaultNetworkName();	
		const defaultZone			= this.getDefaultZone(networkName);
		
		let zoneExt;
		if(defaultZone !== destAddress.zone) {
			zoneExt = '.' + `000${destAddress.zone.toString(16)}`.substr(-3);
		} else {
			zoneExt = '';
		}
		
		if(defaultNetworkName === networkName) {
			dir = paths.join(dir, `outbound${zoneExt}`);
		} else {
			dir = paths.join(dir, `${networkName}${zoneExt}`);
		}
		
		return dir;
	};
	
	this.getOutgoingPacketFileName = function(basePath, messageId, isTemp) {
		//
		//	Generating an outgoing packet file name comes with a few issues:
		//	*	We must use DOS 8.3 filenames due to legacy systems that receive
		//		the packet not understanding LFNs
		//	*	We need uniqueness; This is especially important with packets that
		//		end up in bundles and on the receiving/remote system where conflicts
		//		with other systems could also occur
		//
		//	There are a lot of systems in use here for the name:
		//	*	HEX CRC16/32 of data
		//	*	HEX UNIX timestamp
		//	*	Mystic at least at one point, used Hex8(day of month + seconds past midnight + hundredths of second) 
		//		See https://groups.google.com/forum/#!searchin/alt.bbs.mystic/netmail$20filename/alt.bbs.mystic/m1xLnY8i1pU/YnG2excdl6MJ
		//	* 	SBBSEcho uses DDHHMMSS - see https://github.com/ftnapps/pkg-sbbs/blob/master/docs/fidonet.txt
		//	*	We already have a system for 8-character serial number gernation that is
		//		used for e.g. in FTS-0009.001 MSGIDs... let's use that!
		// 		
		const name	= ftnUtil.getMessageSerialNumber(messageId);
		const ext	= (true === isTemp) ? 'pk_' : 'pkt';				 
		return paths.join(basePath, `${name}.${ext}`);
	};
	
	this.getOutgoingFlowFileExtension = function(destAddress, flowType, exportType) {
		let ext;
		
		switch(flowType) {
		case 'mail'		: ext = `${exportType.toLowerCase()[0]}ut`; break;
		case 'ref'		: ext = `${exportType.toLowerCase()[0]}lo`; break;
		case 'busy'		: ext = 'bsy'; break;
		case 'request'	: ext = 'req'; break;
		case 'requests'	: ext = 'hrq'; break;
		}
		
		return ext;	
	};

	this.getOutgoingFlowFileName = function(basePath, destAddress, flowType, exportType) {
		let basename;			
		const ext = self.getOutgoingFlowFileExtension(destAddress, flowType, exportType);
		
		if(destAddress.point) {

		} else {
			//
			//	Use |destAddress| nnnnNNNN.??? where nnnn is dest net and NNNN is dest
			//	node. This seems to match what Mystic does
			//
			basename =
				`0000${destAddress.net.toString(16)}`.substr(-4) + 
				`0000${destAddress.node.toString(16)}`.substr(-4);			
		}
		
		return paths.join(basePath, `${basename}.${ext}`);
	};
	
	this.flowFileAppendRefs = function(filePath, fileRefs, directive, cb) {
		const appendLines = fileRefs.reduce( (content, ref) => {
			return content + `${directive}${ref}\n`;
		}, '');
		
		fs.appendFile(filePath, appendLines, err => {
			cb(err);
		});
	};
	
	this.getOutgoingBundleFileName = function(basePath, sourceAddress, destAddress, cb) {
		//
		//	Base filename is constructed as such:
		//	*	If this |destAddress| is *not* a point address, we use NNNNnnnn where 
		//		NNNN is 0 padded hex of dest net - source net and and nnnn is 0 padded 
		//		hex of dest node - source node.
		//	*	If |destAddress| is a point, NNNN becomes 0000 and nnnn becomes 'p' +
		//		3 digit 0 padded hex point
		//
		//	Extension is dd? where dd is Su...Mo and ? is 0...Z as collisions arise
		//
		let basename;
		if(destAddress.point) {
			const pointHex = `000${destAddress.point}`.substr(-3);
			basename = `0000p${pointHex}`;
		} else {
			basename = 
				`0000${Math.abs(sourceAddress.net - destAddress.net).toString(16)}`.substr(-4) + 
				`0000${Math.abs(sourceAddress.node - destAddress.node).toString(16)}`.substr(-4);			
		}
		
		//
		//	We need to now find the first entry that does not exist starting
		//	with dd0 to ddz
		//
		const EXT_SUFFIXES = '0123456789abcdefghijklmnopqrstuvwxyz'.split('');		
		let fileName = `${basename}.${moment().format('dd').toLowerCase()}`;
		async.detectSeries(EXT_SUFFIXES, (suffix, callback) => {
			const checkFileName = fileName + suffix; 			
			fs.stat(paths.join(basePath, checkFileName), err => {
				callback((err && 'ENOENT' === err.code) ? true : false);
			});
		}, finalSuffix => {
			if(finalSuffix) {
				cb(null, paths.join(basePath, fileName + finalSuffix));
			} else {
				cb(new Error('Could not acquire a bundle filename!'));
			}
		});
	};
	
	this.prepareMessage = function(message, options) {
		//
		//	Set various FTN kludges/etc.
		//
		message.meta.FtnProperty = message.meta.FtnProperty || {};
		message.meta.FtnKludge = message.meta.FtnKludge || {};
		
		message.meta.FtnProperty.ftn_orig_node		= options.network.localAddress.node;
		message.meta.FtnProperty.ftn_dest_node		= options.destAddress.node;
		message.meta.FtnProperty.ftn_orig_network	= options.network.localAddress.net;
		message.meta.FtnProperty.ftn_dest_network	= options.destAddress.net;
		message.meta.FtnProperty.ftn_cost			= 0;
		message.meta.FtnProperty.ftn_tear_line		= ftnUtil.getTearLine();		

		//	:TODO: Need an explicit isNetMail() check
		let ftnAttribute = 
			ftnMailPacket.Packet.Attribute.Local;	//	message from our system
		
		if(message.isPrivate()) {
			ftnAttribute |= ftnMailPacket.Packet.Attribute.Private;
			
			//
			//	NetMail messages need a FRL-1005.001 "Via" line
			//	http://ftsc.org/docs/frl-1005.001
			//
			if(_.isString(message.meta.FtnKludge.Via)) {
				message.meta.FtnKludge.Via = [ message.meta.FtnKludge.Via ];
			}
			message.meta.FtnKludge.Via = message.meta.FtnKludge.Via || [];
			message.meta.FtnKludge.Via.push(ftnUtil.getVia(options.network.localAddress));
		} else {
			//
			//	Set appropriate attribute flag for export type
			//
			switch(this.getExportType(options.nodeConfig)) {
			case 'crash'	: ftnAttribute |= ftnMailPacket.Packet.Attribute.Crash; break;
			case 'hold'		: ftnAttribute |= ftnMailPacket.Packet.Attribute.Hold; break;
				//	:TODO: Others?
			}
			
			//
			//	EchoMail requires some additional properties & kludges
			//		
			message.meta.FtnProperty.ftn_origin		= ftnUtil.getOrigin(options.network.localAddress);
			message.meta.FtnProperty.ftn_area		= Config.messageNetworks.ftn.areas[message.areaTag].tag;
			
			//
			//	When exporting messages, we should create/update SEEN-BY
			//	with remote address(s) we are exporting to.
			//
			const seenByAdditions = 
				[ `${options.network.localAddress.net}/${options.network.localAddress.node}` ].concat(Config.messageNetworks.ftn.areas[message.areaTag].uplinks);
			message.meta.FtnProperty.ftn_seen_by = 
				ftnUtil.getUpdatedSeenByEntries(message.meta.FtnProperty.ftn_seen_by, seenByAdditions);

			//
			//	And create/update PATH for ourself
			//
			message.meta.FtnKludge.PATH = 
				ftnUtil.getUpdatedPathEntries(message.meta.FtnKludge.PATH, options.network.localAddress);
		}
		
		message.meta.FtnProperty.ftn_attr_flags = ftnAttribute;
		
		//
		//	Additional kludges
		//
		//	Check for existence of MSGID as we may already have stored it from a previous
		//	export that failed to finish
		//	
		if(!message.meta.FtnKludge.MSGID) {
			message.meta.FtnKludge.MSGID = ftnUtil.getMessageIdentifier(message, options.network.localAddress);
		}
			
		message.meta.FtnKludge.TZUTC = ftnUtil.getUTCTimeZoneOffset();
			
		//
		//	According to FSC-0046:
		//	
		//	"When a Conference Mail processor adds a TID to a message, it may not
		//	add a PID. An existing TID should, however, be replaced. TIDs follow
		//	the same format used for PIDs, as explained above."
		//
		message.meta.FtnKludge.TID = ftnUtil.getProductIdentifier(); 
		
		//
		//	Determine CHRS and actual internal encoding name
		//	Try to preserve anything already here
		//
		let encoding = options.nodeConfig.encoding || 'utf8';
		if(message.meta.FtnKludge.CHRS) {
			const encFromChars = ftnUtil.getEncodingFromCharacterSetIdentifier(message.meta.FtnKludge.CHRS);
			if(encFromChars) {
				encoding = encFromChars;
			}
		}
		
		//
		//	Ensure we ended up with something useable. If not, back to utf8!
		//
		if(!iconv.encodingExists(encoding)) {
			Log.debug( { encoding : encoding }, 'Unknown encoding. Falling back to utf8');
			encoding = 'utf8';
		} 
		
		options.encoding = encoding;	//	save for later
		message.meta.FtnKludge.CHRS = ftnUtil.getCharacterSetIdentifierByEncoding(encoding);
		//	:TODO: FLAGS kludge? 		
	};
	
	this.setReplyKludgeFromReplyToMsgId = function(message, cb) {
		//
		//	Look up MSGID kludge for |message.replyToMsgId|, if any.
		//	If found, we can create a REPLY kludge with the previously
		//	discovered MSGID.
		//
		
		if(0 === message.replyToMsgId) {
			return cb(null);	//	nothing to do
		}
		
		Message.getMetaValuesByMessageId(message.replyToMsgId, 'FtnKludge', 'MSGID', (err, msgIdVal) => {			
			if(!err) {
				assert(_.isString(msgIdVal), 'Expected string but got ' + (typeof msgIdVal) + ' (' + msgIdVal + ')');			
				//	got a MSGID - create a REPLY
				message.meta.FtnKludge.REPLY = msgIdVal;
			}
			
			cb(null);	//	this method always passes
		});	
	};
	
	//	check paths, Addresses, etc.
	this.isAreaConfigValid = function(areaConfig) {
		if(!areaConfig || !_.isString(areaConfig.tag) || !_.isString(areaConfig.network)) {
			return false;
		}
		
		if(_.isString(areaConfig.uplinks)) {
			areaConfig.uplinks = areaConfig.uplinks.split(' ');
		}
		
		return (_.isArray(areaConfig.uplinks));
	};
	
	
	this.hasValidConfiguration = function() {
		if(!_.has(this, 'moduleConfig.nodes') || !_.has(Config, 'messageNetworks.ftn.areas')) {
			return false;
		}
		
		//	:TODO: need to check more!
		
		return true;
	};
	
	this.parseScheduleString = function(schedStr) {
		if(!schedStr) {
			return;	//	nothing to parse!
		}
		
		let schedule = {};
		
		const m = SCHEDULE_REGEXP.exec(schedStr);
		if(m) {
			schedStr = schedStr.substr(0, m.index).trim();
			
			if('@watch:' === m[1]) {
				schedule.watchFile = m[2];
			} else if('@immediate' === m[1]) {
				schedule.immediate = true;
			}
		}

		if(schedStr.length > 0) {
			const sched = later.parse.text(schedStr);
			if(-1 === sched.error) {
				schedule.sched = sched;
			}	
		}
		
		//	return undefined if we couldn't parse out anything useful
		if(!_.isEmpty(schedule)) {
			return schedule;
		} 
	};
	
	this.getAreaLastScanId = function(areaTag, cb) {
		const sql = 
			`SELECT area_tag, message_id
			FROM message_area_last_scan
			WHERE scan_toss = "ftn_bso" AND area_tag = ?
			LIMIT 1;`;
			
		msgDb.get(sql, [ areaTag ], (err, row) => {
			cb(err, row ? row.message_id : 0);
		});
	};
	
	this.setAreaLastScanId = function(areaTag, lastScanId, cb) {
		const sql =
			`REPLACE INTO message_area_last_scan (scan_toss, area_tag, message_id)
			VALUES ("ftn_bso", ?, ?);`;
		
		msgDb.run(sql, [ areaTag, lastScanId ], err => {
			cb(err);
		});
	};
	
	this.getNodeConfigKeyByAddress = function(uplink) {
		//	:TODO: sort by least # of '*' & take top?
		const nodeKey = _.filter(Object.keys(this.moduleConfig.nodes), addr => {
			return Address.fromString(addr).isPatternMatch(uplink);
		})[0];

		return nodeKey;
	};
	
	this.exportMessagesByUuid = function(messageUuids, exportOpts, cb) {
		//
		//	This method has a lot of madness going on:
		//	- Try to stuff messages into packets until we've hit the target size
		//	- We need to wait for write streams to finish before proceeding in many cases
		//	  or data will be cut off when closing and creating a new stream
		//
		let exportedFiles	= [];
		let currPacketSize	= self.moduleConfig.packetTargetByteSize;
		let packet;
		let ws;
		let remainMessageBuf;
		let remainMessageId;
		const createTempPacket = !_.isString(exportOpts.nodeConfig.archiveType) || 0 === exportOpts.nodeConfig.archiveType.length; 
		
		async.each(messageUuids, (msgUuid, nextUuid) => {
			let message = new Message();
			
			async.series(
				[
					function finalizePrevious(callback) {
						if(packet && currPacketSize >= self.moduleConfig.packetTargetByteSize) {
							packet.writeTerminator(ws);
							ws.end();
							ws.once('finish', () => {
								callback(null);
							});
						} else {
							callback(null);
						}
					},
					function loadMessage(callback) {
						message.load( { uuid : msgUuid }, err => {
							if(err) {
								return callback(err);
							}
							
							//	General preperation
							self.prepareMessage(message, exportOpts);
							
							self.setReplyKludgeFromReplyToMsgId(message, err => {
								callback(err);
							});
						});
					},
					function createNewPacket(callback) {			
						if(currPacketSize >= self.moduleConfig.packetTargetByteSize) {					
							packet = new ftnMailPacket.Packet();
							
							const packetHeader = new ftnMailPacket.PacketHeader(
								exportOpts.network.localAddress,
								exportOpts.destAddress,
								exportOpts.nodeConfig.packetType);

							packetHeader.password = exportOpts.nodeConfig.packetPassword || '';
							
							//	use current message ID for filename seed
							const pktFileName = self.getOutgoingPacketFileName(self.exportTempDir, message.messageId, createTempPacket);
							exportedFiles.push(pktFileName);
							
							ws = fs.createWriteStream(pktFileName);
							
							currPacketSize = packet.writeHeader(ws, packetHeader);
							
							if(remainMessageBuf) {
								currPacketSize += packet.writeMessageEntry(ws, remainMessageBuf);
								remainMessageBuf = null;
							}						
						}
						
						callback(null);					
					},
					function appendMessage(callback) {
						const msgBuf	= packet.getMessageEntryBuffer(message, exportOpts);
						currPacketSize	+= msgBuf.length;
						
						if(currPacketSize >= self.moduleConfig.packetTargetByteSize) {
							remainMessageBuf	= msgBuf;	//	save for next packet	
							remainMessageId 	= message.messageId;						
						} else {
							ws.write(msgBuf);
						}
						callback(null);
					},
					function storeStateFlags0Meta(callback) {
						message.persistMetaValue('System', 'state_flags0', Message.StateFlags0.Exported.toString(), err => {
							callback(err);
						});
					},
					function storeMsgIdMeta(callback) {
						//
						//	We want to store some meta as if we had imported
						//	this message for later reference
						//
						if(message.meta.FtnKludge.MSGID) {
							message.persistMetaValue('FtnKludge', 'MSGID', message.meta.FtnKludge.MSGID, err => {
								callback(err);
							});
						} else {
							callback(null);
						}					
					}
				], 
				err => {
					nextUuid(err);
				}
			);
		}, err => {
			if(err) {
				cb(err);
			} else {
				async.series(
					[
						function terminateLast(callback) {
							if(packet) {
								packet.writeTerminator(ws);
								ws.end();
								ws.once('finish', () => {
									callback(null);
								});
							} else {
								callback(null);
							}
						},
						function writeRemainPacket(callback) {
							if(remainMessageBuf) {
								//	:TODO: DRY this with the code above -- they are basically identical
								packet = new ftnMailPacket.Packet();
											
								const packetHeader = new ftnMailPacket.PacketHeader(
									exportOpts.network.localAddress,
									exportOpts.destAddress,
									exportOpts.nodeConfig.packetType);

								packetHeader.password = exportOpts.nodeConfig.packetPassword || '';
								
								//	use current message ID for filename seed
								const pktFileName = self.getOutgoingPacketFileName(self.exportTempDir, remainMessageId, createTempPacket);
								exportedFiles.push(pktFileName);
								
								ws = fs.createWriteStream(pktFileName);
								
								packet.writeHeader(ws, packetHeader);
								ws.write(remainMessageBuf);
								packet.writeTerminator(ws);
								ws.end();
								ws.once('finish', () => {
									callback(null);
								});
							} else {
								callback(null);
							}
						}
					],
					err => {
						cb(err, exportedFiles);
					}
				);	
			}			
		});
	};
		
	this.exportMessagesToUplinks = function(messageUuids, areaConfig, cb) {
		async.each(areaConfig.uplinks, (uplink, nextUplink) => {
			const nodeConfigKey = self.getNodeConfigKeyByAddress(uplink);
			if(!nodeConfigKey) {
				return nextUplink();
			}
			
			const exportOpts = {
				nodeConfig		: self.moduleConfig.nodes[nodeConfigKey],
				network			: Config.messageNetworks.ftn.networks[areaConfig.network],
				destAddress		: Address.fromString(uplink),
				networkName		: areaConfig.network,
			};
				
			if(_.isString(exportOpts.network.localAddress)) {
				exportOpts.network.localAddress = Address.fromString(exportOpts.network.localAddress); 
			}
			
			const outgoingDir 	= self.getOutgoingPacketDir(exportOpts.networkName, exportOpts.destAddress);
			const exportType	= self.getExportType(exportOpts.nodeConfig);
			
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
						if(self.archUtil.haveArchiver(exportOpts.nodeConfig.archiveType)) {
							//	:TODO: support bundleTargetByteSize:
							//
							//	Compress to a temp location then we'll move it in the next step
							//
							//	Note that we must use the *final* output dir for getOutgoingBundleFileName()
							//	as it checks for collisions in bundle names!
							//
							self.getOutgoingBundleFileName(outgoingDir, exportOpts.network.localAddress, exportOpts.destAddress, (err, bundlePath) => {
								if(err) {
									return callback(err);
								}
								
								//	adjust back to temp path
								const tempBundlePath = paths.join(self.exportTempDir, paths.basename(bundlePath));
								
								self.archUtil.compressTo(
									exportOpts.nodeConfig.archiveType, 
									tempBundlePath,
									exportedFileNames, err => {
										callback(err, [ tempBundlePath ] );
									}
								);	
							});
						} else {
							callback(null, exportedFileNames);
						}
					},
					function moveFilesToOutgoing(exportedFileNames, callback) {
						async.each(exportedFileNames, (oldPath, nextFile) => {
							const ext = paths.extname(oldPath).toLowerCase();
							if('.pk_' === ext) {
								//
								//	For a given temporary .pk_ file, we need to move it to the outoing
								//	directory with the appropriate BSO style filename.
								// 
								const ext = self.getOutgoingFlowFileExtension(
									exportOpts.destAddress,
									'mail', 
									exportType);
									
								const newPath = paths.join(
									outgoingDir, 
									`${paths.basename(oldPath, 'pk_')}${ext}`);
																		
								fse.move(oldPath, newPath, nextFile);
							} else {
								const newPath = paths.join(outgoingDir, paths.basename(oldPath));
								fse.move(oldPath, newPath, err => {
									if(err) {
										Log.warn(
											{ oldPath : oldPath, newPath : newPath, error : err.toString() },
											'Failed moving temporary bundle file!');
											
										return nextFile();
									}
									
									//
									//	For bundles, we need to append to the appropriate flow file
									//
									const flowFilePath = self.getOutgoingFlowFileName(
										outgoingDir, 
										exportOpts.destAddress,
										'ref',
										exportType);
										 
									//	directive of '^' = delete file after transfer
									self.flowFileAppendRefs(flowFilePath, [ newPath ], '^', err => {
										if(err) {
											Log.warn( { path : flowFilePath }, 'Failed appending flow reference record!');			
										}
										nextFile();
									});
								});
							}
						}, callback);
					}
				],
				err => {
					//	:TODO: do something with |err| ?
					nextUplink();
				}
			);			
		}, cb);	//	complete
	};
	
	this.setReplyToMsgIdFtnReplyKludge = function(message, cb) {
		//
		//	Given a FTN REPLY kludge, set |message.replyToMsgId|, if possible,
		//	by looking up an associated MSGID kludge meta.
		//
		//	See also: http://ftsc.org/docs/fts-0009.001
		//
		if(!_.isString(message.meta.FtnKludge.REPLY)) {
			//	nothing to do
			return cb();
		}
		
		Message.getMessageIdsByMetaValue('FtnKludge', 'MSGID', message.meta.FtnKludge.REPLY, (err, msgIds) => {
			if(msgIds && msgIds.length > 0) {
				//	expect a single match, but dupe checking is not perfect - warn otherwise
				if(1 === msgIds.length) {
					message.replyToMsgId = msgIds[0];	
				} else {
					Log.warn( { msgIds : msgIds, replyKludge :  message.meta.FtnKludge.REPLY }, 'Found 2:n MSGIDs matching REPLY kludge!');
				}
			}
			cb();
		});
	};
	
	this.importEchoMailToArea = function(localAreaTag, header, message, cb) {
		async.series(
			[
				function validateDestinationAddress(callback) {			
					const localNetworkPattern = `${message.meta.FtnProperty.ftn_dest_network}/${message.meta.FtnProperty.ftn_dest_node}`;					
					const localNetworkName = self.getNetworkNameByAddressPattern(localNetworkPattern);
					
					callback(_.isString(localNetworkName) ? null : new Error('Packet destination is not us'));
				},
				function checkForDupeMSGID(callback) {
					//
					//	If we have a MSGID, don't allow a dupe
					//
					if(!_.has(message.meta, 'FtnKludge.MSGID')) {
						return callback(null);
					}

					Message.getMessageIdsByMetaValue('FtnKludge', 'MSGID', message.meta.FtnKludge.MSGID, (err, msgIds) => {
						if(msgIds && msgIds.length > 0) {
							const err = new Error('Duplicate MSGID');
							err.code = 'DUPE_MSGID';
							return callback(err);
						}

						return callback(null);
					});
				},
				function basicSetup(callback) {
					message.areaTag = localAreaTag;
					
					//
					//	If we *allow* dupes (disabled by default), then just generate
					//	a random UUID. Otherwise, don't assign the UUID just yet. It will be
					//	generated at persist() time and should be consistent across import/exports
					//
					if(Config.messageNetworks.ftn.areas[localAreaTag].allowDupes) {
						//	just generate a UUID & therefor always allow for dupes
						message.uuid = uuid.v1();
					}
					
					callback(null);	
				},
				function setReplyToMessageId(callback) {
					self.setReplyToMsgIdFtnReplyKludge(message, () => {
						callback(null);
					});
				},
				function persistImport(callback) {
					//	mark as imported
					message.meta.System.state_flags0 = Message.StateFlags0.Imported.toString();
					
					//	save to disc
					message.persist(err => {
						callback(err);						
					});
				}
			], 
			err => {
				cb(err);	
			}
		);
	};

	this.appendTearAndOrigin = function(message) {
		if(message.meta.FtnProperty.ftn_tear_line) {
			message.message += `\r\n${message.meta.FtnProperty.ftn_tear_line}\r\n`;
		}

		if(message.meta.FtnProperty.ftn_origin) {
			message.message += `${message.meta.FtnProperty.ftn_origin}\r\n`;
		}
	};
	
	//
	//	Ref. implementations on import: 
	//	*	https://github.com/larsks/crashmail/blob/26e5374710c7868dab3d834be14bf4041041aae5/crashmail/pkt.c
	//		https://github.com/larsks/crashmail/blob/26e5374710c7868dab3d834be14bf4041041aae5/crashmail/handle.c
	//
	this.importMessagesFromPacketFile = function(packetPath, password, cb) {
		let packetHeader;
				
		const packetOpts = { keepTearAndOrigin : false };	//	needed so we can calc message UUID without these; we'll add later
		
		let importStats = {
			areaSuccess	: {},	//	areaTag->count
			areaFail	: {},	//	areaTag->count
			otherFail	: 0,
		};
        
		new ftnMailPacket.Packet(packetOpts).read(packetPath, (entryType, entryData, next) => {
			if('header' === entryType) {
				packetHeader = entryData;
				
				const localNetworkName = self.getNetworkNameByAddress(packetHeader.destAddress);
				if(!_.isString(localNetworkName)) {
					return next(new Error('No configuration for this packet'));
				} else {
					
					//	:TODO: password needs validated - need to determine if it will use the same node config (which can have wildcards) or something else?!					
					return next(null);
				}
				
			} else if('message' === entryType) {
				const message = entryData;
				const areaTag = message.meta.FtnProperty.ftn_area;

				if(areaTag) {
					//
					//	EchoMail
					//
					const localAreaTag = self.getLocalAreaTagByFtnAreaTag(areaTag);
					if(localAreaTag) {
						message.uuid = Message.createMessageUUID(
							localAreaTag,
							message.modTimestamp,
							message.subject,
							message.message);

						self.appendTearAndOrigin(message);
						
						self.importEchoMailToArea(localAreaTag, packetHeader, message, err => {
							if(err) {
								//	bump area fail stats
								importStats.areaFail[localAreaTag] = (importStats.areaFail[localAreaTag] || 0) + 1;
								
								if('SQLITE_CONSTRAINT' === err.code || 'DUPE_MSGID' === err.code) {
									const msgId = _.has(message.meta, 'FtnKludge.MSGID') ? message.meta.FtnKludge.MSGID : 'N/A';
									Log.info(
										{ area : localAreaTag, subject : message.subject, uuid : message.uuid, MSGID : msgId }, 
										'Not importing non-unique message');
									
									return next(null);
								}
							} else {
								//	bump area success
								importStats.areaSuccess[localAreaTag] = (importStats.areaSuccess[localAreaTag] || 0) + 1;
							}
															
							return next(err);
						});
					} else {
						//
						//	No local area configured for this import
						//
						//	:TODO: Handle the "catch all" case, if configured 
						Log.warn( { areaTag : areaTag }, 'No local area configured for this packet file!');
						
						//	bump generic failure
						importStats.otherFail += 1;
						
						return next(null);
					}
				} else {
					//
					//	NetMail
					//
					Log.warn('NetMail import not yet implemented!');
					return next(null);
				}
			}
		}, err => {
			const finalStats = Object.assign(importStats, { packetPath : packetPath } );
			Log.info(finalStats, 'Import complete');
			
			cb(err);
		});
	};
	
	this.archivePacketFile = function(type, origPath, label, cb) {
		if('import' === type && _.isString(self.moduleConfig.retainImportPacketPath)) {
			const archivePath = paths.join(
				self.moduleConfig.retainImportPacketPath, 
				`${label}-${moment().format('YYYY-MM-DDTHH.mm.ss.SSS')}-${paths.basename(origPath)}`);
				
			fse.copy(origPath, archivePath, err => {
				if(err) {
					Log.warn( { origPath : origPath, archivePath : archivePath }, 'Failed to archive packet file');
				}
				cb(null);	//	non-fatal always
			});
		} else {
			cb(null);	//	NYI
		}
	}
	
	this.importPacketFilesFromDirectory = function(importDir, password, cb) {
		async.waterfall(
			[
				function getPacketFiles(callback) {
					fs.readdir(importDir, (err, files) => {
						if(err) {
							return callback(err);
						}
						callback(null, files.filter(f => '.pkt' === paths.extname(f).toLowerCase()));
					});
				},
				function importPacketFiles(packetFiles, callback) {
					let rejects = [];
					async.eachSeries(packetFiles, (packetFile, nextFile) => {
						self.importMessagesFromPacketFile(paths.join(importDir, packetFile), '', err => {							
							if(err) {
								Log.debug( 
									{ path : paths.join(importDir, packetFile), error : err.toString() }, 
									'Failed to import packet file');
								
								rejects.push(packetFile);
							}
							nextFile();
						});
					}, err => {
						//	:TODO: Handle err! we should try to keep going though...
						callback(err, packetFiles, rejects);
					});
				},
				function handleProcessedFiles(packetFiles, rejects, callback) {
					async.each(packetFiles, (packetFile, nextFile) => {
						const fullPath = paths.join(importDir, packetFile);
						
						//
						//	If scannerTossers::ftn_bso::reainImportPacketPath is set,
						//	copy each packet file over in the following format:
						//
						//	<good|bad>-<msSinceEpoc>-<origPacketFileName.pkt>
						//
						if(rejects.indexOf(packetFile) > -1) {
							self.archivePacketFile('import', fullPath, 'reject', () => {
								nextFile();
							});
							//	:TODO: rename to .bad, perhaps move to a rejects dir + log
							//nextFile();					
						} else {
							self.archivePacketFile('import', fullPath, 'imported', () => {
								fs.unlink(fullPath, () => {
									nextFile();
								});
							});
						}
					}, err => {
						callback(err);
					});
				}
			],
			err => {
				cb(err);
			}
		);
	};
	
	this.importMessagesFromDirectory = function(inboundType, importDir, cb) {
		async.waterfall(
			[
				//	start with .pkt files
				function importPacketFiles(callback) {
					self.importPacketFilesFromDirectory(importDir, '', err => {
						callback(err);
					});
				},
				function discoverBundles(callback) {
					fs.readdir(importDir, (err, files) => {
						//	:TODO: if we do much more of this, probably just use the glob module
						const bundleRegExp = /\.(su|mo|tu|we|th|fr|sa)[0-9a-z]/i;
						files = files.filter(f => {
							const fext = paths.extname(f);
							return bundleRegExp.test(fext);
						});
						
						async.map(files, (file, transform) => {
							const fullPath = paths.join(importDir, file);
							self.archUtil.detectType(fullPath, (err, archName) => {
								transform(null, { path : fullPath, archName : archName } );
							});
						}, (err, bundleFiles) => {
							callback(err, bundleFiles);
						});
					});
				},
				function importBundles(bundleFiles, callback) {
					let rejects = [];
					
					async.each(bundleFiles, (bundleFile, nextFile) => {
						if(_.isUndefined(bundleFile.archName)) {
							Log.warn( 
								{ fileName : bundleFile.path },
								'Unknown bundle archive type');
					
							rejects.push(bundleFile.path);
										
							return nextFile();	//	unknown archive type
						}
						
						self.archUtil.extractTo(
							bundleFile.path,
							self.importTempDir,
							bundleFile.archName,
							err => {
								if(err) {									
									Log.warn(
										{ fileName : bundleFile.path, error : err.toString() },
										'Failed to extract bundle');
										
									rejects.push(bundleFile.path);
								}
								
								nextFile();		
							}
						);
					}, err => {
						if(err) {
							return callback(err);
						}
						
						//
						//	All extracted - import .pkt's
						//
						self.importPacketFilesFromDirectory(self.importTempDir, '', err => {
							//	:TODO: handle |err|
							callback(null, bundleFiles, rejects);
						});					
					});
				},
				function handleProcessedBundleFiles(bundleFiles, rejects, callback) {
					async.each(bundleFiles, (bundleFile, nextFile) => {
						if(rejects.indexOf(bundleFile.path) > -1) {
							//	:TODO: rename to .bad, perhaps move to a rejects dir + log
							nextFile();					
						} else {
							fs.unlink(bundleFile.path, err => {
								nextFile();
							});
						}
					}, err => {
						callback(err);
					});
				}
			],
			err => {
				cb(err);
			}
		);
	};
	
	this.createTempDirectories = function(cb) {
		temp.mkdir('enigftnexport-', (err, tempDir) => {
			if(err) {
				return cb(err);
			}
			
			self.exportTempDir = tempDir;
			
			temp.mkdir('enigftnimport-', (err, tempDir) => {
				self.importTempDir = tempDir;
				
				cb(err);
			});
		});
	};
	
	//	Starts an export block - returns true if we can proceed
	this.exportingStart = function() {
		if(!this.exportRunning) {
			this.exportRunning = true;
			return true;
		}
		
		return false;
	};
	
	//	ends an export block
	this.exportingEnd = function() {
		this.exportRunning = false;	
	};
}

require('util').inherits(FTNMessageScanTossModule, MessageScanTossModule);

//	:TODO: *scheduled* portion of this stuff should probably use event_scheduler - @immediate would still use record().

FTNMessageScanTossModule.prototype.startup = function(cb) {
	Log.info(`${exports.moduleInfo.name} Scanner/Tosser starting up`);
	
	let importing = false;
	
	let self = this;
				
	function tryImportNow(reasonDesc) {
		if(!importing) {
			importing = true;
			
			Log.info( { module : exports.moduleInfo.name }, reasonDesc);
			
			self.performImport( () => {
				importing = false;
			});
		}
	}
	
	this.createTempDirectories(err => {
		if(err) {
			Log.warn( { error : err.toStrong() }, 'Failed creating temporary directories!');
			return cb(err);
		}
	
		if(_.isObject(this.moduleConfig.schedule)) {
			const exportSchedule = this.parseScheduleString(this.moduleConfig.schedule.export);
			if(exportSchedule) {
				Log.debug(
					{ 
						schedule	: this.moduleConfig.schedule.export,
						schedOK		: -1 === exportSchedule.sched.error,
						immediate	: exportSchedule.immediate ? true : false,
					},
					'Export schedule loaded'
				);
				
				if(exportSchedule.sched && this.exportingStart()) {
					this.exportTimer = later.setInterval( () => {
						
						Log.info( { module : exports.moduleInfo.name }, 'Performing scheduled message scan/export...');
						
						this.performExport( () => {
							this.exportingEnd();
						});
					}, exportSchedule.sched);
				}
				
				if(_.isBoolean(exportSchedule.immediate)) {
					this.exportImmediate = exportSchedule.immediate;
				}
			}
			
			const importSchedule = this.parseScheduleString(this.moduleConfig.schedule.import);
			if(importSchedule) {
				Log.debug(
					{
						schedule	: this.moduleConfig.schedule.import,
						schedOK		: -1 === importSchedule.sched.error,
						watchFile	: _.isString(importSchedule.watchFile) ? importSchedule.watchFile : 'None',
					},
					'Import schedule loaded'
				);
				
				if(importSchedule.sched) {					
					this.importTimer = later.setInterval( () => {
						tryImportNow('Performing scheduled message import/toss...');						
					}, importSchedule.sched);
				}
				
				if(_.isString(importSchedule.watchFile)) {
					gaze(importSchedule.watchFile, (err, watcher) => {
						watcher.on('all', (event, watchedPath) => {
							if(importSchedule.watchFile === watchedPath) {
								tryImportNow(`Performing import/toss due to @watch: ${watchedPath} (${event})`);	
							}
						});
					});
				}
			}
		}
		
		FTNMessageScanTossModule.super_.prototype.startup.call(this, cb);
	});
};

FTNMessageScanTossModule.prototype.shutdown = function(cb) {
	Log.info('FidoNet Scanner/Tosser shutting down');
	
	if(this.exportTimer) {
		this.exportTimer.clear();
	}
	
	if(this.importTimer) {
		this.importTimer.clear();
	}
	
	//
	//	Clean up temp dir/files we created
	//
	temp.cleanup((err, stats) => {
		const fullStats = Object.assign(stats, { exportTemp : this.exportTempDir, importTemp : this.importTempDir } ); 
		
		if(err) {
			Log.warn(fullStats, 'Failed cleaning up temporary directories!');
		} else {
			Log.trace(fullStats, 'Temporary directories cleaned up');
		}
			
		FTNMessageScanTossModule.super_.prototype.shutdown.call(this, cb);
	});
};

FTNMessageScanTossModule.prototype.performImport = function(cb) {
	if(!this.hasValidConfiguration()) {
		return cb(new Error('Missing or invalid configuration'));
	}
	
	var self = this;
	
	async.each( [ 'inbound', 'secInbound' ], (inboundType, nextDir) => {
		self.importMessagesFromDirectory(inboundType, self.moduleConfig.paths[inboundType], err => {
			
			nextDir();
		});
	}, cb);
};

FTNMessageScanTossModule.prototype.performExport = function(cb) {
	//
	//	We're only concerned with areas related to FTN. For each area, loop though
	//	and let's find out what messages need exported.
	//
	if(!this.hasValidConfiguration()) {
		return cb(new Error('Missing or invalid configuration'));
	}
	
	//
	//	Select all messages with a |message_id| > |lastScanId|.
	//	Additionally exclude messages with the System state_flags0 which will be present for
	//	imported or already exported messages
	//
	//	NOTE: If StateFlags0 starts to use additional bits, we'll likely need to check them here!
	//
	const getNewUuidsSql = 
		`SELECT message_id, message_uuid
		FROM message m
		WHERE area_tag = ? AND message_id > ? AND
			(SELECT COUNT(message_id) 
			FROM message_meta 
			WHERE message_id = m.message_id AND meta_category = 'System' AND meta_name = 'state_flags0') = 0
		ORDER BY message_id;`;
		
	let self = this;		
		
	async.each(Object.keys(Config.messageNetworks.ftn.areas), (areaTag, nextArea) => {
		const areaConfig = Config.messageNetworks.ftn.areas[areaTag];
		if(!this.isAreaConfigValid(areaConfig)) {
			return nextArea();
		}
		
		//
		//	For each message that is newer than that of the last scan
		//	we need to export to each configured associated uplink(s)
		//
		async.waterfall(
			[
				function getLastScanId(callback) {
					self.getAreaLastScanId(areaTag, callback);
				},
				function getNewUuids(lastScanId, callback) {
					msgDb.all(getNewUuidsSql, [ areaTag, lastScanId ], (err, rows) => {
						if(err) {
							callback(err);
						} else {
							if(0 === rows.length) {
								let nothingToDoErr = new Error('Nothing to do!');
								nothingToDoErr.noRows = true;
								callback(nothingToDoErr);
							} else {
								callback(null, rows);
							}
						}
					});
				},
				function exportToConfiguredUplinks(msgRows, callback) {
					const uuidsOnly = msgRows.map(r => r.message_uuid);	//	convert to array of UUIDs only
					self.exportMessagesToUplinks(uuidsOnly, areaConfig, err => {
						const newLastScanId = msgRows[msgRows.length - 1].message_id; 
						
						Log.info(
							{ areaTag : areaTag, messagesExported : msgRows.length, newLastScanId : newLastScanId }, 
							'Export complete');
							
						callback(err, newLastScanId);
					});					
				},
				function updateLastScanId(newLastScanId, callback) {
					self.setAreaLastScanId(areaTag, newLastScanId, callback);
				}
			],
			function complete(err) {
				nextArea();
			}
		);
	}, err => {
		cb(err);
	});
};

FTNMessageScanTossModule.prototype.record = function(message) {
	//
	//	This module works off schedules, but we do support @immediate for export
	//
	if(true !== this.exportImmediate || !this.hasValidConfiguration()) {
		return;
	}
	
	if(message.isPrivate()) {
		//	:TODO: support NetMail
	} else if(message.areaTag) {
		const areaConfig = Config.messageNetworks.ftn.areas[message.areaTag];
		if(!this.isAreaConfigValid(areaConfig)) {
			return;
		}
				
		if(this.exportingStart()) {
			this.exportMessagesToUplinks( [ message.uuid ], areaConfig, err => {
				const info = { uuid : message.uuid, subject : message.subject };
			
				if(err) {
					Log.warn(info, 'Failed exporting message');
				} else {
					Log.info(info, 'Message exported');
				}
				
				this.exportingEnd();
			});
		}		
	}		
};
