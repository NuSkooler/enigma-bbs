'use strict';

const crypto = require('crypto');

const CHALLENGE_LENGTH = 16;

function generateChallenge() {
    return crypto.randomBytes(CHALLENGE_LENGTH);
}

// HMAC-MD5(password, challenge_bytes) -> lowercase hex
function computeResponse(password, challengeHex) {
    const challenge = Buffer.from(challengeHex, 'hex');
    return crypto
        .createHmac('md5', Buffer.from(password, 'binary'))
        .update(challenge)
        .digest('hex');
}

function verifyResponse(password, challengeHex, responseHex) {
    const expected = computeResponse(password, challengeHex);
    // Constant-time compare to avoid timing attacks
    const a = Buffer.from(expected.toLowerCase(), 'hex');
    const b = Buffer.from(responseHex.toLowerCase(), 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

module.exports = { generateChallenge, computeResponse, verifyResponse };
