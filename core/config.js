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

	//	Probably many better ways of doing this:
	//	:TODO: See http://jsfiddle.net/jlowery2663/z8at6knn/4/
	var recursiveMerge = function(target, source) {
		for(var p in source) {
			try {
				if(_.isObject(source)) {
					target[p] = recursiveMerge(target[p], source[p]);
				} else {
					target[p] = source[p];
				}
			} catch(e) {
				target[p] = source[p];
			}
		}
		return target;
	};

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
			function mergeWithDefaultConfig(menuConfig, callback) {
				var mergedConfig = recursiveMerge(menuConfig, getDefaultConfig());
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
		return paths.join(base, '.enigmabbs', 'config.json');
	}
}

function getDefaultConfig() {
	return {
		general : {
			boardName	: 'Another Fine ENiGMA½ BBS',
		},

		firstMenu	: 'connected',
		
		preLoginTheme : '*',

		//	:TODO: change to nua
		users : {
			usernameMin			: 2,
			usernameMax			: 22,
			usernamePattern		: '^[A-Za-z0-9~!@#$%^&*()\\-\\_+]+$',
			passwordMin			: 6,
			passwordMax			: 256,
			requireActivation	: true,	//	require SysOp activation?
			invalidUsernames	: [],
		},

		defaults : {
			theme			: 'NU-MAYA',	//	:TODO: allow "*" here
			passwordChar	: '*',		//	TODO: move to user ?
		},

		paths		: {
			mods				: paths.join(__dirname, './../mods/'),
			servers				: paths.join(__dirname, './servers/'),
			art					: paths.join(__dirname, './../mods/art/'),
			themes				: paths.join(__dirname, './../mods/art/themes/'),
			logs				: paths.join(__dirname, './../logs/'),	//	:TODO: set up based on system, e.g. /var/logs/enigmabbs or such
			db					: paths.join(__dirname, './../db/'),
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
	};
}
