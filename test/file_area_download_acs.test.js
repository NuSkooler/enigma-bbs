'use strict';

//
//  The 'download' file-area ACS was honoured by the REST API and by nothing
//  else: a sysop who restricted downloads saw it silently ignored over telnet
//  and SSH. 'read' (browse) and 'download' are separate rights, and an area
//  that lets everyone look while restricting who may pull bytes down is a
//  perfectly ordinary configuration.
//

const { strict: assert } = require('assert');
const moment = require('moment');

const configModule = require('../core/config.js');
const ACS = require('../core/acs.js');

// ── fixtures ──────────────────────────────────────────────────────────────────

const TEST_CONFIG = {
    debug: { assertsEnabled: false },
    menus: { cls: false },
    fileBase: {
        storageTags: { tag: '/tmp/enigma-test-files' },
        areas: {
            //  no acs block at all -> ACS.Defaults (download: GM[users])
            open_area: { name: 'Open', storageTags: ['tag'] },

            //  browsable by any user, downloadable only by donors
            donors_only: {
                name: 'Donors',
                storageTags: ['tag'],
                acs: { read: 'GM[users]', download: 'GM[donors]' },
            },
        },
    },
};

function makeUser(groups) {
    const props = {
        account_status: 0,
        login_count: 10,
        account_created: moment().subtract(90, 'days').format(),
    };
    return {
        userId: 42,
        username: 'testuser',
        authFactor: 1,
        groups,
        properties: {},
        downloadQueue: [],
        isGroupMember(name) {
            return this.groups.includes(name);
        },
        getAge() {
            return 25;
        },
        getProperty(name) {
            return props[name];
        },
        getPropertyAsNumber(name) {
            const v = props[name];
            return typeof v === 'number' ? v : parseInt(v, 10) || 0;
        },
    };
}

function makeClient(groups) {
    const user = makeUser(groups);
    const client = {
        node: 1,
        user,
        session: { isSecure: false },
        term: {
            termHeight: 25,
            termWidth: 80,
            termType: 'ansi',
            outputEncoding: 'cp437',
        },
        currentTheme: { name: 'luciano_blocktronics' },
        isLocal() {
            return false;
        },
        log: { warn() {}, info() {}, debug() {}, error() {} },
    };
    client.acs = new ACS({ client, user });
    return client;
}

//
//  A real FileEntry, not a lookalike: DownloadQueue.isQueued() keys off
//  `instanceof FileEntry` to decide whether it was handed an entry or a bare
//  fileId, so a plain object silently never matches. It must come from the
//  same reloaded module instance the queue sees, hence |mods|.
//
//  |filePath| is a derived getter off storageTag/relPath; the storage tag in
//  TEST_CONFIG resolves it without touching disk.
//
function entry(mods, areaTag, fileId = 1) {
    return new mods.FileEntry({
        fileId,
        areaTag,
        storageTag: 'tag',
        fileName: `file${fileId}.zip`,
        meta: { byte_size: 1024 },
    });
}

//
//  file_base_area.js captures Config at first require, so the test config has
//  to be installed before it (and download_queue, which pulls it in) loads.
//
const RELOAD = [
    '../core/file_entry.js',
    '../core/file_base_area.js',
    '../core/download_queue.js',
];

function loadModules() {
    const previous = configModule._pushTestConfig(TEST_CONFIG);
    RELOAD.forEach(m => delete require.cache[require.resolve(m)]);
    return {
        FileEntry: require('../core/file_entry.js'),
        FileArea: require('../core/file_base_area.js'),
        DownloadQueue: require('../core/download_queue.js'),
        restore: () => {
            configModule._popTestConfig(previous);
            RELOAD.forEach(m => delete require.cache[require.resolve(m)]);
        },
    };
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('file area download ACS', () => {
    let mods;

    beforeEach(() => {
        mods = loadModules();
    });

    afterEach(() => {
        mods.restore();
    });

    describe('hasFileAreaDownloadAccess()', () => {
        it('allows an area with no ACS block (defaults to GM[users])', () => {
            const client = makeClient(['users']);
            assert.equal(
                mods.FileArea.hasFileAreaDownloadAccess(client, 'open_area'),
                true
            );
        });

        it('denies a restricted area to a user who may still browse it', () => {
            const client = makeClient(['users']);

            //  the point of the whole fix: read yes, download no
            assert.equal(
                client.acs.hasFileAreaRead(mods.FileArea.getFileAreaByTag('donors_only')),
                true
            );
            assert.equal(
                mods.FileArea.hasFileAreaDownloadAccess(client, 'donors_only'),
                false
            );
        });

        it('allows a restricted area to a user in the right group', () => {
            const client = makeClient(['users', 'donors']);
            assert.equal(
                mods.FileArea.hasFileAreaDownloadAccess(client, 'donors_only'),
                true
            );
        });

        //  Temporary session downloads (QWK packets, FSE attachments) are
        //  generated for the user on request and carry no ACS of their own.
        it('allows internal areas regardless of ACS', () => {
            const client = makeClient([]);
            assert.equal(
                mods.FileArea.hasFileAreaDownloadAccess(
                    client,
                    'system_temporary_download'
                ),
                true
            );
            assert.equal(
                mods.FileArea.hasFileAreaDownloadAccess(
                    client,
                    'system_message_attachment'
                ),
                true
            );
        });

        it('fails closed for an area that is no longer configured', () => {
            const client = makeClient(['users', 'donors', 'sysops']);
            assert.equal(
                mods.FileArea.hasFileAreaDownloadAccess(client, 'removed_area'),
                false
            );
        });
    });

    describe('DownloadQueue', () => {
        it('queues a file the user may download', () => {
            const client = makeClient(['users']);
            const dlQueue = new mods.DownloadQueue(client);

            assert.equal(dlQueue.add(entry(mods, 'open_area')), true);
            assert.equal(dlQueue.items.length, 1);
        });

        it('refuses a file the user may browse but not download', () => {
            const client = makeClient(['users']);
            const dlQueue = new mods.DownloadQueue(client);

            assert.equal(dlQueue.add(entry(mods, 'donors_only')), false);
            assert.equal(dlQueue.items.length, 0);
        });

        it('refuses via toggle() as well as add()', () => {
            const client = makeClient(['users']);
            const dlQueue = new mods.DownloadQueue(client);

            assert.equal(dlQueue.toggle(entry(mods, 'donors_only')), false);
            assert.equal(dlQueue.items.length, 0);
        });

        it('still toggles a permitted file off and on', () => {
            const client = makeClient(['users']);
            const dlQueue = new mods.DownloadQueue(client);
            const e = entry(mods, 'open_area');

            assert.equal(dlQueue.toggle(e), true);
            assert.equal(dlQueue.items.length, 1);
            assert.equal(dlQueue.toggle(e), false); //  now de-queued
            assert.equal(dlQueue.items.length, 0);
        });

        it('does not gate system files against area ACS', () => {
            const client = makeClient([]);
            const dlQueue = new mods.DownloadQueue(client);

            assert.equal(dlQueue.add(entry(mods, 'donors_only'), true), true);
            assert.equal(dlQueue.items.length, 1);
        });

        //
        //  A queue lives in a user property across sessions, so it can outlive
        //  the rights that filled it -- a user moved out of a group must not
        //  keep downloading what they queued while still in it.
        //
        it('filters queued items whose access has since been revoked', () => {
            const client = makeClient(['users', 'donors']);
            const dlQueue = new mods.DownloadQueue(client);

            assert.equal(dlQueue.add(entry(mods, 'open_area', 1)), true);
            assert.equal(dlQueue.add(entry(mods, 'donors_only', 2)), true);
            assert.equal(dlQueue.allowedItems.length, 2);

            client.user.groups = ['users']; //  dropped from donors

            const allowed = dlQueue.allowedItems;
            assert.equal(allowed.length, 1);
            assert.equal(allowed[0].fileId, 1);
            assert.equal(dlQueue.items.length, 2, 'queue itself is left intact');
        });

        it('keeps system files in allowedItems', () => {
            const client = makeClient([]);
            const dlQueue = new mods.DownloadQueue(client);

            dlQueue.add(entry(mods, 'donors_only'), true);
            assert.equal(dlQueue.allowedItems.length, 1);
        });
    });
});
