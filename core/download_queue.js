/* jslint node: true */
'use strict';

const FileEntry	= require('./file_entry.js');

module.exports = class DownloadQueue {
	constructor(user) {
		this.user = user;

		this.user.downloadQueue = this.user.downloadQueue || [];
	}

	toggle(fileEntry) {
		if(this.isQueued(fileEntry)) {
			this.user.downloadQueue = this.user.downloadQueue.filter(e => fileEntry.fileId !== e.fileId);
		} else {
			this.add(fileEntry);
		}
	}

	add(fileEntry) {
		this.user.downloadQueue.push({
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

		return this.user.downloadQueue.find(e => entryOrId === e.fileId) ? true : false;
	}

	toProperty() { return JSON.stringify(this.user.downloadQueue); }
	
	loadFromProperty(prop) {
		try {
			this.user.downloadQueue = JSON.parse(prop);
		} catch(e) {
			this.user.log.error( { error : e.message, property : prop }, 'Failed parsing download queue property'); 			
		}
	}	
};
