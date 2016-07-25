var user				= require('./user.js');
var Config				= require('./config.js').config;

exports.validateNonEmpty		= validateNonEmpty;
exports.validateMessageSubject	= validateMessageSubject;
exports.validateUserNameAvail 	= validateUserNameAvail;
exports.validateUserNameExists	= validateUserNameExists;
exports.validateEmailAvail		= validateEmailAvail;
exports.validateBirthdate		= validateBirthdate;
exports.validatePasswordSpec	= validatePasswordSpec;

function validateNonEmpty(data, cb) {
	cb(data && data.length > 0 ? null : new Error('Field cannot be empty'));
}

function validateMessageSubject(data, cb) {
	cb(data && data.length > 1 ? null : new Error('Subject too short'));
}

function validateUserNameAvail(data, cb) {
	if(data.length < Config.users.usernameMin) {
		cb(new Error('Username too short'));
	} else if(data.length > Config.users.usernameMax) {
		//	generally should be unreached due to view restraints
		cb(new Error('Username too long'));
	} else {
		var usernameRegExp	= new RegExp(Config.users.usernamePattern);
		var invalidNames	= Config.users.newUserNames + Config.users.badUserNames;

		if(!usernameRegExp.test(data)) {
			cb(new Error('Username contains invalid characters'));
		} else if(invalidNames.indexOf(data.toLowerCase()) > -1) {
			cb(new Error('Username is blacklisted'));
		} else {
			user.getUserIdAndName(data, function userIdAndName(err) {
				if(!err) {	//	err is null if we succeeded -- meaning this user exists already
					cb(new Error('Userame unavailable'));
				} else {
					cb(null);
				}
			});
		}
	}
}

function validateUserNameExists(data, cb) {
	const invalidUserNameError = new Error('Invalid username');

	if(0 === data.length) {
		return cb(invalidUserNameError);
	}

	user.getUserIdAndName(data, (err) => {
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
	var emailRegExp = /[a-z0-9!#$%&'*+\/=?^_`{|}~.-]+@[a-z0-9-]+(.[a-z0-9-]+)*/;
	if(!emailRegExp.test(data)) {
		return cb(new Error('Invalid email address'));
	}

	user.getUserIdsWithProperty('email_address', data, function userIdsWithEmail(err, uids) {
		if(err) {
			cb(new Error('Internal system error'));
		} else if(uids.length > 0) {
			cb(new Error('Email address not unique'));
		} else {
			cb(null);
		}
	});
}


function validateBirthdate(data, cb) {
	//	:TODO: check for dates in the future, or > reasonable values
	cb(isNaN(Date.parse(data)) ? new Error('Invalid birthdate') : null);
}

function validatePasswordSpec(data, cb) {
	cb((!data || data.length < Config.users.passwordMin) ? new Error('Password too short') : null);
}
