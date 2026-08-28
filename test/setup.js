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

//  MenuModule (and every subclass) reads Config().menus.cls in its constructor.
//  Modules capture `const Config = require('./config.js').get` at first-require,
//  and Node's module cache means a later _pushTestConfig() cannot rebind that
//  captured reference — so whichever test first constructs a MenuModule freezes
//  Config to THIS default. It must therefore carry everything a core constructor
//  reads, or those tests fail order-dependently with "Cannot read properties of
//  undefined (reading 'cls')".
//  |general.boardName| is here for the same reason: core/ftn_util.js captures
//  config.js's |get| at require time, and mocha loads every test file (and so
//  every top-level require) before running anything -- so ftn_util is pinned
//  to THIS config for the whole run, no matter what a later suite pushes.
//  getOrigin() reads general.boardName, and without it any test that exports
//  an FTN message throws from inside an async series.
const MINIMAL_CONFIG = {
    debug: { assertsEnabled: false },
    menus: { cls: false },
    general: { boardName: 'ENiGMA½ BBS' },
};
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
