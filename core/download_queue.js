/* jslint node: true */
'use strict';

const FileEntry	= require('./file_entry.js');

module.exports = class DownloadQueue {
	constructor(client) {
		this.client	= client;

		if(!Array.isArray(this.client.user.downloadQueue)) {
			this.loadFromProperty(client);
		}
	}

	toggle(fileEntry) {
		if(this.isQueued(fileEntry)) {
			this.client.user.downloadQueue = this.client.user.downloadQueue.filter(e => fileEntry.fileId !== e.fileId);
		} else {
			this.add(fileEntry);
		}
	}

	add(fileEntry) {
		this.client.user.downloadQueue.push({
			fileId		: fileEntry.fileId,
			areaTag		: fileEntry.areaTag,
			fileName	: fileEntry.fileName,
			byteSize	: fileEntry.meta.byteSize || 0,
		});
	}

	isQueued(entryOrId) {
		if(entryOrId instanceof FileEntry) {
			entryOrId = entryOrId.fileId;
		}

		return this.client.user.downloadQueue.find(e => entryOrId === e.fileId) ? true : false;
	}

	toProperty() { return JSON.stringify(this.client.user.downloadQueue); }
	
	loadFromProperty(prop) {
		try {
			this.client.user.downloadQueue = JSON.parse(prop);
		} catch(e) {
			this.client.user.downloadQueue = [];

			this.client.log.error( { error : e.message, property : prop }, 'Failed parsing download queue property'); 			
		}
	}	
};
