'use strict';

//
//  RFC 9421 HTTP Message Signatures: inbound verification only.
//
//  Mastodon (4.7+, as a retry after a 400/401) and Fedify (first, before
//  draft-cavage) sign ActivityPub requests this way. The draft-cavage path
//  stays in the web handler (http-signature); this module is used only
//  when a request carries a Signature-Input header.
//
//  It holds the small part of RFC 8941 (Structured Field Values) that the
//  Signature-Input, Signature and Content-Digest (RFC 9530) fields need: a
//  Dictionary / List / Inner List / Parameters parser, and a canonical
//  serializer for an Inner List with parameters (the @signature-params
//  line of the signature base).
//
//  Parsed values:
//    sf-string     -> JS string
//    sf-integer    -> JS number (an integer)
//    sf-decimal    -> SfDecimal
//    sf-token      -> SfToken
//    byte sequence -> Buffer
//    sf-boolean    -> true / false
//    a member      -> { value, params } (params: Map, in order)
//    inner list    -> { value: [ { value, params }, ... ], params }
//    dictionary    -> Map of key -> member
//

const crypto = require('crypto');

class SfToken {
    constructor(value) {
        this.value = value;
    }
}

class SfDecimal {
    constructor(value) {
        this.value = value;
    }
}

class StructuredFieldError extends Error {}

const DIGIT = /[0-9]/;
const ALPHA = /[A-Za-z]/;
const LCALPHA = /[a-z]/;
const KEY_CHAR = /[a-z0-9_\-.*]/;
//  RFC 9110 tchar, plus ":" and "/" which a token may also hold
const TOKEN_CHAR = /[!#$%&'*+\-.^_`|~0-9A-Za-z:/]/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

//  A parser over one field value. Each method consumes what it parses.
class SfParser {
    constructor(input) {
        if (typeof input !== 'string') {
            throw new StructuredFieldError('not a string');
        }
        //  ASCII only (RFC 8941 4.2 step 1)
        for (let i = 0; i < input.length; ++i) {
            if (input.charCodeAt(i) > 0x7f) {
                throw new StructuredFieldError('non-ASCII input');
            }
        }
        this.s = input;
        this.i = 0;
    }

    peek() {
        return this.s[this.i];
    }

    empty() {
        return this.i >= this.s.length;
    }

    fail(msg) {
        throw new StructuredFieldError(`${msg} at offset ${this.i}`);
    }

    skipSP() {
        while (this.s[this.i] === ' ') {
            ++this.i;
        }
    }

    skipOWS() {
        while (this.s[this.i] === ' ' || this.s[this.i] === '\t') {
            ++this.i;
        }
    }

    //  RFC 8941 4.2 steps 2, 6 and 7 around a top-level parse
    top(fn) {
        this.skipSP();
        const out = fn.call(this);
        this.skipSP();
        if (!this.empty()) {
            this.fail('trailing characters');
        }
        return out;
    }

    // 4.2.1
    list() {
        const members = [];
        while (!this.empty()) {
            members.push(this.itemOrInnerList());
            this.skipOWS();
            if (this.empty()) {
                return members;
            }
            if (this.s[this.i++] !== ',') {
                this.fail('expected ","');
            }
            this.skipOWS();
            if (this.empty()) {
                this.fail('trailing comma');
            }
        }
        return members;
    }

    // 4.2.1.1
    itemOrInnerList() {
        return this.peek() === '(' ? this.innerList() : this.item();
    }

    // 4.2.1.2
    innerList() {
        if (this.s[this.i++] !== '(') {
            this.fail('expected "("');
        }
        const value = [];
        while (!this.empty()) {
            this.skipSP();
            if (this.peek() === ')') {
                ++this.i;
                return { value, params: this.parameters() };
            }
            value.push(this.item());
            const c = this.peek();
            if (c !== ' ' && c !== ')') {
                this.fail('expected SP or ")"');
            }
        }
        this.fail('unterminated inner list');
    }

    // 4.2.2
    dictionary() {
        const dict = new Map();
        while (!this.empty()) {
            const key = this.key();
            let member;
            if (this.peek() === '=') {
                ++this.i;
                member = this.itemOrInnerList();
            } else {
                member = { value: true, params: this.parameters() };
            }
            //  a duplicate key overwrites, keeping its first position
            dict.set(key, member);
            this.skipOWS();
            if (this.empty()) {
                return dict;
            }
            if (this.s[this.i++] !== ',') {
                this.fail('expected ","');
            }
            this.skipOWS();
            if (this.empty()) {
                this.fail('trailing comma');
            }
        }
        return dict;
    }

    // 4.2.3
    item() {
        const value = this.bareItem();
        return { value, params: this.parameters() };
    }

    // 4.2.3.1
    bareItem() {
        const c = this.peek();
        if (c === undefined) {
            this.fail('expected an item');
        }
        if (c === '-' || DIGIT.test(c)) {
            return this.number();
        }
        if (c === '"') {
            return this.string();
        }
        if (c === '*' || ALPHA.test(c)) {
            return this.token();
        }
        if (c === ':') {
            return this.byteSequence();
        }
        if (c === '?') {
            return this.boolean();
        }
        this.fail('unrecognised item type');
    }

    // 4.2.3.2
    parameters() {
        const params = new Map();
        while (this.peek() === ';') {
            ++this.i;
            this.skipSP();
            const key = this.key();
            let value = true;
            if (this.peek() === '=') {
                ++this.i;
                value = this.bareItem();
            }
            params.set(key, value);
        }
        return params;
    }

    // 4.2.3.3
    key() {
        const c = this.peek();
        if (c === undefined || (c !== '*' && !LCALPHA.test(c))) {
            this.fail('expected a key');
        }
        const start = this.i;
        while (!this.empty() && KEY_CHAR.test(this.peek())) {
            ++this.i;
        }
        return this.s.slice(start, this.i);
    }

    // 4.2.4
    number() {
        let sign = 1;
        if (this.peek() === '-') {
            sign = -1;
            ++this.i;
        }
        if (this.empty()) {
            this.fail('empty integer');
        }
        if (!DIGIT.test(this.peek())) {
            this.fail('expected a digit');
        }
        let decimal = false;
        let num = '';
        while (!this.empty()) {
            const c = this.peek();
            if (DIGIT.test(c)) {
                num += c;
            } else if (!decimal && c === '.') {
                if (num.length > 12) {
                    this.fail('decimal too long');
                }
                num += c;
                decimal = true;
            } else {
                break;
            }
            ++this.i;
            if (!decimal && num.length > 15) {
                this.fail('integer too long');
            }
            if (decimal && num.length > 16) {
                this.fail('decimal too long');
            }
        }
        if (!decimal) {
            return sign * parseInt(num, 10);
        }
        if (num.endsWith('.')) {
            this.fail('decimal ends with "."');
        }
        if (num.length - num.indexOf('.') - 1 > 3) {
            this.fail('decimal has more than 3 fractional digits');
        }
        return new SfDecimal(sign * parseFloat(num));
    }

    // 4.2.5
    string() {
        if (this.s[this.i++] !== '"') {
            this.fail('expected DQUOTE');
        }
        let out = '';
        while (!this.empty()) {
            const c = this.s[this.i++];
            if (c === '\\') {
                if (this.empty()) {
                    this.fail('unterminated escape');
                }
                const next = this.s[this.i++];
                if (next !== '"' && next !== '\\') {
                    this.fail('bad escape');
                }
                out += next;
            } else if (c === '"') {
                return out;
            } else {
                const code = c.charCodeAt(0);
                if (code < 0x20 || code > 0x7e) {
                    this.fail('bad character in string');
                }
                out += c;
            }
        }
        this.fail('unterminated string');
    }

    // 4.2.6
    token() {
        const c = this.peek();
        if (c !== '*' && !ALPHA.test(c)) {
            this.fail('expected a token');
        }
        const start = this.i;
        while (!this.empty() && TOKEN_CHAR.test(this.peek())) {
            ++this.i;
        }
        return new SfToken(this.s.slice(start, this.i));
    }

    // 4.2.7
    byteSequence() {
        if (this.s[this.i++] !== ':') {
            this.fail('expected ":"');
        }
        const end = this.s.indexOf(':', this.i);
        if (end < 0) {
            this.fail('unterminated byte sequence');
        }
        const b64 = this.s.slice(this.i, end);
        this.i = end + 1;
        if (!BASE64.test(b64)) {
            this.fail('bad base64 in byte sequence');
        }
        return Buffer.from(b64, 'base64');
    }

    // 4.2.8
    boolean() {
        if (this.s[this.i++] !== '?') {
            this.fail('expected "?"');
        }
        const c = this.s[this.i++];
        if (c === '1') {
            return true;
        }
        if (c === '0') {
            return false;
        }
        this.fail('bad boolean');
    }
}

function parseDictionary(value) {
    const p = new SfParser(value);
    return p.top(p.dictionary);
}

function parseList(value) {
    const p = new SfParser(value);
    return p.top(p.list);
}

function parseItem(value) {
    const p = new SfParser(value);
    return p.top(p.item);
}

//
//  Serialization (RFC 8941 4.1), for what an @signature-params line holds
//
function serializeKey(key) {
    if (!/^[a-z*][a-z0-9_\-.*]*$/.test(key)) {
        throw new StructuredFieldError(`bad key "${key}"`);
    }
    return key;
}

function serializeBareItem(v) {
    if (typeof v === 'string') {
        for (let i = 0; i < v.length; ++i) {
            const code = v.charCodeAt(i);
            if (code < 0x20 || code > 0x7e) {
                throw new StructuredFieldError('bad character in string');
            }
        }
        return `"${v.replace(/[\\"]/g, c => `\\${c}`)}"`;
    }
    if (typeof v === 'number') {
        if (!Number.isInteger(v) || Math.abs(v) > 999999999999999) {
            throw new StructuredFieldError('bad integer');
        }
        return String(v);
    }
    if (typeof v === 'boolean') {
        return v ? '?1' : '?0';
    }
    if (v instanceof SfToken) {
        return v.value;
    }
    if (v instanceof SfDecimal) {
        //  rounded to 3 fractional digits, at least one shown (4.1.5)
        const rounded = Math.round(v.value * 1000) / 1000;
        const s = String(rounded);
        return s.includes('.') ? s : `${s}.0`;
    }
    if (Buffer.isBuffer(v)) {
        return `:${v.toString('base64')}:`;
    }
    throw new StructuredFieldError('unsupported item type');
}

function serializeParameters(params) {
    let out = '';
    for (const [key, value] of params || []) {
        out += `;${serializeKey(key)}`;
        if (value !== true) {
            out += `=${serializeBareItem(value)}`;
        }
    }
    return out;
}

// 4.1.1.1
function serializeInnerList(innerList) {
    const items = innerList.value
        .map(item => serializeBareItem(item.value) + serializeParameters(item.params))
        .join(' ');
    return `(${items})${serializeParameters(innerList.params)}`;
}

//
//  Request side
//

//  All values of one header field, in order (several field lines included)
function fieldValues(req, name) {
    const own = (obj, key) => !!obj && Object.prototype.hasOwnProperty.call(obj, key);
    if (own(req.headersDistinct, name) && Array.isArray(req.headersDistinct[name])) {
        return req.headersDistinct[name];
    }
    const v = own(req.headers, name) ? req.headers[name] : undefined;
    if (v === undefined || v === null) {
        return [];
    }
    return Array.isArray(v) ? v : [String(v)];
}

//  The combined value of a header field (RFC 9421 2.1), or null when absent
function fieldValue(req, name) {
    const values = fieldValues(req, name);
    if (values.length === 0) {
        return null;
    }
    return values.map(v => String(v).trim()).join(', ');
}

//  Derived components this module can produce for a request
const DerivedComponents = new Set([
    '@method',
    '@target-uri',
    '@authority',
    '@scheme',
    '@request-target',
    '@path',
    '@query',
]);

//  Signature parameters with the type each must have
const SignatureParamTypes = {
    created: 'integer',
    expires: 'integer',
    keyid: 'string',
    alg: 'string',
    nonce: 'string',
    tag: 'string',
};

class SignatureError extends Error {}

//
//  Parse Signature-Input and Signature. The first label in Signature-Input
//  that has a Signature entry is used; any others are ignored.
//
//  Returns { label, components: [{ name, params }], params, sigBytes,
//  innerList } or throws SignatureError.
//
function parseRequestSignature(req) {
    const inputValue = fieldValue(req, 'signature-input');
    const sigValue = fieldValue(req, 'signature');
    if (inputValue === null) {
        throw new SignatureError('no Signature-Input header');
    }
    if (sigValue === null) {
        throw new SignatureError('no Signature header');
    }

    let inputs, sigs;
    try {
        inputs = parseDictionary(inputValue);
        sigs = parseDictionary(sigValue);
    } catch (e) {
        throw new SignatureError(`malformed signature header: ${e.message}`);
    }

    const label = [...inputs.keys()].find(l => sigs.has(l));
    if (!label) {
        throw new SignatureError('no Signature-Input label has a Signature');
    }

    const innerList = inputs.get(label);
    if (!Array.isArray(innerList.value)) {
        throw new SignatureError('Signature-Input member is not an inner list');
    }
    const sigBytes = sigs.get(label).value;
    if (!Buffer.isBuffer(sigBytes)) {
        throw new SignatureError('Signature member is not a byte sequence');
    }

    const seen = new Set();
    const components = innerList.value.map(item => {
        if (typeof item.value !== 'string') {
            throw new SignatureError('component identifier is not a string');
        }
        const name = item.value;
        if (item.params.size > 0) {
            throw new SignatureError(
                `unsupported parameter on component "${name}": ${[
                    ...item.params.keys(),
                ].join(', ')}`
            );
        }
        if (name !== name.toLowerCase()) {
            throw new SignatureError(`component name "${name}" is not lower case`);
        }
        if (seen.has(name)) {
            throw new SignatureError(`component "${name}" is listed twice`);
        }
        seen.add(name);
        if (name.startsWith('@') && !DerivedComponents.has(name)) {
            throw new SignatureError(`unsupported derived component "${name}"`);
        }
        return { name, params: item.params };
    });

    const params = {};
    for (const [key, value] of innerList.params) {
        const type = SignatureParamTypes[key];
        if (!type) {
            continue; // unregistered parameter: still serialized in the base
        }
        const ok =
            type === 'integer'
                ? typeof value === 'number' && Number.isInteger(value)
                : typeof value === 'string';
        if (!ok) {
            throw new SignatureError(`signature parameter "${key}" is not ${type}`);
        }
        params[key] = value;
    }

    return { label, components, params, sigBytes, innerList };
}

//  The authority of a URL: host lower-cased, default port dropped (URL does both)
function authorityOf(url) {
    return url.host.toLowerCase();
}

function derivedValue(name, req, fullUrl) {
    switch (name) {
        case '@method':
            return String(req.method);
        case '@target-uri':
            return fullUrl.href;
        case '@authority':
            return authorityOf(fullUrl);
        case '@scheme':
            return fullUrl.protocol.replace(/:$/, '').toLowerCase();
        case '@request-target':
            return fullUrl.pathname + fullUrl.search;
        case '@path':
            return fullUrl.pathname || '/';
        case '@query':
            return fullUrl.search || '?';
    }
    throw new SignatureError(`unsupported derived component "${name}"`);
}

//
//  Build the signature base (RFC 9421 2.5) for |parsed| over |req|.
//
//  fullUrl — the request's target URI, a URL. The web handler passes
//            getFullUrl(req): the configured base URL plus req.url, so
//            @target-uri / @authority name the URL the sender posted to
//            whatever a reverse proxy did to Host or the scheme.
//
function signatureBase(req, parsed, fullUrl) {
    const lines = parsed.components.map(({ name, params }) => {
        const id = serializeBareItem(name) + serializeParameters(params);
        let value;
        if (name.startsWith('@')) {
            value = derivedValue(name, req, fullUrl);
        } else {
            value = fieldValue(req, name);
            if (value === null) {
                throw new SignatureError(`covered header "${name}" is missing`);
            }
        }
        return `${id}: ${value}`;
    });
    lines.push(`"@signature-params": ${serializeInnerList(parsed.innerList)}`);
    const base = lines.join('\n');
    for (let i = 0; i < base.length; ++i) {
        if (base.charCodeAt(i) > 0x7f) {
            throw new SignatureError('signature base is not ASCII');
        }
    }
    return base;
}

//  Algorithms we verify, and the key type each needs
const Algorithms = {
    'rsa-v1_5-sha256': { keyType: 'rsa' },
    'rsa-pss-sha512': { keyType: 'rsa' },
    'ecdsa-p256-sha256': { keyType: 'ec', curve: 'prime256v1' },
    ed25519: { keyType: 'ed25519' },
};

//  The algorithm a key implies when the signature names none
function defaultAlgorithm(key) {
    switch (key.asymmetricKeyType) {
        case 'rsa':
            return 'rsa-v1_5-sha256';
        case 'ed25519':
            return 'ed25519';
        case 'ec':
            return key.asymmetricKeyDetails &&
                key.asymmetricKeyDetails.namedCurve === 'prime256v1'
                ? 'ecdsa-p256-sha256'
                : null;
    }
    return null;
}

//
//  Verify |sigBytes| over |base| with |alg| and |key| (a KeyObject or PEM).
//  Throws SignatureError when the algorithm is unsupported or does not fit
//  the key; returns the cryptographic result otherwise.
//
function verifySignatureBytes(alg, base, sigBytes, key) {
    const keyObject = typeof key === 'string' ? crypto.createPublicKey(key) : key;
    const spec = Algorithms[alg];
    if (!spec) {
        throw new SignatureError(`unsupported algorithm "${alg}"`);
    }
    if (keyObject.asymmetricKeyType !== spec.keyType) {
        throw new SignatureError(
            `algorithm "${alg}" does not match a ${keyObject.asymmetricKeyType} key`
        );
    }
    if (
        spec.curve &&
        (!keyObject.asymmetricKeyDetails ||
            keyObject.asymmetricKeyDetails.namedCurve !== spec.curve)
    ) {
        throw new SignatureError(`algorithm "${alg}" does not match the key's curve`);
    }

    const data = Buffer.from(base, 'ascii');
    switch (alg) {
        case 'rsa-v1_5-sha256':
            return crypto.verify(
                'sha256',
                data,
                { key: keyObject, padding: crypto.constants.RSA_PKCS1_PADDING },
                sigBytes
            );
        case 'rsa-pss-sha512':
            return crypto.verify(
                'sha512',
                data,
                {
                    key: keyObject,
                    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
                    saltLength: 64,
                },
                sigBytes
            );
        case 'ecdsa-p256-sha256':
            return crypto.verify(
                'sha256',
                data,
                { key: keyObject, dsaEncoding: 'ieee-p1363' },
                sigBytes
            );
        case 'ed25519':
            return crypto.verify(null, data, keyObject, sigBytes);
    }
    return false;
}

//
//  Verify a parsed signature over its base with the signer's public key
//  (PEM). The algorithm is the signature's alg parameter when present,
//  otherwise the one the key implies. Returns true or false; a malformed
//  key, an unsupported algorithm or one that does not fit the key is false.
//
function verify(parsed, base, publicKeyPem) {
    try {
        const key = crypto.createPublicKey(publicKeyPem);
        const alg = parsed.params.alg || defaultAlgorithm(key);
        if (!alg) {
            return false;
        }
        return verifySignatureBytes(alg, base, parsed.sigBytes, key);
    } catch {
        return false;
    }
}

module.exports = {
    SfToken,
    SfDecimal,
    StructuredFieldError,
    SignatureError,
    parseDictionary,
    parseList,
    parseItem,
    serializeInnerList,
    fieldValue,
    parseRequestSignature,
    signatureBase,
    verify,
    verifySignatureBytes,
};
