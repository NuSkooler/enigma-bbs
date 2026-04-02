'use strict';

//  Mocha setup — loaded via --require before any test file.
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
