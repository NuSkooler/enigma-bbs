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

	condArray.forEach(function cond(c) {
		if(acsParser.parse( { client : client }, c.acs)) {
			return c[memberName];
		}
	});
}