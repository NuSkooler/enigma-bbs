/* jslint node: true */
'use strict';

//  ENiGMA½
const Config = require('./config.js').get;
const Log = require('./logger.js').log;

//  deps
const assert = require('assert');

module.exports = function (condition, message) {
    if (Config().debug.assertsEnabled) {
        assert.apply(this, arguments);
    } else if (!condition) {
        const stack = new Error().stack;
        Log.error({ condition: condition, stack: stack }, message || 'Assertion failed');
    }
};
