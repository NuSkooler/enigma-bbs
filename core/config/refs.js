/* jslint node: true */
'use strict';

//  ENiGMA½
const { IssueCodes, makeIssue } = require('./issue.js');
const { canonicalNetworkName, validateOutboundConfig } = require('../bso_util.js');
const { suggestKey, keyDistance } = require('./validate.js');
const DefaultConfig = require('../config_default.js');

//  deps
const _ = require('lodash');

//
//  Cross-reference checks: names in one part of the configuration that have to
//  exist in another.
//
//  Type checking would not have caught a single one of the expensive
//  configuration bugs in this project's history. The couplings that actually
//  break are referential -- a file area naming a storage tag that was renamed,
//  a TIC area pointing at a file area that does not exist, an echo naming a
//  network that is spelled differently where it is defined. None of these
//  produce an error: the file quietly goes nowhere, the echo is quietly not
//  exported, and there is nothing in the log to say why.
//
//  core/bso_util.js exists in large part because of one of these.
//
//  Two details that would otherwise produce false positives, both taken from
//  the code that does the real lookups:
//
//    * Network names are matched case-insensitively -- canonicalNetworkName()
//      lowercases both sides -- so "AgoraNet" and "agoranet" are the same
//      network.
//    * Area and storage tags are matched exactly: getFileAreaByTag() and
//      friends index straight into the object.
//

const RefKind = {
    StorageTag: 'storage tag',
    FileArea: 'file area',
    Network: 'FTN network',
    Conference: 'message conference',
    MessageArea: 'message area',
};

function keysAt(config, path) {
    const value = _.get(config, path);
    return _.isPlainObject(value) ? Object.keys(value) : [];
}

function entriesAt(config, path) {
    const value = _.get(config, path);
    return _.isPlainObject(value) ? Object.entries(value) : [];
}

//  storageTags is documented as an array but a bare string is accepted; see
//  core/file_base_area.js:247-249
function asArray(value) {
    if (Array.isArray(value)) {
        return value;
    }
    return _.isString(value) ? [value] : [];
}

//
//  Keys ENiGMA ships itself -- sys_msg_attach, system_internal and friends.
//  Derived from the defaults rather than listed here, so a new internal area
//  cannot leave a stale list behind.
//
let shippedConfig;
function shippedKeysAt(refPath) {
    if (!shippedConfig) {
        shippedConfig = DefaultConfig();
    }
    return keysAt(shippedConfig, refPath);
}

//
//  What to offer someone who has mistyped a name. Their own entries are what
//  a near miss is almost certainly a miss *of*; the handful of built-ins are
//  noise, and nobody means to point a file echo at sys_temp_download.
//
//  They stay perfectly legal to reference -- the shipped areas reference them
//  themselves -- this only decides what we suggest. A board with none of its
//  own entries is better served by seeing the built-ins than an empty list.
//
function suggestableCandidates(candidates, refPath) {
    const shipped = shippedKeysAt(refPath);
    const own = (candidates || []).filter(key => !shipped.includes(key));
    return own.length ? own : candidates || [];
}

function unresolved(issues, { path, value, kind, refPath, candidates, hint }) {
    const suggestable = suggestableCandidates(candidates, refPath);
    const suggestion = suggestKey(value, suggestable);

    const detail = {
        value,
        refKind: kind,
        refPath,
        //  closest first: with forty file areas, the first ten in declaration
        //  order are arbitrary, and arbitrary is not help
        candidates: suggestable
            .slice()
            .sort((a, b) => keyDistance(value, a) - keyDistance(value, b)),
    };

    if (suggestion) {
        detail.suggestion = suggestion;
    }

    if (hint) {
        detail.hint = hint;
    }

    issues.push(makeIssue(IssueCodes.UnresolvedRef, path, detail));
}

//
//  File areas and storage tags are two separate namespaces that look alike,
//  live beside each other, and are routinely named after the same thing. Using
//  one where the other belongs is an easy mistake and a completely silent one,
//  so when the name *is* valid -- just in the wrong namespace -- say so, and
//  name the area that actually owns it. That is the answer, not a word list.
//
function crossNamespaceHint(config, kind, value) {
    if (RefKind.FileArea === kind) {
        if (!keysAt(config, 'fileBase.storageTags').includes(value)) {
            return undefined;
        }

        const owners = entriesAt(config, 'fileBase.areas')
            .filter(
                ([, area]) =>
                    _.isPlainObject(area) && asArray(area.storageTags).includes(value)
            )
            .map(([areaTag]) => areaTag);

        if (owners.length) {
            return `that is a storage tag; the file area using it is ${owners
                .map(o => `"${o}"`)
                .join(' or ')}`;
        }

        return 'that is a storage tag, not a file area';
    }

    if (RefKind.StorageTag === kind) {
        if (keysAt(config, 'fileBase.areas').includes(value)) {
            return 'that is a file area, not a storage tag';
        }
    }

    return undefined;
}

//  A name that is missing or not a string is a shape problem, which the type
//  walk already covers; saying so twice helps nobody.
function checkExact(issues, config, spec) {
    if (!_.isString(spec.value) || 0 === spec.value.length) {
        return;
    }
    if (spec.candidates.includes(spec.value)) {
        return;
    }

    unresolved(
        issues,
        Object.assign({ hint: crossNamespaceHint(config, spec.kind, spec.value) }, spec)
    );
}

function checkNetwork(issues, config, path, value) {
    if (!_.isString(value) || 0 === value.length) {
        return;
    }

    const networks = _.get(config, 'messageNetworks.ftn.networks');
    if (undefined !== canonicalNetworkName(networks, value)) {
        return;
    }

    unresolved(issues, {
        path,
        value,
        kind: RefKind.Network,
        refPath: 'messageNetworks.ftn.networks',
        candidates: keysAt(config, 'messageNetworks.ftn.networks'),
    });
}

//
//  fileBase.areas.<tag>.storageTags[] -> fileBase.storageTags
//
//  Left dangling, getAreaStorageDirectoryByTag() returns undefined and the
//  area's files are written relative to nothing in particular.
//
function checkFileAreaStorageTags(issues, config) {
    const storageTags = keysAt(config, 'fileBase.storageTags');

    entriesAt(config, 'fileBase.areas').forEach(([areaTag, area]) => {
        if (!_.isPlainObject(area)) {
            return;
        }

        asArray(area.storageTags).forEach((tag, i) => {
            checkExact(issues, config, {
                path: `fileBase.areas.${areaTag}.storageTags[${i}]`,
                value: tag,
                kind: RefKind.StorageTag,
                refPath: 'fileBase.storageTags',
                candidates: storageTags,
            });
        });
    });
}

//
//  scannerTossers.ftn_bso.ticAreas.<externalTag> -> file base and networks
//
//  The entry may be a bare string, which is shorthand for { areaTag: <it> };
//  see core/scanner_tossers/ftn_bso.js:2822-2830.
//
function checkTicAreas(issues, config) {
    const base = 'scannerTossers.ftn_bso.ticAreas';
    const fileAreas = keysAt(config, 'fileBase.areas');
    const storageTags = keysAt(config, 'fileBase.storageTags');

    entriesAt(config, base).forEach(([externalTag, entry]) => {
        const path = `${base}.${externalTag}`;

        if (_.isString(entry)) {
            return checkExact(issues, config, {
                path,
                value: entry,
                kind: RefKind.FileArea,
                refPath: 'fileBase.areas',
                candidates: fileAreas,
            });
        }

        if (!_.isPlainObject(entry)) {
            return;
        }

        checkExact(issues, config, {
            path: `${path}.areaTag`,
            value: entry.areaTag,
            kind: RefKind.FileArea,
            refPath: 'fileBase.areas',
            candidates: fileAreas,
        });

        checkExact(issues, config, {
            path: `${path}.storageTag`,
            value: entry.storageTag,
            kind: RefKind.StorageTag,
            refPath: 'fileBase.storageTags',
            candidates: storageTags,
        });

        checkNetwork(issues, config, `${path}.network`, entry.network);
    });
}

//
//  messageNetworks.ftn.areas.<localAreaTag>.network -> networks
//
//  isAreaConfigValid() requires this to be a string but never checks that it
//  names anything, so a misspelling means the echo is simply never exported.
//
function checkFtnAreaNetworks(issues, config) {
    entriesAt(config, 'messageNetworks.ftn.areas').forEach(([areaTag, area]) => {
        if (_.isPlainObject(area)) {
            checkNetwork(
                issues,
                config,
                `messageNetworks.ftn.areas.${areaTag}.network`,
                area.network
            );
        }
    });
}

//
//  scannerTossers.ftn_bso.netMail.routes.<pattern>.network -> networks
//
function checkNetMailRoutes(issues, config) {
    const base = 'scannerTossers.ftn_bso.netMail.routes';

    entriesAt(config, base).forEach(([pattern, route]) => {
        if (_.isPlainObject(route)) {
            checkNetwork(issues, config, `${base}.${pattern}.network`, route.network);
        }
    });
}

//
//  contentServers.nntp.publicMessageConferences: confTag -> [ areaTag, ... ]
//
//  Both halves matter: isConfAndAreaPubliclyExposed() simply returns false for
//  a name that does not match, so the group never appears for anonymous
//  readers and nothing says why.
//
function checkPublicMessageConferences(issues, config) {
    const base = 'contentServers.nntp.publicMessageConferences';
    const confTags = keysAt(config, 'messageConferences');

    entriesAt(config, base).forEach(([confTag, areaTags]) => {
        const path = `${base}.${confTag}`;

        if (!confTags.includes(confTag)) {
            return unresolved(issues, {
                path,
                value: confTag,
                kind: RefKind.Conference,
                refPath: 'messageConferences',
                candidates: confTags,
            });
        }

        const areas = keysAt(config, `messageConferences.${confTag}.areas`);

        asArray(areaTags).forEach((areaTag, i) => {
            checkExact(issues, config, {
                path: `${path}[${i}]`,
                value: areaTag,
                kind: RefKind.MessageArea,
                refPath: `messageConferences.${confTag}.areas`,
                candidates: areas,
            });
        });
    });
}

//
//  bso_util.js already knows about the outbound spool's own ambiguities;
//  translate rather than reimplement. Its codes do not all map onto the
//  general taxonomy, so the two that have no equivalent are passed through
//  under their own names.
//
function checkOutboundConfig(issues, config) {
    const networks = _.get(config, 'messageNetworks.ftn.networks');
    const defaultNetwork = _.get(config, 'scannerTossers.ftn_bso.defaultNetwork');

    validateOutboundConfig(networks, defaultNetwork).forEach(issue => {
        switch (issue.code) {
            case 'unknownDefaultNetwork':
                unresolved(issues, {
                    path: 'scannerTossers.ftn_bso.defaultNetwork',
                    value: issue.defaultNetwork,
                    kind: RefKind.Network,
                    refPath: 'messageNetworks.ftn.networks',
                    candidates: Object.keys(networks || {}),
                });
                break;

            case 'unresolvableZone':
                issues.push(
                    makeIssue(
                        IssueCodes.UnresolvedRef,
                        `messageNetworks.ftn.networks.${issue.network}`,
                        {
                            value: issue.network,
                            refKind: RefKind.Network,
                            refPath: 'defaultZone or a parsable localAddress',
                            candidates: [],
                        }
                    )
                );
                break;

            case 'reservedNetworkName':
                issues.push(
                    makeIssue(
                        IssueCodes.InvalidEnum,
                        `messageNetworks.ftn.networks.${issue.network}`,
                        {
                            value: issue.network,
                            allowed: ['any name other than "outbound"'],
                        }
                    )
                );
                break;
        }
    });
}

//
//  Config-internal references only: everything here is answerable from the
//  merged configuration alone. Names that depend on the filesystem or on
//  menu.hjson -- theme.default, loginServers.*.firstMenu -- load after the
//  configuration does and are checked separately.
//
function validateReferences(mergedConfig) {
    const issues = [];

    if (!_.isPlainObject(mergedConfig)) {
        return issues;
    }

    checkFileAreaStorageTags(issues, mergedConfig);
    checkTicAreas(issues, mergedConfig);
    checkFtnAreaNetworks(issues, mergedConfig);
    checkNetMailRoutes(issues, mergedConfig);
    checkPublicMessageConferences(issues, mergedConfig);
    checkOutboundConfig(issues, mergedConfig);

    return issues;
}

module.exports = {
    validateReferences,
    RefKind,
};
