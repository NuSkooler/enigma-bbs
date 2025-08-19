/* jslint node: true */
/* eslint-disable no-console */
'use strict';

//	ENiGMA½
const initConfigAndDatabases = require('./oputil_common.js').initConfigAndDatabases;

const {
    printUsageAndSetExitCode,
    argv,
    ExitCodes,
    getAnswers,
} = require('./oputil_common.js');
const getHelpFor = require('./oputil_help.js').getHelpFor;

//	deps
const async = require('async');
const fs = require('fs-extra');
const exec = require('child_process').exec;
const inq = require('inquirer');

exports.handleSSHKeyCommand = handleSSHKeyCommand;

const MINIMUM_PASSWORD_LENGTH = 8;

const QUESTIONS = {
    Create: [
        {
            name: 'createNew',
            message: 'Generate New SSH Keys?',
            type: 'confirm',
            default: false,
        },
        {
            name: 'password',
            message: 'SSL Password:',
            default: '',
            when: answers => answers.createNew,
        },
    ],
};

function execute(ui, command) {
    exec(command, function (error) {
        ui.log.write(error);

        if (error) {
            const reason = error ? error.message : 'OpenSSL Error';
            ui.log.write(`openssl command failed: ${reason}`);
        } else {
            ui.log.write('SSH Keys Generated');
        }
    });
}

function createNew(cb) {
    const ui = new inq.ui.BottomBar();

    async.waterfall(
        [
            function init(callback) {
                return initConfigAndDatabases(callback);
            },
            function create(configuration, callback) {
                getAnswers(QUESTIONS.Create, answers => {
                    if (!answers.createNew) {
                        return callback('exit');
                    }

                    // Get Answer Value
                    const sslPassword = answers.password.trim();
                    if (!sslPassword || sslPassword == '') {
                        ui.log.write('Password must be set.');

                        return callback('exit');
                    }
                    if (sslPassword.length < MINIMUM_PASSWORD_LENGTH) {
                        ui.log.write(
                            `Password must be at least ${MINIMUM_PASSWORD_LENGTH} characters.`
                        );

                        return callback('exit');
                    }

                    // Check if Keyfiles Exist
                    const sshKeyPath = 'config/security/';
                    const sshKeyFilename = 'ssh_private_key.pem';
                    const targetKeyFile = sshKeyPath + sshKeyFilename;

                    ui.log.write(`Creating SSH Key: ${targetKeyFile}`);

                    // Create Dir
                    ui.log.write(`Creating Directory: ${sshKeyPath}`);
                    fs.ensureDirSync(sshKeyPath);

                    // Create SSH Keys
                    const command = `openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -pkeyopt rsa_keygen_pubexp:65537 | openssl rsa -out ./${targetKeyFile} -aes128 -traditional -passout pass:`;
                    execute(ui, `${command}${sslPassword}`);
                });
            },
        ],
        err => {
            return cb(err);
        }
    );
}

function handleSSHKeyCommand() {
    if (true === argv.help) {
        return printUsageAndSetExitCode(getHelpFor('SSH'), ExitCodes.ERROR);
    }

    const action = argv._[1];

    switch (action) {
        case 'create':
            return createNew();

        default:
            return printUsageAndSetExitCode(getHelpFor('SSH'), ExitCodes.ERROR);
    }
}
