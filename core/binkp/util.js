'use strict';

const _ = require('lodash');
const Address = require('../ftn_address.js');

//  Helpers shared across the BinkP module surface (caller, scanner_tosser).
//  Anything reaching for `messageNetworks.ftn.networks` or the in-memory
//  zone:net/node dedupe key should source it from here so the three
//  callsites can't drift.

//
//  Configured local FTN addresses across every network. Returns an array of
//  address strings (e.g. "21:1/100"); networks without |localAddress| are
//  silently dropped.
//
//  |config| is the full Config() object (so caller modules don't have to
//  re-derive the lookup path).
//
function localAddresses(config) {
    const networks = _.get(config, 'messageNetworks.ftn.networks', {});
    return Object.values(networks)
        .map(n => n.localAddress)
        .filter(Boolean);
}

//
//  Stable in-memory key for an Address. Used to dedupe the union of pending
//  + force-poll addresses in pollNodes(), and as the Map key for the
//  crashmail pending-dispatch set. Not used for filesystem paths (those are
//  the BSO 4-hex-net+4-hex-node convention from bso_spool.nodeBaseName).
//
function addressKey(addr) {
    return `${addr.zone || 0}:${addr.net}/${addr.node}`;
}

//
//  Find the most-specific node config entry whose address pattern matches
//  |addr|. |nodes| is the keyed object from binkp.nodes — keys are FTN
//  patterns (concrete or wildcard), values are node config blocks.
//
//  Returns the matching node config, or undefined if nothing matches.
//
//  Why "most specific" rather than first-match: configs frequently have a
//  catch-all wildcard ("21:*") alongside specific overrides ("21:1/100");
//  a first-match-wins on object iteration order means the catch-all could
//  shadow the override depending on how the user wrote the HJSON. Scoring
//  by Address#getMatchScore makes the result deterministic and intuitive.
//
//  |addr| can be an Address instance or anything with the same shape; we
//  wrap it in Address only to call getMatchScore.
//
function findBestNodeMatch(nodes, addr) {
    if (_.isEmpty(nodes)) return undefined;
    const a = addr instanceof Address ? addr : new Address(addr);

    let bestScore = 0;
    let bestConf;
    for (const [pattern, conf] of Object.entries(nodes)) {
        if (!a.isPatternMatch(pattern)) continue;
        const score = a.getMatchScore(pattern);
        if (score > bestScore) {
            bestScore = score;
            bestConf = conf;
        }
    }
    return bestConf;
}

module.exports = { localAddresses, addressKey, findBestNodeMatch };
