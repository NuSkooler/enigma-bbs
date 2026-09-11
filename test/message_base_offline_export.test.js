'use strict';

const { strict: assert } = require('assert');
const { EventEmitter } = require('events');

const configModule = require('../core/config.js');

const MessageBaseOfflineExport = require('../core/message_base_offline_export.js');
const QWKExport = require('../core/message_base_qwk_export.js').getModule;
const BlueWaveExport = require('../core/message_base_bluewave_export.js').getModule;

//
//  The module is exercised through its prototype: constructing it wants a live
//  menu stack and a file area, and none of this touches either.
//
function makeModule(Module, { properties = {}, config = {} } = {}) {
    const mod = Object.create(Module.prototype);
    mod.config = config;
    mod.tempPacketDir = '/tmp/does-not-matter';
    mod.client = {
        user: {
            getProperty: name => properties[name],
        },
    };
    return mod;
}

//  a stand-in for a packet writer, which is an EventEmitter either way
class FakeWriter extends EventEmitter {
    constructor(outcome) {
        super();
        this.outcome = outcome;
    }

    finish() {
        process.nextTick(() => {
            if ('error' === this.outcome) {
                return this.emit('error', new Error('archiver failed'));
            }
            this.emit('packet', { path: '/tmp/ENIGMA.QWK', stats: { size: 42 } });
            this.emit('finished');
        });
    }
}

describe('offline packet export', () => {
    //
    //  A writer that fails while finishing used to leave the caller sitting on
    //  the export screen: the only 'error' handler recorded the failure and
    //  the step waited on 'finished', which never came.
    //
    it('ends the wait when the writer fails while finishing', done => {
        const mod = makeModule(MessageBaseOfflineExport);
        mod._finishPacket(new FakeWriter('error'), err => {
            assert.ok(err, 'expected an error');
            assert.equal(err.message, 'archiver failed');
            done();
        });
    });

    it('hands back the packet when the writer finishes', done => {
        const mod = makeModule(MessageBaseOfflineExport);
        mod._finishPacket(new FakeWriter('ok'), (err, packetInfo) => {
            assert.equal(err, null);
            assert.equal(packetInfo.path, '/tmp/ENIGMA.QWK');
            done();
        });
    });

    it('answers only once, however many events arrive', done => {
        const mod = makeModule(MessageBaseOfflineExport);
        const writer = new FakeWriter('ok');
        let calls = 0;

        mod._finishPacket(writer, () => {
            calls += 1;
        });

        setTimeout(() => {
            writer.emit('error', new Error('and then it failed too'));
            assert.equal(calls, 1);
            done();
        }, 10);
    });

    //  the extension is part of what a reader recognizes
    it('keeps the extension the writer chose', () => {
        const mod = makeModule(MessageBaseOfflineExport);
        const name = mod.tempDownloadFileName({ path: '/tmp/work/ENIGMA.MO4' });
        assert.ok(name.endsWith('.MO4'), name);
        assert.equal(name.length, 8 + '.MO4'.length);
    });

    it('falls back to the format defaults when the caller has chosen nothing', () => {
        const mod = makeModule(QWKExport);
        assert.deepEqual(mod._getUserExportOptions(), {
            enableQWKE: true,
            enableHeadersExtension: true,
            enableAtKludges: true,
            archiveFormat: 'application/zip',
        });
    });

    it('reads the options the caller has stored', () => {
        const mod = makeModule(QWKExport, {
            properties: { qwk_export_options: '{"archiveFormat":"application/x-7z"}' },
        });
        assert.deepEqual(mod._getUserExportOptions(), {
            archiveFormat: 'application/x-7z',
        });
    });

    it('reads the areas the caller has stored', () => {
        const mod = makeModule(QWKExport, {
            properties: {
                qwk_export_msg_areas: JSON.stringify([
                    { areaTag: 'general', newerThanTimestamp: '2026-09-09T00:00:00Z' },
                ]),
            },
        });

        const areas = mod._getUserExportAreas();
        assert.equal(areas.length, 1);
        assert.equal(areas[0].areaTag, 'general');
        assert.ok(areas[0].newerThanTimestamp.isValid(), 'parsed as a moment');
    });

    //  a format that supplies none of them cannot export, and says so
    it('requires a format to name itself and its writer', () => {
        const mod = makeModule(MessageBaseOfflineExport);
        assert.throws(() => mod.packetFormatName, /packetFormatName/);
        assert.throws(() => mod.userProperties, /userProperties/);
        assert.throws(() => mod.createPacketWriter({}), /createPacketWriter/);
    });

    //
    //  The hook whose breakage is silent: a writer built without the board's
    //  packet ID produces a packet named for the wrong system rather than an
    //  error.
    //
    it('hands the packet ID to the writer it builds', () => {
        const mod = makeModule(QWKExport, { config: { bbsID: 'TESTBBS' } });
        const writer = mod.createPacketWriter({ user: null });
        assert.equal(writer.options.bbsID, 'TESTBBS');
        writer.temptmp.cleanup(); //  the constructor tracks a session of its own
    });

    //  a menu whose art carries neither view is a format's own business
    it('asks for the status and progress views by default', () => {
        assert.deepEqual(makeModule(MessageBaseOfflineExport).requiredViewIds(), [1, 2]);
    });

    //
    //  A missing hook used to surface from inside a callback, after the idle
    //  monitor was stopped and a key press listener attached, leaving the
    //  session wedged with neither undone.
    //
    it('names the hook a format forgot, before the export starts', () => {
        class Incomplete extends MessageBaseOfflineExport {
            get packetFormatName() {
                return 'Incomplete';
            }
            get userProperties() {
                return { ExportOptions: 'x', ExportAreas: 'y' };
            }
            noResultsMenuName() {
                return 'x';
            }
        }

        const missing = makeModule(Incomplete)._missingHook();
        assert.ok(missing, 'expected a missing hook');
        assert.match(missing.message, /createPacketWriter/);

        assert.match(
            makeModule(MessageBaseOfflineExport)._missingHook().message,
            /packetFormatName/
        );
        assert.equal(makeModule(QWKExport)._missingHook(), null);
    });

    it('carries the QWK names through to the base', () => {
        const mod = makeModule(QWKExport);
        assert.equal(mod.packetFormatName, 'QWK');
        assert.deepEqual(mod.userProperties, {
            ExportOptions: 'qwk_export_options',
            ExportAreas: 'qwk_export_msg_areas',
        });
    });
});

//
//  The export flow itself. The public area walk needs a live message base, so
//  what this reaches is the caller's private mail and everything after it:
//  the writer's start and finish, the counting, the delivery and the export
//  high-water mark.
//
describe('offline packet export flow', () => {
    const Message = require('../core/message.js');

    //
    //  Message is required as an object, so its statics can be stood in for.
    //  The originals are captured ONCE here, at require time: capturing them
    //  inside the factory would grab a stub the moment one test patched twice,
    //  and afterEach would then restore the stub for every later test file.
    //
    const realFindMessages = Message.findMessages;
    const realLoad = Message.prototype.load;

    afterEach(() => {
        Message.findMessages = realFindMessages;
        Message.prototype.load = realLoad;
    });

    //  a writer that reaches 'ready' and 'finished' the way a real one does
    class FakeWriter extends EventEmitter {
        constructor(startup = 'ready') {
            super();
            this.startup = startup;
            this.messages = [];
            this.finishedIn = null;
        }

        init() {
            process.nextTick(() => {
                if ('error' === this.startup) {
                    return this.emit('error', new Error('no temp directory'));
                }
                this.emit('ready');
                //  a writer that starts and then fails while gathering
                if ('lateError' === this.startup) {
                    process.nextTick(() =>
                        this.emit('error', new Error('the stream closed'))
                    );
                }
            });
        }

        appendMessage(message) {
            this.messages.push(message.subject);
        }

        finish(packetDirectory) {
            this.finishedIn = packetDirectory;
            process.nextTick(() => {
                this.emit('packet', { path: '/tmp/TEST.QWK', stats: { size: 7 } });
                this.emit('finished');
            });
        }
    }

    class FakeExport extends MessageBaseOfflineExport {
        get packetFormatName() {
            return 'Test';
        }
        get userProperties() {
            return { ExportOptions: 'test_options', ExportAreas: 'test_areas' };
        }
        noResultsMenuName() {
            return 'testNoResults';
        }
        createPacketWriter() {
            return this.writer;
        }
        prepareAreaForExport(packetWriter, info) {
            this.declared.push(info.areaTag);
            this.declaredInfo.push(info);
        }
    }

    function makeExport(messageIds, { Module = FakeExport, startup = 'ready' } = {}) {
        const mod = Object.create(Module.prototype);
        mod.config = { progBarChar: '▒' };
        mod.writer = new FakeWriter(startup);
        mod.tempPacketDir = '/tmp/packet-work';
        mod.declared = [];
        mod.declaredInfo = [];
        mod.delivered = null;
        mod.status = [];
        mod.warnings = [];
        mod.idle = [];
        mod.persisted = {};

        //  the delivery tail wants the file base; the flow above it does not
        mod._deliverPacket = (packetInfo, dir, cb) => {
            mod.delivered = { packetInfo, dir };
            return cb(null);
        };

        //  a view that records what it is told, so the progress path runs
        const view = {
            dimens: { width: 10 },
            setText: text => mod.status.push(text),
        };
        mod.viewControllers = { main: { getView: () => view } };
        mod.updateCustomViewTextsWithFilter = () => {};

        mod.client = {
            log: {
                warn: ctx => mod.warnings.push(ctx),
                error: () => {},
            },
            stopIdleMonitor: () => mod.idle.push('stop'),
            startIdleMonitor: () => mod.idle.push('start'),
            on: () => {},
            removeListener: () => {},
            user: {
                userId: 1,
                username: 'testuser',
                getProperty: name =>
                    'test_areas' === name
                        ? JSON.stringify([{ areaTag: Message.WellKnownAreaTags.Private }])
                        : undefined,
                persistProperty: (name, value, cb) => {
                    mod.persisted[name] = value;
                    return cb(null);
                },
            },
        };

        Message.findMessages = (filter, cb) => {
            mod.lastFilter = filter;
            return cb(null, messageIds);
        };
        Message.prototype.load = function (options, cb) {
            this.subject = `Message ${options.messageId}`;
            return cb(null);
        };

        return mod;
    }

    it('walks the caller private mail into the writer and delivers the packet', done => {
        const mod = makeExport([10, 11, 12]);

        mod._performExport('/tmp/downloads', err => {
            assert.equal(err, null);
            assert.deepEqual(mod.writer.messages, [
                'Message 10',
                'Message 11',
                'Message 12',
            ]);
            assert.equal(mod.lastFilter.privateTagUserId, 1);
            assert.equal(mod.writer.finishedIn, '/tmp/packet-work');
            assert.ok(mod.delivered, 'the packet was delivered');
            assert.equal(mod.delivered.packetInfo.path, '/tmp/TEST.QWK');
            assert.equal(mod.delivered.dir, '/tmp/downloads');
            done();
        });
    });

    //  a format that lists areas in the packet is told about the private one too
    it('declares the private area to the writer', done => {
        const mod = makeExport([10]);
        mod._performExport('/tmp/downloads', () => {
            assert.deepEqual(mod.declared, [Message.WellKnownAreaTags.Private]);
            done();
        });
    });

    //  the hook gets one shape: private mail is a real area, so |area| and
    //  |conf| are populated for it exactly as they are for a public one
    it('hands the private area its area and conference', done => {
        const previousConfig = configModule._pushTestConfig({
            debug: { assertsEnabled: false },
            menus: { cls: false },
            general: { boardName: 'ENiGMA½ BBS' },
            messageConferences: {
                system_internal: {
                    name: 'System Internal',
                    areas: {
                        private_mail: { name: 'Private Mail' },
                    },
                },
            },
        });

        const mod = makeExport([10]);
        mod._performExport('/tmp/downloads', () => {
            configModule._popTestConfig(previousConfig);

            assert.equal(mod.declaredInfo.length, 1);
            const info = mod.declaredInfo[0];
            assert.equal(info.areaTag, Message.WellKnownAreaTags.Private);
            assert.equal(info.area.name, 'Private Mail');
            assert.equal(info.conf.name, 'System Internal');
            done();
        });
    });

    it('tells the caller where the packet went', done => {
        const mod = makeExport([10]);
        mod._performExport('/tmp/downloads', () => {
            assert.match(
                mod.status[mod.status.length - 1],
                /A Test packet has been placed in your download queue/
            );
            done();
        });
    });

    //  a stopped idle monitor that is never restarted leaves a node that
    //  cannot time out
    it('restarts the idle monitor whatever happens', done => {
        const mod = makeExport([10]);
        mod._performExport('/tmp/downloads', () => {
            assert.deepEqual(mod.idle, ['stop', 'start']);
            done();
        });
    });

    it('records how far each area was exported, so the next packet carries only what is new', done => {
        const mod = makeExport([10]);
        mod._performExport('/tmp/downloads', () => {
            const areas = JSON.parse(mod.persisted.test_areas);
            assert.equal(areas.length, 1);
            assert.equal(areas[0].areaTag, Message.WellKnownAreaTags.Private);
            assert.ok(
                new Date(areas[0].newerThanTimestamp).getTime() > 0,
                'a usable timestamp was written'
            );
            done();
        });
    });

    //  nothing to export is not an error the caller should see
    it('says so, and does not deliver a packet, when there is nothing to export', done => {
        const mod = makeExport([]);
        mod._performExport('/tmp/downloads', err => {
            assert.equal(err, null, 'swallowed rather than raised');
            assert.equal(mod.delivered, null);
            assert.match(mod.status[mod.status.length - 1], /No messages to export/);
            done();
        });
    });

    //
    //  A writer that fails to start used to leave the caller on the export
    //  screen: the error handler recorded the failure and the step went on
    //  waiting for 'ready'.
    //
    it('ends the export when the writer fails to start', done => {
        const mod = makeExport([10], { startup: 'error' });
        mod._performExport('/tmp/downloads', err => {
            assert.ok(err, 'expected an error');
            assert.equal(err.message, 'no temp directory');
            assert.equal(mod.delivered, null);
            assert.deepEqual(mod.idle, ['stop', 'start'], 'and cleans up after itself');
            done();
        });
    });

    //
    //  The writer's error handler answers the step that started it. Once the
    //  step has been answered a later failure must not answer it again: the
    //  waterfall would run its next step twice.
    //
    it('answers the start of the export once, even if the writer fails later', done => {
        const mod = makeExport([10], { startup: 'lateError' });
        let calls = 0;

        mod._performExport('/tmp/downloads', () => {
            calls += 1;
        });

        setTimeout(() => {
            assert.equal(calls, 1);
            done();
        }, 50);
    });

    it('logs a warning the writer raises', done => {
        const mod = makeExport([10]);
        mod.writer.once('ready', () =>
            mod.writer.emit('warning', new Error('an area was too large'))
        );

        mod._performExport('/tmp/downloads', () => {
            assert.equal(mod.warnings.length, 1);
            assert.equal(mod.warnings[0].warning.message, 'an area was too large');
            done();
        });
    });

    //
    //  A format missing a hook has to fail before the export touches the
    //  session: past that point the idle monitor is stopped and a key press
    //  listener is attached, and neither is undone by a throw.
    //
    it('refuses a format that has not supplied its hooks, before it starts', done => {
        class Incomplete extends MessageBaseOfflineExport {
            get packetFormatName() {
                return 'Incomplete';
            }
            get userProperties() {
                return { ExportOptions: 'x', ExportAreas: 'y' };
            }
            noResultsMenuName() {
                return 'x';
            }
        }

        const mod = makeExport([10], { Module: Incomplete });
        mod._performExport('/tmp/downloads', err => {
            assert.ok(err, 'expected an error');
            assert.match(err.message, /createPacketWriter/);
            assert.deepEqual(mod.idle, [], 'the idle monitor was never stopped');
            assert.equal(mod.delivered, null);
            done();
        });
    });
});

//
//  The Blue Wave format's own hooks. The flow above them is covered by the
//  fake format elsewhere in this file; what is checked here is that this
//  subclass fills every hook the flow calls, since a missing one is only
//  discovered when a caller tries to export.
//
describe('Blue Wave export format', () => {
    it('names itself and the properties it stores under', () => {
        const mod = makeModule(BlueWaveExport);
        assert.equal(mod.packetFormatName, 'Blue Wave');
        assert.deepEqual(mod.userProperties, {
            ExportOptions: 'bluewave_export_options',
            ExportAreas: 'bluewave_export_msg_areas',
        });
    });

    it('supplies every hook the flow requires', () => {
        assert.equal(makeModule(BlueWaveExport)._missingHook(), null);
    });

    //  no art ships for this format, so it must not ask the menu for views
    it('asks for no views, unlike the default', () => {
        assert.deepEqual(makeModule(BlueWaveExport).requiredViewIds(), []);
        assert.deepEqual(makeModule(MessageBaseOfflineExport).requiredViewIds(), [1, 2]);
    });

    it('hands the packet ID to the writer it builds', () => {
        const mod = makeModule(BlueWaveExport, { config: { bbsID: 'TESTBBS' } });
        const writer = mod.createPacketWriter({ user: null });
        assert.equal(writer.options.bbsID, 'TESTBBS');
        writer.temptmp.cleanup(); //  the constructor tracks a session of its own
    });

    //
    //  Blue Wave lists every area the caller can reach, not only those with
    //  new mail, so the hook has to reach the writer for an area that never
    //  produces a message.
    //
    it('declares an area to the writer by tag', () => {
        const declared = [];
        makeModule(BlueWaveExport).prepareAreaForExport(
            { addArea: areaTag => declared.push(areaTag) },
            { areaTag: 'general', area: { name: 'General' }, conf: { name: 'Local' } }
        );
        assert.deepEqual(declared, ['general']);
    });
});
