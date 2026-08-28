'use strict';

const { strict: assert } = require('assert');

const Address = require('../core/ftn_address.js');

// ── Address.findBestPatternMatch ──────────────────────────────────────────────
//
//  Several FTN patterns can match one address, and configuration routinely
//  pairs a catch-all with more specific overrides. Picking the first match in
//  object iteration order makes the winner depend on nothing but the order the
//  sysop happened to write config.hjson -- a catch-all at the top silently
//  shadows every override below it. These pin the "most specific wins" rule
//  that nodes{}, the NetMail routes{} table and binkp.nodes{} all share.

describe('Address.findBestPatternMatch', () => {
    const ADDR = Address.fromString('21:1/100');

    it('returns undefined for an empty or absent table', () => {
        assert.equal(Address.findBestPatternMatch({}, ADDR), undefined);
        assert.equal(Address.findBestPatternMatch(null, ADDR), undefined);
        assert.equal(Address.findBestPatternMatch(undefined, ADDR), undefined);
    });

    it('returns undefined when nothing matches', () => {
        assert.equal(Address.findBestPatternMatch({ '46:*': 'other' }, ADDR), undefined);
    });

    it('returns the pattern alongside the value', () => {
        const got = Address.findBestPatternMatch({ '21:*': 'zone' }, ADDR);
        assert.deepEqual(got, { pattern: '21:*', value: 'zone' });
    });

    it('prefers an exact address over a zone wildcard, listed first', () => {
        const got = Address.findBestPatternMatch(
            { '21:1/100': 'exact', '21:*': 'zone' },
            ADDR
        );
        assert.equal(got.value, 'exact');
    });

    it('prefers an exact address over a zone wildcard, listed last', () => {
        const got = Address.findBestPatternMatch(
            { '21:*': 'zone', '21:1/100': 'exact' },
            ADDR
        );
        assert.equal(got.value, 'exact');
    });

    it('prefers a zone wildcard over a bare catch-all', () => {
        const got = Address.findBestPatternMatch(
            { '*': 'everything', '21:*': 'zone' },
            ADDR
        );
        assert.equal(got.value, 'zone');
    });

    it('prefers a net wildcard over a zone wildcard', () => {
        const got = Address.findBestPatternMatch(
            { '21:*': 'zone', '21:1/*': 'net' },
            ADDR
        );
        assert.equal(got.value, 'net');
    });

    it('falls back to the catch-all when nothing more specific matches', () => {
        const got = Address.findBestPatternMatch(
            { '21:*': 'zone', '*': 'everything' },
            Address.fromString('2:280/464')
        );
        assert.equal(got.value, 'everything');
    });

    it('accepts a plain address-shaped object', () => {
        const got = Address.findBestPatternMatch(
            { '21:1/100': 'exact' },
            { zone: 21, net: 1, node: 100 }
        );
        assert.equal(got.value, 'exact');
    });

    it('distinguishes a point from its boss node', () => {
        const table = { '21:1/100': 'boss', '21:1/100.5': 'point' };
        assert.equal(
            Address.findBestPatternMatch(table, Address.fromString('21:1/100.5')).value,
            'point'
        );
        assert.equal(Address.findBestPatternMatch(table, ADDR).value, 'boss');
    });
});
