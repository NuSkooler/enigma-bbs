/* jslint node: true */
'use strict';

function bbs_list_entry() {
	this.name = '';
	this.sysop = '';
	this.telnet = '';
	this.www = '';
	this.location = '';
	this.software = '';
	this.submitter = 0;
	this.id = -1;
}

module.exports = bbs_list_entry;
