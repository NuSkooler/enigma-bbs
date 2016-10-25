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

function getPredefinedMCIValue(client, code) {

	if(!client || !code) {
		return;
	}

	try {
		return {
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
			UN	: function userName() { return client.user.username; },
			UI	: function userId() { return client.user.userId.toString(); },
			UG	: function groups() { return _.values(client.user.groups).join(', '); },
			UR	: function realName() { return client.user.properties.real_name; },
			LO	: function location() { return client.user.properties.location; },
			UA	: function age() { return client.user.getAge().toString(); },
			UB	: function birthdate() { return moment(client.user.properties.birthdate).format(client.currentTheme.helpers.getDateFormat()); },
			US	: function sex() { return client.user.properties.sex; },
			UE	: function emailAddres() { return client.user.properties.email_address; },
			UW	: function webAddress() { return client.user.properties.web_address; },
			UF	: function affils() { return client.user.properties.affiliation; },
			UT	: function themeId() { return client.user.properties.theme_id; },
			UC	: function loginCount() { return client.user.properties.login_count.toString(); },
			ND	: function connectedNode() { return client.node.toString(); },
			IP	: function clientIpAddress() { return client.address().address; },
			ST	: function serverName() { return client.session.serverName; },
			FN	: function activeFileBaseFilterName() {
				const activeFilter = FileBaseFilters.getActiveFilter(client);
				return activeFilter ? activeFilter.name : ''; 
			},

			MS	: function accountCreated() { return moment(client.user.properties.account_created).format(client.currentTheme.helpers.getDateFormat()); },
			CS	: function currentStatus() { return client.currentStatus; },
			PS	: function userPostCount() {
				const postCount = client.user.properties.post_count || 0; 
				return postCount.toString();
			},
			PC	: function userPostCallRatio() {
				const postCount = client.user.properties.post_count || 0;
				const callCount	= client.user.properties.login_count;
				const ratio		= ~~((postCount / callCount) * 100);
				return `${ratio}%`;
			},

			MD	: function currentMenuDescription() {
				return _.has(client, 'currentMenuModule.menuConfig.desc') ? client.currentMenuModule.menuConfig.desc : '';
			},

			MA	: function messageAreaName() {
				const area = getMessageAreaByTag(client.user.properties.message_area_tag);
				return area ? area.name : '';
			},
			MC  : function messageConfName() {
				const conf = getMessageConferenceByTag(client.user.properties.message_conf_tag);
				return conf ? conf.name : '';
			},
			ML  : function messageAreaDescription() {
				const area = getMessageAreaByTag(client.user.properties.message_area_tag);
				return area ? area.desc : '';
			},
			CM	: function messageConfDescription() {
				const conf = getMessageConferenceByTag(client.user.properties.message_conf_tag);
				return conf ? conf.desc : '';
			},

			SH	: function termHeight() { return client.term.termHeight.toString(); },
			SW	: function termWidth() { return client.term.termWidth.toString(); },

			//
			//	Date/Time
			//
			//	:TODO: change to CD for 'Current Date'
			DT	: function date() { return moment().format(client.currentTheme.helpers.getDateFormat()); },
			CT	: function time() { return moment().format(client.currentTheme.helpers.getTimeFormat()) ;},

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
				return os.cpus()[0].model.replace(/\(R\)|\(TM\)|processor|CPU/g, '')
					.replace(/\s+(?= )/g, '');
			},

			//	:TODO: MCI for core count, e.g. os.cpus().length

			//	:TODO: cpu load average (over N seconds): http://stackoverflow.com/questions/9565912/convert-the-output-of-os-cpus-in-node-js-to-percentage
			NV	: function nodeVersion() { return process.version; },

			AN	: function activeNodes() { return clientConnections.getActiveConnections().length.toString(); },

			TC	: function totalCalls() { return StatLog.getSystemStat('login_count').toString(); },

			RR	: function randomRumor() {
				//	start the process of picking another random one
				setNextRandomRumor();

				return StatLog.getSystemStat('random_rumor');
			},

			//
			//	Special handling for XY
			//
			XY	: function xyHack() { return; /* nothing */ },

		}[code]();	//	:TODO: Just call toString() here and remove above - DRY

	} catch(e) {
		//	Don't use client.log here as we may not have a client logger established yet!!
		Log.warn( { code : code, exception : e.message }, 'Exception caught attempting to construct predefined MCI value');
	}
}
