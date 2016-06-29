/* jslint node: true */
'use strict';

var MenuModule		= require('../core/menu_module.js').MenuModule;
var sqlite3			= require('sqlite3');
var db			= require('../core/database.js');
var async = require('async');

exports.getModule	= BBSListSubmissionModule;

let moduleInfo = {
	name	: 'BBS List Submission',
	desc	: 'List of other BBSes (Submission Part)',
	author	: 'Andrew Pamment',
	packageName: 'com.magickabbs.enigma.bbslist'
};

exports.moduleInfo = moduleInfo;



function BBSListSubmissionModule(options) {
	MenuModule.call(this, options);

	let self = this;
	const database = new sqlite3.Database(db.getModDatabasePath(moduleInfo));

	this.menuMethods = {
		submitBBS : function(formData) {
			async.series(
				[
					function createDatabase(callback) {
						database.run(
							'CREATE TABLE IF NOT EXISTS bbses(' +
							'id INTEGER PRIMARY KEY AUTOINCREMENT,' +
							'bbsname TEXT,' +
							'sysop TEXT,' +
							'telnet TEXT,' +
							'www TEXT,' +
							'location TEXT,' +
							'software TEXT,' +
							'submitter INTEGER);',
							[],
							function done(err) {
								if (err) {
									callback('SQL Error');
								} else {
									callback(null);
								}
							}
						);
					},
					function addEntry(callback) {
						database.run(
							'INSERT INTO bbses (bbsname, sysop, telnet, www, location, software, submitter) VALUES(?, ?, ?, ?, ?, ?, ?)',
							[formData.value.name, formData.value.sysop, formData.value.telnet, formData.value.www, formData.value.location, formData.value.software, self.client.user.userId],
							function done(err) {
								if (err) {
									callback('SQL Error');
								} else {
									callback(null);
								}
							}
						);
					}
				],
				function complete(err) {
					if (err) {
						self.client.log.error( { error : err.toString() }, 'Error adding to BBS list');
					}
					self.prevMenu();
				}
			);
		}
	};
}

require('util').inherits(BBSListSubmissionModule, MenuModule);

BBSListSubmissionModule.prototype.mciReady = function(mciData, cb) {
	this.standardMCIReadyHandler(mciData, cb);
};
