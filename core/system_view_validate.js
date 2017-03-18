/* jslint node: true */
'use strict';

//	ENiGMA½
const User		= require('./user.js');
const Config	= require('./config.js').config;
const Log		= require('./logger.js').log;

//	deps
const fs		= require('fs');

exports.validateNonEmpty		= validateNonEmpty;
exports.validateMessageSubject	= validateMessageSubject;
exports.validateUserNameAvail 	= validateUserNameAvail;
exports.validateUserNameExists	= validateUserNameExists;
exports.validateEmailAvail		= validateEmailAvail;
exports.validateBirthdate		= validateBirthdate;
exports.validatePasswordSpec	= validatePasswordSpec;

function validateNonEmpty(data, cb) {
	return cb(data && data.length > 0 ? null : new Error('Field cannot be empty'));
}

function validateMessageSubject(data, cb) {
	return cb(data && data.length > 1 ? null : new Error('Subject too short'));
}

function validateUserNameAvail(data, cb) {
	if(!data || data.length < Config.users.usernameMin) {
		cb(new Error('Username too short'));
	} else if(data.length > Config.users.usernameMax) {
		//	generally should be unreached due to view restraints
		return cb(new Error('Username too long'));
	} else {
		const usernameRegExp	= new RegExp(Config.users.usernamePattern);
		const invalidNames		= Config.users.newUserNames + Config.users.badUserNames;

		if(!usernameRegExp.test(data)) {
			return cb(new Error('Username contains invalid characters'));
		} else if(invalidNames.indexOf(data.toLowerCase()) > -1) {
			return cb(new Error('Username is blacklisted'));
		} else if(/^[0-9]+$/.test(data)) {
			return cb(new Error('Username cannot be a number'));
		} else {
			User.getUserIdAndName(data, function userIdAndName(err) {
				if(!err) {	//	err is null if we succeeded -- meaning this user exists already
					return cb(new Error('Username unavailable'));
				}
				
				return cb(null);
			});
		}
	}
}

function validateUserNameExists(data, cb) {
	const invalidUserNameError = new Error('Invalid username');

	if(0 === data.length) {
		return cb(invalidUserNameError);
	}

	User.getUserIdAndName(data, (err) => {
		return cb(err ? invalidUserNameError : null);
	});
}

function validateEmailAvail(data, cb) {
	//
	//	This particular method allows empty data - e.g. no email entered
	//	
	if(!data || 0 === data.length) {
		return cb(null);
	}

	//
	//	Otherwise, it must be a valid email. We'll be pretty lose here, like
	//	the HTML5 spec.
	//
	//	See http://stackoverflow.com/questions/7786058/find-the-regex-used-by-html5-forms-for-validation
	//
	const emailRegExp = /[a-z0-9!#$%&'*+\/=?^_`{|}~.-]+@[a-z0-9-]+(.[a-z0-9-]+)*/;
	if(!emailRegExp.test(data)) {
		return cb(new Error('Invalid email address'));
	}

	User.getUserIdsWithProperty('email_address', data, function userIdsWithEmail(err, uids) {
		if(err) {
			return cb(new Error('Internal system error'));
		} else if(uids.length > 0) {
			return cb(new Error('Email address not unique'));
		}
		
		return cb(null);		
	});
}


function validateBirthdate(data, cb) {
	//	:TODO: check for dates in the future, or > reasonable values
	return cb(isNaN(Date.parse(data)) ? new Error('Invalid birthdate') : null);
}

function validatePasswordSpec(data, cb) {
	if(!data || data.length < Config.users.passwordMin) {
		return cb(new Error('Password too short'));
	}

	//	check badpass, if avail
	fs.readFile(Config.users.badPassFile, 'utf8', (err, passwords) => {
		if(err) {
			Log.warn( { error : err.message }, 'Cannot read bad pass file');
			return cb(null);
		}

		passwords = passwords.toString().split(/\r\n|\n/g);
		if(passwords.includes(data)) {
			return cb(new Error('Password is too common'));
		}

		return cb(null);
	});
}
