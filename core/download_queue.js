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

	get items() {
		return this.client.user.downloadQueue;
	}

	clear() {
		this.client.user.downloadQueue = [];
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
			path		: fileEntry.filePath,
			byteSize	: fileEntry.meta.byte_size || 0,
		});
	}

	removeItems(fileIds) {
		if(!Array.isArray(fileIds)) {
			fileIds = [ fileIds ];
		}

		this.client.user.downloadQueue = this.client.user.downloadQueue.filter(e => ( -1 === fileIds.indexOf(e.fileId) ) );
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
