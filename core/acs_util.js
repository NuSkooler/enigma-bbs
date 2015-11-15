/* jslint node: true */
'use strict';

//	ENiGMA½
var acsParser	= require('./acs_parser.js');

var _			= require('lodash');
var assert		= require('assert');

exports.getConditionalValue			= getConditionalValue;

function getConditionalValue(client, condArray, memberName) {
	assert(_.isObject(client));
	assert(_.isArray(condArray));
	assert(_.isString(memberName));

	var matchCond = _.find(condArray, function cmp(cond) {
		return _.has(cond, 'acs') && acsParser.parse(cond.acs, { client : client } );
	});

	//
	//	If no matchCond, look for a default entry. That is,
	//	a entry without a 'acs' string.
	//
	if(!matchCond) {
		matchCond = _.find(condArray, function cmp(cond) {
			return !_.has(cond, 'acs');
		});
	}
	
	if(matchCond) {
		return matchCond[memberName];
	}
}