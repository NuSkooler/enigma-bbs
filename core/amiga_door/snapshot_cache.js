'use strict';

//
//  Booted-machine snapshots, one per door image and machine configuration.
//
//  The first session of a door warp-boots the emulator to the shim's ready
//  state and snapshots it there; every later session restores that snapshot
//  in a few tens of milliseconds instead of booting.
//
//  The door's disk is its image file (enigma-vamiga's file-backed disk): a
//  snapshot holds the image's path, not its blocks, and the restored machine
//  reopens the file as it is then. The guest's RAM in the snapshot holds its
//  file system's caches (bitmap, directories, buffers) as they were when the
//  snapshot was taken, so a snapshot is good only for the image exactly as it
//  was right after it was taken; restored over a file that changed since, the
//  guest would corrupt the volume at its next write. Hence:
//
//    * each entry carries |stat|, the image's size, mtime, inode and device
//      taken right after the snapshot (by the worker that made it), and
//      lookup() hands a snapshot out only while the image still matches; an
//      entry that does not is dropped. With the disk written as the door goes,
//      that is after every session that wrote anything;
//    * the key carries the image, the ROMs, the machine and the enigma-vamiga
//      version: a snapshot loads only into the core that made it.
//
//  Snapshots are LZ4, about 1.5 MB each, and are kept in SharedArrayBuffers so
//  that handing one to a worker shares it rather than copying it. The cache is
//  bounded; the least recently used entry goes first.
//
const fs = require('fs');
const paths = require('path');

//  The file itself, however it is spelled (symlinks, ..): the same key the
//  readers/writer hold uses. A path that does not resolve (no such file yet)
//  falls back to the absolute path.
function canonicalPath(p) {
    try {
        return fs.realpathSync(p);
    } catch (e) {
        return paths.resolve(p);
    }
}

const DefaultMaxEntries = 4;

//  What a snapshot depends on besides the image: the ROMs and the machine
const MachineKeys = ['rom', 'extRom', 'cpu', 'chipKb', 'slowKb', 'fastKb', 'overclock'];

class SnapshotCache {
    constructor({ maxEntries = DefaultMaxEntries } = {}) {
        this.maxEntries = maxEntries;
        this.entries = new Map(); //  key -> { image, snapshot, meta, stat, bytes, createdAt }; insertion order = LRU order
    }

    //
    //  |image| is the image path; |machine| the door config (only MachineKeys
    //  are read); |version| enigma-vamiga's. Paths are canonicalised (realpath) so
    //  that two spellings of one file share an entry.
    //
    static keyFor(image, machine = {}, version = null) {
        const key = {
            image: canonicalPath(image),
            vamiga: version || null,
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

    //  What lookup() compares: from an fs.Stats, or the plain object a worker
    //  posts (size, mtimeMs, ino, dev); null without one
    static imageStat(stat) {
        if (!stat) {
            return null;
        }
        return { size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino, dev: stat.dev };
    }

    static sameImage(a, b) {
        return (
            !!a &&
            !!b &&
            a.size === b.size &&
            a.mtimeMs === b.mtimeMs &&
            a.ino === b.ino &&
            a.dev === b.dev
        );
    }

    get size() {
        return this.entries.size;
    }

    //
    //  The entry for |key| if the image is still the file it was snapshotted
    //  with; |stat| is the image's stat now. Returns { snapshot, meta } (and
    //  counts as a use), { stale: true, was } after dropping an entry whose
    //  image has changed, or null when there is no entry.
    //
    lookup(key, stat) {
        const entry = this.entries.get(key);
        if (!entry) {
            return null;
        }
        if (!SnapshotCache.sameImage(entry.stat, SnapshotCache.imageStat(stat))) {
            this.entries.delete(key);
            return { stale: true, was: entry.stat };
        }
        this.get(key);
        return { snapshot: entry.snapshot, meta: entry.meta };
    }

    //  The snapshot (a Uint8Array over a SharedArrayBuffer), or undefined. No
    //  check against the image: sessions use lookup().
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

    //  What set() was given beside the snapshot ({} if nothing), or undefined.
    //  Does not count as a use.
    meta(key) {
        const entry = this.entries.get(key);
        return entry ? entry.meta : undefined;
    }

    //
    //  Store a copy of |bytes| (Buffer or Uint8Array) with |stat|, the image's
    //  stat taken right after the snapshot, and |meta|: facts about the machine
    //  the snapshot was taken from that the snapshot does not carry. Returns
    //  the shared copy, or null when caching is off (maxEntries 0) or there is
    //  no stat (a snapshot that cannot be checked against its image is never
    //  restored, so it is not kept).
    //
    set(key, bytes, meta = {}, stat = null) {
        const imageStat = SnapshotCache.imageStat(stat);
        if (!(this.maxEntries > 0) || !imageStat) {
            return null;
        }

        const sab = new SharedArrayBuffer(bytes.length);
        const snapshot = new Uint8Array(sab);
        snapshot.set(bytes);

        this.entries.delete(key);
        this.entries.set(key, {
            image: SnapshotCache.imageOf(key),
            snapshot,
            meta: Object.freeze(Object.assign({}, meta)),
            stat: Object.freeze(imageStat),
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

    //  Drop |key|'s entry (a snapshot the core refused); true if there was one.
    drop(key) {
        return this.entries.delete(key);
    }

    //  Drop every snapshot of |image|; returns how many went.
    invalidateImage(image) {
        const resolved = canonicalPath(image);
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
