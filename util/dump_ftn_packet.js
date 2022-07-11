#!/usr/bin/env node

/* jslint node: true */
/* eslint-disable no-console */
'use strict';

const { Packet } = require('../core/ftn_mail_packet.js');

const argv = require('minimist')(process.argv.slice(2));

function main() {
    if (0 === argv._.length) {
        console.error('usage: dump_ftn_packet.js PATH');
        process.exitCode = -1;
        return;
    }

    const packet = new Packet();
    const packetPath = argv._[0];

    packet.read(
        packetPath,
        (dataType, data, next) => {
            if ('header' === dataType) {
                console.info('--- header ---');
                console.info(
                    `Created   : ${data.created.format('dddd, MMMM Do YYYY, h:mm:ss a')}`
                );
                console.info(`Dst. Addr : ${data.destAddress.toString()}`);
                console.info(`Src. Addr : ${data.origAddress.toString()}`);
                console.info('--- raw header ---');
                console.info(data);
                console.info('--------------');
                console.info('');
            } else if ('message' === dataType) {
                console.info('--- message ---');
                console.info(`To        : ${data.toUserName}`);
                console.info(`From      : ${data.fromUserName}`);
                console.info(`Subject   : ${data.subject}`);
                console.info('--- raw message ---');
                console.info(data);
                console.info('---------------');
            }

            return next(null);
        },
        err => {
            if (err) {
                return console.error(`Error processing packet: ${err.message}`);
            }
            console.info('');
            console.info('--- EOF --- ');
            console.info('');
        }
    );
}

main();
