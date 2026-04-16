'use strict';

const { strict: assert } = require('assert');

//
//  ap_search_util.js contains pure functions with no Config/DB deps.
//  Require it directly — no mocking needed.
//
const {
    padR,
    ftsPhrase,
    looksLikeActorId,
    actorUrlToHandle,
    formatSubject,
    formatDate,
    noteToItem,
} = require('../core/activitypub/ap_search_util');

// ─── padR ─────────────────────────────────────────────────────────────────────

describe('padR()', function () {
    it('pads a short string to n chars', () => {
        assert.equal(padR('hi', 5), 'hi   ');
        assert.equal(padR('hi', 5).length, 5);
    });

    it('returns string unchanged when length equals n', () => {
        assert.equal(padR('hello', 5), 'hello');
    });

    it('truncates strings longer than n', () => {
        assert.equal(padR('toolong', 4), 'tool');
    });

    it('treats null/undefined as empty string', () => {
        assert.equal(padR(null, 3), '   ');
        assert.equal(padR(undefined, 3), '   ');
    });

    it('coerces numbers to strings', () => {
        assert.equal(padR(42, 5), '42   ');
    });
});

// ─── ftsPhrase ────────────────────────────────────────────────────────────────

describe('ftsPhrase()', function () {
    it('wraps a simple term in double quotes', () => {
        assert.equal(ftsPhrase('hello'), '"hello"');
    });

    it('strips internal double quotes to prevent FTS5 parse errors', () => {
        assert.equal(ftsPhrase('hel"lo'), '"hello"');
        assert.equal(ftsPhrase('"quoted"'), '"quoted"');
    });

    it('handles empty string', () => {
        assert.equal(ftsPhrase(''), '""');
    });

    it('preserves spaces inside the phrase', () => {
        assert.equal(ftsPhrase('packet radio'), '"packet radio"');
    });

    it('preserves column-scoped prefix like tags:', () => {
        //  Callers pass 'tags:' prefix separately; ftsPhrase wraps only the term
        const tag = 'packetradio';
        assert.equal('tags:' + ftsPhrase(tag), 'tags:"packetradio"');
    });
});

// ─── looksLikeActorId ─────────────────────────────────────────────────────────

describe('looksLikeActorId()', function () {
    it('recognises @user@host handles', () => {
        assert.ok(looksLikeActorId('@alice@mastodon.social'));
        assert.ok(looksLikeActorId('@bob@chaos.social'));
    });

    it('recognises https:// actor URLs', () => {
        assert.ok(looksLikeActorId('https://mastodon.social/users/alice'));
        assert.ok(looksLikeActorId('https://example.com/@bob'));
    });

    it('recognises http:// actor URLs', () => {
        assert.ok(looksLikeActorId('http://example.com/users/carol'));
    });

    it('returns false for plain search terms', () => {
        assert.ok(!looksLikeActorId('alice'));
        assert.ok(!looksLikeActorId('packet radio'));
        assert.ok(!looksLikeActorId('#fidonet'));
    });

    it('returns false for partial handles (missing host)', () => {
        assert.ok(!looksLikeActorId('@alice'));
        assert.ok(!looksLikeActorId('@alice@'));
    });

    it('returns false for empty string', () => {
        assert.ok(!looksLikeActorId(''));
    });
});

// ─── actorUrlToHandle ─────────────────────────────────────────────────────────

describe('actorUrlToHandle()', function () {
    it('converts /users/ path to @user@host', () => {
        assert.equal(
            actorUrlToHandle('https://mastodon.social/users/alice'),
            '@alice@mastodon.social'
        );
    });

    it('converts /@user path to @user@host', () => {
        assert.equal(
            actorUrlToHandle('https://mastodon.social/@alice'),
            '@alice@mastodon.social'
        );
    });

    it('falls back to @hostname for unrecognised path', () => {
        assert.equal(
            actorUrlToHandle('https://mastodon.social/'),
            '@mastodon.social'
        );
    });

    it('returns empty string for null/undefined/empty', () => {
        assert.equal(actorUrlToHandle(null), '');
        assert.equal(actorUrlToHandle(undefined), '');
        assert.equal(actorUrlToHandle(''), '');
    });

    it('returns the original string when URL parsing fails', () => {
        assert.equal(actorUrlToHandle('not-a-url'), 'not-a-url');
    });
});

// ─── formatSubject ────────────────────────────────────────────────────────────

describe('formatSubject()', function () {
    it('uses summary when present', () => {
        assert.equal(formatSubject({ summary: 'Hello world' }), 'Hello world');
    });

    it('falls back to name when summary is absent', () => {
        assert.equal(formatSubject({ name: 'My post' }), 'My post');
    });

    it('returns empty string when both summary and name are absent', () => {
        assert.equal(formatSubject({}), '');
    });

    it('prepends [CW] for sensitive notes', () => {
        assert.equal(
            formatSubject({ summary: 'politics', sensitive: true }),
            '[CW] politics'
        );
    });

    it('prepends re: for replies (inReplyTo set)', () => {
        assert.equal(
            formatSubject({ summary: 'original', inReplyTo: 'https://example.com/notes/1' }),
            're: original'
        );
    });

    it('[CW] takes precedence over re: when both flags are set', () => {
        const result = formatSubject({
            summary:   'cw topic',
            sensitive: true,
            inReplyTo: 'https://example.com/notes/1',
        });
        assert.ok(result.startsWith('[CW]'));
    });

    it('trims whitespace from summary', () => {
        assert.equal(formatSubject({ summary: '  trimmed  ' }), 'trimmed');
    });
});

// ─── formatDate ───────────────────────────────────────────────────────────────

describe('formatDate()', function () {
    it('returns empty string for falsy timestamp', () => {
        assert.equal(formatDate(null, 'MM/DD'), '');
        assert.equal(formatDate('', 'MM/DD'), '');
        assert.equal(formatDate(undefined, 'MM/DD'), '');
    });

    it('formats a known timestamp correctly', () => {
        //  2026-04-16T12:00:00Z → "04/16 12:00p" with default fmt
        const ts = '2026-04-16T12:00:00.000Z';
        const result = formatDate(ts, 'MM/DD hh:mma');
        assert.ok(result.startsWith('04/16'), `expected date to start with 04/16, got: ${result}`);
    });

    it('collapses am → a and pm → p', () => {
        //  Pick a time we know is AM in UTC
        const amTs = '2026-04-16T04:30:00.000Z';
        const pmTs = '2026-04-16T14:30:00.000Z';
        const amResult = formatDate(amTs, 'hh:mma');
        const pmResult = formatDate(pmTs, 'hh:mma');
        assert.ok(!amResult.includes('am'), `should collapse am to a: ${amResult}`);
        assert.ok(!pmResult.includes('pm'), `should collapse pm to p: ${pmResult}`);
        assert.ok(amResult.endsWith('a') || amResult.endsWith('p'), `should end with a or p: ${amResult}`);
        assert.ok(pmResult.endsWith('a') || pmResult.endsWith('p'), `should end with a or p: ${pmResult}`);
    });
});

// ─── noteToItem ───────────────────────────────────────────────────────────────

describe('noteToItem()', function () {
    const baseNote = {
        id:           'https://remote.example.com/notes/1',
        attributedTo: 'https://mastodon.social/users/alice',
        summary:      'Hello world',
        content:      '<p>Body text</p>',
        published:    '2026-04-16T12:00:00.000Z',
    };

    it('builds a minimal item from a Note', () => {
        const item = noteToItem(baseNote);
        assert.equal(item.noteId, baseNote.id);
        assert.equal(item.from, '@alice@mastodon.social');
        assert.equal(item.subject, 'Hello world');
        assert.ok(typeof item.date === 'string');
    });

    it('prefers timestamp param over note.published', () => {
        //  Use a midday UTC timestamp to avoid local-timezone date boundary issues.
        const ts = '2025-06-15T12:00:00.000Z';
        const item = noteToItem(baseNote, ts);
        assert.ok(item.date.startsWith('06/15'), `expected 06/15 date, got: ${item.date}`);
    });

    it('sets hasAttachment true when attachments are present', () => {
        const note = Object.assign({}, baseNote, {
            attachment: [{ type: 'Image', url: 'https://example.com/img.png' }],
        });
        assert.equal(noteToItem(note).hasAttachment, true);
    });

    it('sets hasAttachment false when attachment array is empty', () => {
        const note = Object.assign({}, baseNote, { attachment: [] });
        assert.equal(noteToItem(note).hasAttachment, false);
    });

    it('sets hasAttachment false when attachment is absent', () => {
        assert.equal(noteToItem(baseNote).hasAttachment, false);
    });

    it('extracts contextId from note.context', () => {
        const note = Object.assign({}, baseNote, {
            context: 'https://example.com/context/1',
        });
        assert.equal(noteToItem(note).contextId, 'https://example.com/context/1');
    });

    it('falls back to note.conversation for contextId', () => {
        const note = Object.assign({}, baseNote, {
            conversation: 'https://example.com/conv/1',
        });
        assert.equal(noteToItem(note).contextId, 'https://example.com/conv/1');
    });

    it('sets contextId null when neither context nor conversation is present', () => {
        assert.equal(noteToItem(baseNote).contextId, null);
    });

    it('sets inReplyTo from note.inReplyTo', () => {
        const note = Object.assign({}, baseNote, {
            inReplyTo: 'https://example.com/notes/0',
        });
        assert.equal(noteToItem(note).inReplyTo, 'https://example.com/notes/0');
    });

    it('sets inReplyTo null when absent', () => {
        assert.equal(noteToItem(baseNote).inReplyTo, null);
    });
});
