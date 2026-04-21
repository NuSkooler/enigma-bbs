'use strict';

//
//  ap_search_util.js — pure helper functions shared across AP search/browse modules.
//
//  Exported so they can be unit-tested without pulling in MenuModule or DB deps.
//

const moment = require('moment');

//  Pad / truncate s to exactly n chars.
function padR(s, n) {
    s = String(s == null ? '' : s);
    return s.length >= n ? s.slice(0, n) : s.padEnd(n);
}

//  Wrap a user-supplied search term as an FTS5 phrase (double-quoted).
//  Internal double-quotes are stripped so FTS5 doesn't choke.
function ftsPhrase(term) {
    return '"' + term.replace(/"/g, '') + '"';
}

//  Regex to detect a direct actor URL or @user@host handle — bypasses FTS5.
//  Also matches user@host (no leading @) since users often omit it.
const AP_HANDLE_RE = /^@?\S+@\S+$/;
const AP_URL_RE = /^https?:\/\//i;

//  True when input looks like a direct actor identifier rather than a search term.
function looksLikeActorId(term) {
    return AP_HANDLE_RE.test(term) || AP_URL_RE.test(term);
}

//  Normalise a handle to the @user@host form expected by Actor.fromId / WebFinger.
function normaliseHandle(term) {
    if (AP_URL_RE.test(term)) return term;
    return term.startsWith('@') ? term : `@${term}`;
}

//  Extract a short display handle from an AP actor URL.
//  Handles both /users/name and /@name path conventions.
//    https://mastodon.social/users/alice  →  @alice@mastodon.social
//    https://mastodon.social/@alice       →  @alice@mastodon.social
function actorUrlToHandle(url) {
    if (!url) return '';
    try {
        const u = new URL(url);
        const m = u.pathname.match(/\/users\/([^/]+)/) || u.pathname.match(/\/@([^/]+)/);
        return m ? `@${m[1]}@${u.host}` : `@${u.host}`;
    } catch (_) {
        return String(url);
    }
}

//  Build the subject/summary display field for a Note.
//  Prepends [CW] for sensitive notes, re: for replies.
function formatSubject(note) {
    const base = (note.summary || note.name || '').trim();
    if (note.sensitive) return `[CW] ${base}`;
    if (note.inReplyTo) return `re: ${base}`;
    return base;
}

//  Format a timestamp using a moment.js format string.
//  'am'/'pm' from the 'a' token are collapsed to 'a'/'p' for compact display.
function formatDate(ts, fmt) {
    if (!ts) return '';
    return moment(ts).format(fmt).replace('am', 'a').replace('pm', 'p');
}

//  Convert a Note object into a viewer-compatible item.
//  timestamp overrides note.published when provided (sharedInbox row timestamp).
function noteToItem(note, timestamp, dateTimeFormat) {
    const fmt = dateTimeFormat || 'MM/DD hh:mma';
    const ts = timestamp || note.published || '';
    return {
        from: actorUrlToHandle(note.attributedTo),
        subject: formatSubject(note),
        date: formatDate(ts, fmt),
        hasAttachment: Array.isArray(note.attachment) && note.attachment.length > 0,
        noteId: note.id,
        contextId: note.context || note.conversation || null,
        inReplyTo: note.inReplyTo || null,
    };
}

module.exports = {
    padR,
    ftsPhrase,
    looksLikeActorId,
    normaliseHandle,
    actorUrlToHandle,
    formatSubject,
    formatDate,
    noteToItem,
};
