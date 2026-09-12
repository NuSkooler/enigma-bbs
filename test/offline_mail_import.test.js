'use strict';

const { strict: assert } = require('assert');

const Message = require('../core/message.js');
const { getModule, PacketFormats } = require('../core/message_base_offline_import.js');

const importer = getModule.prototype;

const detect = members => {
    const format = PacketFormats.find(f => f.detect(members));
    return format && format.name;
};

//
//  The two guards below are the ones with no reader and no database in the
//  way, so they are exercised directly against a bare context rather than
//  through a session.
//
describe('offline mail import', () => {
    describe('threading a reply', () => {
        let realLoad;

        //  Message.load() reaches the message database, which no unit test
        //  has; the stub stands in for the row it would have found
        const withStoredMessage = stored => {
            Message.prototype.load = function (loadWith, cb) {
                if (!stored || stored.messageId !== loadWith.messageId) {
                    return cb(new Error('No such message'));
                }
                this.areaTag = stored.areaTag;
                return cb(null);
            };
        };

        beforeEach(() => {
            realLoad = Message.prototype.load;
        });

        afterEach(() => {
            Message.prototype.load = realLoad;
        });

        const reply = replyToNumber =>
            new Message({
                areaTag: 'general',
                message: 'A reply.',
                meta: { BlueWaveProperty: { bw_reply_to_num: replyToNumber } },
            });

        it('threads onto the message the packet named', done => {
            withStoredMessage({ messageId: 900, areaTag: 'general' });

            const message = reply(900);
            importer._resolveReplyTo(message, () => {
                assert.equal(message.replyToMsgId, 900);
                done();
            });
        });

        //
        //  A number that names a message in another area came from a packet
        //  built before the sysop moved things, or from a caller who edited
        //  the record. A wrong chain is worse than none.
        //
        it('will not thread onto a message in another area', done => {
            withStoredMessage({ messageId: 900, areaTag: 'somewhere_else' });

            const message = reply(900);
            importer._resolveReplyTo(message, () => {
                assert.equal(message.replyToMsgId, 0);
                done();
            });
        });

        it('leaves a reply to a message that no longer exists unthreaded', done => {
            withStoredMessage(null);

            const message = reply(900);
            importer._resolveReplyTo(message, () => {
                assert.equal(message.replyToMsgId, 0);
                done();
            });
        });

        //  zero is the format's "no number", and what the export writes for a
        //  message whose ID will not fit the field
        it('does nothing for a reply that names no message', done => {
            withStoredMessage({ messageId: 900, areaTag: 'general' });

            const message = reply(0);
            importer._resolveReplyTo(message, () => {
                assert.equal(message.replyToMsgId, 0);
                done();
            });
        });
    });

    //
    //  The reply packet carries the name it was built for. Uploaded under a
    //  different login, its messages would be posted over this caller's name.
    //
    describe('the name the packet was built for', () => {
        const contextFor = user => ({ client: { user } });

        const user = {
            username: 'anne',
            realName: () => 'Anne Onymous',
        };

        it('accepts the login the packet names', () => {
            const err = importer._checkPacketUser.call(contextFor(user), {
                loginName: 'anne',
            });
            assert.equal(err, null);
        });

        it('accepts the alias, in any case', () => {
            const err = importer._checkPacketUser.call(contextFor(user), {
                loginName: 'ANNE ONYMOUS',
            });
            assert.equal(err, null);
        });

        it('refuses a packet built for somebody else', () => {
            const err = importer._checkPacketUser.call(contextFor(user), {
                loginName: 'bob',
            });
            assert.ok(err);
            assert.match(err.message, /bob/);
        });

        //  an older reader may not fill the field at all
        it('accepts a packet that names nobody', () => {
            const err = importer._checkPacketUser.call(contextFor(user), {
                loginName: '',
            });
            assert.equal(err, null);
        });
    });

    //
    //  Nothing asks the caller what they uploaded, so the members have to
    //  separate the formats on their own.
    //
    describe('recognising a reply packet', () => {
        it('knows a Blue Wave reply by its records', () => {
            assert.equal(detect(['ENIGMA.UPL', '00000.MSG']), 'Blue Wave');
        });

        it('knows an older Blue Wave reply', () => {
            assert.equal(detect(['ENIGMA.UPI', 'ENIGMA.NET', '00000.MSG']), 'Blue Wave');
        });

        it('knows a QWK reply by its lone messages file', () => {
            assert.equal(detect(['ENIGMA.MSG']), 'QWK');
        });

        //
        //  Both formats name their message files .MSG, so a Blue Wave packet
        //  would answer a "carries a .MSG" test as well as QWK does.
        //
        it('does not take a Blue Wave reply for a QWK one', () => {
            assert.equal(detect(['ENIGMA.UPL', '00000.MSG', '00001.MSG']), 'Blue Wave');
        });

        //  CONTROL.DAT means this is the packet that was downloaded
        it('does not take a downloaded QWK packet for a reply', () => {
            assert.equal(
                detect(['CONTROL.DAT', 'MESSAGES.DAT', 'ENIGMA.MSG']),
                undefined
            );
        });

        it('recognises nothing in an unrelated archive', () => {
            assert.equal(detect(['READ.ME', 'SETUP.EXE']), undefined);
        });
    });
});

//
//  uses_upl_file tells a reader whether to write replies at all, so it has to
//  follow whether this board can take them -- which is a menu the sysop adds,
//  not something the format knows.
//
describe('advertising that replies are accepted', () => {
    const {
        getModule: exportModule,
    } = require('../core/message_base_bluewave_export.js');
    const exporter = exportModule.prototype;

    const withMenus = menus => ({ client: { currentTheme: { menus } } });

    it('is on when a menu carries the import module', () => {
        const context = withMenus({
            messageBaseMainMenu: { art: 'MSGMNU' },
            offlineMailImport: { module: 'message_base_offline_import' },
        });
        assert.equal(exporter.acceptsReplies.call(context), true);
    });

    //  an upgraded board keeps the menus it already had
    it('is off when no menu does', () => {
        const context = withMenus({
            messageBaseMainMenu: { art: 'MSGMNU' },
            bluewaveExport: { module: 'message_base_bluewave_export' },
        });
        assert.equal(exporter.acceptsReplies.call(context), false);
    });

    it('is off before a theme has loaded', () => {
        assert.equal(exporter.acceptsReplies.call({ client: {} }), false);
    });
});
