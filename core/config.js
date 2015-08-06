/* jslint node: true */
'use strict';

var miscUtil			= require('./misc_util.js');

var fs					= require('fs');
var paths				= require('path');
var stripJsonComments	= require('strip-json-comments');
var async				= require('async');
var _					= require('lodash');

exports.init				= init;
exports.getDefaultPath		= getDefaultPath;

function init(configPath, cb) {
	async.waterfall(
		[
			function loadUserConfig(callback) {
		
				fs.readFile(configPath, { encoding : 'utf8' }, function configData(err, data) {
					if(err) {
						callback(null, { } );
					} else {
						try {
							var configJson = JSON.parse(stripJsonComments(data));
							callback(null, configJson);
						} catch(e) {
							callback(e);							
						}
					}
				});
			},
			function mergeWithDefaultConfig(configJson, callback) {
				var mergedConfig = _.defaultsDeep(configJson, getDefaultConfig());
				callback(null, mergedConfig);
			}
		],
		function complete(err, mergedConfig) {
			exports.config = mergedConfig;
			cb(err);
		}
	);
}

function getDefaultPath() {
	var base = miscUtil.resolvePath('~/');
	if(base) {
		return paths.join(base, '.enigma-bbs', 'config.json');
	}
}

function getDefaultConfig() {
	return {
		general : {
			boardName		: 'Another Fine ENiGMA½ BBS',
		},

		firstMenu	: 'connected',
		
		preLoginTheme : '*',

		users : {
			usernameMin			: 2,
			usernameMax			: 16,	//	Note that FidoNet wants 36 max
			usernamePattern		: '^[A-Za-z0-9~!@#$%^&*()\\-\\_+]+$',
			passwordMin			: 6,
			passwordMax			: 128,
			requireActivation	: true,	//	require SysOp activation?
			invalidUsernames	: [],
			defaultGroups		: [ 'users' ]
		},

		defaults : {
			theme			: 'NU-MAYA',	//	:TODO: allow "*" here
			passwordChar	: '*',		//	TODO: move to user ?
			dateFormat	: {
				short	: 'MM/DD/YYYY',
			},
			timeFormat : {
				short	: 'h:mm a',
			}
		},

		/*
		Concept
		"theme" : {
			"default" : "defaultThemeName", // or "*"
			"passwordChar" : "*",
			...
		}
		*/

		paths		: {
			mods				: paths.join(__dirname, './../mods/'),
			servers				: paths.join(__dirname, './servers/'),
			art					: paths.join(__dirname, './../mods/art/'),
			themes				: paths.join(__dirname, './../mods/themes/'),
			logs				: paths.join(__dirname, './../logs/'),	//	:TODO: set up based on system, e.g. /var/logs/enigmabbs or such
			db					: paths.join(__dirname, './../db/'),
			dropFiles			: paths.join(__dirname, './../dropfiles/'),	//	+ "/node<x>/
		},
		
		servers : {
			telnet : {
				port			: 8888,
				enabled			: true,
			},
			ssh : {
				port			: 8889,
				enabled			: true,
				rsaPrivateKey	: paths.join(__dirname, './../misc/default_key.rsa'),
				dsaPrivateKey	: paths.join(__dirname, './../misc/default_key.dsa'),
			}
		},

		networks : {
			/*
			networkName : {	//	e.g. fidoNet
				address : {
					zone	: 0,
					net		: 0,
					node	: 0,
					point 	: 0,
					domain	: 'l33t.codes'
				}
			}
			*/
		},

		misc : {
			idleLogoutSeconds	: 60 * 3,	//	3m
		},

		logging : {
			level	: 'debug'
		}
	};
}
