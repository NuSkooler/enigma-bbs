#!/usr/bin/env node

/* jslint node: true */
/* eslint-disable no-console */
'use strict';

//	:TODO: Make this it's own sep tool/repo

const exiftool		= require('exiftool');
const fs			= require('fs');

function main() {
	const path = process.argv[2];

	fs.readFile(path, (err, data) => {
		if(err) {
			return -1;
		}

		exiftool.metadata(data, (err, metadata) => {
			if(err) {
				return -1;
			}

			switch(metadata.fileType) {
				case 'AIFF' : 
				case 'APE' : 
				case 'FLAC' : 
				case 'OGG' : 
				case 'MP3' :
					console.log(`${metadata.artist||'Unknown Artist'} - ${metadata.title||'Unknown'} (${metadata.audioBitrate})`);
					break;

				case 'PDF' :				
					console.log(`${metadata.author||'Unknown Author'} - ${metadata.title||'Unknown'}`);
					break;
				
				default :
					return -1;
			}

			return 0;
		});
	});
}

return main();