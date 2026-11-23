'use strict';

const { strict: assert } = require('assert');
const events = require('events');
const fs = require('fs');
const os = require('os');
const paths = require('path');

const configModule = require('../core/config.js');
const { Client } = require('../core/client.js');

//
//  #1084: an ANSI body is saved as ANSI (the leading ANSI prefix and
//  explicit_encoding) whether or not the message is a reply, and the quote
//  builder no longer changes how an uploaded ANSI body is saved. A reply to
//  a subject the editor tagged ("[ANSI] RE: foo") is not given another RE:.
//
//  The editor here is the real one, its forms as the stock
//  messageAreaReplyPost sets them (misc/menu_templates/message_base.in.hjson);
//  only the art is stubbed (an mciMap per section).
//

const CONFIG = {
    debug: { assertsEnabled: false },
    menus: { cls: false },
    general: { boardName: 'Test' },
    messageConferences: {
        local: { name: 'Local', areas: { general: { name: 'General' } } },
    },
    theme: { default: 'luciano_blocktronics' },
    paths: { themes: '/nonexistent/themes', art: '/nonexistent/art' },
    term: { cp437TermList: [], utf8TermList: [] },
};

const FORMS = {
    0: {
        mci: {
            TL1: { argName: 'from' },
            ET2: { argName: 'to', focus: true, maxLength: 36 },
            ET3: { argName: 'subject', maxLength: 72, submit: true },
        },
        submit: {
            3: [{ value: { subject: null }, action: '@method:headerSubmit' }],
        },
    },
    1: {
        mci: { MT1: { width: 79, height: 14, argName: 'message', mode: 'edit' } },
        submit: { '*': [{ value: 'message', action: '@method:editModeEscPressed' }] },
        actionKeys: [{ keys: ['escape'], viewId: 1 }],
    },
    2: {
        mci: {
            SB1: {
                width: 9,
                panels: [
                    { name: 'mode', width: 3 },
                    { name: 'pos', width: 5 },
                ],
            },
        },
    },
    5: {
        mci: {
            MT1: { width: 79, height: 7 },
            VM3: { width: 79, height: 4, argName: 'quote' },
        },
        submit: {
            '*': [{ value: { quote: null }, action: '@method:appendQuoteEntry' }],
        },
        actionKeys: [{ keys: ['escape'], action: '@method:quoteBuilderEscPressed' }],
    },
};

function mci(code, id, row, col) {
    return { code, id, position: [row, col], args: [], SGR: '\x1b[0;37m' };
}

const ART = {
    H: {
        height: 4,
        mciMap: {
            TL1: mci('TL', 1, 1, 10),
            ET2: mci('ET', 2, 2, 10),
            ET3: mci('ET', 3, 3, 10),
        },
    },
    B: { height: 19, mciMap: { MT1: mci('MT', 1, 5, 1) } },
    FE: { height: 1, mciMap: { SB1: mci('SB', 1, 24, 1) } },
    Q: {
        height: 12,
        mciMap: { MT1: mci('MT', 1, 5, 1), VM3: mci('VM', 3, 13, 1) },
    },
};

const ESC = '\x1b';
const ART_BODY = `${ESC}[1;31mRED${ESC}[0m\r\n${ESC}[32mGREEN${ESC}[0m\r\n${ESC}[34mBLUE${ESC}[0m\r\n`;

function makeClient() {
    const client = new events.EventEmitter();
    client.log = {};
    ['trace', 'debug', 'info', 'warn', 'error', 'fatal'].forEach(level => {
        client.log[level] = () => {};
    });
    client.log.child = () => client.log;
    const term = { termWidth: 80, termHeight: 25, out: [] };
    term.write = (s, convertLf, cb) => {
        term.out.push(String(s));
        if (typeof convertLf === 'function') {
            convertLf();
        } else if (typeof cb === 'function') {
            cb();
        }
    };
    term.rawWrite = s => term.out.push(String(s));
    term.beginWrite = () => {};
    term.commitWrite = () => {};
    client.term = term;
    client.captureInput = Client.prototype.captureInput;
    client.releaseInput = Client.prototype.releaseInput;
    client.hasInputCapture = Client.prototype.hasInputCapture;
    client.user = {
        userId: 42,
        username: 'caller',
        realName: () => 'Caller',
        getProperty: () => undefined,
    };
    client.acs = {
        hasMessageBodyUpload: () => true,
        hasMessageConfWrite: () => true,
        hasMessageAreaWrite: () => true,
    };
    return client;
}

//  calls cb once cond() holds; the editor's async steps run on later ticks
function waitFor(cond, cb, tries = 500) {
    if (cond()) {
        return cb();
    }
    if (tries <= 0) {
        return cb(new Error('timed out waiting'));
    }
    return setImmediate(waitFor, cond, cb, tries - 1);
}

describe('FSE: an ANSI body, on a new post or a reply (#1084)', () => {
    let previousConfig;
    let AreaPostFSEModule;
    let Message;
    let theme;
    let previousDisplayThemeArt;
    let isAnsi;
    let FormLifecycle;
    let tempDirs;

    before(() => {
        previousConfig = configModule._pushTestConfig(CONFIG);
        AreaPostFSEModule = require('../core/msg_area_post_fse.js').getModule;
        Message = require('../core/message.js');
        theme = require('../core/theme.js');
        ({ isAnsi } = require('../core/string_util.js'));
        ({ FormLifecycle } = require('../core/view_controller.js'));
        //  the quote builder draws its art with theme.displayThemeArt()
        previousDisplayThemeArt = theme.displayThemeArt;
        theme.displayThemeArt = (options, cb) => setImmediate(cb, null, ART.Q);
    });
    after(() => {
        theme.displayThemeArt = previousDisplayThemeArt;
        configModule._popTestConfig(previousConfig);
    });
    beforeEach(() => {
        tempDirs = [];
    });
    afterEach(() => {
        tempDirs.forEach(dir => fs.rmSync(dir, { recursive: true, force: true }));
    });

    //  An uploaded file, in a temp dir of its own as _startBodyUpload() makes one
    function uploadFile(content) {
        const dir = fs.mkdtempSync(paths.join(os.tmpdir(), 'enig-fse-1084-'));
        tempDirs.push(dir);
        const file = paths.join(dir, 'body.ans');
        fs.writeFileSync(file, content);
        return { dir, file };
    }

    //  The editor as the menu stack starts it, drawn and ready: optionally a
    //  reply, optionally returning from a menu (savedState) with an upload
    function openEditor({ replyToMessage, savedState, upload } = {}, cb) {
        const client = makeClient();
        const options = {
            menuName: 'messageAreaReplyPost',
            menuConfig: {
                config: {
                    art: {
                        header: 'H',
                        body: 'B',
                        footerEditor: 'FE',
                        quote: 'Q',
                    },
                    editorMode: 'edit',
                    editorType: 'area',
                    noUpdateLastReadId: true,
                    quoteDateTimeFormat: 'YYYY-MM-DD',
                },
                form: FORMS,
            },
            extraArgs: { messageAreaTag: 'general', replyToMessage },
            client,
        };
        if (upload) {
            options.lastMenuResult = { recvFilePaths: [upload.file] };
        }
        const editor = new AreaPostFSEModule(options);
        client.currentMenuModule = editor;
        if (savedState) {
            editor.restoreSavedState(savedState);
        }
        editor.displayAsset = (name, opts, done) => setImmediate(done, null, ART[name]);
        editor.finishedLoading = () => cb(editor, client);
        editor.initSequence();
        return editor;
    }

    //  What getSaveState() wrote before the upload menu was entered
    function savedBeforeUpload(
        upload,
        { headerTo = 'All', headerSubject = 'My art' } = {}
    ) {
        return {
            bodyText: '',
            replyIsAnsi: false,
            bodyIsAnsi: false,
            headerFrom: 'caller',
            headerTo,
            headerSubject,
            ansiTagAdded: false,
            tempUploadDir: upload.dir + paths.sep,
        };
    }

    const subjectOf = editor => editor.viewControllers.header.getView(3).getData();

    function built(editor, cb) {
        editor.buildMessage(err => {
            assert.ifError(err);
            return cb(editor.message);
        });
    }

    function plainMessage(subject = 'Hello') {
        return new Message({
            areaTag: 'general',
            toUserName: 'caller',
            fromUserName: 'Someone',
            subject,
            message: 'first line of the original\r\nsecond line\r\n',
            messageId: 7,
        });
    }

    function ansiMessage(subject = 'Some art') {
        return new Message({
            areaTag: 'general',
            toUserName: 'caller',
            fromUserName: 'Artist',
            subject,
            message: ART_BODY,
            messageId: 8,
        });
    }

    //  Opens the quote builder, then selects |lines| quote lines with Enter,
    //  starting at |from| (default: the last |lines|, so the last Enter ends
    //  the session), then leaves with Escape if still open
    function quote(editor, client, { lines, from }, cb) {
        //  a second session's list is still filled from the first: empty it,
        //  so the wait below sees this session's lines
        editor.viewControllers.quoteBuilder?.getView(3).setItems([]);
        //  as editModeMenuQuote does: the builder is drawn over the body
        FormLifecycle.cover(editor.viewControllers.body);
        editor.displayQuoteBuilder();
        waitFor(
            () =>
                editor.viewControllers.quoteBuilder &&
                editor.viewControllers.quoteBuilder.getView(3).getCount() > 0,
            err => {
                assert.ifError(err);
                const list = editor.viewControllers.quoteBuilder.getView(3);
                const start = undefined === from ? list.getCount() - lines : from;
                if (lines > 0) {
                    list.setFocusItemIndex(start);
                }
                for (let i = 0; i < lines; ++i) {
                    client.emit('key press', '\r', { name: 'return' });
                }
                if (0 === lines || start + lines < list.getCount()) {
                    client.emit('key press', undefined, { name: 'escape' });
                }
                //  finalize redraws, then hands the body the keys back
                waitFor(() => editor.viewControllers.body.attached, cb);
            }
        );
    }

    it('a new post with an uploaded ANSI file is saved as ANSI, tagged', done => {
        const upload = uploadFile(ART_BODY);
        openEditor({ savedState: savedBeforeUpload(upload), upload }, editor => {
            assert.equal(subjectOf(editor), '[ANSI] My art');
            built(editor, msg => {
                assert.equal(msg.replyToMsgId, 0);
                assert.equal(msg.subject, '[ANSI] My art');
                assert.equal(msg.meta?.System?.explicit_encoding, 'cp437');
                assert.ok(msg.message.startsWith(`${ESC}[0m${ESC}[2J${ESC}[1;1H\r\n`));
                assert.ok(isAnsi(msg.message));
                assert.ok(msg.message.includes(`${ESC}[1;31mRED`));
                done();
            });
        });
    });

    it('saves the same body and meta as an ANSI reply with the same upload', done => {
        const postUpload = uploadFile(ART_BODY);
        openEditor(
            { savedState: savedBeforeUpload(postUpload), upload: postUpload },
            postEditor => {
                const replyUpload = uploadFile(ART_BODY);
                openEditor(
                    {
                        replyToMessage: plainMessage(),
                        savedState: savedBeforeUpload(replyUpload, {
                            headerTo: 'Someone',
                            headerSubject: 'RE: Hello',
                        }),
                        upload: replyUpload,
                    },
                    replyEditor => {
                        built(postEditor, post => {
                            built(replyEditor, reply => {
                                assert.equal(reply.replyToMsgId, 7);
                                assert.equal(post.message, reply.message);
                                assert.deepEqual(post.meta, reply.meta);
                                done();
                            });
                        });
                    }
                );
            }
        );
    });

    it('a plain upload is saved as plain text', done => {
        const upload = uploadFile('just some words\r\n');
        openEditor({ savedState: savedBeforeUpload(upload), upload }, editor => {
            assert.equal(subjectOf(editor), 'My art');
            built(editor, msg => {
                assert.equal(msg.meta?.System?.explicit_encoding, undefined);
                assert.equal(msg.message, 'just some words\r\n');
                done();
            });
        });
    });

    it('ANSI upload, then quoting a plain message: the body stays ANSI, tag kept', done => {
        const upload = uploadFile(ART_BODY);
        openEditor(
            {
                replyToMessage: plainMessage(),
                savedState: savedBeforeUpload(upload, {
                    headerTo: 'Someone',
                    headerSubject: 'RE: Hello',
                }),
                upload,
            },
            (editor, client) => {
                assert.equal(subjectOf(editor), '[ANSI] RE: Hello');
                quote(editor, client, { lines: 1 }, err => {
                    assert.ifError(err);
                    assert.equal(subjectOf(editor), '[ANSI] RE: Hello');
                    built(editor, msg => {
                        assert.equal(msg.meta?.System?.explicit_encoding, 'cp437');
                        assert.ok(msg.message.includes(`${ESC}[1;31mRED`));
                        assert.ok(msg.message.includes('second line'));
                        done();
                    });
                });
            }
        );
    });

    it('ANSI upload, then quoting an ANSI message: the body stays ANSI, tag kept', done => {
        const upload = uploadFile(ART_BODY);
        openEditor(
            {
                replyToMessage: ansiMessage(),
                savedState: savedBeforeUpload(upload, {
                    headerTo: 'Artist',
                    headerSubject: 'RE: Some art',
                }),
                upload,
            },
            (editor, client) => {
                quote(editor, client, { lines: 1 }, err => {
                    assert.ifError(err);
                    assert.equal(subjectOf(editor), '[ANSI] RE: Some art');
                    built(editor, msg => {
                        assert.equal(msg.meta?.System?.explicit_encoding, 'cp437');
                        assert.ok(msg.message.includes(`${ESC}[1;31mRED`));
                        done();
                    });
                });
            }
        );
    });

    it('quoting ANSI lines into a typed reply makes it ANSI and tags it', done => {
        openEditor({ replyToMessage: ansiMessage() }, (editor, client) => {
            assert.equal(subjectOf(editor), 'RE: Some art');
            quote(editor, client, { lines: 1 }, err => {
                assert.ifError(err);
                assert.equal(subjectOf(editor), '[ANSI] RE: Some art');
                built(editor, msg => {
                    assert.equal(msg.meta?.System?.explicit_encoding, 'cp437');
                    assert.ok(isAnsi(msg.message));
                    done();
                });
            });
        });
    });

    it('a subject already at the field length: saved as ANSI, left untagged', done => {
        const subject = 'S'.repeat(72);
        const upload = uploadFile(ART_BODY);
        openEditor(
            { savedState: savedBeforeUpload(upload, { headerSubject: subject }), upload },
            editor => {
                assert.equal(subjectOf(editor), subject);
                built(editor, msg => {
                    assert.equal(msg.subject, subject);
                    assert.equal(msg.meta?.System?.explicit_encoding, 'cp437');
                    assert.ok(
                        msg.message.startsWith(`${ESC}[0m${ESC}[2J${ESC}[1;1H\r\n`)
                    );
                    assert.ok(msg.message.includes(`${ESC}[1;31mRED`));
                    done();
                });
            }
        );
    });

    it('two ANSI quote sessions: the body keeps both, stays ANSI, tagged once', done => {
        const count = (str, sub) => str.split(sub).length - 1;
        openEditor({ replyToMessage: ansiMessage() }, (editor, client) => {
            //  RED, then GREEN and BLUE
            quote(editor, client, { lines: 1, from: 0 }, err => {
                assert.ifError(err);
                const first = editor._bodyView.getData({ forceLineTerms: true });
                assert.ok(first.includes('RED'));
                assert.equal(subjectOf(editor), '[ANSI] RE: Some art');
                quote(editor, client, { lines: 2, from: 1 }, err => {
                    assert.ifError(err);
                    const second = editor._bodyView.getData({ forceLineTerms: true });
                    //  the first session's text is still there, more after it
                    assert.ok(second.startsWith(first.trimEnd()));
                    assert.equal(count(second, 'RED'), 1);
                    assert.ok(second.indexOf('GREEN') > second.indexOf('RED'));
                    assert.ok(second.indexOf('BLUE') > second.indexOf('GREEN'));
                    assert.equal(subjectOf(editor), '[ANSI] RE: Some art');
                    built(editor, msg => {
                        assert.equal(msg.meta?.System?.explicit_encoding, 'cp437');
                        assert.ok(msg.message.includes('GREEN'));
                        assert.equal(count(msg.subject, '[ANSI]'), 1);
                        done();
                    });
                });
            });
        });
    });

    it('a plain upload, then an ANSI quote session: the body becomes ANSI, tagged', done => {
        const upload = uploadFile('words of my own\r\n');
        openEditor(
            {
                replyToMessage: ansiMessage(),
                savedState: savedBeforeUpload(upload, {
                    headerTo: 'Artist',
                    headerSubject: 'RE: Some art',
                }),
                upload,
            },
            (editor, client) => {
                assert.equal(subjectOf(editor), 'RE: Some art');
                quote(editor, client, { lines: 1 }, err => {
                    assert.ifError(err);
                    assert.equal(subjectOf(editor), '[ANSI] RE: Some art');
                    built(editor, msg => {
                        assert.equal(msg.meta?.System?.explicit_encoding, 'cp437');
                        assert.ok(msg.message.includes('words of my own'));
                        assert.ok(isAnsi(msg.message));
                        done();
                    });
                });
            }
        );
    });

    it('opening the quote builder on an ANSI message and quoting nothing changes nothing', done => {
        openEditor({ replyToMessage: ansiMessage() }, (editor, client) => {
            quote(editor, client, { lines: 0 }, err => {
                assert.ifError(err);
                assert.equal(subjectOf(editor), 'RE: Some art');
                built(editor, msg => {
                    assert.equal(msg.meta?.System?.explicit_encoding, undefined);
                    done();
                });
            });
        });
    });

    it('a plain upload replaces an ANSI body: saved plain, the added tag removed', done => {
        const ansiUpload = uploadFile(ART_BODY);
        openEditor(
            {
                replyToMessage: ansiMessage(),
                savedState: savedBeforeUpload(ansiUpload, {
                    headerTo: 'Artist',
                    headerSubject: 'RE: Some art',
                }),
                upload: ansiUpload,
            },
            first => {
                assert.equal(subjectOf(first), '[ANSI] RE: Some art');
                const saved = first.getSaveState();
                const plainUpload = uploadFile('words only\r\n');
                saved.tempUploadDir = plainUpload.dir + paths.sep;
                openEditor(
                    {
                        replyToMessage: ansiMessage(),
                        savedState: saved,
                        upload: plainUpload,
                    },
                    second => {
                        assert.equal(subjectOf(second), 'RE: Some art');
                        built(second, msg => {
                            assert.equal(msg.meta?.System?.explicit_encoding, undefined);
                            assert.equal(msg.message, 'words only\r\n');
                            done();
                        });
                    }
                );
            }
        );
    });

    it('an ANSI new post survives a menu round trip (e.g. help)', done => {
        const upload = uploadFile(ART_BODY);
        openEditor({ savedState: savedBeforeUpload(upload), upload }, first => {
            const saved = first.getSaveState();
            assert.equal(saved.bodyIsAnsi, true);
            openEditor({ savedState: saved }, second => {
                assert.equal(subjectOf(second), '[ANSI] My art');
                built(second, msg => {
                    assert.equal(msg.meta?.System?.explicit_encoding, 'cp437');
                    assert.ok(msg.message.includes(`${ESC}[1;31mRED`));
                    done();
                });
            });
        });
    });

    it('a saved state from before bodyIsAnsi (replyIsAnsi only) restores an ANSI body', done => {
        const saved = {
            bodyText: ART_BODY,
            replyIsAnsi: true,
            headerFrom: 'caller',
            headerTo: 'All',
            headerSubject: '[ANSI] My art',
            ansiTagAdded: true,
            tempUploadDir: null,
        };
        openEditor({ savedState: saved }, editor => {
            assert.equal(editor.bodyIsAnsi, true);
            built(editor, msg => {
                assert.equal(msg.meta?.System?.explicit_encoding, 'cp437');
                done();
            });
        });
    });

    describe('reply subjects', () => {
        const cases = [
            ['Hello', 'RE: Hello'],
            ['RE: Hello', 'RE: Hello'],
            ['re: Hello', 're: Hello'],
            //  tagged by the editor on an earlier ANSI reply
            ['[ANSI] RE: Hello', 'RE: Hello'],
            ['[ANSI] re: Hello', 're: Hello'],
            //  an ANSI original: the tag is part of the thread's subject
            ['[ANSI] Hello', 'RE: [ANSI] Hello'],
            ['RE: [ANSI] Hello', 'RE: [ANSI] Hello'],
        ];
        for (const [original, expected] of cases) {
            it(`a reply to "${original}" is "${expected}"`, done => {
                openEditor({ replyToMessage: plainMessage(original) }, editor => {
                    assert.equal(subjectOf(editor), expected);
                    done();
                });
            });
        }

        it('an ANSI reply to "[ANSI] RE: Hello" is tagged once, and untagged by a plain upload', done => {
            const upload = uploadFile(ART_BODY);
            openEditor({ replyToMessage: plainMessage('[ANSI] RE: Hello') }, first => {
                const saved = first.getSaveState();
                saved.tempUploadDir = upload.dir + paths.sep;
                openEditor(
                    {
                        replyToMessage: plainMessage('[ANSI] RE: Hello'),
                        savedState: saved,
                        upload,
                    },
                    second => {
                        assert.equal(subjectOf(second), '[ANSI] RE: Hello');
                        const again = second.getSaveState();
                        const plain = uploadFile('words\r\n');
                        again.tempUploadDir = plain.dir + paths.sep;
                        openEditor(
                            {
                                replyToMessage: plainMessage('[ANSI] RE: Hello'),
                                savedState: again,
                                upload: plain,
                            },
                            third => {
                                assert.equal(subjectOf(third), 'RE: Hello');
                                done();
                            }
                        );
                    }
                );
            });
        });
    });
});
