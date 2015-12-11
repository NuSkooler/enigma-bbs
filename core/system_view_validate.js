var user				= require('./user.js');
var Config				= require('./config.js').config;


exports.validateUserNameAvail 	= validateUserNameAvail;
exports.validateEmailAvail		= validateEmailAvail;
exports.validateBirthdate		= validateBirthdate;
exports.validatePasswordSpec	= validatePasswordSpec;

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

function validateEmailAvail(data, cb) {
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
