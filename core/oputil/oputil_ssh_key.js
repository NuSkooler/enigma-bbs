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
const fs = require('graceful-fs');
const exec = require('child_process').exec;
const inq = require('inquirer');
const _ = require('lodash');


exports.handleSSHKeyCommand = handleSSHKeyCommand;

const ConfigIncludeKeys = [
    'loginServers.ssh',
    'loginServers.ssh.privateKeyPem',
];

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
            default: "",
            when: answers => answers.createNew,
        },
    ],
};

function execute(ui, command) {
    ui.log.write("Ping!");
    ui.log.write(command);
    exec(
        command,
        function (error, stdout, stderr) {
            ui.log.write(error);

            if (error) {
                const reason = error ? error.message : 'OpenSSL Error';
                logDebug(
                    {
                        reason: reason,
                        cmd: util.cmd,
                        args: args
                    },
                    `openssl command failed`
                );
            }
            else {
                ui.log.write("SSH Keys Generated")
            }
        }
    );
}

function createNew(cb) {
    const ui = new inq.ui.BottomBar();

    let sslPassword;

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
                    sslPassword = answers.password;
                    if (!sslPassword || sslPassword.replaceAll(" ", "") == "") {
                        ui.log.write('Password must be set.');

                        return callback('exit');
                    }
                    if (sslPassword.length < MINIMUM_PASSWORD_LENGTH) {
                        ui.log.write(`Password must be at least ${MINIMUM_PASSWORD_LENGTH} characters.`);

                        return callback('exit');
                    }

                    // Check if Keyfiles Exist
                    const sshKeyPath = "config/security/";
                    const sshKeyFilename = "ssh_private_key.pem";
                    const targetKeyFile = sshKeyPath + sshKeyFilename;

                    // Check if Keyfile Exists
                    if (fs.existsSync(targetKeyFile)) {
                        ui.log.write(`${targetKeyFile} already exists.`)

                        return callback('exit');
                    }

                    ui.log.write(`Creating SSH Key: ${targetKeyFile}`);

                    // Create Dir
                    if (!fs.existsSync(sshKeyPath)) {
                        ui.log.write(`Creating Directory: ${sshKeyPath}`);
                        exec(`mkdir -p ${sshKeyPath}`);
                    }

                    // Check if OpenSSL binary is installed
                    const binaryPath = "/usr/bin/openssl";
                    if (!fs.existsSync(binaryPath)) {
                        ui.log.write(`${binaryPath} was not found in your path`);

                        return callback('exit');
                    }

                    // Create SSH Keys
                    const command = `${binaryPath} genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -pkeyopt rsa_keygen_pubexp:65537 | openssl rsa -out ./${targetKeyFile} -aes128 -traditional -passout pass:`;
                    execute(ui, `${command}${sslPassword}`);
                });
            },
        ],
        err => {
            return cb(err, configPath, config);
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
