/* jslint node: true */
'use strict';

//	ENiGMA½
const checkAcs	= require('./acs_parser.js').parse;
const Log		= require('./logger.js').log;

//	deps
const assert	= require('assert');
const _			= require('lodash');

class ACS {
	constructor(client) {
		this.client = client;
	}

	check(acs, scope, defaultAcs) {
		acs = acs ? acs[scope] : defaultAcs;
		acs = acs || defaultAcs;
		try {
			return checkAcs(acs, { client : this.client } );
		} catch(e) {
			Log.warn( { exception : e, acs : acs }, 'Exception caught checking ACS');
			return false;
		}
	}

	//
	//	Message Conferences & Areas
	//
	hasMessageConfRead(conf) {
		return this.check(conf.acs, 'read', ACS.Defaults.MessageConfRead);
	}

	hasMessageAreaRead(area) {
		return this.check(area.acs, 'read', ACS.Defaults.MessageAreaRead);
	}

	//
	//	File Base / Areas
	//
	hasFileAreaRead(area) {
		return this.check(area.acs, 'read', ACS.Defaults.FileAreaRead);
	}

	hasFileAreaWrite(area) {
		return this.check(area.acs, 'write', ACS.Defaults.FileAreaWrite);
	}

	hasFileAreaDownload(area) {
		return this.check(area.acs, 'download', ACS.Defaults.FileAreaDownload);
	}

	getConditionalValue(condArray, memberName) {
		assert(_.isArray(condArray));
		assert(_.isString(memberName));

		const matchCond = condArray.find( cond => {
			if(_.has(cond, 'acs')) {
				try {
					return checkAcs(cond.acs, { client : this.client } );
				} catch(e) {
					Log.warn( { exception : e, acs : cond }, 'Exception caught checking ACS');
					return false;
				}
			} else {
				return true;	//	no acs check req.
			}
		});

		if(matchCond) {
			return matchCond[memberName];
		}
	}
}

ACS.Defaults = {
	MessageAreaRead		: 'GM[users]',
	MessageConfRead		: 'GM[users]',

	FileAreaRead		: 'GM[users]',
	FileAreaWrite		: 'GM[sysops]',
	FileAreaDownload	: 'GM[users]',
};

module.exports = ACS;