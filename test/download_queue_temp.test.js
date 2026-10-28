'use strict';

const { strict: assert } = require('assert');

const Events = require('../core/events.js');
const { clientConnections } = require('../core/client_connections.js');

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

    //
    //  Other suites drop file_entry.js from the require cache, so the queue
    //  loaded earlier may hold a FileEntry that is no longer the cached one.
    //  It is loaded afresh here, against the cached FileEntry the stub goes
    //  on, and the earlier copy put back afterwards.
    //
    const queuePath = require.resolve('../core/download_queue.js');
    let cachedQueue;

    before(() => {
        cachedQueue = require.cache[queuePath];
        delete require.cache[queuePath];
        FileEntry = require('../core/file_entry.js');
        DownloadQueue = require('../core/download_queue.js');
        realRemoveEntry = FileEntry.removeEntry;
    });

    after(() => {
        FileEntry.removeEntry = realRemoveEntry;
        if (cachedQueue) {
            require.cache[queuePath] = cachedQueue;
        } else {
            delete require.cache[queuePath];
        }
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

    //  connected, as removeClient() will find it
    const makeClient = uniqueId => {
        const client = {
            session: { uniqueId },
            log: { info: () => {}, error: () => {} },
            user: { downloadQueue: [], properties: {} },
        };
        clientConnections.push(client);
        return client;
    };

    const entry = fileId => ({
        fileId,
        areaTag: 'system_temporary_download',
        fileName: `${fileId}.QWK`,
        filePath: `/tmp/${fileId}.QWK`,
        meta: { byte_size: 1 },
    });

    //  as removeClient() does it: gone from the list, then the event
    const disconnect = client => {
        const i = clientConnections.indexOf(client);
        if (i > -1) {
            clientConnections.splice(i, 1);
        }
        Events.emit(Events.getSystemEvents().ClientDisconnected, { client });
    };

    //
    //  A caller who hangs up while their packet is built has had their
    //  ClientDisconnected before the packet is queued, so nothing would ever
    //  remove it.
    //
    it('removes at once a download queued after its session ended', () => {
        const baseline = disconnectListeners();
        const client = makeClient('session-gone');
        disconnect(client);

        DownloadQueue.get(client).addTemporaryDownload(entry(99));
        assert.deepEqual(removed, [99]);
        assert.equal(disconnectListeners(), baseline, 'nothing waits for it');
        assert.deepEqual(client.user.downloadQueue, [], 'and it is not queued');
    });

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
