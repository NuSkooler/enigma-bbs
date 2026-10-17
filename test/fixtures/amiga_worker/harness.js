'use strict';

//
//  Worker entry for test/amiga_worker.test.js: core/amiga_door/amiga_worker.js
//  with require('enigma-vamiga') answered by fake_vamiga.js, so the worker's
//  queueing, framing and persist logic run without an emulator.
//
const Module = require('module');
const path = require('path');

const FAKE = path.join(__dirname, 'fake_vamiga.js');
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
    if ('enigma-vamiga' === request) {
        return FAKE;
    }
    return resolve.call(this, request, ...rest);
};

require('../../../core/amiga_door/amiga_worker.js');
