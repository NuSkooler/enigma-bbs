/* jslint node: true */
'use strict';

//	ENiGMA½
let MessageScanTossModule	= require('../msg_scan_toss_module.js').MessageScanTossModule;
let Config					= require('../config.js').config;
let ftnMailPacket			= require('../ftn_mail_packet.js');
let ftnUtil					= require('../ftn_util.js');
let Address					= require('../ftn_address.js');
let Log						= require('../logger.js').log;
let ArchiveUtil				= require('../archive_util.js');
let msgDb					= require('../database.js').dbs.message;
let Message					= require('../message.js');

let moment					= require('moment');
let _						= require('lodash');
let paths					= require('path');
let mkdirp 					= require('mkdirp');
let async					= require('async');
let fs						= require('fs');
let later					= require('later');
let temp					= require('temp').track();	//	track() cleans up temp dir/files for us
let assert					= require('assert');

exports.moduleInfo = {
	name	: 'FTN BSO',
	desc	: 'BSO style message scanner/tosser for FTN networks',
	author	: 'NuSkooler',
};

/*
	:TODO: 
	* Add bundle timer (arcmail)
	* Queue until time elapses / fixed time interval
	* Pakcets append until >= max byte size
	* [if arch type is not empty): Packets -> bundle until max byte size -> repeat process
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
			return this.moduleConfig.defaultNetwork;
		}
		
		const networkNames = Object.keys(Config.messageNetworks.ftn.networks);
		if(1 === networkNames.length) {
			return networkNames[0];
		}
	};
	
	this.isDefaultDomainZone = function(networkName, address) {
		const defaultNetworkName = this.getDefaultNetworkName();
		return(networkName === defaultNetworkName && address.zone === this.moduleConfig.defaultZone);
	};
	
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
	
	this.getOutgoingPacketDir = function(networkName, destAddress) {
		let dir = this.moduleConfig.paths.outbound;
		if(!this.isDefaultDomainZone(networkName, destAddress)) {
			const hexZone = `000${destAddress.zone.toString(16)}`.substr(-3);
			dir = paths.join(dir, `${networkName.toLowerCase()}.${hexZone}`);
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

	this.getOutgoingFlowFileName = function(basePath, destAddress, exportType, extSuffix) {
		if(destAddress.point) {

		} else {
			//
			//	Use |destAddress| nnnnNNNN.??? where nnnn is dest net and NNNN is dest
			//	node. This seems to match what Mystic does
			//
			return `${Math.abs(destAddress.net)}${Math.abs(destAddress.node)}.${exportType[1]}${extSuffix}`;
		}
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
		var basename;
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
			fs.stat(paths.join(basePath, checkFileName), (err, stats) => {
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
		//	:TODO: attr1 & 2
		message.meta.FtnProperty.ftn_cost			= 0;
		
		message.meta.FtnProperty.ftn_tear_line		= ftnUtil.getTearLine();		

		//	:TODO: Need an explicit isNetMail() check
		let ftnAttribute = 0;
		
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
		
		if(!message.meta.FtnKludge.PID) {
			message.meta.FtnKludge.PID = ftnUtil.getProductIdentifier();
		}
		
		if(!message.meta.FtnKludge.TID) {
			//	:TODO: Create TID!!
			//message.meta.FtnKludge.TID = 
		}
		
		//
		//	Determine CHRS and actual internal encoding name
		//	Try to preserve anything already here
		let encoding = options.nodeConfig.encoding || 'utf8';
		if(message.meta.FtnKludge.CHRS) {
			const encFromChars = ftnUtil.getEncodingFromCharacterSetIdentifier(message.meta.FtnKludge.CHRS);
			if(encFromChars) {
				encoding = encFromChars;
			}
		}
		
		options.encoding = encoding;	//	save for later
		message.meta.FtnKludge.CHRS = ftnUtil.getCharacterSetIdentifierByEncoding(encoding);
		//	:TODO: FLAGS kludge? 
		//	:TODO: Add REPLY kludge if appropriate
		
	};
	
	
	//	:TODO: change to something like isAreaConfigValid
	//	check paths, Addresses, etc.
	this.isAreaConfigValid = function(areaConfig) {
		if(!_.isString(areaConfig.tag) || !_.isString(areaConfig.network)) {
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
	
	this.getNodeConfigKeyForUplink = function(uplink) {
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
							if(!err) {
								self.prepareMessage(message, exportOpts);
							}
							callback(err);
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
							const pktFileName = self.getOutgoingPacketFileName(exportOpts.tempDir, message.messageId);
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
					function updateStoredMeta(callback) {
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
								const pktFileName = self.getOutgoingPacketFileName(exportOpts.tempDir, remainMessageId);
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
			const nodeConfigKey = self.getNodeConfigKeyForUplink(uplink);
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
			
			const outgoingDir = self.getOutgoingPacketDir(exportOpts.networkName, exportOpts.destAddress);
			
			async.waterfall(
				[
					function createTempDir(callback) {
						temp.mkdir('enigftnexport--', (err, tempDir) => {
							exportOpts.tempDir = tempDir;
							callback(err);
						});
					},
					function createOutgoingDir(callback) {
						mkdirp(outgoingDir, err => {
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
								const tempBundlePath = paths.join(exportOpts.tempDir, paths.basename(bundlePath));
								
								self.archUtil.compressTo(
									exportOpts.nodeConfig.archiveType, 
									tempBundlePath,
									exportedFileNames, err => {
										//	:TODO: we need to delete the original input file(s)
										fs.rename(tempBundlePath, bundlePath, err => {
											callback(err, [ bundlePath ] );
										});
									}
								);	
							});
						} else {
							callback(null, exportedFileNames);
						}
					},
					function moveFilesToOutgoing(exportedFileNames, callback) {
						async.each(exportedFileNames, (oldPath, nextFile) => {
							const ext = paths.extname(oldPath);
							if('.pk_' === ext) {
								const newPath = paths.join(outgoingDir, paths.basename(oldPath, ext) + '.pkt');
								fs.rename(oldPath, newPath, nextFile);
							} else {
								const newPath = paths.join(outgoingDir, paths.basename(oldPath));
								fs.rename(oldPath, newPath, nextFile);
							}
						}, callback);
					},
					function cleanUpTempDir(callback) {
						temp.cleanup((err, stats) => {
							Log.trace(
								Object.assign(stats, { tempDir : exportOpts.tempDir }), 
								'Temporary directory cleaned up');
						});
					}
				],
				err => {
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
			if(!err) {
				assert(1 === msgIds.length);
				message.replyToMsgId = msgIds[0];
			}
			cb();
		});
	};
	
	this.importNetMailToArea = function(localAreaTag, header, message, cb) {
		async.series(
			[
				function validateDestinationAddress(callback) {
					/*
					const messageDestAddress = new Address({
						node	: message.meta.FtnProperty.ftn_dest_node,
						net		: message.meta.FtnProperty.ftn_dest_network,
					});
					*/
					
					const localNetworkPattern = `${message.meta.FtnProperty.ftn_dest_network}/${message.meta.FtnProperty.ftn_dest_node}`;
					
					const localNetworkName = self.getNetworkNameByAddressPattern(localNetworkPattern);
					
					callback(_.isString(localNetworkName) ? null : new Error('Packet destination is not us'));
				},
				function basicSetup(callback) {
					message.areaTag = localAreaTag;
					
					//
					//	If duplicates are NOT allowed in the area (the default), we need to update
					//	the message UUID using data available to us. Duplicate UUIDs are internally
					//	not allowed in our local database.
	 				//
					if(!Config.messageNetworks.ftn.areas[localAreaTag].allowDupes) {
						if(self.messageHasValidMSGID(message)) {
							//	Update UUID with our preferred generation method
							message.uuid = ftnUtil.createMessageUuid(
								message.meta.FtnKludge.MSGID,
								message.meta.FtnProperty.ftn_area);
						} else {
							//	Update UUID with alternate/backup generation method
							message.uuid = ftnUtil.createMessageUuidAlternate(
								message.meta.FtnProperty.ftn_area, 
								message.modTimestamp,
								message.subject,
								message.message);
						}
					}
					
					callback(null);	
				},
				function setReplyToMessageId(callback) {
					self.setReplyToMsgIdFtnReplyKludge(message, () => {
						callback(null);
					});
				},
				function persistImport(callback) {
					message.persist(err => {
						callback(err);						
					});
				}
			], err => {
				cb(err);	
			}
		);
	};
	
	//
	//	Ref. implementations on import: 
	//	*	https://github.com/larsks/crashmail/blob/26e5374710c7868dab3d834be14bf4041041aae5/crashmail/pkt.c
	//		https://github.com/larsks/crashmail/blob/26e5374710c7868dab3d834be14bf4041041aae5/crashmail/handle.c
	//
	this.importMessagesFromPacketFile = function(packetPath, cb) {
		let packetHeader;
				
		new ftnMailPacket.Packet().read(packetPath, (entryType, entryData, next) => {
			if('header' === entryType) {
				packetHeader = entryData;
				
				const localNetworkName = self.getNetworkNameByAddress(packetHeader.destAddress);
				if(!_.isString(localNetworkName)) {
					next(new Error('No configuration for this packet'));
				} else {
					next(null);
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
						self.importNetMailToArea(localAreaTag, packetHeader, message, err => {
							if(err) {
								if('SQLITE_CONSTRAINT' === err.code) {
									Log.info(
										{ subject : message.subject, uuid : message.uuid }, 
										'Not importing non-unique message');
									
									return next(null);
								}
							}
															
							next(err);
						});
					} else {
						//
						//	No local area configured for this import
						//
						//	:TODO: Handle the "catch all" case, if configured 
					}
				} else {
					//
					//	NetMail
					//
				}
			}
		}, err => {
			cb(err);
		});
	};
	
	this.importPacketFilesFromDirectory = function(importDir, cb) {
		async.waterfall(
			[
				function getPacketFiles(callback) {
					fs.readdir(importDir, (err, files) => {
						if(err) {
							return callback(err);
						}
						callback(null, files.filter(f => '.pkt' === paths.extname(f)));
					});
				},
				function importPacketFiles(packetFiles, callback) {
					let rejects = [];
					async.each(packetFiles, (packetFile, nextFile) => {
						self.importMessagesFromPacketFile(paths.join(importDir, packetFile), err => {
							//	:TODO: check err -- log / track rejects, etc.
							if(err) {
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
						if(rejects.indexOf(packetFile) > -1) {
							//	:TODO: rename to .bad, perhaps move to a rejects dir + log
							nextFile();					
						} else {
							fs.unlink(fullPath, err => {
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
	
	this.importMessagesFromDirectory = function(inboundType, importDir, cb) {
		let tempDirectory;
		
		async.waterfall(
			[
				//	start with .pkt files
				function importPacketFiles(callback) {
					self.importPacketFilesFromDirectory(importDir, err => {
						callback(err);
					});
				},
				function discoverBundles(callback) {
					fs.readdir(importDir, (err, files) => {
						files = files.filter(f => '.pkt' !== paths.extname(f));
						
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
				function createTempDir(bundleFiles, callback) {
					temp.mkdir('enigftnimport-', (err, tempDir) => {
						tempDirectory = tempDir;
						callback(err, bundleFiles);
					});
				}, 
				function importBundles(bundleFiles, callback) {
					let rejects = [];
					
					async.each(bundleFiles, (bundleFile, nextFile) => {
						if(_.isUndefined(bundleFile.archName)) {
							Log.info( 
								{ fileName : bundleFile.path },
								'Unknown bundle archive type');
					
							rejects.push(bundleFile.path);
										
							return nextFile();	//	unknown archive type
						}
						
						self.archUtil.extractTo(
							bundleFile.path,
							tempDirectory,
							bundleFile.archName,
							err => {
								if(err) {									
									Log.info(
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
						self.importPacketFilesFromDirectory(tempDirectory, err => {
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
				if(tempDirectory) {
					temp.cleanup( (errIgnored, stats) => {
						Log.trace(
							Object.assign(stats, { tempDir : tempDirectory } ),
							'Temporary directory cleaned up'
						);
						
						cb(err);	//	orig err
					});
				} else {				
					cb(err);
				}
			}
		);
	};
}

require('util').inherits(FTNMessageScanTossModule, MessageScanTossModule);

FTNMessageScanTossModule.prototype.startup = function(cb) {
	Log.info('FidoNet Scanner/Tosser starting up');
	
	if(_.isObject(this.moduleConfig.schedule)) {
		const exportSchedule = this.parseScheduleString(this.moduleConfig.schedule.export);
		if(exportSchedule) {
			if(exportSchedule.sched) {
				let exporting = false;
				this.exportTimer = later.setInterval( () => {
					if(!exporting) {
						exporting = true;
						
						Log.info( { module : exports.moduleInfo.name }, 'Performing scheduled message scan/export...');
						
						this.performExport(err => {
							exporting = false;
						});
					}
				}, exportSchedule.sched);
			}
			
			if(exportSchedule.watchFile) {
				//	:TODO: monitor file for changes/existance with gaze
			}
		}
		
		const importSchedule = this.parseScheduleString(this.moduleConfig.schedule.import);
		if(importSchedule) {
			if(importSchedule.sched) {
				let importing = false;
				this.importTimer = later.setInterval( () => {
					if(!importing) {
						importing = true;
						
						Log.info( { module : exports.moduleInfo.name }, 'Performing scheduled message import/toss...');
						
						this.performImport(err => {
							importing = false;
						});
					}
				}, importSchedule.sched);
			}
		}
	}
	
	FTNMessageScanTossModule.super_.prototype.startup.call(this, cb);
};

FTNMessageScanTossModule.prototype.shutdown = function(cb) {
	Log.info('FidoNet Scanner/Tosser shutting down');
	
	if(this.exportTimer) {
		this.exportTimer.clear();
	}

	FTNMessageScanTossModule.super_.prototype.shutdown.call(this, cb);
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
	
	const getNewUuidsSql = 
		`SELECT message_id, message_uuid
		FROM message
		WHERE area_tag = ? AND message_id > ?
		ORDER BY message_id;`;
		
	var self = this;		
		
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
	//	:TODO: If @immediate, we should do something here!
};
