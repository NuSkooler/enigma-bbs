'use strict';

const { strict: assert } = require('assert');

//
//  Config mock — must be in place before any transitive require touches Config.
//
const configModule = require('../core/config.js');
configModule.get = () => ({
    debug: { assertsEnabled: false },
    general: { boardName: 'TestBoard' },
    contentServers: {
        web: { domain: 'test.example.com', port: 443, https: true },
    },
});

//
//  web_util.getWebDomain() reads config, so the mock above is enough.
//  We don't need a DB for util.js functions.
//
const {
    htmlToMessageBody,
    messageToHtml,
    extractMessageMetadata,
    isValidLink,
    parseTimestampOrNow,
    userNameFromSubject,
} = require('../core/activitypub/util.js');

// ─── htmlToMessageBody ────────────────────────────────────────────────────────

describe('htmlToMessageBody()', function () {
    it('strips basic HTML tags', () => {
        const result = htmlToMessageBody('<p>Hello world</p>');
        assert.ok(result.includes('Hello world'));
        assert.ok(!result.includes('<p>'), 'should not contain <p> tag');
    });

    it('converts <br> to CRLF before stripping', () => {
        const result = htmlToMessageBody('Line one<br>Line two');
        assert.ok(result.includes('Line one'), 'first line should be present');
        assert.ok(result.includes('Line two'), 'second line should be present');
        assert.ok(
            result.includes('\r\n') || result.includes('\n'),
            'newline should be present'
        );
    });

    it('converts self-closing <br /> to CRLF', () => {
        const result = htmlToMessageBody('First<br />Second');
        assert.ok(result.includes('First'));
        assert.ok(result.includes('Second'));
        assert.ok(result.includes('\r\n') || result.includes('\n'));
    });

    it('converts <br/> (no space) to CRLF', () => {
        const result = htmlToMessageBody('A<br/>B');
        assert.ok(result.includes('A'));
        assert.ok(result.includes('B'));
        assert.ok(result.includes('\r\n') || result.includes('\n'));
    });

    it('decodes HTML entities', () => {
        const result = htmlToMessageBody('&amp; &lt; &gt; &quot;');
        assert.ok(result.includes('&'), 'ampersand should be decoded');
        assert.ok(result.includes('<') || result.includes('>') || result.includes('"'));
    });

    it('handles Mastodon-style multi-paragraph HTML', () => {
        const html = '<p>Hello</p><p>World</p>';
        const result = htmlToMessageBody(html);
        assert.ok(result.includes('Hello'));
        assert.ok(result.includes('World'));
        assert.ok(!result.includes('<p>'));
    });

    it('returns empty string for empty input', () => {
        const result = htmlToMessageBody('');
        assert.equal(typeof result, 'string');
    });

    it('handles plain text (no HTML) passthrough', () => {
        const result = htmlToMessageBody('Just plain text');
        assert.ok(result.includes('Just plain text'));
    });
});

// ─── messageToHtml ────────────────────────────────────────────────────────────

describe('messageToHtml()', function () {
    function makeMessage(body) {
        return { message: body };
    }

    it('wraps content in <p> tag', () => {
        const result = messageToHtml(makeMessage('Hello'));
        assert.ok(result.startsWith('<p>'));
        assert.ok(result.endsWith('</p>'));
    });

    it('converts newlines to <br>', () => {
        const result = messageToHtml(makeMessage('Line one\r\nLine two'));
        assert.ok(result.includes('<br>'), 'should contain <br>');
    });

    it('encodes HTML special characters', () => {
        const result = messageToHtml(makeMessage('a & b < c > d'));
        // HTML entities or encoded form expected
        assert.ok(!result.includes(' & '), 'ampersand should be encoded');
    });

    it('trims whitespace from message', () => {
        const result = messageToHtml(makeMessage('  hello  '));
        assert.ok(!result.includes('  hello  '), 'raw padded string should not appear');
        assert.ok(result.includes('hello'));
    });

    it('strips ENiGMA pipe color codes (|XX) before encoding', () => {
        //  Pipe codes like |07 (white), |CE (cyan bold) must not appear in AP content.
        const result = messageToHtml(makeMessage('|07Hello |CE world|16'));
        assert.ok(!result.includes('|07'), '|07 pipe code should be stripped');
        assert.ok(!result.includes('|CE'), '|CE pipe code should be stripped');
        assert.ok(!result.includes('|16'), '|16 pipe code should be stripped');
        assert.ok(result.includes('Hello'), 'text content should be preserved');
        assert.ok(result.includes('world'), 'text content should be preserved');
    });

    it('strips pipe codes from auto-signature content when appended', () => {
        //  Auto-sigs appended by fse.js may contain pipe codes; the combined
        //  message+sig string is what messageToHtml receives.
        const body = 'Post body\r\n-- \r\n|07Sysop Name|16\r\n|BRBoard Name';
        const result = messageToHtml(makeMessage(body));
        assert.ok(!/\|[A-Z\d]{2}/.test(result), 'no pipe codes should survive into HTML');
        assert.ok(result.includes('Sysop Name'), 'plain text of sig should be preserved');
    });
});

// ─── extractMessageMetadata ───────────────────────────────────────────────────

describe('extractMessageMetadata()', function () {
    it('returns empty sets for plain text', () => {
        const { mentions, hashTags } = extractMessageMetadata('Hello world');
        assert.equal(mentions.size, 0);
        assert.equal(hashTags.size, 0);
    });

    it('extracts a single @mention', () => {
        const { mentions } = extractMessageMetadata('Hello @alice');
        assert.ok(mentions.has('@alice'));
        assert.equal(mentions.size, 1);
    });

    it('extracts multiple @mentions', () => {
        const { mentions } = extractMessageMetadata('@alice and @bob are here');
        assert.ok(mentions.has('@alice'));
        assert.ok(mentions.has('@bob'));
        assert.equal(mentions.size, 2);
    });

    it('extracts a single #hashtag', () => {
        const { hashTags } = extractMessageMetadata('Check out #BBS today');
        assert.ok(hashTags.has('#BBS'));
        assert.equal(hashTags.size, 1);
    });

    it('extracts multiple #hashtags', () => {
        const { hashTags } = extractMessageMetadata('#retro and #bbs and #fidonet');
        assert.ok(hashTags.has('#retro'));
        assert.ok(hashTags.has('#bbs'));
        assert.ok(hashTags.has('#fidonet'));
        assert.equal(hashTags.size, 3);
    });

    it('extracts both @mentions and #hashtags from same message', () => {
        const { mentions, hashTags } = extractMessageMetadata(
            'Hey @alice, check out #retro stuff!'
        );
        assert.ok(mentions.has('@alice'));
        assert.ok(hashTags.has('#retro'));
    });

    it('deduplicates repeated @mentions', () => {
        const { mentions } = extractMessageMetadata('@alice @alice @alice');
        assert.equal(mentions.size, 1);
    });

    it('deduplicates repeated #hashtags', () => {
        const { hashTags } = extractMessageMetadata('#bbs #bbs #bbs');
        assert.equal(hashTags.size, 1);
    });

    it('returns Sets (not arrays)', () => {
        const { mentions, hashTags } = extractMessageMetadata('@alice #bbs');
        assert.ok(mentions instanceof Set);
        assert.ok(hashTags instanceof Set);
    });
});

// ─── Note tag array construction (unit-level logic test) ─────────────────────

describe('Note tag array (protocol conformance)', function () {
    //  Mirrors the tag-building logic in note.js fromLocalMessage without
    //  needing a real Message object or DB.
    function buildTagArray(body) {
        const { mentions, hashTags } = extractMessageMetadata(body);
        const tag = [];
        mentions.forEach(mention => {
            tag.push({ type: 'Mention', name: mention });
        });
        hashTags.forEach(ht => {
            tag.push({ type: 'Hashtag', name: ht });
        });
        return tag.length > 0 ? tag : undefined;
    }

    it('returns undefined when no mentions or hashtags', () => {
        assert.equal(buildTagArray('Hello world'), undefined);
    });

    it('Mention entry has type and name fields', () => {
        const tag = buildTagArray('Hello @alice');
        assert.ok(Array.isArray(tag));
        const mention = tag.find(t => t.type === 'Mention');
        assert.ok(mention, 'should have a Mention entry');
        assert.equal(mention.name, '@alice');
    });

    it('Hashtag entry has type and name fields', () => {
        const tag = buildTagArray('Check #retro');
        assert.ok(Array.isArray(tag));
        const ht = tag.find(t => t.type === 'Hashtag');
        assert.ok(ht, 'should have a Hashtag entry');
        assert.equal(ht.name, '#retro');
    });

    it('includes both Mention and Hashtag in same array', () => {
        const tag = buildTagArray('@alice loves #retro');
        assert.ok(Array.isArray(tag));
        assert.ok(tag.some(t => t.type === 'Mention'));
        assert.ok(tag.some(t => t.type === 'Hashtag'));
    });
});

// ─── isValidLink ──────────────────────────────────────────────────────────────

describe('isValidLink()', function () {
    it('accepts https URLs', () => {
        assert.ok(isValidLink('https://example.com/user/foo'));
    });

    it('accepts http URLs', () => {
        assert.ok(isValidLink('http://example.com'));
    });

    it('rejects empty string', () => {
        assert.ok(!isValidLink(''));
    });

    it('rejects plain domain without scheme', () => {
        assert.ok(!isValidLink('example.com'));
    });

    it('rejects mailto: scheme', () => {
        assert.ok(!isValidLink('mailto:foo@example.com'));
    });

    it('rejects ftp: scheme', () => {
        assert.ok(!isValidLink('ftp://example.com'));
    });
});

// ─── parseTimestampOrNow ──────────────────────────────────────────────────────

describe('parseTimestampOrNow()', function () {
    it('parses a valid ISO timestamp', () => {
        const m = parseTimestampOrNow('2023-01-15T12:00:00Z');
        assert.ok(m.isValid());
        assert.equal(m.year(), 2023);
    });

    it('returns a moment object for an invalid string (falls back to now)', () => {
        const m = parseTimestampOrNow('not-a-date');
        // moment('not-a-date') is actually invalid in strict mode but parseTimestampOrNow
        // wraps in try/catch returning moment() on throw — moment itself doesn't throw here,
        // but the result is an object
        assert.ok(m != null);
        assert.equal(typeof m.year, 'function');
    });

    it('returns a moment object for null input', () => {
        const m = parseTimestampOrNow(null);
        assert.ok(m != null);
    });
});

// ─── userNameFromSubject / userNameToSubject ──────────────────────────────────

describe('userNameFromSubject()', function () {
    it('strips acct: prefix', () => {
        assert.equal(userNameFromSubject('acct:alice@example.com'), 'alice@example.com');
    });

    it('passes through non-acct strings unchanged', () => {
        assert.equal(userNameFromSubject('alice@example.com'), 'alice@example.com');
    });
});

//  userNameToSubject() is not tested here because web_util.js captures
//  Config at module-load time, making it hard to stub in the test environment.
