/* jslint node: true */
'use strict';

//	ENiGMA½
const Config							= require('./config.js').config;
const Log								= require('./logger.js').log;
const getMessageAreaByTag				= require('./message_area.js').getMessageAreaByTag;
const getMessageConferenceByTag			= require('./message_area.js').getMessageConferenceByTag;
const clientConnections					= require('./client_connections.js');
const StatLog							= require('./stat_log.js');
const FileBaseFilters					= require('./file_base_filter.js');
const formatByteSize					= require('./string_util.js').formatByteSize;

//	deps
const packageJson 			= require('../package.json');
const os					= require('os');
const _						= require('lodash');
const moment				= require('moment');

exports.getPredefinedMCIValue	= getPredefinedMCIValue;
exports.init					= init;

function init(cb) {
	setNextRandomRumor(cb);
}

function setNextRandomRumor(cb) {
	StatLog.getSystemLogEntries('system_rumorz', StatLog.Order.Random, 1, (err, entry) => {
		if(entry) {
			entry = entry[0];
		}
		const randRumor = entry && entry.log_value ? entry.log_value : '';
		StatLog.setNonPeristentSystemStat('random_rumor', randRumor);
		if(cb) {
			return cb(null);
		}
	});
}

function getUserRatio(client, propA, propB) {
	const a = StatLog.getUserStatNum(client.user, propA);
	const b	= StatLog.getUserStatNum(client.user, propB);
	const ratio	= ~~((a / b) * 100);
	return `${ratio}%`;
}

function userStatAsString(client, statName, defaultValue) {
	return (StatLog.getUserStat(client.user, statName) || defaultValue).toLocaleString();
}

function sysStatAsString(statName, defaultValue) {
	return (StatLog.getSystemStat(statName) || defaultValue).toLocaleString();
}

const PREDEFINED_MCI_GENERATORS = {
	//
	//	Board
	//
	BN	: function boardName() { return Config.general.boardName; },

	//	ENiGMA
	VL	: function versionLabel() { return 'ENiGMA½ v' + packageJson.version; },
	VN	: function version() { return packageJson.version; },

	//	+op info
	SN	: function opUserName() { return StatLog.getSystemStat('sysop_username'); },
	SR	: function opRealName() { return StatLog.getSystemStat('sysop_real_name'); },
	SL	: function opLocation() { return StatLog.getSystemStat('sysop_location'); },
	SA	: function opAffils() { return StatLog.getSystemStat('sysop_affiliation'); },
	SS	: function opSex() { return StatLog.getSystemStat('sysop_sex'); },
	SE	: function opEmail() { return StatLog.getSystemStat('sysop_email_address'); },
	//	:TODO: op age, web, ?????

	//
	//	Current user / session
	//
	UN	: function userName(client) { return client.user.username; },
	UI	: function userId(client) { return client.user.userId.toString(); },
	UG	: function groups(client) { return _.values(client.user.groups).join(', '); },
	UR	: function realName(client) { return userStatAsString(client, 'real_name', ''); },
	LO	: function location(client) { return userStatAsString(client, 'location', ''); },
	UA	: function age(client) { return client.user.getAge().toString(); },
	BD	: function birthdate(client) { return moment(client.user.properties.birthdate).format(client.currentTheme.helpers.getDateFormat()); },	//	iNiQUiTY
	US	: function sex(client) { return userStatAsString(client, 'sex', ''); },
	UE	: function emailAddres(client) { return userStatAsString(client, 'email_address', ''); },
	UW	: function webAddress(client) { return userStatAsString(client, 'web_address', ''); },
	UF	: function affils(client) { return userStatAsString(client, 'affiliation', ''); },
	UT	: function themeId(client) { return userStatAsString(client, 'theme_id', ''); },
	UC	: function loginCount(client) { return userStatAsString(client, 'login_count', 0); },
	ND	: function connectedNode(client) { return client.node.toString(); },
	IP	: function clientIpAddress(client) { return client.remoteAddress.replace(/^::ffff:/, ''); },	//	convert any :ffff: IPv4's to 32bit version
	ST	: function serverName(client) { return client.session.serverName; },
	FN	: function activeFileBaseFilterName(client) {
		const activeFilter = FileBaseFilters.getActiveFilter(client);
		return activeFilter ? activeFilter.name : ''; 
	},
	DN	: function userNumDownloads(client) { return userStatAsString(client, 'dl_total_count', 0); },		//	Obv/2
	DK	: function userByteDownload(client) {	//	Obv/2 uses DK=downloaded Kbytes
		const byteSize = StatLog.getUserStatNum(client.user, 'dl_total_bytes');
		return formatByteSize(byteSize, true);	//	true=withAbbr
	},
	UP	: function userNumUploads(client) { return userStatAsString(client, 'ul_total_count', 0); },			//	Obv/2
	UK	: function userByteUpload(client) { //	Obv/2 uses UK=uploaded Kbytes
		const byteSize = StatLog.getUserStatNum(client.user, 'ul_total_bytes');
		return formatByteSize(byteSize, true);	//	true=withAbbr
	},
	NR	: function userUpDownRatio(client) {	//	Obv/2
		return getUserRatio(client, 'ul_total_count', 'dl_total_count');
	},
	KR	: function userUpDownByteRatio(client) {	//	Obv/2 uses KR=upload/download Kbyte ratio
		return getUserRatio(client, 'ul_total_bytes', 'dl_total_bytes');
	},

	MS	: function accountCreatedclient(client) { return moment(client.user.properties.account_created).format(client.currentTheme.helpers.getDateFormat()); },
	PS	: function userPostCount(client) { return userStatAsString(client, 'post_count', 0); },
	PC	: function userPostCallRatio(client) { return getUserRatio(client, 'post_count', 'login_count'); },

	MD	: function currentMenuDescription(client) {
		return _.has(client, 'currentMenuModule.menuConfig.desc') ? client.currentMenuModule.menuConfig.desc : '';
	},

	MA	: function messageAreaName(client) {
		const area = getMessageAreaByTag(client.user.properties.message_area_tag);
		return area ? area.name : '';
	},
	MC  : function messageConfName(client) {
		const conf = getMessageConferenceByTag(client.user.properties.message_conf_tag);
		return conf ? conf.name : '';
	},
	ML  : function messageAreaDescription(client) {
		const area = getMessageAreaByTag(client.user.properties.message_area_tag);
		return area ? area.desc : '';
	},
	CM	: function messageConfDescription(client) {
		const conf = getMessageConferenceByTag(client.user.properties.message_conf_tag);
		return conf ? conf.desc : '';
	},

	SH	: function termHeight(client) { return client.term.termHeight.toString(); },
	SW	: function termWidth(client) { return client.term.termWidth.toString(); },

	//
	//	Date/Time
	//
	//	:TODO: change to CD for 'Current Date'
	DT	: function date(client) { return moment().format(client.currentTheme.helpers.getDateFormat()); },
	CT	: function time(client) { return moment().format(client.currentTheme.helpers.getTimeFormat()) ;},

	//
	//	OS/System Info
	//
	OS	: function operatingSystem() {
		return {
			linux	: 'Linux',
			darwin	: 'Mac OS X',
			win32	: 'Windows',
			sunos	: 'SunOS',
			freebsd	: 'FreeBSD',
		}[os.platform()] || os.type();
	},

	OA	: function systemArchitecture() { return os.arch(); },
	
	SC	: function systemCpuModel() {
		//
		//	Clean up CPU strings a bit for better display
		//
		return os.cpus()[0].model
			.replace(/\(R\)|\(TM\)|processor|CPU/g, '')
			.replace(/\s+(?= )/g, '');
	},

	//	:TODO: MCI for core count, e.g. os.cpus().length

	//	:TODO: cpu load average (over N seconds): http://stackoverflow.com/questions/9565912/convert-the-output-of-os-cpus-in-node-js-to-percentage
	NV	: function nodeVersion() { return process.version; },

	AN	: function activeNodes() { return clientConnections.getActiveConnections().length.toString(); },

	TC	: function totalCalls() { return StatLog.getSystemStat('login_count').toLocaleString(); },

	RR	: function randomRumor() {
		//	start the process of picking another random one
		setNextRandomRumor();

		return StatLog.getSystemStat('random_rumor');
	},

	//
	//	System File Base, Up/Download Info
	//
	//	:TODO: DD - Today's # of downloads (iNiQUiTY)
	//	
	SD	: function systemNumDownloads() { return sysStatAsString('dl_total_count', 0); },
	SO	: function systemByteDownload() {
		const byteSize = StatLog.getSystemStatNum('dl_total_bytes');
		return formatByteSize(byteSize, true);	//	true=withAbbr
	},
	SU	: function systemNumUploads() { return sysStatAsString('ul_total_count', 0); },
	SP	: function systemByteUpload() {
		const byteSize = StatLog.getSystemStatNum('ul_total_bytes');
		return formatByteSize(byteSize, true);	//	true=withAbbr
	},
	TF	: function totalFilesOnSystem() {
		const areaStats = StatLog.getSystemStat('file_base_area_stats');
		return _.get(areaStats, 'totalFiles', 0).toLocaleString();
	},
	TB	: function totalBytesOnSystem() {
		const areaStats		= StatLog.getSystemStat('file_base_area_stats');
		const totalBytes	= parseInt(_.get(areaStats, 'totalBytes', 0));
		return formatByteSize(totalBytes, true);	//	true=withAbbr
	},

	//	:TODO: PT - Messages posted *today* (Obv/2)
	//		-> Include FTN/etc.
	//	:TODO: NT - New users today (Obv/2)
	//	:TODO: CT - Calls *today* (Obv/2)
	//	:TODO: FT - Files uploaded/added *today* (Obv/2)
	//	:TODO: DD - Files downloaded *today* (iNiQUiTY)
	//	:TODO: TP - total message/posts on the system (Obv/2)
	//		-> Include FTN/etc.
	//	:TODO: LC - name of last caller to system (Obv/2)
	//	:TODO: TZ - Average *system* post/call ratio (iNiQUiTY)
	

	//
	//	Special handling for XY
	//
	XY	: function xyHack() { return; /* nothing */ },
};

function getPredefinedMCIValue(client, code) {

	if(!client || !code) {
		return;
	}

	const generator = PREDEFINED_MCI_GENERATORS[code];

	if(generator) {
		let value;
		try {
			value = generator(client);
		} catch(e) {
			Log.error( { code : code, exception : e.message }, 'Exception caught generating predefined MCI value' );
		}

		return value;
	}
}
