'use strict';

//
//  The FSE's '[ANSI] ' subject tag never cuts the subject: it is added only
//  when the whole subject still fits the field, and only a tag the editor
//  added is taken off again (#1036).
//

const { strict: assert } = require('assert');

const TAG = '[ANSI] ';

describe('FSE [ANSI] subject tag', function () {
    let EditTextView;
    let FullScreenEditorModule;

    before(function () {
        ({ EditTextView } = require('../core/edit_text_view.js'));
        ({ FullScreenEditorModule } = require('../core/fse.js'));
    });

    function makeClient() {
        const debug = [];
        return {
            debug,
            term: { termWidth: 80, termHeight: 25, write() {}, rawWrite() {} },
            user: { username: 'Bryan' },
            log: {
                trace() {},
                debug: (...a) => debug.push(a),
                info() {},
                warn() {},
                error() {},
                fatal() {},
            },
        };
    }

    //  The real subject field (an ET, maxLength 72 as the stock templates
    //  set it) and the real method, on a module that has only what it reads
    function makeEditor(subject, { maxLength = 72 } = {}) {
        const client = makeClient();
        const subjView = new EditTextView({
            client,
            id: 3,
            position: { row: 3, col: 5 },
            dimens: { width: 60, height: 1 },
            maxLength,
        });
        subjView.setText(subject, false);
        const editor = {
            client,
            viewControllers: {
                header: {
                    getView: () => subjView,
                    getFormData: () => ({ value: { subject: subjView.getData() } }),
                },
            },
            sync(isAnsi) {
                FullScreenEditorModule.prototype._syncAnsiSubjectTag.call(this, isAnsi);
            },
        };
        return { editor, subjView, client };
    }

    it('a short subject: added, then removed, round trips exactly', function () {
        const { editor, subjView } = makeEditor('RE: My art');
        editor.sync(true);
        assert.equal(subjView.getData(), TAG + 'RE: My art');
        editor.sync(false);
        assert.equal(subjView.getData(), 'RE: My art');
    });

    it('a subject the tag would push past the field is left untagged', function () {
        const subject = 'RE: ' + 'x'.repeat(60) + 'TAILEND!';
        assert.equal(subject.length, 72);
        const { editor, subjView, client } = makeEditor(subject);
        editor.sync(true);
        assert.equal(subjView.getData(), subject);
        assert.equal(client.debug.length, 1);
        editor.sync(false);
        assert.equal(subjView.getData(), subject);
    });

    it('a subject that fits exactly is tagged, and comes back whole', function () {
        const subject = 'y'.repeat(65);
        const { editor, subjView } = makeEditor(subject);
        editor.sync(true);
        assert.equal(subjView.getData(), TAG + subject);
        assert.equal(subjView.getData().length, 72);
        editor.sync(false);
        assert.equal(subjView.getData(), subject);
    });

    it("the field's own maxLength is the limit, not a fixed 72", function () {
        const { editor, subjView } = makeEditor('abcdefghij', { maxLength: 16 });
        editor.sync(true);
        assert.equal(subjView.getData(), 'abcdefghij');
    });

    it('a reply to a tagged subject is not tagged twice', function () {
        const { editor, subjView } = makeEditor('RE: [ANSI] My art');
        editor.sync(true);
        assert.equal(subjView.getData(), 'RE: [ANSI] My art');
        editor.sync(false); //  not a tag the editor added
        assert.equal(subjView.getData(), 'RE: [ANSI] My art');
    });

    it('a tag already at the front counts, whatever the case of RE:', function () {
        for (const subject of ['[ANSI] My art', 're: [ANSI] My art']) {
            const { editor, subjView } = makeEditor(subject);
            editor.sync(true);
            assert.equal(subjView.getData(), subject);
        }
    });

    it('a tag the user typed is not removed', function () {
        const { editor, subjView } = makeEditor('[ANSI] typed by hand');
        editor.sync(false);
        assert.equal(subjView.getData(), '[ANSI] typed by hand');
    });

    it('a tag the user deleted after it was added is not removed again', function () {
        const { editor, subjView } = makeEditor('Hello');
        editor.sync(true);
        subjView.setText('[ANSI]Hello', false); //  user removed the space
        editor.sync(false);
        assert.equal(subjView.getData(), '[ANSI]Hello');
        //  and a later ANSI body tags again, from what is there now
        subjView.setText('Hello', false);
        editor.sync(true);
        assert.equal(subjView.getData(), TAG + 'Hello');
    });

    it('a tag added before a menu round trip can still be removed after it', function (done) {
        const { editor, subjView } = makeEditor('Hello');
        editor.sync(true);

        const saved = FullScreenEditorModule.prototype.getSaveState.call(
            Object.assign({}, editor, { isReady: true, _bodyView: null })
        );
        assert.equal(saved.ansiTagAdded, true);
        assert.equal(saved.headerSubject, TAG + 'Hello');

        //  a new module instance, as the menu system makes one
        const fresh = makeEditor('');
        Object.assign(fresh.editor, {
            _pendingSavedState: saved,
            isEditMode: () => false,
        });
        fresh.editor.viewControllers.header.getView = () => fresh.subjView;
        FullScreenEditorModule.prototype._restoreSavedState.call(fresh.editor, err => {
            assert.ifError(err);
            assert.equal(fresh.subjView.getData(), TAG + 'Hello');
            fresh.editor.sync(false);
            assert.equal(fresh.subjView.getData(), 'Hello');
            assert.equal(subjView.getData(), TAG + 'Hello'); //  untouched
            return done();
        });
    });
});
