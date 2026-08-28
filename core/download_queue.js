/* jslint node: true */
'use strict';

const FileEntry = require('./file_entry');
const UserProps = require('./user_property');
const Events = require('./events');
const { hasFileAreaDownloadAccess } = require('./file_base_area.js');

//  deps
const _ = require('lodash');

module.exports = class DownloadQueue {
    constructor(client) {
        this.client = client;

        if (!Array.isArray(this.client.user.downloadQueue)) {
            if (this.client.user.properties[UserProps.DownloadQueue]) {
                this.loadFromProperty(
                    this.client.user.properties[UserProps.DownloadQueue]
                );
            } else {
                this.client.user.downloadQueue = [];
            }
        }
    }

    static get(client) {
        return new DownloadQueue(client);
    }

    get items() {
        return this.client.user.downloadQueue;
    }

    clear() {
        this.client.user.downloadQueue = [];
    }

    //
    //  May the current user download |fileEntry|? Browsing an area ('read')
    //  and downloading from it ('download') are separate rights.
    //
    canDownload(fileEntry) {
        return hasFileAreaDownloadAccess(this.client, fileEntry.areaTag);
    }

    //  Returns true if the entry ended up queued, false if it was refused.
    toggle(fileEntry, systemFile = false) {
        if (this.isQueued(fileEntry)) {
            this.client.user.downloadQueue = this.client.user.downloadQueue.filter(
                e => fileEntry.fileId !== e.fileId
            );
            return false;
        }

        return this.add(fileEntry, systemFile);
    }

    //  Returns true if queued, false if the user has no download rights to the
    //  entry's area.
    add(fileEntry, systemFile = false) {
        if (!systemFile && !this.canDownload(fileEntry)) {
            this.client.log.info(
                { fileId: fileEntry.fileId, areaTag: fileEntry.areaTag },
                'Refusing to queue download; no download ACS for area'
            );
            return false;
        }

        this.client.user.downloadQueue.push({
            fileId: fileEntry.fileId,
            areaTag: fileEntry.areaTag,
            fileName: fileEntry.fileName,
            path: fileEntry.filePath,
            byteSize: fileEntry.meta.byte_size || 0,
            systemFile: systemFile,
        });

        return true;
    }

    //
    //  Queues persist in a user property across sessions, so an item queued
    //  while permitted can outlive the permission. Filter at the point of
    //  actually sending or generating links, not just at queue time.
    //
    get allowedItems() {
        return this.items.filter(
            item =>
                item.systemFile || hasFileAreaDownloadAccess(this.client, item.areaTag)
        );
    }

    removeItems(fileIds) {
        if (!Array.isArray(fileIds)) {
            fileIds = [fileIds];
        }

        const [remain, removed] = _.partition(
            this.client.user.downloadQueue,
            e => -1 === fileIds.indexOf(e.fileId)
        );
        this.client.user.downloadQueue = remain;
        return removed;
    }

    isQueued(entryOrId) {
        if (entryOrId instanceof FileEntry) {
            entryOrId = entryOrId.fileId;
        }

        return this.client.user.downloadQueue.find(e => entryOrId === e.fileId)
            ? true
            : false;
    }

    toProperty() {
        return JSON.stringify(this.client.user.downloadQueue);
    }

    loadFromProperty(prop) {
        try {
            this.client.user.downloadQueue = JSON.parse(prop);
        } catch (e) {
            this.client.user.downloadQueue = [];

            this.client.log.error(
                { error: e.message, property: prop },
                'Failed parsing download queue property'
            );
        }
    }

    addTemporaryDownload(entry) {
        this.add(entry, true); //  true=systemFile

        //  clean up after ourselves when the session ends
        const thisUniqueId = this.client.session.uniqueId;
        Events.once(Events.getSystemEvents().ClientDisconnected, evt => {
            if (thisUniqueId === _.get(evt, 'client.session.uniqueId')) {
                FileEntry.removeEntry(entry, { removePhysFile: true }, err => {
                    const Log = require('./logger').log;
                    if (err) {
                        Log.warn(
                            { fileId: entry.fileId, path: entry.filePath },
                            'Failed removing temporary session download'
                        );
                    } else {
                        Log.debug(
                            { fileId: entry.fileId, path: entry.filePath },
                            'Removed temporary session download item'
                        );
                    }
                });
            }
        });
    }
};
