#!/usr/bin/env node

/* jslint node: true */
/* eslint-disable no-console */
'use strict';

//	:TODO: Make this it's own sep tool/repo

const exiftool		= require('exiftool');
const fs			= require('fs');
const moment		= require('moment');

const TOOL_VERSION	= '1.0.0.0';

//	map fileTypes -> handlers
const FILETYPE_HANDLERS = {};
[ 'AIFF', 'APE', 'FLAC', 'OGG', 'MP3' ].forEach(ext => FILETYPE_HANDLERS[ext] = audioFile);
[ 'PDF', 'DOC', 'DOCX', 'DOCM', 'ODB', 'ODC', 'ODF', 'ODG', 'ODI', 'ODP', 'ODS', 'ODT' ].forEach(ext => FILETYPE_HANDLERS[ext] = documentFile);
[ 'PNG', 'JPEG', 'GIF', 'WEBP', 'XCF' ].forEach(ext => FILETYPE_HANDLERS[ext] = imageFile);

function audioFile(metadata) {
	let desc = `${metadata.artist||'Unknown Artist'} - ${metadata.title||'Unknown'} (`;
	if(metadata.year) {
		desc += `${metadata.year}, `;
	}
	desc += `${metadata.audioBitrate})`;
	return desc;
}

function documentFile(metadata) {
	let desc = `${metadata.author||'Unknown Author'} - ${metadata.title||'Unknown'}`;
	const created = moment(metadata.createdate);
	if(created.isValid()) {
		desc += ` (${created.format('YYYY')})`;
	}
	return desc;
}

function imageFile(metadata) {
	let desc = `${metadata.fileType} image (`;
	if(metadata.animationIterations) {
		desc += 'Animated, ';
	}
	desc += `${metadata.imageSize}px`;
	const created = moment(metadata.createdate);
	if(created.isValid()) {
		desc += `, ${created.format('YYYY')})`;
	} else {
		desc += ')';
	}
	return desc;
}

function main() {
	const argv = exports.argv = require('minimist')(process.argv.slice(2), {
		alias : {
			h		: 'help',
			v		: 'version',			
		}
	});

	if(argv.version) {
		console.info(TOOL_VERSION);
		return 0;
	}

	if(0 === argv._.length || argv.help) {
		console.info('usage: exiftool2desc.js [--version] [--help] PATH');
		return 0;
	}

	const path = argv._[0];

	fs.readFile(path, (err, data) => {
		if(err) {
			return -1;
		}

		exiftool.metadata(data, (err, metadata) => {
			if(err) {
				return -1;				
			}

			const handler = FILETYPE_HANDLERS[metadata.fileType];
			if(!handler) {
				return -1;
			}
			
			console.info(handler(metadata));
			return 0;
		});
	});
}

return main();