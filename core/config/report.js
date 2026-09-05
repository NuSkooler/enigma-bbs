/* jslint node: true */
'use strict';

//  ENiGMA½
const { describeIssue, countBySeverity, Severity } = require('./issue.js');

//  deps
const _ = require('lodash');

//
//  Reporting configuration problems at runtime.
//
//  Two surfaces, because the first load has no logger yet: Log.init() runs
//  from core/bbs.js:269, well after the configuration is loaded at :104. So
//  the initial load says its piece on the console and a hot reload says it to
//  the log, which is where an operator editing a live board will be looking.
//
//  Neither ever stops anything. A configuration with problems is still
//  applied -- see decision 6 in the design. The point is to tell somebody,
//  not to hold the board hostage over a key we happen not to recognise.
//

const ValidationMode = {
    Warn: 'warn',
    Off: 'off',
};

const CONFIG_PATH = 'general.configValidation';

//
//  Anything that is not exactly "off" means "warn", so that a typo in the
//  value cannot quietly disable validation. The bad value is itself reported,
//  since meta declares the enum.
//
function validationMode(mergedConfig) {
    return ValidationMode.Off === _.get(mergedConfig, CONFIG_PATH)
        ? ValidationMode.Off
        : ValidationMode.Warn;
}

function isEnabled(mergedConfig) {
    return ValidationMode.Off !== validationMode(mergedConfig);
}

function summaryOf(issues) {
    const { errors, warnings } = countBySeverity(issues);
    const parts = [];

    if (errors) {
        parts.push(`${errors} error${1 === errors ? '' : 's'}`);
    }
    if (warnings) {
        parts.push(`${warnings} warning${1 === warnings ? '' : 's'}`);
    }

    return `${issues.length} issue${1 === issues.length ? '' : 's'} (${parts.join(
        ', '
    )})`;
}

//  one line per issue: at boot a wall of text helps nobody, and the full
//  report is a command away
function oneLine(issue) {
    const described = describeIssue(issue);
    return `  ${described.severity.padEnd(8)} ${described.path}: ${described.message
        .split('\n')
        .join(' ')}`;
}

function reportToConsole(issues) {
    /* eslint-disable no-console */
    console.info(`Configuration: ${summaryOf(issues)}`);
    issues.forEach(issue => console.info(oneLine(issue)));
    console.info("  Run './oputil.js config validate' for details.\n");
    /* eslint-enable no-console */
}

function reportToLog(issues) {
    //  Log.log is only set once Log.init() has run, so this cannot be hoisted
    const Log = require('../logger.js').log;
    if (!Log) {
        return reportToConsole(issues);
    }

    issues.forEach(issue => {
        const described = describeIssue(issue);
        const detail = {
            path: issue.path,
            code: issue.code,
        };

        if (issue.suggestion) {
            detail.suggestion = issue.suggestion;
        }

        const log = Severity.Error === issue.severity ? Log.error : Log.warn;
        log.call(Log, detail, `Configuration: ${described.message}`);
    });
}

function reportIssues(issues, { initialLoad = false } = {}) {
    if (!issues || 0 === issues.length) {
        return;
    }

    return initialLoad ? reportToConsole(issues) : reportToLog(issues);
}

module.exports = {
    ValidationMode,
    validationMode,
    isEnabled,
    reportIssues,
    summaryOf,
};
