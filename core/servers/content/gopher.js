/* jslint node: true */
'use strict';

//	ENiGMA½
const Log					= require('../../logger.js').log;
const { ServerModule }		= require('../../server_module.js');
const Config				= require('../../config.js').config;
const {
	splitTextAtTerms,
	isAnsi,
	cleanControlCodes
}							= require('../../string_util.js');
const {
	getMessageConferenceByTag,
	getMessageAreaByTag,
	getMessageListForArea,
}							= require('../../message_area.js');
const { sortAreasOrConfs }	= require('../../conf_area_util.js');
const AnsiPrep				= require('../../ansi_prep.js');

//	deps
const net					= require('net');
const _						= require('lodash');
const fs					= require('graceful-fs');
const paths					= require('path');
const moment				= require('moment');

const ModuleInfo = exports.moduleInfo = {
	name		: 'Gopher',
	desc		: 'Gopher Server',
	author		: 'NuSkooler',
	packageName	: 'codes.l33t.enigma.gopher.server',
};

const Message				= require('../../message.js');

const ItemTypes = {
	Invalid				: '',	//	not really a type, of course!

	//	Canonical, RFC-1436
	TextFile			: '0',
	SubMenu				: '1',
	CCSONameserver		: '2',
	Error				: '3',
	BinHexFile			: '4',
	DOSFile				: '5',
	UuEncodedFile		: '6',
	FullTextSearch		: '7',
	Telnet				: '8',
	BinaryFile			: '9',
	AltServer			: '+',
	GIFFile				: 'g',
	ImageFile			: 'I',
	Telnet3270			: 'T',

	//	Non-canonical
	HtmlFile			: 'h',
	InfoMessage			: 'i',
	SoundFile			: 's',
};

exports.getModule = class GopherModule extends ServerModule {

	constructor() {
		super();

		this.routes = new Map();	//	selector->generator => gopher item
	}

	createServer() {
		if(!this.enabled) {
			return;
		}

		this.publicHostname = Config.contentServers.gopher.publicHostname;
		this.publicPort		= Config.contentServers.gopher.publicPort;

		this.addRoute(/^\/?\r\n$/, this.defaultGenerator);
		this.addRoute(/^\/msgarea(\/[a-z0-9_-]+(\/[a-z0-9_-]+)?(\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(_raw)?)?)?\/?\r\n$/, this.messageAreaGenerator);

		this.server = net.createServer( socket => {
			socket.setEncoding('ascii');

			socket.on('data', data => {
				this.routeRequest(data, socket);
			});

			socket.on('error', err => {
				if('ECONNRESET' !== err.code) {	//	normal
					Log.trace( { error : err.message }, 'Socket error');
				}
			});
		});
	}

	listen() {
		if(!this.enabled) {
			return true;	//	nothing to do, but not an error
		}

		const port = parseInt(Config.contentServers.gopher.port);
		if(isNaN(port)) {
			Log.warn( { port : Config.contentServers.gopher.port, server : ModuleInfo.name }, 'Invalid port' );
			return false;
		}

		return this.server.listen(port);
	}

	get enabled() {
		return _.get(Config, 'contentServers.gopher.enabled', false) && this.isConfigured();
	}

	isConfigured() {
		//	public hostname & port must be set; responses contain them!
		return _.isString(_.get(Config, 'contentServers.gopher.publicHostname')) &&
			_.isNumber(_.get(Config, 'contentServers.gopher.publicPort'));
	}

	addRoute(selectorRegExp, generatorHandler) {
		if(_.isString(selectorRegExp)) {
			try {
				selectorRegExp = new RegExp(`${selectorRegExp}\r\n`);
			} catch(e) {
				Log.warn( { pattern : selectorRegExp }, 'Invalid RegExp for selector' );
				return false;
			}
		}
		this.routes.set(selectorRegExp, generatorHandler.bind(this));
	}

	routeRequest(selector, socket) {
		let generator;
		let match;
		for(let [regex, gen] of this.routes) {
			match = selector.match(regex);
			if(match) {
				generator = gen;
				break;
			}
		}
		generator = generator || this.notFoundGenerator;
		generator(match, res => {
			socket.end(`${res}.\r\n`);	//	includes RFC-1436 'Lastline'
		});
	}

	makeItem(itemType, text, selector, hostname, port) {
		selector = selector || '';	//	e.g. for info
		hostname = hostname || this.publicHostname;
		port = port || this.publicPort;
		return `${itemType}${text}\t${selector}\t${hostname}\t${port}\r\n`;
	}

	defaultGenerator(selectorMatch, cb) {
		let bannerFile = _.get(Config, 'contentServers.gopher.banner', 'startup_banner.asc');
		bannerFile = paths.isAbsolute(bannerFile) ? bannerFile : paths.join(__dirname, '../../../misc', bannerFile);
		fs.readFile(bannerFile, 'utf8', (err, banner) => {
			if(err) {
				return cb('You have reached an ENiGMA½ Gopher server!');
			}

			banner = splitTextAtTerms(banner).map(l => this.makeItem(ItemTypes.InfoMessage, l)).join('');
			banner += this.makeItem(ItemTypes.SubMenu, 'Public Message Area', '/msgarea');
			return cb(banner);
		});
	}

	notFoundGenerator(selectorMatch, cb) {
		return cb('Not found');
	}

	isAreaAndConfExposed(confTag, areaTag) {
		const conf = _.get(Config, [ 'contentServers', 'gopher', 'messageConferences', confTag ]);
		return Array.isArray(conf) && conf.includes(areaTag);
	}

	prepareMessageBody(body, cb) {
		if(isAnsi(body)) {
			AnsiPrep(
				body,
				{
					cols			: 79,				//	Gopher std. wants 70, but we'll have to deal with it.
					forceLineTerm	: true,				//	ensure each line is term'd
					asciiMode		: true,				//	export to ASCII
					fillLines		: false,			//	don't fill up to |cols|
				},
				(err, prepped) => {
					return cb(prepped || body);
				}
			);
		} else {
			return cb(cleanControlCodes(body, { all : true } ));
		}
	}

	messageAreaGenerator(selectorMatch, cb) {
		//
		//	Selector should be:
		//	/msgarea - list confs
		//	/msgarea/conftag - list areas in conf
		//	/msgarea/conftag/areatag - list messages in area
		//	/msgarea/conftag/areatag/<num> - message as text
		//	/msgarea/conftag/areatag/<num>_raw - full message as text + headers
		//
		if(selectorMatch[3] || selectorMatch[4]) {
			//	message
			//const raw = selectorMatch[4] ? true : false;
			//	:TODO: support 'raw'
			const msgUuid	= selectorMatch[3].replace(/\r\n|\//g, '');
			const confTag	= selectorMatch[1].substr(1).split('/')[0];
			const areaTag	= selectorMatch[2].replace(/\r\n|\//g, '');
			const message 	= new Message();

			return message.load( { uuid : msgUuid }, err => {
				if(err) {
					return this.notFoundGenerator(selectorMatch, cb);
				}

				if(message.areaTag !== areaTag || !this.isAreaAndConfExposed(confTag, areaTag)) {
					return this.notFoundGenerator(selectorMatch, cb);
				}

				this.prepareMessageBody(message.message, msgBody => {
					//	:TODO: create DRY for subject trimming...
					const response = `${'-'.repeat(70)}
To     : ${message.toUserName}
From   : ${message.fromUserName}
When   : ${moment(message.modTimestamp).format('dddd, MMMM Do YYYY, h:mm:ss a (UTCZ)')}
Subject: ${message.subject}
ID     : ${message.messageUuid} (${message.messageId})
${'-'.repeat(70)}
${msgBody}
	`;
					return cb(response);
				});
			});
		} else if(selectorMatch[2]) {
			//	list messages in area
			const confTag	= selectorMatch[1].substr(1).split('/')[0];
			const areaTag	= selectorMatch[2].replace(/\r\n|\//g, '');
			const area		= getMessageAreaByTag(areaTag);

			if(Message.isPrivateAreaTag(areaTag)) {
				return cb(this.makeItem(ItemTypes.InfoMessage, 'Area is private'));
			}

			if(!area || !this.isAreaAndConfExposed(confTag, areaTag)) {
				return this.notFoundGenerator(selectorMatch, cb);
			}

			return getMessageListForArea(null, areaTag, (err, msgList) => {
				const response = [
					this.makeItem(ItemTypes.InfoMessage, '-'.repeat(70)),
					this.makeItem(ItemTypes.InfoMessage, `Messages in ${area.name}`),
					this.makeItem(ItemTypes.InfoMessage, '-'.repeat(70)),
					...msgList.map(msg => this.makeItem(
						ItemTypes.TextFile,
						//	:TODO: reasonably trim string
						`${moment(msg.modTimestamp).format('YYYY-MM-DD hh:mma')}  ${msg.subject} (${msg.fromUserName} to ${msg.toUserName})`,
						`/msgarea/${confTag}/${areaTag}/${msg.messageUuid}`
					))
				].join('');

				return cb(response);
			});
		} else if(selectorMatch[1]) {
			//	list areas in conf
			const confTag	= selectorMatch[1].replace(/\r\n|\//g, '');
			const conf		= _.get(Config, [ 'contentServers', 'gopher', 'messageConferences', confTag ]) && getMessageConferenceByTag(confTag);
			if(!conf) {
				return this.notFoundGenerator(selectorMatch, cb);
			}

			const areas = _.get(Config, [ 'contentServers', 'gopher', 'messageConferences', confTag ], {})
				.map(areaTag => Object.assign( { areaTag }, getMessageAreaByTag(areaTag)))
				.filter(area => area && !Message.isPrivateAreaTag(area.areaTag));

			if(0 === areas.length) {
				return cb(this.makeIItem(ItemTypes.InfoMessage, 'No message areas available'));
			}

			sortAreasOrConfs(areas);

			const response = [
				this.makeItem(ItemTypes.InfoMessage, '-'.repeat(70)),
				this.makeItem(ItemTypes.InfoMessage, `Message areas in ${conf.name}`),
				this.makeItem(ItemTypes.InfoMessage, '-'.repeat(70)),
				...areas.map(area => this.makeItem(ItemTypes.SubMenu, area.name, `/msgarea/${confTag}/${area.areaTag}`))
			].join('');

			return cb(response);
		} else {
			//	message area base (list confs)
			const confs = Object.keys(_.get(Config, 'contentServers.gopher.messageConferences', {}))
				.map(confTag => Object.assign( { confTag }, getMessageConferenceByTag(confTag)))
				.filter(conf => conf);	//	remove any baddies

			if(0 === confs.length) {
				return cb(this.makeItem(ItemTypes.InfoMessage, 'No message conferences available'));
			}

			sortAreasOrConfs(confs);

			const response = [
				this.makeItem(ItemTypes.InfoMessage, '-'.repeat(70)),
				this.makeItem(ItemTypes.InfoMessage, 'Available Message Conferences'),
				this.makeItem(ItemTypes.InfoMessage, '-'.repeat(70)),
				this.makeItem(ItemTypes.InfoMessage, ''),
				...confs.map(conf => this.makeItem(ItemTypes.SubMenu, conf.name, `/msgarea/${conf.confTag}`))
			].join('');

			return cb(response);
		}
	}
};