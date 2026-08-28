'use strict';

const { strict: assert } = require('assert');

const {
    AreaFixStatus,
    tokenizeReplyLine,
    parseAreaFixReply,
} = require('../core/areafix_reply.js');

const REQUESTED = ['FSX_GEN', 'FSX_BBS', 'FSX_MYS'];

const parse = (body, extraPhrases) =>
    parseAreaFixReply(body, { tags: REQUESTED, extraPhrases });

const statusFor = (body, tag) => {
    const found = parse(body).results.find(r => r.tag === tag);
    return found && found.status;
};

// ─── Tokenizer ───────────────────────────────────────────────────────────────

describe('areafix_reply: line tokenizer', () => {
    it('handles husky dot-fill', () => {
        assert.deepEqual(
            tokenizeReplyLine(' FSX_GEN ........................... added'),
            { tag: 'FSX_GEN', statusText: 'added' }
        );
    });

    it('handles SBBSecho bare form with a trailing period', () => {
        assert.deepEqual(tokenizeReplyLine('FSX_GEN added.'), {
            tag: 'FSX_GEN',
            statusText: 'added',
        });
    });

    it('handles CrashMail column padding and an echoed command character', () => {
        assert.deepEqual(tokenizeReplyLine('+FSX_GEN                       Attached'), {
            tag: 'FSX_GEN',
            statusText: 'attached',
        });
    });

    it('strips the other command characters managers echo back', () => {
        ['-', '=', '%', '*'].forEach(ch => {
            assert.equal(tokenizeReplyLine(`${ch}FSX_GEN removed`).tag, 'FSX_GEN');
        });
    });

    it('collapses internal whitespace in the status text', () => {
        assert.equal(
            tokenizeReplyLine('FSX_GEN   already    linked').statusText,
            'already linked'
        );
    });

    it('returns null for a line with nothing after the tag', () => {
        assert.equal(tokenizeReplyLine('FSX_GEN'), null);
        assert.equal(tokenizeReplyLine('   '), null);
        assert.equal(tokenizeReplyLine(''), null);
    });
});

// ─── Vocabulary ──────────────────────────────────────────────────────────────
//
//  Structure converges across husky, SBBSecho and CrashMail II; vocabulary
//  does not. Each of these came from one of those implementations.
//
describe('areafix_reply: status vocabulary', () => {
    const cases = [
        //  husky
        [' FSX_GEN ........................... added', AreaFixStatus.Added],
        [' FSX_GEN ........................... unlinked', AreaFixStatus.Removed],
        [
            ' FSX_GEN ........................... already linked',
            AreaFixStatus.AlreadyLinked,
        ],
        [' FSX_GEN ........................... not linked', AreaFixStatus.NotLinked],
        //  SBBSecho
        ['FSX_GEN added.', AreaFixStatus.Added],
        ['FSX_GEN removed.', AreaFixStatus.Removed],
        ['FSX_GEN not found.', AreaFixStatus.NotFound],
        //  CrashMail II
        ['+FSX_GEN                       Attached', AreaFixStatus.Added],
        ['-FSX_GEN                       Detached', AreaFixStatus.Removed],
        ['+FSX_GEN                       Unknown area', AreaFixStatus.NotFound],
        [
            '+FSX_GEN                       You are already attached to that area',
            AreaFixStatus.AlreadyLinked,
        ],
        ['+FSX_GEN                       Attached as read-only', AreaFixStatus.Added],
    ];

    cases.forEach(([line, expected]) => {
        it(`${JSON.stringify(line.trim())} -> ${expected}`, () => {
            assert.equal(statusFor(line, 'FSX_GEN'), expected);
        });
    });

    it("matches SBBSecho's rescan line by prefix, since it carries a count", () => {
        assert.equal(
            statusFor('FSX_GEN rescanned and 123 messages exported.', 'FSX_GEN'),
            AreaFixStatus.Rescanned
        );
    });

    it('reports an unseeded vocabulary as unknown rather than guessing', () => {
        const { results, unknownCount } = parse('FSX_GEN wibbled sideways');
        assert.equal(results[0].status, AreaFixStatus.Unknown);
        assert.equal(results[0].raw, 'FSX_GEN wibbled sideways');
        assert.equal(unknownCount, 1);
    });

    it('can be taught a manager-specific phrase without code changes', () => {
        const { results } = parse('FSX_GEN wibbled sideways', {
            'wibbled sideways': AreaFixStatus.Added,
        });
        assert.equal(results[0].status, AreaFixStatus.Added);
    });
});

// ─── Correlation ─────────────────────────────────────────────────────────────

describe('areafix_reply: only lines about areas we asked about', () => {
    it('discards entries for areas we never mentioned', () => {
        const { results } = parse(
            [
                'FSX_GEN added',
                'SOME_OTHER added', //  not in our request
            ].join('\r\n')
        );
        assert.deepEqual(
            results.map(r => r.tag),
            ['FSX_GEN']
        );
    });

    it("ignores husky's appended %LIST block for unrelated areas", () => {
        //  With queryReports on, husky appends the full linked-areas list to
        //  the same netmail as the confirmations -- one message, both content
        //  types, one subject. The tag-set intersection is what keeps that safe.
        const body = [
            'Areafix reply: node change request',
            '',
            ' FSX_GEN ........................... added',
            '',
            'Your linked areas:',
            ' SOMENET_CHAT ...................... General chatter',
            ' SOMENET_ADS ....................... Advertisements',
        ].join('\r\n');

        const { results } = parse(body);
        assert.deepEqual(
            results.map(r => r.tag),
            ['FSX_GEN']
        );
        assert.equal(results[0].status, AreaFixStatus.Added);
    });

    it('cannot return free text -- a %LIST description becomes a status, never a desc', () => {
        //  A confirmation and a %LIST entry are structurally identical, so a
        //  description for an area we DID ask about is unavoidably parsed. It
        //  must come back as Unknown, not as something assignable to desc.
        const { results } = parse(' FSX_GEN ........................... General chatter');
        assert.equal(results[0].status, AreaFixStatus.Unknown);
        assert.equal(Object.keys(results[0]).includes('desc'), false);
    });

    it('keeps the first recognized status when a tag appears twice', () => {
        const { results } = parse(
            ['FSX_GEN added', 'FSX_GEN General chatter'].join('\r\n')
        );
        assert.equal(results.length, 1);
        assert.equal(results[0].status, AreaFixStatus.Added);
    });

    it('upgrades an earlier unknown when a later line is recognized', () => {
        const { results, unknownCount } = parse(
            ['FSX_GEN General chatter', 'FSX_GEN added'].join('\r\n')
        );
        assert.equal(results[0].status, AreaFixStatus.Added);
        assert.equal(unknownCount, 0);
    });

    it('returns nothing for an empty or unrelated body', () => {
        assert.equal(parse('').results.length, 0);
        assert.equal(parse('Thanks for your message!\r\n\r\n-- Bob').results.length, 0);
    });

    it('returns nothing when no tags were requested', () => {
        assert.equal(parseAreaFixReply('FSX_GEN added', { tags: [] }).results.length, 0);
    });

    it('matches tags case-insensitively', () => {
        const { results } = parseAreaFixReply('fsx_gen added', {
            tags: ['FSX_GEN'],
        });
        assert.equal(results.length, 1);
        assert.equal(results[0].tag, 'FSX_GEN');
    });

    it('handles a multi-area reply', () => {
        const body = [
            ' FSX_GEN ........................... added',
            ' FSX_BBS ........................... already linked',
            ' FSX_MYS ........................... not found',
        ].join('\r\n');

        const byTag = Object.fromEntries(parse(body).results.map(r => [r.tag, r.status]));
        assert.deepEqual(byTag, {
            FSX_GEN: AreaFixStatus.Added,
            FSX_BBS: AreaFixStatus.AlreadyLinked,
            FSX_MYS: AreaFixStatus.NotFound,
        });
    });
});
