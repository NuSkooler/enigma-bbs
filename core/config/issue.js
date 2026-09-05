/* jslint node: true */
'use strict';

//
//  Configuration validation issues.
//
//  An issue is a plain { code, ... } bag, following the precedent set by
//  validateOutboundConfig() in core/bso_util.js: the code that finds a problem
//  knows nothing about how it will be reported. Unlike that one, these carry a
//  severity and a path, because there are enough codes and enough reporting
//  surfaces -- stderr at boot, the log on reload, oputil -- that repeating a
//  switch statement at each of them would be silly.
//
//  describeIssue() turns an issue into something a human can read. It is the
//  only place wording lives, so all three surfaces say the same thing.
//

const IssueCodes = {
    //  A key the schema does not know, somewhere it does expect to know them
    //  all. Only ever a warning: it may be a mod's own configuration.
    UnknownKey: 'unknownKey',

    //  A value whose type disagrees with the default it overrides
    TypeMismatch: 'typeMismatch',

    //  A value outside a set or range meta declares
    InvalidEnum: 'invalidEnum',
    ValueOutOfRange: 'valueOutOfRange',

    //  A name that must exist elsewhere in the configuration and does not
    //  (storage tags, network names, area tags). Raised by config/refs.js.
    UnresolvedRef: 'unresolvedRef',

    //  Declared as required and absent. Only meaningful where there is no
    //  default, since validation runs against the merged configuration.
    MissingRequired: 'missingRequired',

    //  An "@environment:", "@file:" or "@reference:" spec that did not
    //  resolve, so the literal spec string is still sitting in the config.
    //  Only ever raised when explicitly asked for -- resolution depends on
    //  the invoking process, so checking it by default would report perfectly
    //  good configurations as broken.
    UnresolvedSpec: 'unresolvedSpec',

    //  Reserved for later use
    DeprecatedKey: 'deprecatedKey',
};

const Severity = {
    Error: 'error',
    Warning: 'warning',
};

const SeverityByCode = {
    [IssueCodes.UnknownKey]: Severity.Warning,
    [IssueCodes.DeprecatedKey]: Severity.Warning,
    [IssueCodes.TypeMismatch]: Severity.Error,
    [IssueCodes.InvalidEnum]: Severity.Error,
    [IssueCodes.ValueOutOfRange]: Severity.Error,
    [IssueCodes.UnresolvedRef]: Severity.Error,
    [IssueCodes.MissingRequired]: Severity.Error,
    [IssueCodes.UnresolvedSpec]: Severity.Error,
};

function severityOf(code) {
    //  an unrecognised code is a bug in us, not in the operator's config
    return SeverityByCode[code] || Severity.Warning;
}

function makeIssue(code, path, extra = {}) {
    return Object.assign({ code, severity: severityOf(code), path }, extra);
}

//  A board may have a great many areas; listing them all turns a useful
//  message into a wall of text.
const MAX_LISTED = 10;

function listOf(values) {
    const all = values || [];
    if (all.length <= MAX_LISTED) {
        return all.join(', ');
    }
    return `${all.slice(0, MAX_LISTED).join(', ')}, ... (${all.length - MAX_LISTED} more)`;
}

function describeIssue(issue) {
    let message;

    switch (issue.code) {
        case IssueCodes.UnknownKey:
            message = `unknown key "${issue.key}"`;
            if (issue.suggestion) {
                message += ` -- did you mean "${issue.suggestion}"?`;
            }
            break;

        case IssueCodes.TypeMismatch:
            message = `expected ${issue.expected}, got ${issue.actual}`;
            break;

        case IssueCodes.InvalidEnum:
            message = `"${issue.value}" is not one of: ${listOf(issue.allowed)}`;
            break;

        case IssueCodes.ValueOutOfRange:
            message =
                undefined !== issue.min && issue.value < issue.min
                    ? `${issue.value} is below the minimum of ${issue.min}`
                    : `${issue.value} is above the maximum of ${issue.max}`;
            break;

        case IssueCodes.UnresolvedRef:
            message = `${issue.refKind} "${issue.value}" is not defined in ${issue.refPath}`;
            //  A near miss is the answer, so say it and stop. The full list is
            //  only worth printing when there is nothing close to point at.
            if (issue.suggestion) {
                message += ` -- did you mean "${issue.suggestion}"?`;
            } else if (issue.candidates && issue.candidates.length) {
                message += `\nknown: ${listOf(issue.candidates)}`;
            }
            break;

        case IssueCodes.MissingRequired:
            message = 'required, but not set';
            break;

        case IssueCodes.UnresolvedSpec:
            message = `"${issue.spec}" did not resolve`;
            break;

        case IssueCodes.DeprecatedKey:
            message = `"${issue.key}" is deprecated`;
            if (issue.replacement) {
                message += `; use "${issue.replacement}"`;
            }
            break;

        default:
            message = issue.code;
            break;
    }

    return { severity: issue.severity, path: issue.path, message };
}

function countBySeverity(issues) {
    return (issues || []).reduce(
        (acc, issue) => {
            if (Severity.Error === issue.severity) {
                acc.errors += 1;
            } else {
                acc.warnings += 1;
            }
            return acc;
        },
        { errors: 0, warnings: 0 }
    );
}

module.exports = {
    IssueCodes,
    Severity,
    severityOf,
    makeIssue,
    describeIssue,
    countBySeverity,
};
