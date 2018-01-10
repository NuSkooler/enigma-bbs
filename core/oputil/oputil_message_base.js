/* jslint node: true */
/* eslint-disable no-console */
'use strict';

const printUsageAndSetExitCode	= require('./oputil_common.js').printUsageAndSetExitCode;
const ExitCodes					= require('./oputil_common.js').ExitCodes;
const argv						= require('./oputil_common.js').argv;
const initConfigAndDatabases	= require('./oputil_common.js').initConfigAndDatabases;
const getHelpFor				= require('./oputil_help.js').getHelpFor;
const Address					= require('../ftn_address.js');
const Errors					= require('../enig_error.js').Errors;

//	deps
const async						= require('async');

exports.handleMessageBaseCommand	= handleMessageBaseCommand;

function areaFix() {
	//
	//	oputil mb areafix CMD1 CMD2 ... ADDR [--password PASS]
	//
	if(argv._.length < 3) {
		return printUsageAndSetExitCode(
			getHelpFor('MessageBase'),
			ExitCodes.ERROR
		);
	}

	async.waterfall(
		[
			function init(callback) {
				return initConfigAndDatabases(callback);
			},
			function validateAddress(callback) {
				const addrArg = argv._.slice(-1)[0];
				const ftnAddr = Address.fromString(addrArg);

				if(!ftnAddr) {
					return callback(Errors.Invalid(`"${addrArg}" is not a valid FTN address`));
				}

				//
				//	We need to validate the address targets a system we know unless
				//	the --force option is used
				//
				//	:TODO:
				return callback(null, ftnAddr);
			},
			function fetchFromUser(ftnAddr, callback) {
				//
				//	--from USER || +op from system
				//
				//	If possible, we want the user ID of the supplied user as well
				//
				const User = require('../user.js');

				if(argv.from) {
					User.getUserIdAndNameByLookup(argv.from, (err, userId, fromName) => {
						if(err) {
							return callback(null, ftnAddr, argv.from, 0);
						}

						//	fromName is the same as argv.from, but case may be differnet (yet correct)
						return callback(null, ftnAddr, fromName, userId);
					});
				} else {
					User.getUserName(User.RootUserID, (err, fromName) => {
						return callback(null, ftnAddr, fromName || 'SysOp', err ? 0 : User.RootUserID);
					});
				}
			},
			function createMessage(ftnAddr, fromName, fromUserId, callback) {
				//
				//	Build message as commands separated by line feed
				//
				//	We need to remove quotes from arguments. These are required
				//	in the case of e.g. removing an area: "-SOME_AREA" would end
				//	up confusing minimist, therefor they must be quoted: "'-SOME_AREA'"
				//
				const messageBody = argv._.slice(2, -1).map(arg => {
					return arg.replace(/["']/g, '');
				}).join('\r\n') + '\n';

				const Message = require('../message.js');

				const message = new Message({
					toUserName		: argv.to || 'AreaFix',
					fromUserName	: fromName,
					subject			: argv.password || '',
					message			: messageBody,
					areaTag			: Message.WellKnownAreaTags.Private,	//	mark private
					meta			: {
						FtnProperty : {
							[ Message.FtnPropertyNames.FtnDestZone ]	: ftnAddr.zone,
							[ Message.FtnPropertyNames.FtnDestNetwork ]	: ftnAddr.net,							
							[ Message.FtnPropertyNames.FtnDestNode ]	: ftnAddr.node,
						}
					}
				});

				if(ftnAddr.point) {
					message.meta.FtnProperty[Message.FtnPropertyNames.FtnDestPoint] = ftnAddr.point;
				}

				if(0 !== fromUserId) {
					message.setLocalFromUserId(fromUserId);
				}

				return callback(null, message);
			},
			function persistMessage(message, callback) {
				//	:TODO: Persist message in private outgoing (sysop out box) (TBD: implementation)
				message.persist(err => {
					if(!err) {
						console.log('AreaFix message persisted and will be exported at next scheduled scan');
					}
					return callback(err);
				});
			}
		],
		err => {
			if(err) {
				process.exitCode = ExitCodes.ERROR;
				console.error(`${err.message}${err.reason ? ': ' + err.reason : ''}`);
			}
		}
	);
}

function handleMessageBaseCommand() {

	function errUsage() {
		return printUsageAndSetExitCode(
			getHelpFor('MessageBase'),
			ExitCodes.ERROR
		);
	}

	if(true === argv.help) {
		return errUsage();
	}

	const action = argv._[1];

	return({
		areafix	: areaFix,
	}[action] || errUsage)();
}