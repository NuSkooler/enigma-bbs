'use strict';

//
//  Gopher and NNTP both flatten a message body for a reader that cannot render
//  anything the BBS draws with. Both route an ANSI body through AnsiPrep() and
//  everything else through a strip -- and AnsiPrep knows nothing about pipe
//  codes, so for a long time the ANSI branch published them verbatim.
//
//  isAnsi() trips at four escape sequences (ANSI_DET_THRESHOLD), which is to
//  say: every decorated message. These pin both branches.
//

const { strict: assert } = require('assert');

const configModule = require('../core/config.js');
configModule.get = () => ({
    debug: { assertsEnabled: false },
    menus: { cls: false },
    general: { boardName: 'TestBoard' },
    contentServers: { gopher: {}, nntp: {} },
});

const { isAnsi } = require('../core/string_util.js');
const GopherModule = require('../core/servers/content/gopher.js').getModule;

const ESC = '\x1b';

//  An ANSI post with a pipe-coded auto-signature appended -- what fse.js
//  actually produces, and the shape that used to leak.
const ANSI_BODY_WITH_PIPE_SIG =
    `${ESC}[0m${ESC}[1;36mCOOL ${ESC}[1;35mPOST${ESC}[0m\r\n` +
    'some text here\r\n' +
    '--- \r\n' +
    '|07SysOp|16 of |BRThe Board|00\r\n';

const PLAIN_BODY_WITH_PIPE = 'hello |07there|00 friend';

describe('Gopher prepareMessageBody()', function () {
    //  The method is on the prototype and touches no connection state.
    const gopher = Object.create(GopherModule.prototype);

    function prep(body, cb) {
        gopher.prepareMessageBody(body, cb);
    }

    it('treats a decorated post as ANSI', () => {
        assert.equal(isAnsi(ANSI_BODY_WITH_PIPE_SIG), true);
    });

    it('strips pipe codes from an ANSI body (the AnsiPrep branch)', done => {
        prep(ANSI_BODY_WITH_PIPE_SIG, out => {
            assert.ok(
                !/\|[A-Z\d]{2}/.test(out),
                `pipe code survived: ${JSON.stringify(out)}`
            );
            done();
        });
    });

    it('keeps the surrounding text when stripping an ANSI body', done => {
        prep(ANSI_BODY_WITH_PIPE_SIG, out => {
            assert.ok(out.includes('COOL POST'), 'post text lost');
            assert.ok(out.includes('SysOp'), 'signature name lost');
            assert.ok(out.includes('The Board'), 'board name lost');
            done();
        });
    });

    it('leaves no ESC in an ANSI body', done => {
        prep(ANSI_BODY_WITH_PIPE_SIG, out => {
            assert.ok(!out.includes(ESC), 'ESC survived');
            done();
        });
    });

    it('strips pipe codes from a non-ANSI body', done => {
        prep(PLAIN_BODY_WITH_PIPE, out => {
            assert.ok(!/\|[A-Z\d]{2}/.test(out));
            assert.ok(out.includes('hello'));
            assert.ok(out.includes('there'));
            done();
        });
    });

    it('leaves "||" alone, matching what the terminal renders', done => {
        prep('if (a || b) {', out => {
            assert.ok(out.includes('a || b'), `got: ${JSON.stringify(out)}`);
            done();
        });
    });

    it('passes plain text through unchanged apart from wrapping', done => {
        prep('just a normal message', out => {
            assert.ok(out.includes('just a normal message'));
            done();
        });
    });
});

describe('NNTP prepareMessageBody()', function () {
    const { NNTPServer } = require('../core/servers/content/nntp.js');
    const nntp = Object.create(NNTPServer.prototype);

    //  NNTP sets message.preparedBody rather than handing the text back.
    function prep(body, cb) {
        const message = { message: body };
        nntp.prepareMessageBody(message, () => cb(message.preparedBody));
    }

    it('strips pipe codes from an ANSI body (the AnsiPrep branch)', done => {
        prep(ANSI_BODY_WITH_PIPE_SIG, out => {
            assert.ok(
                !/\|[A-Z\d]{2}/.test(out),
                `pipe code survived: ${JSON.stringify(out)}`
            );
            done();
        });
    });

    it('keeps the surrounding text when stripping an ANSI body', done => {
        prep(ANSI_BODY_WITH_PIPE_SIG, out => {
            assert.ok(out.includes('COOL POST'), 'post text lost');
            assert.ok(out.includes('SysOp'), 'signature name lost');
            assert.ok(out.includes('The Board'), 'board name lost');
            done();
        });
    });

    it('leaves no ESC in an ANSI body', done => {
        prep(ANSI_BODY_WITH_PIPE_SIG, out => {
            assert.ok(!out.includes(ESC), 'ESC survived');
            done();
        });
    });

    it('strips pipe codes from a non-ANSI body', done => {
        prep(PLAIN_BODY_WITH_PIPE, out => {
            assert.ok(!/\|[A-Z\d]{2}/.test(out));
            assert.ok(out.includes('hello'));
            assert.ok(out.includes('there'));
            done();
        });
    });

    it('leaves "||" alone, matching what the terminal renders', done => {
        prep('if (a || b) {', out => {
            assert.equal(out, 'if (a || b) {');
            done();
        });
    });
});
