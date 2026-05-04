'use strict';

const { strict: assert } = require('assert');
const crypto = require('crypto');
const {
    generateChallenge,
    computeResponse,
    verifyResponse,
} = require('../core/binkp/cram');

// ── generateChallenge ─────────────────────────────────────────────────────────

describe('generateChallenge', () => {
    it('returns a Buffer', () => {
        assert.ok(generateChallenge() instanceof Buffer);
    });

    it('returns exactly 16 bytes', () => {
        assert.equal(generateChallenge().length, 16);
    });

    it('returns different values on successive calls', () => {
        const a = generateChallenge();
        const b = generateChallenge();
        assert.notDeepEqual(
            a,
            b,
            'successive challenges should differ (with overwhelming probability)'
        );
    });
});

// ── computeResponse ───────────────────────────────────────────────────────────

describe('computeResponse', () => {
    it('returns a 32-character lowercase hex string', () => {
        const hex = generateChallenge().toString('hex');
        const response = computeResponse('password', hex);
        assert.equal(typeof response, 'string');
        assert.equal(response.length, 32);
        assert.match(response, /^[0-9a-f]+$/);
    });

    it('produces the correct HMAC-MD5 digest (known-answer)', () => {
        // Fixed inputs; expected value verified against Node.js crypto directly.
        // password='TestPassword', challenge=0x01..0x10
        const password = 'TestPassword';
        const challengeHex = '0102030405060708090a0b0c0d0e0f10';
        const response = computeResponse(password, challengeHex);
        assert.equal(response, '5b613239a702bb6b3658a4174b644f2d');
    });

    it('is deterministic — same inputs produce the same output', () => {
        const hex = generateChallenge().toString('hex');
        const r1 = computeResponse('s3cr3t', hex);
        const r2 = computeResponse('s3cr3t', hex);
        assert.equal(r1, r2);
    });

    it('differs when the password differs', () => {
        const hex = generateChallenge().toString('hex');
        assert.notEqual(computeResponse('pass1', hex), computeResponse('pass2', hex));
    });

    it('differs when the challenge differs', () => {
        const hex1 = generateChallenge().toString('hex');
        const hex2 = generateChallenge().toString('hex');
        if (hex1 === hex2) return; // astronomically unlikely; skip rather than fail
        assert.notEqual(computeResponse('pass', hex1), computeResponse('pass', hex2));
    });

    it('handles an empty password without throwing', () => {
        const hex = generateChallenge().toString('hex');
        assert.doesNotThrow(() => computeResponse('', hex));
    });

    it('handles a password with non-ASCII characters', () => {
        const hex = generateChallenge().toString('hex');
        assert.doesNotThrow(() => computeResponse('pässwörd', hex));
    });
});

// ── verifyResponse ────────────────────────────────────────────────────────────

describe('verifyResponse', () => {
    function makeScenario(password) {
        const challenge = generateChallenge();
        const challengeHex = challenge.toString('hex');
        const response = computeResponse(password, challengeHex);
        return { challengeHex, response };
    }

    it('returns true for a correct password', () => {
        const { challengeHex, response } = makeScenario('correcthorsebatterystaple');
        assert.ok(verifyResponse('correcthorsebatterystaple', challengeHex, response));
    });

    it('returns false for a wrong password', () => {
        const { challengeHex, response } = makeScenario('rightpassword');
        assert.ok(!verifyResponse('wrongpassword', challengeHex, response));
    });

    it('is case-insensitive on the response hex', () => {
        const { challengeHex, response } = makeScenario('pass');
        assert.ok(verifyResponse('pass', challengeHex, response.toUpperCase()));
        assert.ok(verifyResponse('pass', challengeHex, response.toLowerCase()));
    });

    it('rejects an all-zero response when password is non-empty', () => {
        const { challengeHex } = makeScenario('pass');
        assert.ok(!verifyResponse('pass', challengeHex, '0'.repeat(32)));
    });

    it('rejects a response that is one character off', () => {
        const { challengeHex, response } = makeScenario('pass');
        // Flip the last hex digit
        const flipped =
            response.slice(0, -1) + (response[response.length - 1] === 'f' ? '0' : 'f');
        assert.ok(!verifyResponse('pass', challengeHex, flipped));
    });

    it('uses timing-safe comparison (no TypeError for unequal lengths)', () => {
        // If lengths differ the function should return false, not throw
        const { challengeHex } = makeScenario('pass');
        assert.ok(!verifyResponse('pass', challengeHex, 'deadbeef')); // too short
        assert.ok(!verifyResponse('pass', challengeHex, '0'.repeat(64))); // too long
    });
});
