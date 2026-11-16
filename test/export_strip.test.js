'use strict';

const { strict: assert } = require('assert');

//
//  Text handed to something that cannot draw codes (e-mail, FSE export, the
//  REST API, NNTP, Gopher, ActivityPub) goes through stripAllControlCodes():
//  a code the message body renderer consumes goes, and what it shows
//  literally stays.
//
describe('Export stripping (message body grammar)', function () {
    let stripAllControlCodes;
    let PipeCodes;
    let previous;

    before(function () {
        ({ stripAllControlCodes } = require('../core/string_util.js'));
        PipeCodes = require('../core/pipe_codes.js');
        //  the codes predefined_mci.js would register, without loading it
        previous = PipeCodes.setMciResolver(
            () => undefined,
            new Set(['UN', 'UR', 'CF', 'CB', 'CU', 'CD', 'VN'])
        );
    });

    after(function () {
        PipeCodes.setMciResolver(previous.resolver, previous.knownMci);
    });

    const cases = [
        //  [input, stripped, why]
        ['|07hi |UN there', 'hi  there', 'colours and known MCI codes go'],
        ['|ZZ top', '|ZZ top', 'an unknown |XY shows literally, so it stays'],
        ['|A1 x', '|A1 x', 'so does |A1'],
        ['|40x|99', 'x', '|32-|99 are consumed'],
        ['a||b', 'a||b', 'no pipe escape in a message body'],
        ['||07x', '|x', '"|" then colour 07'],
        ['|CF05x', '     x', 'a cursor-forward becomes spaces'],
        ['a |CF99 b', 'a       b', 'never more spaces than the code is long'],
        ['|CU02x|CB1y', 'xy', 'other cursor codes go'],
        ['|1Ahello', '|1Ahello', '|1A shows as typed'],
        ['@X1Fhi', '@X1Fhi', 'the PCBoard family is left alone'],
    ];

    for (const [input, want, why] of cases) {
        it(`${JSON.stringify(input)} -> ${JSON.stringify(want)}: ${why}`, function () {
            assert.equal(stripAllControlCodes(input), want);
        });
    }

    it('still strips ANSI and pipe codes that split each other', function () {
        assert.equal(stripAllControlCodes('\x1b[1|07m|0\x1b[0m7x'), 'x');
    });

    describe('REST _maybeStrip', function () {
        let messagesStrip;
        let filesStrip;

        before(function () {
            messagesStrip = require('../core/rest/routes/messages.js')._maybeStrip;
            filesStrip = require('../core/rest/routes/files.js')._maybeStrip;
        });

        it('strips pipe codes as well as ANSI when asked', function () {
            for (const fn of [messagesStrip, filesStrip]) {
                assert.equal(
                    fn('|15Hi\x1b[1;32m |UN|07, |ZZ stays', true),
                    'Hi , |ZZ stays'
                );
            }
        });

        it('leaves the text alone when not asked, and passes empty values through', function () {
            for (const fn of [messagesStrip, filesStrip]) {
                assert.equal(fn('|15Hi', false), '|15Hi');
                assert.equal(fn('', true), '');
                assert.equal(fn(undefined, true), undefined);
            }
        });
    });
});
