/* jslint node: true */
'use strict';

const FileEntry		= require('./file_entry.js');

//	deps
const { partition }	= require('lodash');

module.exports = class DownloadQueue {
	constructor(client) {
		this.client	= client;

		if(!Array.isArray(this.client.user.downloadQueue)) {
			if(this.client.user.properties.dl_queue) {
				this.loadFromProperty(this.client.user.properties.dl_queue);
			} else {
				this.client.user.downloadQueue = [];
			}
		}
	}

	get items() {
		return this.client.user.downloadQueue;
	}

	clear() {
		this.client.user.downloadQueue = [];
	}

	toggle(fileEntry, systemFile=false) {
		if(this.isQueued(fileEntry)) {
			this.client.user.downloadQueue = this.client.user.downloadQueue.filter(e => fileEntry.fileId !== e.fileId);
		} else {
			this.add(fileEntry, systemFile);
		}
	}

	add(fileEntry, systemFile=false) {
		this.client.user.downloadQueue.push({
			fileId		: fileEntry.fileId,
			areaTag		: fileEntry.areaTag,
			fileName	: fileEntry.fileName,
			path		: fileEntry.filePath,
			byteSize	: fileEntry.meta.byte_size || 0,
			systemFile	: systemFile,
		});
	}

	removeItems(fileIds) {
		if(!Array.isArray(fileIds)) {
			fileIds = [ fileIds ];
		}

		const [ remain, removed ] = partition(this.client.user.downloadQueue, e => ( -1 === fileIds.indexOf(e.fileId) ));
		this.client.user.downloadQueue = remain;
		return removed;
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
