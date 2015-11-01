/* jslint node: true */
'use strict';

var Config					= require('./config.js').config;
var Log						= require('./logger.js').log;
var getMessageAreaByName	= require('./message_area.js').getMessageAreaByName;
var clientConnections		= require('./client_connections.js');
var sysProp					= require('./system_property.js');

var packageJson 			= require('../package.json');
var assert					= require('assert');
var os						= require('os');
var _						= require('lodash');
var moment					= require('moment');

exports.getPredefinedMCIValue	= getPredefinedMCIValue;

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

			//	:TODO: SysOp username
			//	:TODO: SysOp real name
			

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

			MS	: function accountCreated() { return moment(client.user.properties.account_created).format(client.currentTheme.helpers.getDateFormat()); },
			CS	: function currentStatus() { return client.currentStatus; },
			
			MD	: function currentMenuDescription() {
				return _.has(client, 'currentMenuModule.menuConfig.desc') ? client.currentMenuModule.menuConfig.desc : '';
			},

			MA	: function messageAreaDescription() { 
				var area = getMessageAreaByName(client.user.properties.message_area_name);
				return area ? area.desc : '';
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
			SC		: function systemCpuModel() {
				//
				//	Clean up CPU strings a bit for better display
				//
				return os.cpus()[0].model.replace(/\s+(?= )|\(R\)|\(TM\)|processor|CPU/g, '');
			},

			//	:TODO: cpu load average (over N seconds): http://stackoverflow.com/questions/9565912/convert-the-output-of-os-cpus-in-node-js-to-percentage
			//	:TODO: Node version/info

			AN	: function activeNodes() { return clientConnections.getActiveConnections().toString(); },

			TC	: function totalCalls() { return sysProp.getSystemProperty('login_count').toString(); },
			
		}[code]();

	} catch(e) {
		//	Don't use client.log here as we may not have a client logger established yet!!
		Log.warn( { code : code, exception : e.message }, 'Exception caught attempting to construct predefined MCI value');
	}
}
