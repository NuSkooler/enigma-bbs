'use strict';

//  Mocha setup — loaded via --require before any test file.
//  npm test wires this up via package.json; direct `npx mocha` invocations
//  on a single file should pass `--require test/setup.js` to get the same
//  Config and Log defaults.
//
//  The ENiGMA view system uses enigma_assert(), which calls Config() at first
//  invocation.  In tests, Config.create() is never called, so Config.get is
//  undefined by default.  Patch it here — before any test file is loaded — so
//  that enigma_assert silently no-ops rather than throwing.
//
//  Tests that need a richer Config (file base tests, etc.) should replace
//  Config.get with their own mock before requiring the modules under test.
//  Use the helpers below to save/restore across test suites.

const configModule = require('../core/config.js');

const MINIMAL_CONFIG = { debug: { assertsEnabled: false } };
configModule.get = () => MINIMAL_CONFIG;

//  Logger stub — production code reaches for require('../core/logger.js').log
//  at module-load time. In tests Log.init() never runs, so |log| is undefined
//  and any Log.warn(...) call throws. Install a quiet stub here so individual
//  test files don't have to. The .child() stub is for code paths that
//  ask for a child logger (binkp/session.js etc).
const loggerModule = require('../core/logger.js');
if (!loggerModule.log) {
    const stub = {
        warn() {},
        info() {},
        debug() {},
        trace() {},
        error() {},
        child() {
            return stub;
        },
    };
    loggerModule.log = stub;
}

//  Save/restore helpers so individual test suites can install a richer mock
//  without leaking into other suites.
configModule._pushTestConfig = function (cfg) {
    const previous = configModule.get;
    configModule.get = () => cfg;
    return previous;
};
configModule._popTestConfig = function (previous) {
    configModule.get = previous;
};
