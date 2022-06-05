/* jslint node: true */
/* eslint-disable no-console */
'use strict';

const ExitCodes = require('./oputil_common.js').ExitCodes;
const argv = require('./oputil_common.js').argv;
const printUsageAndSetExitCode = require('./oputil_common.js').printUsageAndSetExitCode;
const handleUserCommand = require('./oputil_user.js').handleUserCommand;
const handleFileBaseCommand = require('./oputil_file_base.js').handleFileBaseCommand;
const handleMessageBaseCommand =
    require('./oputil_message_base.js').handleMessageBaseCommand;
const handleConfigCommand = require('./oputil_config.js').handleConfigCommand;
const getHelpFor = require('./oputil_help.js').getHelpFor;

module.exports = function () {
    process.exitCode = ExitCodes.SUCCESS;

    if (true === argv.version) {
        return console.info(require('../../package.json').version);
    }

    if (0 === argv._.length || 'help' === argv._[0]) {
        return printUsageAndSetExitCode(getHelpFor('General'), ExitCodes.SUCCESS);
    }

    switch (argv._[0]) {
        case 'user':
            return handleUserCommand();
        case 'config':
            return handleConfigCommand();
        case 'fb':
            return handleFileBaseCommand();
        case 'mb':
            return handleMessageBaseCommand();
        default:
            return printUsageAndSetExitCode(getHelpFor('General'), ExitCodes.BAD_COMMAND);
    }
};
