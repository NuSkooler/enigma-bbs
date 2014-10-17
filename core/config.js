/* jslint node: true */
'use strict';

var fs			= require('fs');
var paths		= require('path');
var miscUtil	= require('./misc_util.js');

module.exports = {
	config			: undefined,

	defaultPath		: function() {
		var base = miscUtil.resolvePath('~/');
		if(base) {
			return paths.join(base, '.enigmabbs', 'config.json');
		}
	},

	initFromFile	: function(path, cb) {
		var data	= fs.readFileSync(path, 'utf8');
		this.config = JSON.parse(data);
	},

	createDefault	: function() {
		this.config = {
			bbsName		: 'Another Fine ENiGMA½ BBS',

			entryMod	: 'connect',

			paths		: {
				mods				: paths.join(__dirname, './../mods/'),
				servers				: paths.join(__dirname, './servers/'),
				art					: paths.join(__dirname, './../mods/art/'),
				logs				: paths.join(__dirname, './../logs/'),	//	:TODO: set up based on system, e.g. /var/logs/enigmabbs or such
			},
			
			servers : {
				telnet : {
					port			: 8888,
					enabled			: true,
				},
				ssh : {
					port			: 8889,
					enabled			: false,
					rsaPrivateKey	: paths.join(__dirname, './../misc/default_key.rsa'),
					dsaPrivateKey	: paths.join(__dirname, './../misc/default_key.dsa'),
				}
			},
		};
	}
};