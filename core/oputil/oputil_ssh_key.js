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
const { spawn } = require('child_process');
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

function generateSSHKey(ui, targetKeyFile, passphrase, cb) {
    //  Pipe: openssl genpkey ... | openssl rsa -passout ...
    //  The passphrase is passed as an argument to execFile/spawn, never via a shell
    //  string, to prevent command injection.
    const genpkey = spawn('openssl', [
        'genpkey',
        '-algorithm',
        'RSA',
        '-pkeyopt',
        'rsa_keygen_bits:2048',
        '-pkeyopt',
        'rsa_keygen_pubexp:65537',
    ]);

    const rsa = spawn('openssl', [
        'rsa',
        '-out',
        `./${targetKeyFile}`,
        '-aes128',
        '-traditional',
        '-passout',
        `pass:${passphrase}`,
    ]);

    genpkey.stdout.pipe(rsa.stdin);

    let errOutput = '';
    genpkey.stderr.on('data', d => {
        errOutput += d;
    });
    rsa.stderr.on('data', d => {
        errOutput += d;
    });

    genpkey.on('error', err => cb(err));
    rsa.on('error', err => cb(err));

    rsa.on('close', code => {
        if (code !== 0) {
            return cb(new Error(`openssl failed (exit ${code}): ${errOutput.trim()}`));
        }
        ui.log.write('SSH Keys Generated');
        return cb(null);
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
                    generateSSHKey(ui, targetKeyFile, sslPassword, callback);
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
