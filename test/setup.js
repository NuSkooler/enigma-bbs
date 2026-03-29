'use strict';

//  Mocha setup — loaded via --require before any test file.
//
//  The ENiGMA view system uses enigma_assert(), which calls Config() at first
//  invocation.  In tests, Config.create() is never called, so Config.get is
//  undefined by default.  Patch it here — before any test file is loaded — so
//  that enigma_assert silently no-ops rather than throwing.

require('../core/config.js').get = () => ({ debug: { assertsEnabled: false } });
