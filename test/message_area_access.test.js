'use strict';

const { strict: assert } = require('assert');

//
//  hasMessageConfAndAreaRead() / hasMessageConfAndAreaWrite() with no area
//  at all: a user with no current message area posts (#1139). That threw a
//  TypeError; it is no access, so the caller takes its no-access path.
//

const configModule = require('../core/config.js');

const TEST_CONFIG = {
    debug: { assertsEnabled: false },
    messageConferences: {
        local: {
            name: 'Local',
            areas: {
                general: { name: 'General' },
                locked: {
                    name: 'Locked',
                    acs: { read: 'GM[sysops]', write: 'GM[sysops]' },
                },
            },
        },
    },
};

//  every ACS check passes unless the conf / area sets its own
function makeClient() {
    const allow = obj => !(obj && obj.acs);
    return {
        acs: {
            hasMessageConfRead: allow,
            hasMessageConfWrite: allow,
            hasMessageAreaRead: allow,
            hasMessageAreaWrite: allow,
        },
    };
}

describe('message area access with no area (#1139)', function () {
    let previousGet;
    let messageArea;

    before(() => {
        previousGet = configModule.get;
        configModule.get = () => TEST_CONFIG;
        messageArea = require('../core/message_area.js');
    });
    after(() => {
        configModule.get = previousGet;
    });

    [undefined, null].forEach(area => {
        it(`write: ${area} is no access, not a TypeError`, () => {
            assert.equal(
                messageArea.hasMessageConfAndAreaWrite(makeClient(), area),
                false
            );
        });

        it(`read: ${area} is no access, not a TypeError`, () => {
            assert.equal(
                messageArea.hasMessageConfAndAreaRead(makeClient(), area),
                false
            );
        });
    });

    it('a configured area by tag or object is checked as before', () => {
        const client = makeClient();
        assert.equal(messageArea.hasMessageConfAndAreaWrite(client, 'general'), true);
        assert.equal(messageArea.hasMessageConfAndAreaRead(client, 'general'), true);
        assert.equal(messageArea.hasMessageConfAndAreaWrite(client, 'locked'), false);
        const general = messageArea.getMessageAreaByTag('general');
        assert.equal(messageArea.hasMessageConfAndAreaWrite(client, general), true);
    });

    it('a tag no longer configured is no access (#1141)', () => {
        assert.equal(
            messageArea.hasMessageConfAndAreaWrite(makeClient(), 'gone_area'),
            false
        );
    });

    it('filterMessageAreaTagsByReadACS() drops a tag that is not configured', () => {
        assert.deepEqual(
            messageArea.filterMessageAreaTagsByReadACS(makeClient(), ['general', 'gone']),
            ['general']
        );
    });

    it('getMessageListForArea() with no area tag lists nothing', done => {
        messageArea.getMessageListForArea(makeClient(), undefined, (err, list) => {
            assert.ifError(err);
            assert.deepEqual(list, []);
            return done();
        });
    });
});
