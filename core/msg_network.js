/* jslint node: true */
'use strict';

//	ENiGMA½
let loadModulesForCategory	= require('./module_util.js').loadModulesForCategory;

//	standard/deps
let async				= require('async');

exports.startup			= startup;
exports.shutdown		= shutdown;
exports.recordMessage	= recordMessage;

let msgNetworkModules = [];

function startup(cb) {
	async.series(
		[
			function loadModules(callback) {
				loadModulesForCategory('scannerTossers', (err, module) => {
					if(!err) {
						const modInst = new module.getModule();

						modInst.startup(err => {
							if(!err) {
								msgNetworkModules.push(modInst);
							}
						});
					}
				}, err => {
					callback(err);
				});
			}
		],
		cb
	);
}

function shutdown(cb) {
	async.each(
		msgNetworkModules, 
		(msgNetModule, next) => {
			msgNetModule.shutdown( () => {
				return next();
			});
		}, 
		() => {
			msgNetworkModules = [];
			return cb(null);
		}
	);	
}

function recordMessage(message, cb) {
	//
	//	Give all message network modules (scanner/tossers)
	//	a chance to do something with |message|. Any or all can
	//	choose to ignore it.
	//
	async.each(msgNetworkModules, (modInst, next) => {
		modInst.record(message);
		next();		
	}, err => {
		cb(err);
	});
}