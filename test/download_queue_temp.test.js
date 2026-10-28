'use strict';

const { strict: assert } = require('assert');

const Events = require('../core/events.js');

//
//  A temporary download (an offline mail packet, say) is removed when the
//  session that queued it ends. It was a once() listener per download, so
//  whichever client disconnected first used it up: another caller hanging up
//  left this one's file on disk for good.
//
describe('temporary session downloads', () => {
    let DownloadQueue;
    let FileEntry;
    let realRemoveEntry;
    let removed;

    //  required here, not at load: file_area_download_acs.test.js drops these
    //  modules from the cache, and the stub has to land on the FileEntry the
    //  queue actually holds
    before(() => {
        DownloadQueue = require('../core/download_queue.js');
        FileEntry = require('../core/file_entry.js');
        realRemoveEntry = FileEntry.removeEntry;
    });

    after(() => {
        FileEntry.removeEntry = realRemoveEntry;
    });

    beforeEach(() => {
        removed = [];
        FileEntry.removeEntry = (entry, options, cb) => {
            removed.push(entry.fileId);
            return cb(null);
        };
    });

    const disconnectListeners = () =>
        Events.listenerCount(Events.getSystemEvents().ClientDisconnected);

    const makeClient = uniqueId => ({
        session: { uniqueId },
        log: { info: () => {}, error: () => {} },
        user: { downloadQueue: [], properties: {} },
    });

    const entry = fileId => ({
        fileId,
        areaTag: 'system_temporary_download',
        fileName: `${fileId}.QWK`,
        filePath: `/tmp/${fileId}.QWK`,
        meta: { byte_size: 1 },
    });

    const disconnect = client =>
        Events.emit(Events.getSystemEvents().ClientDisconnected, { client });

    it('keeps a download until its own session ends', () => {
        const mine = makeClient('session-a');
        const other = makeClient('session-b');

        DownloadQueue.get(mine).addTemporaryDownload(entry(1));

        disconnect(other);
        assert.deepEqual(removed, [], "another session's hang-up removes nothing");

        disconnect(mine);
        assert.deepEqual(removed, [1]);
    });

    it('removes every download a session queued', () => {
        const client = makeClient('session-c');
        DownloadQueue.get(client).addTemporaryDownload(entry(2));
        DownloadQueue.get(client).addTemporaryDownload(entry(3));

        disconnect(client);
        assert.deepEqual(removed, [2, 3]);
    });

    //  one listener for every session and download, and none once all are done
    it('listens once, however many downloads are waiting, and stops after', () => {
        const baseline = disconnectListeners();
        const sessions = ['session-d', 'session-e', 'session-f'].map(makeClient);

        sessions.forEach((client, i) => {
            DownloadQueue.get(client).addTemporaryDownload(entry(10 + i));
            DownloadQueue.get(client).addTemporaryDownload(entry(20 + i));
        });
        assert.equal(disconnectListeners(), baseline + 1);

        sessions.forEach(disconnect);
        assert.equal(disconnectListeners(), baseline);
        assert.deepEqual(removed.sort(), [10, 11, 12, 20, 21, 22]);
    });
});
