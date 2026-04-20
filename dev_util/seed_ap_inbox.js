#!/usr/bin/env node
'use strict';

//
//  seed_ap_inbox.js — populate the ENiGMA½ sharedInbox with fake AP activities
//  for UI/UX testing when no live federation is available.
//
//  Each seeded Note is also written to the BBS message DB (message + message_meta)
//  so that reply, boost, and like actions work correctly in the AP browser/viewer.
//
//  Usage:
//    node dev_util/seed_ap_inbox.js [options]
//
//  Options:
//    --count N       Number of activities to insert  (default: 50)
//    --clear         Delete all existing sharedInbox rows before inserting
//    --db PATH       Path to activitypub.sqlite3     (default: db/activitypub.sqlite3)
//    --msgdb PATH    Path to message.sqlite3         (default: db/message.sqlite3)
//    --help          Show this message
//

const path = require('path');
const crypto = require('crypto');
const { uuidV5 } = require('../core/uuid_util');

//  Must match the constant in core/activitypub/note.js
const PublicMessageIdNamespace = 'a26ae389-5dfb-4b24-a58e-5472085c8e42';

// ─── CLI args ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
let count = 50;
let clear = false;
let dbPath = path.join(__dirname, '..', 'db', 'activitypub.sqlite3');
let msgDbPath = path.join(__dirname, '..', 'db', 'message.sqlite3');

for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
        case '--count':
            count = parseInt(args[++i], 10);
            if (isNaN(count) || count < 1) {
                die('--count must be a positive integer');
            }
            break;
        case '--clear':
            clear = true;
            break;
        case '--db':
            dbPath = args[++i];
            break;
        case '--msgdb':
            msgDbPath = args[++i];
            break;
        case '--help':
        case '-h':
            usage();
            process.exit(0);
            break;
        default:
            die(`Unknown option: ${args[i]}`);
    }
}

function usage() {
    console.log(
        `
Usage: node dev_util/seed_ap_inbox.js [options]

  --count N       Activities to insert (default 50)
  --clear         Wipe sharedInbox + seeded messages before inserting
  --db PATH       Path to activitypub.sqlite3 (default: db/activitypub.sqlite3)
  --msgdb PATH    Path to message.sqlite3     (default: db/message.sqlite3)
  --help          Show this help
`.trim()
    );
}

function die(msg) {
    console.error(`Error: ${msg}`);
    process.exit(1);
}

// ─── open DBs ────────────────────────────────────────────────────────────────

let Database;
try {
    Database = require('better-sqlite3');
} catch (e) {
    die('better-sqlite3 not found. Run: npm install  (from the ENiGMA root)');
}

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const msgDb = new Database(msgDbPath);
msgDb.pragma('journal_mode = WAL');
msgDb.pragma('foreign_keys = ON');

// ─── fake data pools ─────────────────────────────────────────────────────────

const PUBLIC = 'https://www.w3.org/ns/activitystreams#Public';
const COLL_ID = PUBLIC; // sharedInbox uses PublicCollectionId as both collection_id and owner_actor_id

const HOSTS = [
    'mastodon.social',
    'fosstodon.org',
    'hachyderm.io',
    'infosec.exchange',
    'toot.cafe',
    'chaos.social',
    'bsd.network',
    'ruby.social',
];

const USERS = [
    'erosb',
    'deirdre',
    'qbit',
    'vt100freak',
    'phreak42',
    'sysop',
    'retronerd',
    'kryten',
    'hollywoo',
    'greybeard',
    'pixeldust',
    'nullcat',
    'zxspectrum',
    'amigafan',
    'dial_tone',
    'modem_hum',
];

const SUBJECTS = [
    'New BBS software released!',
    'Anyone still using UUCP?',
    'The best door games ever made',
    'Packet radio is making a comeback',
    'My Amiga 4000 still runs fine',
    'Nostalgia: the golden age of BBSes',
    'CP437 forever',
    'Why ANSI art still rules',
    'Terminal emulation in 2025',
    'Fidonet lives!',
    '', // no subject (more realistic)
    '',
    '',
];

const CW_SUMMARIES = [
    'Politics, mute if tired',
    'NSFW language',
    'Long thread, expand for details',
    'Hot take warning',
];

const BODIES = [
    'Just set up my first BBS node in years. ENiGMA½ is incredible software.',
    'Spent the weekend digging through old ANSI art packs. The creativity was unreal.',
    'Does anyone have a working DOOR.SYS implementation they can share?',
    'Packet radio QSO this morning on 144.390 MHz. Still alive out there!',
    'My ZModem transfers hit 56k last night over a clean line. The sound of the handshake 😌',
    'Found a box of old 5.25" floppies. Most still readable! CP/M programs everywhere.',
    'Reminder that CP437 contains characters that Unicode has never quite replaced.',
    'The ANSI art scene is more active than you might think. ansiart.com for starters.',
    'Wrote a new door game this weekend. Rogue-like with CP437 graphics. Testing soon.',
    'Fediverse ActivityPub federation is working on our BBS. First cross-platform message received!',
    'Anyone interested in a Fidonet revival? There are still active zones.',
    'Just ported a classic BBS game to run natively on ENiGMA½. Pure JavaScript, no DOSBox required.',
    'The amount of history encoded in old BBS door game high score lists is staggering.',
    'Telnet BBSes: the last bastion of truly slow, deliberate communication. I love it.',
    'Why does vintage terminal text feel more honest than modern social media? Discuss.',
    'Just got my C64 back online with a Wifi modem. Calling BBSes from 1988 hardware.',
];

const TAGS = [
    '#BBS',
    '#retrocomputing',
    '#ANSI',
    '#CP437',
    '#Fidonet',
    '#ActivityPub',
    '#Fediverse',
    '#terminal',
    '#packetradio',
    '#commodore',
    '#amiga',
    '#oldschool',
];

// ─── helpers ─────────────────────────────────────────────────────────────────

function uuid() {
    return crypto.randomUUID();
}

function pick(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

function pickN(arr, n) {
    const copy = arr.slice();
    const result = [];
    for (let i = 0; i < n && copy.length; i++) {
        const idx = Math.floor(Math.random() * copy.length);
        result.push(copy.splice(idx, 1)[0]);
    }
    return result;
}

function isoTs(msecsAgo) {
    return new Date(Date.now() - msecsAgo).toISOString();
}

function actorUrl(user, host) {
    return `https://${host}/users/${user}`;
}

function noteUrl(host, id) {
    return `https://${host}/objects/${id}`;
}

// ─── activity builders ────────────────────────────────────────────────────────

//  Build a fake Create{Note} activity.
//  contextId  — if set, note is part of a thread (inReplyTo + context populated)
//  replyToId  — specific note URL this is a reply to (implies contextId)
function buildCreate({
    host,
    user,
    ts,
    contextId = null,
    replyToId = null,
    cwSummary = null,
    withAttachment = false,
}) {
    const noteId = noteUrl(host, uuid());
    const actorId = actorUrl(user, host);
    const actId = `https://${host}/activities/${uuid()}`;
    const subject = cwSummary ? '' : pick(SUBJECTS);
    const bodyTags = pickN(TAGS, Math.floor(Math.random() * 3)).join(' ');
    const body = `<p>${pick(BODIES)}</p>${bodyTags ? `<p>${bodyTags}</p>` : ''}`;

    const note = {
        '@context': 'https://www.w3.org/ns/activitystreams',
        id: noteId,
        type: 'Note',
        published: ts,
        url: noteId,
        attributedTo: actorId,
        to: [PUBLIC],
        cc: [actorUrl(user, host) + '/followers'],
        content: body,
        sensitive: !!cwSummary,
    };

    if (cwSummary) {
        note.summary = cwSummary;
    }

    if (subject) {
        note.name = subject;
    }

    if (replyToId) {
        note.inReplyTo = replyToId;
    }

    if (contextId) {
        note.context = contextId;
        note.conversation = contextId;
    }

    if (withAttachment) {
        note.attachment = [
            {
                type: 'Document',
                mediaType: 'image/png',
                url: `https://${host}/media/${uuid()}.png`,
                name: 'attached image',
            },
        ];
    }

    const activity = {
        '@context': 'https://www.w3.org/ns/activitystreams',
        id: actId,
        type: 'Create',
        actor: actorId,
        published: ts,
        to: note.to,
        cc: note.cc,
        object: note,
    };

    return { actId, noteId, activity, note };
}

// ─── insertion helpers ────────────────────────────────────────────────────────

const insertActivity = db.prepare(`
    INSERT OR IGNORE INTO collection
        (name, timestamp, collection_id, owner_actor_id, object_id, object_json, is_private)
    VALUES (?, ?, ?, ?, ?, ?, 0)
`);

const insertReaction = db.prepare(`
    INSERT OR REPLACE INTO note_reactions
        (note_id, actor_id, reaction_type, activity_id, timestamp)
    VALUES (?, ?, ?, ?, ?)
`);

//  Seed a BBS message row for the note so messageForNoteId() works (reply support).
//  Uses the same deterministic UUID as Note.toMessage() for public messages:
//    uuidV5(noteId, PublicMessageIdNamespace)
//  The meta_category string 'ActivityPub' matches Message.WellKnownMetaCategories.ActivityPub.
const insertMessage = msgDb.prepare(`
    INSERT OR IGNORE INTO message
        (area_tag, message_uuid, to_user_name, from_user_name, subject, message, modified_timestamp)
    VALUES ('activitypub_shared', ?, 'All', ?, ?, ?, ?)
`);

const insertMessageMeta = msgDb.prepare(`
    INSERT OR IGNORE INTO message_meta (message_id, meta_category, meta_name, meta_value)
    VALUES (?, 'ActivityPub', ?, ?)
`);

const insertSystemMeta = msgDb.prepare(`
    INSERT OR IGNORE INTO message_meta (message_id, meta_category, meta_name, meta_value)
    VALUES (?, 'System', ?, ?)
`);

function addMessage(note, activityId, ts) {
    const msgUuid = uuidV5(note.id, PublicMessageIdNamespace);
    const fromUser = note.attributedTo || '';
    const subject = note.name || note.summary || '';
    const body = (note.content || '')
        .replace(/<[^>]+>/g, '')
        .replace(/[<>]/g, '')
        .trim();

    const info = insertMessage.run(msgUuid, fromUser, subject, body, ts);
    if (info.lastInsertRowid === 0) {
        return; // OR IGNORE hit — message already exists, skip meta
    }
    const msgId = info.lastInsertRowid;
    insertMessageMeta.run(msgId, 'activitypub_note_id', note.id);
    insertMessageMeta.run(msgId, 'activitypub_activity_id', activityId);
    if (note.context || note.conversation) {
        insertMessageMeta.run(
            msgId,
            'activitypub_context',
            note.context || note.conversation
        );
    }
    if (note.inReplyTo) {
        insertMessageMeta.run(msgId, 'activitypub_in_reply_to', note.inReplyTo);
    }

    //  System meta — required for isFromRemoteUser() and getAddressFlavor() to work
    //  (e.g. quote-reply prefix selection, AP-aware FSE behaviour).
    insertSystemMeta.run(msgId, 'remote_from_user', fromUser);
    insertSystemMeta.run(msgId, 'external_flavor', 'activitypub');
}

function addReaction(noteId, reactionType, reactorHost, reactorUser, ts) {
    const actorId = actorUrl(reactorUser, reactorHost);
    const activityId = `https://${reactorHost}/activities/${uuid()}`;
    insertReaction.run(noteId, actorId, reactionType, activityId, ts);
}

// ─── main ─────────────────────────────────────────────────────────────────────

if (clear) {
    console.log('Clearing sharedInbox collection...');
    const result = db.prepare(`DELETE FROM collection WHERE name = 'sharedInbox'`).run();
    console.log(`  Deleted ${result.changes} row(s).`);

    console.log('Clearing note_reactions...');
    const rResult = db.prepare(`DELETE FROM note_reactions`).run();
    console.log(`  Deleted ${rResult.changes} row(s).`);

    console.log('Clearing seeded AP messages...');
    const mResult = msgDb
        .prepare(`DELETE FROM message WHERE area_tag = 'activitypub_shared'`)
        .run();
    console.log(`  Deleted ${mResult.changes} message row(s).`);
}

console.log(`Seeding ${count} activities into sharedInbox...`);

//  Spread activities over the past 7 days so pagination / cursor tests work.
const spanMs = 7 * 24 * 60 * 60 * 1000;
const stepMs = Math.floor(spanMs / count);

//  Build a few thread contexts first — roughly 20 % of posts will be replies.
const threadCount = Math.max(1, Math.floor(count * 0.08));
const threadContexts = []; // [{ contextId, rootNoteId, rootHost }]

const runInserts = db.transaction(() => {
    let inserted = 0;

    //  Pass 1 — root posts (including thread roots)
    for (let i = 0; i < count; i++) {
        const msecsAgo = (count - i) * stepMs + Math.floor(Math.random() * stepMs);
        const ts = isoTs(msecsAgo);
        const host = pick(HOSTS);
        const user = pick(USERS);

        const isThreadRoot = i < threadCount;
        const isReply = !isThreadRoot && threadContexts.length > 0 && Math.random() < 0.2;
        const isCW = !isReply && Math.random() < 0.12;
        const hasAttachment = Math.random() < 0.15;

        let contextId = null;
        let replyToId = null;
        let cwSummary = null;

        if (isThreadRoot) {
            contextId = `https://${host}/contexts/${uuid()}`;
        } else if (isReply) {
            const thread = pick(threadContexts);
            contextId = thread.contextId;
            replyToId = thread.rootNoteId;
        }

        if (isCW) {
            cwSummary = pick(CW_SUMMARIES);
        }

        const { actId, noteId, activity, note } = buildCreate({
            host,
            user,
            ts,
            contextId,
            replyToId,
            cwSummary,
            withAttachment: hasAttachment,
        });

        insertActivity.run(
            'sharedInbox',
            ts,
            COLL_ID,
            PUBLIC,
            actId,
            JSON.stringify(activity)
        );

        addMessage(note, actId, ts);

        inserted++;

        if (isThreadRoot) {
            threadContexts.push({ contextId, rootNoteId: noteId, rootHost: host });
        }

        //  Add random reactions (likes / boosts) to some notes.
        const likeCount = Math.random() < 0.4 ? Math.floor(Math.random() * 8) + 1 : 0;
        const boostCount = Math.random() < 0.25 ? Math.floor(Math.random() * 5) + 1 : 0;

        for (let l = 0; l < likeCount; l++) {
            addReaction(
                noteId,
                'Like',
                pick(HOSTS),
                pick(USERS),
                isoTs(msecsAgo - 1000 * l)
            );
        }

        for (let b = 0; b < boostCount; b++) {
            addReaction(
                noteId,
                'Announce',
                pick(HOSTS),
                pick(USERS),
                isoTs(msecsAgo - 500 * b)
            );
        }
    }

    return inserted;
});

try {
    const n = runInserts();
    console.log(`Done. Inserted ${n} activities.`);
    console.log(`Thread contexts created: ${threadContexts.length}`);
    console.log(`  (Use 't' or '+' in the AP Message Browser to open a thread.)`);
} catch (err) {
    console.error('Insert failed:', err.message);
    process.exit(1);
}
