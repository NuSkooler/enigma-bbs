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

//
//  Address.isEquivalent — "is this the same system?", as distinct from
//  isEqual()'s "was this written identically".
//
//  This is the loop guard for FTN control data. FSC-0087 requires a file
//  forwarder to understand 2D through 5D and explicitly permits rewriting
//  address dimensions per downlink, so a TIC's Seenby list routinely names the
//  same system in a different shape than our config does. Comparing those
//  strictly means failing to notice a node has already seen a file, and
//  forwarding it to them again -- a loop.
//
describe('Address.isEquivalent', () => {
    const addr = s => Address.fromString(s);

    it('matches an address against itself', () => {
        assert.ok(addr('21:1/100').isEquivalent(addr('21:1/100')));
    });

    it('accepts a string on the right-hand side', () => {
        assert.ok(addr('21:1/100').isEquivalent('21:1/100'));
    });

    it('distinguishes different nodes and nets', () => {
        assert.ok(!addr('21:1/100').isEquivalent(addr('21:1/101')));
        assert.ok(!addr('21:1/100').isEquivalent(addr('21:2/100')));
    });

    it('treats an absent point and point 0 as the same system', () => {
        //  FTS-5006 Seenby lists carry both forms; isEqual() says these differ.
        assert.ok(addr('21:1/100').isEquivalent(addr('21:1/100.0')));
        assert.ok(addr('21:1/100.0').isEquivalent(addr('21:1/100')));
    });

    it('still distinguishes a real point from its boss node', () => {
        assert.ok(!addr('21:1/100').isEquivalent(addr('21:1/100.4')));
        assert.ok(!addr('21:1/100.4').isEquivalent(addr('21:1/100.5')));
    });

    it('ignores a domain that only one side states', () => {
        //  A 3D address is not asserting a *different* network.
        assert.ok(addr('21:1/100').isEquivalent(addr('21:1/100@fsxnet')));
        assert.ok(addr('21:1/100@fsxnet').isEquivalent(addr('21:1/100')));
    });

    it('compares two stated domains, without regard to case', () => {
        assert.ok(addr('21:1/100@fsxnet').isEquivalent(addr('21:1/100@FsxNet')));
        assert.ok(!addr('21:1/100@fsxnet').isEquivalent(addr('21:1/100@agoranet')));
    });

    it('fills a missing zone from defaultZone', () => {
        //  FSC-0087's own examples are zone-less ("To 292/854").
        const twoD = addr('1/100');
        assert.ok(twoD.isEquivalent(addr('21:1/100'), { defaultZone: 21 }));
        assert.ok(addr('21:1/100').isEquivalent(twoD, { defaultZone: 21 }));
    });

    it('does not match across zones when defaultZone disagrees', () => {
        assert.ok(!addr('1/100').isEquivalent(addr('21:1/100'), { defaultZone: 10 }));
    });

    it('without a defaultZone, a zone-less address matches only another', () => {
        //  The safe direction: no false "already seen".
        assert.ok(!addr('1/100').isEquivalent(addr('21:1/100')));
        assert.ok(addr('1/100').isEquivalent(addr('1/100')));
    });

    it('is false for an unparsable or absent other', () => {
        assert.ok(!addr('21:1/100').isEquivalent(undefined));
        assert.ok(!addr('21:1/100').isEquivalent('not an address'));
    });

    it('is more permissive than isEqual, deliberately', () => {
        //  Guards the distinction itself: if these ever agree, one of them has
        //  lost its purpose.
        const a = addr('21:1/100');
        const b = addr('21:1/100.0');
        assert.ok(!a.isEqual(b), 'isEqual is strict');
        assert.ok(a.isEquivalent(b), 'isEquivalent is not');
    });
});

describe('Address.isAnyOf', () => {
    const addr = s => Address.fromString(s);

    it('finds a match anywhere in the list', () => {
        //  "Is this us?" must span every local AKA across every network.
        const ours = ['21:1/100', '10:101/50@araknet', '1/9'];
        assert.ok(addr('10:101/50').isAnyOf(ours));
        assert.ok(addr('21:1/100.0').isAnyOf(ours));
    });

    it('is false when nothing matches', () => {
        assert.ok(!addr('21:1/200').isAnyOf(['21:1/100', '10:101/50']));
    });

    it('handles an empty or absent list', () => {
        assert.ok(!addr('21:1/100').isAnyOf([]));
        assert.ok(!addr('21:1/100').isAnyOf(undefined));
    });

    it('passes options through', () => {
        assert.ok(addr('1/100').isAnyOf(['21:1/100'], { defaultZone: 21 }));
        assert.ok(!addr('1/100').isAnyOf(['21:1/100']));
    });
});

describe('Address.getComparator', () => {
    it('orders points under their boss node, ascending', () => {
        const sorted = ['21:1/100.4', '21:1/100', '21:2/50', '21:1/100.1', '20:1/1']
            .map(s => Address.fromString(s))
            .sort(Address.getComparator())
            .map(a => a.toString('4D'));

        assert.deepEqual(sorted, [
            '20:1/1',
            '21:1/100',
            '21:1/100.1',
            '21:1/100.4',
            '21:2/50',
        ]);
    });

    it('is stable for a node and its points', () => {
        //  Previously the comparator ignored |point| entirely, so a node and
        //  its points compared equal and their order was arbitrary.
        const cmp = Address.getComparator();
        const node = Address.fromString('21:1/100');
        const point = Address.fromString('21:1/100.1');
        assert.ok(cmp(node, point) < 0);
        assert.ok(cmp(point, node) > 0);
    });
});
