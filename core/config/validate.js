/* jslint node: true */
'use strict';

//  ENiGMA½
const { NodeType } = require('./schema.js');
const { IssueCodes, makeIssue } = require('./issue.js');

//  deps
const _ = require('lodash');

//
//  Validates a configuration against a schema.
//
//  Pure: no logging, no filesystem, no Config(). It takes values and returns a
//  list of issues, empty when all is well -- the same shape as
//  validateOutboundConfig() in core/bso_util.js, for the same reason. Every
//  reporting surface shares one formatter rather than each mapping codes to
//  wording of its own.
//
//  Two walks over two different objects, deliberately:
//
//    * Unknown keys are only visible in the *pre-merge* configuration. After
//      _.merge() folds the sysop's file into the defaults, a misspelled key
//      sits quietly beside the correctly spelled default and both are present.
//      That silent shadowing is the failure mode this whole effort exists to
//      catch, so this walk has to see what the sysop actually wrote.
//
//    * Types are only correct in the *merged* configuration, where every
//      defaulted value is present and every "@" spec has been resolved.
//
//  Throughout, the rule is to stay quiet when unsure. A validator that cries
//  wolf on a working board gets switched off, and then it protects nobody.
//

//  A spec _resolveAtSpecs() left alone because it could not resolve it; see
//  core/config_loader.js:310-325. The literal string is still in the config.
const UNRESOLVED_SPEC = /^@(reference|environment|file):/;

//  Below this length a single edit is too likely to be a different word
const SHORT_KEY_LENGTH = 5;

function childPath(path, key) {
    return path ? `${path}.${key}` : key;
}

function typeNameOf(value) {
    if (null === value) {
        return 'null';
    }
    if (Array.isArray(value)) {
        return NodeType.Array;
    }
    return typeof value;
}

//
//  Levenshtein distance, bailing out as soon as it exceeds |max|. Keys are
//  short and the candidate list is one object's worth, so the naive matrix is
//  entirely adequate.
//
function editDistance(a, b, max) {
    if (Math.abs(a.length - b.length) > max) {
        return max + 1;
    }

    let prev = Array.from({ length: b.length + 1 }, (_unused, i) => i);

    for (let i = 1; i <= a.length; ++i) {
        const row = [i];
        let best = i;

        for (let j = 1; j <= b.length; ++j) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            row[j] = Math.min(row[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
            best = Math.min(best, row[j]);
        }

        if (best > max) {
            return max + 1;
        }

        prev = row;
    }

    return prev[b.length];
}

//
//  The nearest sibling key, when there is one close enough to be worth
//  mentioning. Siblings only: searching the whole tree turns up confident
//  nonsense for common names like "enabled", "port" and "path".
//
function suggestKey(key, candidates) {
    const max = key.length < SHORT_KEY_LENGTH ? 1 : 2;
    let best;
    let bestDistance = max + 1;

    (candidates || []).forEach(candidate => {
        const distance = editDistance(
            key.toLowerCase(),
            candidate.toLowerCase(),
            max
        );
        if (distance <= max && distance < bestDistance) {
            best = candidate;
            bestDistance = distance;
        }
    });

    return best;
}

//
//  Walk 1: keys the sysop wrote that the schema does not recognise.
//
function collectUnknownKeys(userConfig, schema, issues) {
    (function walk(value, node, path) {
        if (!node || !_.isPlainObject(value)) {
            return;
        }

        //  nothing is known below here, so nothing can be wrong either
        if (NodeType.Unknown === node.type) {
            return;
        }

        if (true === node.openMap) {
            //  these keys are sysop data; only their contents are checkable
            Object.entries(value).forEach(([key, child]) =>
                walk(child, node.value, childPath(path, key))
            );
            return;
        }

        if (NodeType.Object !== node.type) {
            //  the value disagrees with the schema's shape; walk 2 reports it
            return;
        }

        const children = node.children || {};

        Object.entries(value).forEach(([key, child]) => {
            const childNode = children[key];

            if (childNode) {
                return walk(child, childNode, childPath(path, key));
            }

            //
            //  A leading underscore is a long standing convention here for a
            //  block that is not configuration at all: "_snips" holding
            //  fragments for @reference to point at, for instance. It is
            //  scratch space the operator keeps on purpose, so leave it be.
            //
            if (key.startsWith('_')) {
                return;
            }

            //
            //  Only complain where the schema claims to know every key. A
            //  shape derived from a couple of example entries does not, and
            //  neither does a section we only know about because meta
            //  mentioned it.
            //
            if (true === node.closedKeys) {
                issues.push(
                    makeIssue(IssueCodes.UnknownKey, childPath(path, key), {
                        key,
                        suggestion: suggestKey(key, Object.keys(children)),
                    })
                );
            }

            //  do not descend: everything under an unknown key is unknown too
        });
    })(userConfig, schema, '');
}

function checkEnum(value, node, path, issues) {
    if (!node.enum || node.enum.includes(value)) {
        return;
    }

    issues.push(
        makeIssue(IssueCodes.InvalidEnum, path, { value, allowed: node.enum })
    );
}

function checkRange(value, node, path, issues) {
    if ('number' !== typeof value) {
        return;
    }

    const belowMin = undefined !== node.min && value < node.min;
    const aboveMax = undefined !== node.max && value > node.max;

    if (belowMin || aboveMax) {
        issues.push(
            makeIssue(IssueCodes.ValueOutOfRange, path, {
                value,
                min: node.min,
                max: node.max,
            })
        );
    }
}

function checkLeaf(value, node, path, issues, options) {
    if (undefined === value) {
        return;
    }

    if (null === value) {
        if (true !== node.nullable) {
            issues.push(
                makeIssue(IssueCodes.TypeMismatch, path, {
                    expected: node.type,
                    actual: 'null',
                })
            );
        }
        return;
    }

    //
    //  An unresolved "@" spec is a resolution problem, not a type error: the
    //  variable may simply not exist in whatever shell is doing the checking.
    //  Reporting it by default would flag correct production configurations,
    //  so it is opt-in.
    //
    if ('string' === typeof value && UNRESOLVED_SPEC.test(value)) {
        if (options.checkEnv) {
            issues.push(makeIssue(IssueCodes.UnresolvedSpec, path, { spec: value }));
        }
        return;
    }

    const actual = typeNameOf(value);
    if (actual !== node.type) {
        issues.push(
            makeIssue(IssueCodes.TypeMismatch, path, {
                expected: node.type,
                actual,
            })
        );
        return;
    }

    if (NodeType.Array === node.type) {
        if (node.items && node.items.type !== NodeType.Unknown) {
            value.forEach((entry, i) => {
                checkLeaf(entry, node.items, `${path}[${i}]`, issues, options);
            });
        }
        return;
    }

    checkEnum(value, node, path, issues);
    checkRange(value, node, path, issues);
}

//
//  Walk 2: values whose type, set or range disagrees with the schema.
//
function collectValueIssues(mergedConfig, schema, issues, options) {
    (function walk(value, node, path) {
        if (!node || NodeType.Unknown === node.type || undefined === value) {
            return;
        }

        if (true === node.openMap) {
            if (_.isPlainObject(value)) {
                Object.entries(value).forEach(([key, child]) =>
                    walk(child, node.value, childPath(path, key))
                );
            }
            return;
        }

        if (NodeType.Object === node.type) {
            if (!_.isPlainObject(value)) {
                issues.push(
                    makeIssue(IssueCodes.TypeMismatch, path, {
                        expected: NodeType.Object,
                        actual: typeNameOf(value),
                    })
                );
                return;
            }

            const children = node.children || {};
            Object.entries(value).forEach(([key, child]) => {
                if (children[key]) {
                    walk(child, children[key], childPath(path, key));
                }
            });
            return;
        }

        checkLeaf(value, node, path, issues, options);
    })(mergedConfig, schema, '');
}

//
//  |userConfig|   what the sysop wrote, before the defaults were merged in.
//                 Pass undefined to skip unknown key detection.
//  |mergedConfig| the effective configuration, after merging and after "@"
//                 specs were resolved.
//  |options|      { checkEnv } -- report "@" specs that did not resolve.
//
//  Returns an array of issues, empty when the configuration is clean.
//
function validateConfig(userConfig, mergedConfig, schema, options = {}) {
    const issues = [];

    if (!schema) {
        return issues;
    }

    if (_.isPlainObject(userConfig)) {
        collectUnknownKeys(userConfig, schema, issues);
    }

    if (_.isPlainObject(mergedConfig)) {
        collectValueIssues(mergedConfig, schema, issues, options);
    }

    return issues;
}

//  Unbounded enough for ordering a candidate list by closeness; the cap
//  only stops the matrix growing without limit on absurd input.
function keyDistance(a, b) {
    return editDistance(String(a).toLowerCase(), String(b).toLowerCase(), 64);
}

module.exports = {
    validateConfig,
    suggestKey,
    keyDistance,
};
