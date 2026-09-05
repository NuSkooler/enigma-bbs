'use strict';

const { strict: assert } = require('assert');

const {
    ValidationMode,
    validationMode,
    isEnabled,
    reportIssues,
    summaryOf,
} = require('../core/config/report');
const { buildSchema } = require('../core/config/schema');
const { validateConfig } = require('../core/config/validate');
const { IssueCodes, Severity } = require('../core/config/issue');
const Logger = require('../core/logger');
const DefaultConfig = require('../core/config_default');

//  Capture console.info for the duration of |fn|
function captureConsole(fn) {
    const lines = [];
    const original = console.info; //  eslint-disable-line no-console
    console.info = (...args) => lines.push(args.join(' ')); //  eslint-disable-line no-console
    try {
        fn();
    } finally {
        console.info = original; //  eslint-disable-line no-console
    }
    return lines;
}

//  Log.log is a static set by Log.init(); swap it for the duration of |fn|
function captureLog(fn) {
    const calls = [];
    const previous = Logger.log;
    Logger.log = {
        warn: (detail, message) => calls.push({ level: 'warn', detail, message }),
        error: (detail, message) => calls.push({ level: 'error', detail, message }),
    };
    try {
        fn();
    } finally {
        Logger.log = previous;
    }
    return calls;
}

const anIssue = (code, path, extra = {}) =>
    Object.assign(
        {
            code,
            severity: IssueCodes.UnknownKey === code ? Severity.Warning : Severity.Error,
            path,
        },
        extra
    );

// ─── The knob ────────────────────────────────────────────────────────────────

describe('config validation mode', () => {
    it('warns by default', () => {
        assert.equal(validationMode({}), ValidationMode.Warn);
        assert.equal(isEnabled({}), true);
    });

    it('ships defaulted to warn', () => {
        assert.equal(DefaultConfig().general.configValidation, ValidationMode.Warn);
    });

    it('is silenced by "off"', () => {
        const config = { general: { configValidation: 'off' } };
        assert.equal(validationMode(config), ValidationMode.Off);
        assert.equal(isEnabled(config), false);
    });

    it('treats an unrecognised value as warn, so a typo cannot silence it', () => {
        const config = { general: { configValidation: 'quiet' } };
        assert.equal(validationMode(config), ValidationMode.Warn);
        assert.equal(isEnabled(config), true);
    });

    it('reports an unrecognised value, since meta declares the enum', () => {
        const merged = DefaultConfig();
        merged.general.configValidation = 'quiet';

        const issues = validateConfig({}, merged, buildSchema());
        assert.equal(issues.length, 1);
        assert.equal(issues[0].code, IssueCodes.InvalidEnum);
        assert.equal(issues[0].path, 'general.configValidation');
    });

    it('a misspelled key leaves the default in force and is itself reported', () => {
        //  the point of failing this way round: validation cannot be turned
        //  off by accident, only deliberately
        const user = { general: { configValidaton: 'off' } };
        const merged = DefaultConfig();
        merged.general.configValidaton = 'off';

        assert.equal(isEnabled(merged), true);

        const issues = validateConfig(user, merged, buildSchema());
        assert.equal(issues.length, 1);
        assert.equal(issues[0].code, IssueCodes.UnknownKey);
    });
});

// ─── Surfaces ────────────────────────────────────────────────────────────────

describe('config validation reporting', () => {
    const issues = [
        anIssue(IssueCodes.UnknownKey, 'general.boardnam', {
            key: 'boardnam',
            suggestion: 'boardName',
        }),
        anIssue(IssueCodes.TypeMismatch, 'general.maxConnections', {
            expected: 'number',
            actual: 'string',
        }),
    ];

    it('says nothing when there is nothing to say', () => {
        assert.deepEqual(
            captureConsole(() => reportIssues([], { initialLoad: true })),
            []
        );
        assert.deepEqual(
            captureConsole(() => reportIssues(undefined, { initialLoad: true })),
            []
        );
    });

    it('uses the console on the first load, when there is no logger yet', () => {
        //  Log.init() runs from core/bbs.js:269, after the config is loaded
        //  at :104, so the console is all there is
        const lines = captureConsole(() => reportIssues(issues, { initialLoad: true }));

        assert.equal(lines[0], 'Configuration: 2 issues (1 error, 1 warning)');
        assert.ok(lines[1].includes('general.boardnam'));
        assert.ok(lines[1].includes('did you mean "boardName"?'));
        assert.ok(lines[2].includes('expected number, got string'));
        assert.ok(lines[3].includes('oputil.js config validate'));
    });

    it('uses the log on a reload, where an operator will be looking', () => {
        const calls = captureLog(() => reportIssues(issues, { initialLoad: false }));

        assert.equal(calls.length, 2);
        assert.equal(calls[0].level, 'warn');
        assert.equal(calls[0].detail.path, 'general.boardnam');
        assert.equal(calls[0].detail.suggestion, 'boardName');
        assert.equal(calls[1].level, 'error');
        assert.equal(calls[1].detail.code, IssueCodes.TypeMismatch);
    });

    it('falls back to the console if the logger is somehow not up yet', () => {
        const previous = Logger.log;
        Logger.log = undefined;
        try {
            const lines = captureConsole(() =>
                reportIssues(issues, { initialLoad: false })
            );
            assert.ok(lines.length > 0);
        } finally {
            Logger.log = previous;
        }
    });

    it('pluralises its summary properly', () => {
        assert.equal(summaryOf([issues[0]]), '1 issue (1 warning)');
        assert.equal(summaryOf(issues), '2 issues (1 error, 1 warning)');
        assert.equal(summaryOf([issues[1], issues[1]]), '2 issues (2 errors)');
    });
});
