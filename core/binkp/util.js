'use strict';

const _ = require('lodash');
const Address = require('../ftn_address.js');
const { BsoSpool } = require('./bso_spool.js');

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
//  |addr| can be an Address instance or anything with the same shape.
//
//  The scoring itself lives on Address so the FTN/BSO tosser can apply the
//  same rule to its own pattern-keyed tables (nodes{}, NetMail routes{})
//  without reaching into the BinkP module.
//
function findBestNodeMatch(nodes, addr) {
    if (_.isEmpty(nodes)) return undefined;
    const best = Address.findBestPatternMatch(nodes, addr);
    return best ? best.value : undefined;
}

//
//  A BsoSpool for the current configuration.
//
//  Build one at the point of use and throw it away -- never cache it in a
//  closure. config.hjson is hot-reloadable, so a poll or an inbound session
//  starting after a reload has to honour the new paths and networks. Holding
//  a spool built at startup silently pins the process to boot-time config.
//
//  |config| is the full Config() object, as with localAddresses() above.
//
function buildSpool(config) {
    const ftnBsoCfg = _.get(config, 'scannerTossers.ftn_bso', {});
    return new BsoSpool({
        paths: ftnBsoCfg.paths,
        networks: _.get(config, 'messageNetworks.ftn.networks', {}),
        defaultNetwork: ftnBsoCfg.defaultNetwork,
        staleLockMaxAgeMs: _.get(ftnBsoCfg, 'binkp.staleLockMaxAgeMs'),
        flowRefWarnRepeatMs: _.get(ftnBsoCfg, 'binkp.flowRefWarnRepeatMs'),
    });
}

module.exports = { localAddresses, addressKey, findBestNodeMatch, buildSpool };
