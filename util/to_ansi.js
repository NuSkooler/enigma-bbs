#!/usr/bin/env node

/* jslint node: true */
/* eslint-disable no-console */
'use strict';

const { controlCodesToAnsi } = require('../core/color_codes.js');

const fs = require('graceful-fs');
const iconv = require('iconv-lite');

const ToolVersion = '1.0.0';

function main() {
    const argv = (exports.argv = require('minimist')(process.argv.slice(2), {
        alias: {
            h: 'help',
            v: 'version',
        },
    }));

    if (argv.version) {
        console.info(ToolVersion);
        return 0;
    }

    if (0 === argv._.length || argv.help) {
        console.info('usage: to_ansi.js [--version] [--help] PATH');
        return 0;
    }

    const path = argv._[0];

    fs.readFile(path, (err, data) => {
        if (err) {
            console.error(err.message);
            return -1;
        }

        data = iconv.decode(data, 'cp437');
        console.info(controlCodesToAnsi(data));
        return 0;
    });
}

main();
