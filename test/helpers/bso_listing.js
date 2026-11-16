'use strict';

//
//  What BsoSpool.getOutboundFilesForNode() has queued for |addr|, read the
//  way a session reads it: under the node's .bsy locks, which are released
//  again afterwards. For tests that only look at what is queued. A
//  disposeFn() on the result is refused (the lock is gone); tests that mark
//  lines hold the lock themselves.
//
async function listQueued(spool, addr) {
    const lock = spool.newLockSet();
    if (!(await spool.lockNode(addr, lock))) {
        throw new Error('listQueued: node is locked');
    }
    try {
        return await spool.getOutboundFilesForNode(addr, { lock });
    } finally {
        await lock.close();
    }
}

module.exports = { listQueued };
