/* jslint node: true */
'use strict';

//
//  Client addresses behind reverse proxies.
//
//  A request that arrives through a reverse proxy (nginx, Caddy, Traefik, ...)
//  comes from the proxy's address; the client's address is in the headers the
//  proxy adds. Those headers are only believed when the connecting peer is
//  listed in |trustedProxies|. Anyone else could have written them.
//
//  Only X-Forwarded-For and X-Real-IP are understood. Forwarded (RFC 7239) is
//  not.
//

//  deps
const net = require('net');
const { get, isString } = require('lodash');

const MappedIPv4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

//  config hot-reloads: the parsed list is rebuilt when the setting changes
let cachedKey;
let cachedList;

//  each invalid entry is reported once, not on every request
const warnedEntries = new Set();

function warnInvalidEntry(entry) {
    const key = JSON.stringify(entry);
    if (warnedEntries.has(key)) {
        return;
    }
    warnedEntries.add(key);

    const Log = require('./logger.js').log;
    if (Log) {
        Log.warn(
            { entry },
            'Ignoring invalid trustedProxies entry; expected an IP address or CIDR'
        );
    }
}

//  '::ffff:a.b.c.d' -> 'a.b.c.d'; anything else unchanged
function unmapIPv4(address) {
    const m = MappedIPv4.exec(address);
    return m ? m[1] : address;
}

//  One trustedProxies entry -> { address, family, prefix? } or null
function parseEntry(entry) {
    if (!isString(entry)) {
        return null;
    }

    const parts = entry.trim().split('/');
    if (parts.length > 2) {
        return null;
    }

    let address = parts[0];
    if (2 === parts.length) {
        const family = net.isIP(address);
        if (!family || !/^\d{1,3}$/.test(parts[1])) {
            return null;
        }
        const prefix = parseInt(parts[1], 10);
        if (prefix > (4 === family ? 32 : 128)) {
            return null;
        }
        return { address, family, prefix };
    }

    address = unmapIPv4(address);
    const family = net.isIP(address);
    return family ? { address, family } : null;
}

function buildList(entries) {
    const list = new net.BlockList();

    if (isString(entries)) {
        entries = [entries];
    } else if (!Array.isArray(entries)) {
        if (undefined !== entries && null !== entries) {
            warnInvalidEntry(entries);
        }
        return list;
    }

    for (const entry of entries) {
        const rule = parseEntry(entry);
        if (!rule) {
            warnInvalidEntry(entry);
            continue;
        }

        const type = 4 === rule.family ? 'ipv4' : 'ipv6';
        if (undefined === rule.prefix) {
            list.addAddress(rule.address, type);
        } else {
            list.addSubnet(rule.address, rule.prefix, type);
        }
    }

    return list;
}

function getTrustedList(entries) {
    if (undefined === entries) {
        //  looked up at call time so a test config, or a reload, is seen
        entries = get(require('./config.js').get(), 'trustedProxies');
    }

    const key = JSON.stringify(entries === undefined ? null : entries);
    if (key !== cachedKey) {
        cachedList = buildList(entries);
        cachedKey = key;
    }
    return cachedList;
}

function isTrustedAddress(list, address) {
    if (!isString(address)) {
        return false;
    }

    address = unmapIPv4(address);
    const family = net.isIP(address);
    if (!family) {
        return false;
    }

    try {
        return list.check(address, 4 === family ? 'ipv4' : 'ipv6');
    } catch (e) {
        return false;
    }
}

//  Is |address| one of |trustedProxies| (default: the configured setting)?
function isTrustedProxy(address, trustedProxies) {
    return isTrustedAddress(getTrustedList(trustedProxies), address);
}

//  A single X-Forwarded-For / X-Real-IP entry -> a bare IP address, or null.
//  Tolerates "[v6]", "[v6]:port" and "a.b.c.d:port". IPv6 zone ids ("%eth0")
//  are rejected. An IPv4-mapped address comes back as plain IPv4, so both
//  spellings of one client are the same address.
function normalizeAddress(value) {
    const s = value.trim();
    if (s.includes('%')) {
        return null;
    }

    let m = /^\[([^\]]+)\](?::\d+)?$/.exec(s);
    if (m) {
        return 6 === net.isIP(m[1]) ? unmapIPv4(m[1]) : null;
    }

    m = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(s);
    const address = m ? m[1] : s;
    return net.isIP(address) ? unmapIPv4(address) : null;
}

//  A header's value as one string; repeated headers are joined
function headerValue(headers, name) {
    const value = headers ? headers[name] : undefined;
    if (Array.isArray(value)) {
        return value.join(',');
    }
    return isString(value) ? value : '';
}

const ForwardedHeaders = ['x-forwarded-for', 'x-real-ip', 'x-forwarded-proto'];

function hasForwardedHeaders(headers) {
    return ForwardedHeaders.some(name => headerValue(headers, name).trim().length > 0);
}

//  The client address from X-Forwarded-For, or null if there is none usable.
//
//  Proxies append the address they received the request from, so the header
//  is read right to left: the first entry that is not itself a trusted proxy
//  is the client. Anything left of that was written by the client and is not
//  believed. An entry that is not an IP address ends the walk at the nearest
//  hop already accepted.
function fromForwardedFor(headers, list) {
    const entries = headerValue(headers, 'x-forwarded-for')
        .split(',')
        .filter(e => e.trim().length > 0);

    let lastGood = null;
    for (let i = entries.length - 1; i >= 0; --i) {
        const address = normalizeAddress(entries[i]);
        if (!address) {
            break;
        }

        lastGood = address;
        if (!isTrustedAddress(list, address)) {
            return address;
        }
    }

    //  every entry trusted (the left-most then) or the walk was cut short
    return lastGood;
}

//
//  Work out a client's address from its connection and request headers.
//
//  |peerAddress|       the socket's remote address
//  |headers|           request headers (lowercase names, as Node gives them)
//  |trustedProxies|    optional; defaults to the trustedProxies setting
//
//  Returns { address, forwarded, peerTrusted }:
//  |forwarded| is true when |address| came from a forwarded header rather
//  than the socket; |peerTrusted| is whether the peer is a trusted proxy.
//
function getClientAddress({ peerAddress, headers, trustedProxies } = {}) {
    const list = getTrustedList(trustedProxies);
    const peerTrusted = isTrustedAddress(list, peerAddress);

    if (peerTrusted) {
        let address = fromForwardedFor(headers, list);
        if (!address) {
            //  a single address only; repeated headers arrive comma joined
            address = normalizeAddress(headerValue(headers, 'x-real-ip'));
        }

        if (address) {
            return { address, forwarded: true, peerTrusted };
        }
    }

    return { address: peerAddress, forwarded: false, peerTrusted };
}

//  The client address of an HTTP request
function getRequestClientAddress(req) {
    return getClientAddress({
        peerAddress: req.socket && req.socket.remoteAddress,
        headers: req.headers,
    }).address;
}

module.exports = {
    getClientAddress,
    getRequestClientAddress,
    isTrustedProxy,
    hasForwardedHeaders,
    headerValue,
};
