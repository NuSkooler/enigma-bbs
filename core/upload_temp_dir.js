/* jslint node: true */
'use strict';

//
//  The receive directory of a file base upload, from the moment the upload
//  options page makes it until it is finished with.
//
//  An upload passes through protocol selection, the transfer, and a second
//  instance of the upload module: the options page makes the directory, the
//  transfer fills it, and the upload module -- re-entered with the directory
//  in |lastMenuResult| -- moves the files out. The caller can leave anywhere
//  along the way (cancel at protocol selection, give up after a failed
//  transfer, disconnect), so no single module can own the directory, and it
//  is tracked here instead, per client:
//
//  - create():   the options page makes it; the caller's previous one, if
//                any, is abandoned
//  - transferStarted() / transferFinished(): a transfer is writing into it,
//                and nothing removes it meanwhile
//  - claim():    the re-entered upload module takes it over, and removes it
//                once its files have been moved
//  - abandon():  the caller left the upload; it is removed now, or as soon
//                as a running transfer finishes
//  - disconnecting abandons it too
//
//  Each directory has a tracked temptmp session of its own: removing it can
//  never touch another node's upload, and only ever removes a directory made
//  here -- never a path that merely arrived in a menu's arguments.
//
//  Every function but create() is a no-op for a directory not made here.
//

const TempTmp = require('temptmp');
const paths = require('path');
const { randomUUID } = require('crypto');

exports.create = create;
exports.transferStarted = transferStarted;
exports.transferFinished = transferFinished;
exports.abandon = abandon;
exports.claim = claim;

//  resolved directory -> { client, session, dir, transferring, abandoned, released }
const uploads = new Map();

const log = () => require('./logger.js').log;

function keyOf(dir) {
    return paths.resolve(dir);
}

function lookup(client, dir) {
    if (!dir) {
        return;
    }
    const entry = uploads.get(keyOf(dir));
    return entry && entry.client === client ? entry : undefined;
}

function stopTracking(entry) {
    if (uploads.get(keyOf(entry.dir)) === entry) {
        uploads.delete(keyOf(entry.dir));
    }
    if (entry.onEnd && entry.client) {
        entry.client.removeListener('end', entry.onEnd);
        entry.onEnd = null;
    }
}

function release(entry) {
    if (entry.released) {
        return;
    }
    entry.released = true;
    stopTracking(entry);

    entry.session.cleanup(removed => {
        log().debug(
            { path: entry.dir, removed, sessionId: entry.session.sessionId },
            'Upload temp directory removed'
        );
    });
}

function abandonEntry(entry) {
    if (entry.transferring) {
        entry.abandoned = true; //  transferFinished() removes it
        return;
    }
    return release(entry);
}

//  cb(err, dir)
function create(client, cb) {
    //  one upload at a time per caller: a previous one was left behind
    [...uploads.values()]
        .filter(entry => entry.client === client)
        .forEach(entry => abandonEntry(entry));

    const session = TempTmp.createTrackedSession(`upload_${randomUUID()}`);
    session.mkdir({ prefix: 'enigul-' }, (err, dir) => {
        if (err) {
            session.cleanup();
            return cb(err);
        }

        const entry = {
            client,
            session,
            dir,
            transferring: false,
            abandoned: false,
            released: false,
        };

        if (client && 'function' === typeof client.once) {
            entry.onEnd = () => abandonEntry(entry);
            client.once('end', entry.onEnd);
        }

        uploads.set(keyOf(dir), entry);
        return cb(null, dir);
    });
}

function transferStarted(client, dir) {
    const entry = lookup(client, dir);
    if (entry) {
        entry.transferring = true;
    }
}

function transferFinished(client, dir) {
    const entry = lookup(client, dir);
    if (entry) {
        entry.transferring = false;
        if (entry.abandoned) {
            release(entry);
        }
    }
}

function abandon(client, dir) {
    const entry = lookup(client, dir);
    if (entry) {
        abandonEntry(entry);
    }
}

//
//  Returns { dir, release() } -- the caller now owns the directory, and
//  must release() it when done -- or null if |dir| was not made here for
//  this client.
//
function claim(client, dir) {
    const entry = lookup(client, dir);
    if (!entry) {
        return null;
    }
    stopTracking(entry);
    return { dir: entry.dir, release: () => release(entry) };
}
