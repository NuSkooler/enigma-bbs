'use strict';

//
//  @method targets for test/event_scheduler.test.js. Action paths are taken
//  from the install directory, so entries name this file as
//  test/fixtures/event_scheduler/methods.js.
//

const state = {
    calls: [],
    //  callbacks of 'hold' runs, completed by the test
    pending: [],
};

exports.state = state;

exports.reset = () => {
    state.calls = [];
    state.pending = [];
};

exports.ok = (args, cb) => {
    state.calls.push({ method: 'ok', args });
    return cb(null);
};

exports.fail = (args, cb) => {
    state.calls.push({ method: 'fail', args });
    return cb(new Error('boom'));
};

exports.hold = (args, cb) => {
    state.calls.push({ method: 'hold', args });
    state.pending.push(cb);
};
