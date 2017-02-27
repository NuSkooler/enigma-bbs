/* jslint node: true */
'use strict';

//	ENiGMA½
const Config				= require('./config.js').config;
const Errors				= require('./enig_error.js').Errors;
const Log					= require('./logger.js').log;

//	deps
const _						= require('lodash');
const nodeMailer			= require('nodemailer');

exports.sendMail			= sendMail;

function sendMail(message, cb) {
	if(!_.has(Config, 'email.transport')) {
		return cb(Errors.MissingConfig('Email "email::transport" configuration missing'));
	}

	message.from = message.from || Config.email.defaultFrom;

	const transportOptions = Object.assign( {}, Config.email.transport, {
		logger	: Log,
	});

	const transport = nodeMailer.createTransport(transportOptions);

	transport.sendMail(message, (err, info) => {
		return cb(err, info);
	});
}
