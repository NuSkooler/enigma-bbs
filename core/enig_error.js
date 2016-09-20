/* jslint node: true */
'use strict';

class EnigError extends Error {
	constructor(message, code, reason, reasonCode) {
		super(message);

		this.name		= this.constructor.name;
		this.message	= message;
		this.code		= code;
		this.reason		= reason;
		this.reasonCode	= reasonCode;

		if(typeof Error.captureStackTrace === 'function') {
			Error.captureStackTrace(this, this.constructor);
		} else {
			this.stack = (new Error(message)).stack; 
		}
	}
}

class EnigMenuError extends EnigError { }

exports.EnigError				= EnigError;
exports.EnigMenuError			= EnigMenuError;

exports.Errors = {
	General				: (reason, reasonCode) 	=> new EnigError('An error occurred', -33000, reason, reasonCode),
	MenuStack			: (reason, reasonCode)	=> new EnigMenuError('Menu stack error', -33001, reason, reasonCode),
};
