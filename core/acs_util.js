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
		return acsParser.parse(cond.acs, { client : client } );
	});
	
	if(matchCond) {
		return matchCond[memberName];
	}
}