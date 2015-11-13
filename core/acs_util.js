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

	console.log(condArray)

	condArray.forEach(function cond(c) {
		if(acsParser.parse(c.acs, { client : client })) {
			return c[memberName];
		}
	});
}