'use strict';

const { strict: assert } = require('assert');
const moment = require('moment');

const ftnUtil = require('../core/ftn_util.js');

// -------------------------------------------------------------------------
// parseAbbreviatedNetNodeList / getAbbreviatedNetNodeList
// -------------------------------------------------------------------------

describe('parseAbbreviatedNetNodeList', () => {
    it('parses a simple net/node pair', () => {
        const result = ftnUtil.parseAbbreviatedNetNodeList('104/1');
        assert.equal(result.length, 1);
        assert.equal(result[0].net, 104);
        assert.equal(result[0].node, 1);
    });

    it('parses abbreviated same-net entries', () => {
        // "104/1 501" means 104/1 and 104/501
        const result = ftnUtil.parseAbbreviatedNetNodeList('104/1 501');
        assert.equal(result.length, 2);
        assert.equal(result[0].net, 104);
        assert.equal(result[0].node, 1);
        assert.equal(result[1].net, 104);
        assert.equal(result[1].node, 501);
    });

    it('parses multiple nets', () => {
        const result = ftnUtil.parseAbbreviatedNetNodeList('104/1 200/7 8');
        assert.equal(result.length, 3);
        assert.equal(result[0].net, 104);
        assert.equal(result[0].node, 1);
        assert.equal(result[1].net, 200);
        assert.equal(result[1].node, 7);
        assert.equal(result[2].net, 200);
        assert.equal(result[2].node, 8);
    });

    it('round-trips through getAbbreviatedNetNodeList', () => {
        const original = '104/1 501 200/7';
        const parsed = ftnUtil.parseAbbreviatedNetNodeList(original);
        const serialized = ftnUtil.getAbbreviatedNetNodeList(parsed);
        assert.equal(serialized, original);
    });
});

// -------------------------------------------------------------------------
// getUpdatedSeenByEntries — merge, dedup, sort
// -------------------------------------------------------------------------

describe('getUpdatedSeenByEntries', () => {
    it('builds a new SEEN-BY from empty existing entries', () => {
        const result = ftnUtil.getUpdatedSeenByEntries([], ['104/1']);
        assert.ok(Array.isArray(result));
        assert.ok(result.length >= 1);
        const all = result.join(' ');
        assert.ok(all.includes('104/1'), `expected 104/1 in "${all}"`);
    });

    it('merges additions into existing entries', () => {
        const existing = ['104/1 501'];
        const result = ftnUtil.getUpdatedSeenByEntries(existing, ['200/7']);
        const all = result.join(' ');
        assert.ok(all.includes('104/1'), `missing 104/1 in "${all}"`);
        assert.ok(
            all.includes('104/501') || all.includes('104/1 501'),
            `missing 104/501 in "${all}"`
        );
        assert.ok(all.includes('200/7'), `missing 200/7 in "${all}"`);
    });

    it('deduplicates — adding an already-present node does not create duplicate', () => {
        const existing = ['104/1'];
        const result = ftnUtil.getUpdatedSeenByEntries(existing, ['104/1']);
        const all = result.join(' ');
        // Count occurrences of "104/1" (whole word)
        const matches = all.match(/104\/1/g) || [];
        assert.equal(matches.length, 1, `expected exactly one 104/1, got: "${all}"`);
    });

    it('returns entries in ascending net/node order', () => {
        const existing = ['300/5', '100/1'];
        const result = ftnUtil.getUpdatedSeenByEntries(existing, ['200/3']);
        const allAddrs = result
            .join(' ')
            .trim()
            .split(/\s+/)
            .flatMap(t => ftnUtil.parseAbbreviatedNetNodeList(t));
        for (let i = 1; i < allAddrs.length; i++) {
            const prev = allAddrs[i - 1];
            const curr = allAddrs[i];
            const prevKey = prev.net * 65536 + prev.node;
            const currKey = curr.net * 65536 + curr.node;
            assert.ok(
                prevKey <= currKey,
                `out of order: ${prev.net}/${prev.node} before ${curr.net}/${curr.node}`
            );
        }
    });

    it('wraps onto multiple lines when content exceeds 71 chars', () => {
        //  Force a long list by adding many nodes across different nets
        const additions = [];
        for (let net = 100; net < 130; net++) {
            additions.push(`${net}/1`);
        }
        const result = ftnUtil.getUpdatedSeenByEntries([], additions);
        assert.ok(result.length > 1, 'expected multiple SEEN-BY lines for long list');
        result.forEach(line => {
            assert.ok(line.length <= 71, `line too long (${line.length}): "${line}"`);
        });
    });

    it('accepts a string array as additions', () => {
        const result = ftnUtil.getUpdatedSeenByEntries([], ['104/1', '200/7']);
        const all = result.join(' ');
        assert.ok(all.includes('104/1'));
        assert.ok(all.includes('200/7'));
    });
});

// -------------------------------------------------------------------------
// getUpdatedPathEntries — insertion order, line packing
// -------------------------------------------------------------------------

describe('getUpdatedPathEntries', () => {
    it('creates a first entry from empty', () => {
        const Address = require('../core/ftn_address.js');
        const addr = new Address({ net: 104, node: 1 });
        const result = ftnUtil.getUpdatedPathEntries([], addr);
        assert.equal(result.length, 1);
        assert.ok(result[0].includes('104/1'));
    });

    it('appends to last line when it fits', () => {
        const Address = require('../core/ftn_address.js');
        const existing = ['104/1'];
        const addr = new Address({ net: 200, node: 7 });
        const result = ftnUtil.getUpdatedPathEntries(existing, addr);
        assert.equal(result.length, 1, 'should still be one line');
        assert.ok(result[0].includes('104/1'));
        assert.ok(result[0].includes('200/7'));
    });

    it('starts a new line when last line is full', () => {
        //  Fill the last line close to the 71-char limit
        const Address = require('../core/ftn_address.js');
        const longLine = Array.from({ length: 6 }, (_, i) => `${10000 + i}/1`).join(' ');
        assert.ok(longLine.length > 40); // confirm it's substantial
        const existing = [longLine];
        //  Add enough tokens to push over the limit
        const extra = Array.from({ length: 10 }, (_, i) => `${20000 + i}/1`);
        let result = existing;
        for (const e of extra) {
            const addr = new Address({ net: parseInt(e), node: 1 });
            result = ftnUtil.getUpdatedPathEntries(result, `${e}`);
        }
        assert.ok(result.length > 1, 'expected multiple PATH lines');
    });

    it('preserves insertion order (does not sort)', () => {
        const existing = ['300/5'];
        const result = ftnUtil.getUpdatedPathEntries(existing, '100/1');
        // 300/5 must appear before 100/1
        const joined = result.join(' ');
        const pos300 = joined.indexOf('300/5');
        const pos100 = joined.indexOf('100/1');
        assert.ok(pos300 < pos100, `order should be preserved: "${joined}"`);
    });
});

// -------------------------------------------------------------------------
// getDateFromFtnDateTime — format parsing
// -------------------------------------------------------------------------

describe('getDateFromFtnDateTime', () => {
    it('parses standard FTN date format', () => {
        const m = ftnUtil.getDateFromFtnDateTime('12 Sep 88 18:17:59');
        assert.ok(m.isValid(), 'should be valid moment');
        assert.equal(m.date(), 12);
        assert.equal(m.month(), 8); // 0-based: Sep = 8
        assert.equal(m.hours(), 18);
        assert.equal(m.minutes(), 17);
        assert.equal(m.seconds(), 59);
    });

    it('parses day-of-week prefix format', () => {
        const m = ftnUtil.getDateFromFtnDateTime('Tue 01 Jan 80 00:00');
        assert.ok(m.isValid());
        assert.equal(m.date(), 1);
        assert.equal(m.month(), 0); // Jan = 0
    });

    it('parses double-space time variant', () => {
        const m = ftnUtil.getDateFromFtnDateTime('27 Feb 15  00:00:03');
        assert.ok(m.isValid());
        assert.equal(m.date(), 27);
        assert.equal(m.month(), 1); // Feb = 1
    });
});
