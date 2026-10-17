'use strict';

//
//  Booted-machine snapshots, one per door image and machine configuration.
//
//  The first session of a door warp-boots the emulator to the shim's ready
//  state and snapshots it there; every later session restores that snapshot
//  in a few tens of milliseconds instead of booting. On this core the hard
//  disk lives inside the snapshot, so a snapshot is only good for the image
//  file as it was when the machine booted:
//
//    * the key carries the image's mtime and size, so an image edited behind
//      our back (a sysop adding a door, xdftool) is never restored over;
//    * a session that persists changes into the image drops every snapshot of
//      that image (persistence Model A: the next session boots afresh).
//
//  Snapshots are LZ4, about 1.5 MB each, and are kept in SharedArrayBuffers so
//  that handing one to a worker shares it rather than copying it. The cache is
//  bounded; the least recently used entry goes first.
//
const paths = require('path');

const DefaultMaxEntries = 4;

//  What a snapshot depends on besides the image: the ROMs and the machine
const MachineKeys = ['rom', 'extRom', 'cpu', 'chipKb', 'slowKb', 'fastKb', 'overclock'];

class SnapshotCache {
    constructor({ maxEntries = DefaultMaxEntries } = {}) {
        this.maxEntries = maxEntries;
        this.entries = new Map(); //  key -> { image, snapshot, bytes, createdAt }; insertion order = LRU order
    }

    //
    //  |image| is the image path; |stat| its fs.Stats (mtimeMs, size); |machine|
    //  the door config (only MachineKeys are read). Paths are resolved so that
    //  two spellings of one file share an entry.
    //
    static keyFor(image, stat, machine = {}) {
        const key = {
            image: paths.resolve(image),
            mtimeMs: stat.mtimeMs,
            size: stat.size,
        };
        for (const k of MachineKeys) {
            let v = machine[k];
            if (('rom' === k || 'extRom' === k) && v) {
                v = paths.resolve(v);
            }
            key[k] = undefined === v ? null : v;
        }
        return JSON.stringify(key);
    }

    static imageOf(key) {
        return JSON.parse(key).image;
    }

    get size() {
        return this.entries.size;
    }

    //  The snapshot (a Uint8Array over a SharedArrayBuffer), or undefined.
    get(key) {
        const entry = this.entries.get(key);
        if (!entry) {
            return undefined;
        }
        //  most recently used goes to the back
        this.entries.delete(key);
        this.entries.set(key, entry);
        return entry.snapshot;
    }

    //  Store a copy of |bytes| (Buffer or Uint8Array). Returns the shared copy,
    //  or null when caching is off (maxEntries 0).
    set(key, bytes) {
        if (!(this.maxEntries > 0)) {
            return null;
        }

        const sab = new SharedArrayBuffer(bytes.length);
        const snapshot = new Uint8Array(sab);
        snapshot.set(bytes);

        this.entries.delete(key);
        this.entries.set(key, {
            image: SnapshotCache.imageOf(key),
            snapshot,
            bytes: bytes.length,
            createdAt: Date.now(),
        });

        this.trim();
        return snapshot;
    }

    trim() {
        const max = Math.max(0, this.maxEntries | 0);
        while (this.entries.size > max) {
            const oldest = this.entries.keys().next().value;
            this.entries.delete(oldest);
        }
    }

    //  Drop every snapshot of |image|; returns how many went.
    invalidateImage(image) {
        const resolved = paths.resolve(image);
        let removed = 0;
        for (const [key, entry] of this.entries) {
            if (entry.image === resolved) {
                this.entries.delete(key);
                ++removed;
            }
        }
        return removed;
    }

    clear() {
        this.entries.clear();
    }
}

module.exports = {
    SnapshotCache,
    DefaultMaxEntries,
};
