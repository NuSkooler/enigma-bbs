/* jslint node: true */
'use strict';

const Address = require('./ftn_address.js');

//
//  Shared BSO (Binkley Style Outbound) spool path resolution.
//
//  Two subsystems read and write the same outbound spool:
//
//    * core/scanner_tossers/ftn_bso.js — the writer; scans message areas and
//      drops .pkt/bundle files plus flow file references into the spool.
//    * core/binkp/bso_spool.js         — the reader; the native BinkP mailer's
//      filesystem adapter, which finds those files and ships them.
//
//  They must agree, byte for byte, on the directory a given (network, zone)
//  pair maps to. They previously each carried their own implementation and
//  drifted apart (see issue #719): with two or more networks configured and no
//  explicit |defaultNetwork|, the writer treated *every* network as non-default
//  while the reader always treated the first-listed one as default. Outbound
//  mail for that network was written to one directory and looked for in
//  another, so it silently never shipped.
//
//  Everything here is pure and takes its configuration by argument so both
//  callers - and tests - can drive it without a live Config(). Nothing in this
//  module logs; see validateOutboundConfig() for the diagnostics surface.
//

//
//  BSO outbound directory naming, for reference:
//
//    <paths.outbound>/outbound/          default network, its default zone
//    <paths.outbound>/outbound.<zzz>/    default network, other zone <zzz> (3 hex)
//    <paths.outbound>/<network>/         non-default network, its default zone
//    <paths.outbound>/<network>.<zzz>/   non-default network, other zone
//
//  Directory components are always lowercased: the network name is a config
//  key chosen by the sysop and may be mixed case (e.g. "fsxNet"), but the
//  on-disk name must be stable across both subsystems on case-sensitive
//  filesystems.
//
const DEFAULT_NETWORK_DIR_NAME = 'outbound';

function networkNames(networks) {
    return networks && 'object' === typeof networks ? Object.keys(networks) : [];
}

//
//  Canonical (as-configured) key for |networkName| within |networks|, matched
//  case-insensitively. Returns undefined when there is no such network.
//
function canonicalNetworkName(networks, networkName) {
    if (!networkName) {
        return undefined;
    }
    const wanted = String(networkName).toLowerCase();
    return networkNames(networks).find(k => k.toLowerCase() === wanted);
}

//
//  Which network owns the bare "outbound" directory?
//
//    |defaultNetwork| unset (undefined)   -> the first network listed
//    |defaultNetwork| a network name      -> that network (case-insensitive)
//    |defaultNetwork| null / false / ''   -> none; every network gets its own
//                                            subdirectory
//
//  A |defaultNetwork| naming a network that isn't configured falls back to the
//  documented default (first listed) rather than quietly leaving the system
//  with no default at all; validateOutboundConfig() reports the typo.
//
//  Returns the canonical config key, or undefined when there is no default
//  network (explicitly disabled, or no networks configured).
//
function resolveDefaultNetworkName(networks, defaultNetwork) {
    const names = networkNames(networks);
    if (0 === names.length) {
        return undefined;
    }

    if (undefined === defaultNetwork) {
        return names[0];
    }

    //  explicitly disabled
    if (!defaultNetwork) {
        return undefined;
    }

    return canonicalNetworkName(networks, defaultNetwork) || names[0];
}

//
//  Default zone for |networkName|: an explicit |defaultZone|, else the zone of
//  the network's |localAddress|. Returns undefined when neither is usable --
//  callers must not assume a zone in that case.
//
function resolveNetworkDefaultZone(networks, networkName) {
    const key = canonicalNetworkName(networks, networkName);
    if (undefined === key) {
        return undefined;
    }

    const networkConfig = networks[key] || {};
    if ('number' === typeof networkConfig.defaultZone) {
        return networkConfig.defaultZone;
    }

    if (networkConfig.localAddress) {
        const addr = Address.fromString(networkConfig.localAddress);
        if (addr && 'number' === typeof addr.zone) {
            return addr.zone;
        }
    }

    return undefined;
}

//
//  ".<zzz>" suffix for |zone| within |networkName|, or "" when |zone| is that
//  network's default zone. A network whose default zone can't be resolved is
//  treated as matching nothing, so every zone gets an explicit suffix.
//
function zoneSuffix(networks, networkName, zone) {
    if ('number' !== typeof zone) {
        return '';
    }
    if (zone === resolveNetworkDefaultZone(networks, networkName)) {
        return '';
    }
    return '.' + `000${zone.toString(16)}`.slice(-3);
}

//
//  Outbound directory name (not a full path) for |networkName| / |zone|.
//
function outboundDirName(networks, defaultNetwork, networkName, zone) {
    const name = String(networkName || '').toLowerCase();
    const defaultName = resolveDefaultNetworkName(networks, defaultNetwork);
    const isDefault = undefined !== defaultName && defaultName.toLowerCase() === name;

    return `${
        isDefault ? DEFAULT_NETWORK_DIR_NAME : name
    }${zoneSuffix(networks, networkName, zone)}`;
}

//
//  Pre-0.5.1-beta outbound directory name for |networkName| / |zone|, or null
//  when there isn't a distinct one.
//
//  Before the writer and reader were unified, a system with two or more
//  networks and no explicit |defaultNetwork| had *no* default network on the
//  writing side, so what is now "outbound/" was written as "<network>/". Mail
//  queued under the old layout still needs to ship after an upgrade, so the
//  reader checks here as well. The directory drains itself as those files are
//  sent (flow entries carry the '^' truncate-and-delete directive), after
//  which the sysop can remove it.
//
//  Only the default network has a legacy name -- for every other network the
//  name never changed.
//
function legacyOutboundDirName(networks, defaultNetwork, networkName, zone) {
    const name = String(networkName || '').toLowerCase();
    const defaultName = resolveDefaultNetworkName(networks, defaultNetwork);
    if (undefined === defaultName || defaultName.toLowerCase() !== name) {
        return null;
    }

    return `${name}${zoneSuffix(networks, networkName, zone)}`;
}

//
//  Configuration problems that make outbound spool paths ambiguous or
//  unresolvable. Returns an array of { code, ... } objects, empty when all is
//  well. Intended to be called once at startup and logged; the resolvers above
//  stay silent since they run per message.
//
function validateOutboundConfig(networks, defaultNetwork) {
    const issues = [];
    const names = networkNames(networks);

    if (
        defaultNetwork &&
        undefined === canonicalNetworkName(networks, defaultNetwork) &&
        names.length > 0
    ) {
        issues.push({
            code: 'unknownDefaultNetwork',
            defaultNetwork,
            using: names[0],
        });
    }

    names.forEach(name => {
        if (undefined === resolveNetworkDefaultZone(networks, name)) {
            issues.push({ code: 'unresolvableZone', network: name });
        }

        //  A network literally named "outbound" collides with the default
        //  network's directory.
        if (DEFAULT_NETWORK_DIR_NAME === name.toLowerCase()) {
            issues.push({ code: 'reservedNetworkName', network: name });
        }
    });

    return issues;
}

module.exports = {
    DEFAULT_NETWORK_DIR_NAME,
    canonicalNetworkName,
    resolveDefaultNetworkName,
    resolveNetworkDefaultZone,
    outboundDirName,
    legacyOutboundDirName,
    validateOutboundConfig,
};
