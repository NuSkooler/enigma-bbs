'use strict';

const { strict: assert } = require('assert');
const events = require('events');

const { ViewController } = require('../core/view_controller.js');
const { setArtOrigin, getArtOrigin } = require('../core/mci_map_origin.js');

//
//  F4 (View Lifecycle Framework): view placement from config, and config
//  hygiene.
//
//  *   An `mci` key with a `position` and no marker in the art creates its
//      view, as if the art held the code there ("config-placed"). With a
//      marker as well, the explicit position wins.
//  *   `position` counts from the art's top-left corner (row 1, column 1),
//      wherever the art was drawn; viewOffsets apply as they do to markers.
//  *   Off screen: warned and skipped. An ID that is taken: skipped with the
//      "Duplicate MCI view ID" warning.
//  *   A key whose code is not the view's code still applies, with a
//      warning; so does a key that is not exactly a code and an ID.
//  *   Implicit submit: as before, except that config-placed keys are left
//      out of the "highest ID" choice.
//  *   Placed views are created after the form config is matched: the MCI
//      signature explicit form keys match is the art's alone.
//

function makeClient(menuConfig, { menuName = 'testMenu' } = {}) {
    const client = new events.EventEmitter();
    client.log = { warnings: [] };
    ['trace', 'debug', 'info', 'error', 'fatal'].forEach(level => {
        client.log[level] = () => {};
    });
    client.log.warn = (obj, msg) => client.log.warnings.push({ obj, msg });
    const term = { termWidth: 80, termHeight: 25, out: [], outputEncoding: 'cp437' };
    term.write = s => term.out.push(String(s));
    term.rawWrite = s => term.out.push(String(s));
    term.beginWrite = () => {};
    term.commitWrite = () => {};
    client.term = term;
    client.currentMenuModule = {
        menuName,
        menuConfig: menuConfig || {},
        menuMethods: {},
    };
    return client;
}

//  an mciMap entry as art.display() makes one
function mci(code, id, row, col, args = []) {
    return { code, id, position: [row, col], args, SGR: '\x1b[0;37m' };
}

function loadMenu(client, mciMap, options = {}) {
    const vc = new ViewController({ client, formId: options.formId });
    let called = 0;
    let error;
    vc.loadFromMenuConfig(Object.assign({ mciMap }, options), err => {
        ++called;
        error = err;
    });
    assert.equal(called, 1, 'loaded synchronously');
    assert.ifError(error);
    return vc;
}

function warningsMatching(client, re) {
    return client.log.warnings.filter(w => re.test(w.msg));
}

describe('View placement from config (F4)', () => {
    let vcs;
    beforeEach(() => {
        vcs = [];
    });
    afterEach(() => {
        //  tickers have timers
        vcs.forEach(vc => vc.destroy());
    });
    const track = vc => {
        vcs.push(vc);
        return vc;
    };

    describe('config-only views (a position, no marker)', () => {
        it('creates TL, TK, ET and ME views where the config says', () => {
            const client = makeClient({
                form: {
                    0: {
                        mci: {
                            ET1: { argName: 'name', focus: true, submit: true },
                            TL50: { position: { row: 3, col: 10 }, text: 'Hello' },
                            TK51: {
                                position: { row: 4, col: 2 },
                                width: 20,
                                text: 'ticker',
                            },
                            ET52: { position: { row: 5, col: 5 }, argName: 'extra' },
                            ME53: {
                                position: [6, 7],
                                argName: 'date',
                                maskPattern: '##/##',
                            },
                        },
                    },
                },
            });
            const vc = track(loadMenu(client, { ET1: mci('ET', 1, 1, 1) }));

            const expected = {
                50: ['TL', 3, 10, 'TextView'],
                51: ['TK', 4, 2, 'TickerView'],
                52: ['ET', 5, 5, 'EditTextView'],
                53: ['ME', 6, 7, 'MaskEditTextView'],
            };
            for (const [id, [code, row, col, ctor]] of Object.entries(expected)) {
                const view = vc.getView(id);
                assert.ok(view, `view ${id} created`);
                assert.equal(view.mciCode, code);
                assert.equal(view.constructor.name, ctor);
                assert.deepEqual(view.position, { row, col }, `view ${id} placed`);
            }

            //  configured by applyViewConfig() like any other view
            assert.equal(vc.getView(50).getData(), 'Hello');
            assert.equal(vc.getView(51).dimens.width, 20);
            assert.equal(vc.getView(52).submitArgName, 'extra');
            assert.equal(vc.getView(53).maskPattern, '##/##');

            //  input views take part in the form: focus order and form data
            assert.equal(vc.getView(1).nextId, '52');
            assert.equal(vc.getView(52).nextId, '53');
            const formData = vc.getFormData();
            assert.ok('extra' in formData.value);
            assert.ok('date' in formData.value);

            assert.equal(client.log.warnings.length, 0, 'no warnings');
        });

        it('a predefined code (UN) placed by config shows its value', () => {
            const client = makeClient({
                form: { 0: { mci: { UN60: { position: { row: 2, col: 2 } } } } },
            });
            client.user = { username: 'Placed' };
            const vc = track(loadMenu(client, {}));
            const view = vc.getView(60);
            assert.ok(view);
            assert.equal(view.mciCode, 'UN');
            assert.deepEqual(view.position, { row: 2, col: 2 });
        });

        it('a code that makes no view is skipped with a warning', () => {
            const client = makeClient({
                form: { 0: { mci: { CF60: { position: { row: 2, col: 2 } } } } },
            });
            const vc = track(loadMenu(client, {}));
            assert.equal(vc.getView(60), undefined);
            assert.equal(warningsMatching(client, /makes no view/).length, 1);
        });

        it('a key without a position still creates nothing, as before', () => {
            const client = makeClient({ form: { 0: { mci: { TL60: { text: 'x' } } } } });
            const vc = track(loadMenu(client, {}));
            assert.equal(vc.getView(60), undefined);
            assert.equal(client.log.warnings.length, 0);
        });

        it('a position that is not a whole row and col is ignored, with a warning', () => {
            const client = makeClient({
                form: {
                    0: {
                        mci: {
                            TL60: { position: { row: 'x', col: 2 } },
                            TL1: { position: { row: 0, col: 2 }, text: 'kept' },
                        },
                    },
                },
            });
            const vc = track(loadMenu(client, { TL1: mci('TL', 1, 4, 4) }));
            assert.equal(vc.getView(60), undefined);
            assert.deepEqual(vc.getView(1).position, { row: 4, col: 4 });
            assert.equal(vc.getView(1).getData(), 'kept');
            assert.equal(warningsMatching(client, /needs a whole row and col/).length, 2);
        });
    });

    describe('an art marker and a position', () => {
        it('the explicit position wins', () => {
            const client = makeClient({
                form: {
                    0: {
                        mci: {
                            TL2: { position: { row: 10, col: 30 }, text: 'moved' },
                        },
                    },
                },
            });
            const vc = track(loadMenu(client, { TL2: mci('TL', 2, 3, 3) }));
            const view = vc.getView(2);
            assert.deepEqual(view.position, { row: 10, col: 30 });
            assert.equal(view.getData(), 'moved');
            assert.equal(client.log.warnings.length, 0);
        });

        it('an input view can be moved too', () => {
            const client = makeClient({
                form: {
                    0: { mci: { ET1: { position: { row: 12, col: 40 }, focus: true } } },
                },
            });
            const vc = track(loadMenu(client, { ET1: mci('ET', 1, 2, 2) }));
            assert.deepEqual(vc.getView(1).position, { row: 12, col: 40 });
        });
    });

    describe('off screen', () => {
        it('a config-only view off screen is skipped with a warning', () => {
            const client = makeClient({
                form: {
                    0: {
                        mci: {
                            TL60: { position: { row: 26, col: 1 } },
                            TL61: { position: { row: 1, col: 81 } },
                        },
                    },
                },
            });
            const vc = track(loadMenu(client, {}));
            assert.equal(vc.getView(60), undefined);
            assert.equal(vc.getView(61), undefined);
            const warned = warningsMatching(client, /off screen; view not created/);
            assert.equal(warned.length, 2);
            assert.equal(warned[0].obj.menuName, 'testMenu');
            assert.equal(warned[0].obj.formId, '0');
            assert.equal(warned[0].obj.mci, 'TL60');
        });

        it('a marker moved off screen stays at its marker, with a warning', () => {
            const client = makeClient({
                form: { 0: { mci: { TL2: { position: { row: 40, col: 1 } } } } },
            });
            const vc = track(loadMenu(client, { TL2: mci('TL', 2, 5, 6) }));
            assert.deepEqual(vc.getView(2).position, { row: 5, col: 6 });
            assert.equal(
                warningsMatching(client, /stays where its art marker/).length,
                1
            );
        });
    });

    describe('IDs that are taken', () => {
        it('a config-only view whose ID is taken is skipped: "Duplicate MCI view ID"', () => {
            const client = makeClient({
                form: {
                    0: {
                        mci: {
                            ET1: { focus: true },
                            TL2: { position: { row: 10, col: 10 }, width: 5 },
                        },
                    },
                },
            });
            //  the art has %ET2, not %TL2
            const vc = track(
                loadMenu(client, { ET1: mci('ET', 1, 1, 1), ET2: mci('ET', 2, 2, 1) })
            );

            const view = vc.getView(2);
            assert.equal(view.mciCode, 'ET', 'the art view is kept');
            assert.deepEqual(view.position, { row: 2, col: 1 }, 'and not moved');

            const dup = warningsMatching(client, /^Duplicate MCI view ID/);
            assert.equal(dup.length, 1);
            assert.equal(dup[0].obj.viewId, 2);
            assert.equal(dup[0].obj.mciCode, 'TL2');
            assert.equal(dup[0].obj.menuName, 'testMenu');

            //  its other properties apply to view 2, as they always have
            //  (matched by ID), with the code mismatch warned about
            assert.equal(view.dimens.width, 5);
            assert.equal(warningsMatching(client, /which is a %ET/).length, 1);
        });

        it('two art markers with one ID: the existing warning, as before', () => {
            const client = makeClient({ form: { 0: { mci: {} } } });
            const vc = track(
                loadMenu(client, { TL1: mci('TL', 1, 1, 1), ET1: mci('ET', 1, 2, 1) })
            );
            assert.equal(vc.getView(1).mciCode, 'TL');
            const dup = warningsMatching(client, /^Duplicate MCI view ID/);
            assert.equal(dup.length, 1);
            assert.deepEqual(dup[0].obj, { viewId: 1, mciCode: 'ET1' });
        });
    });

    describe('code-checked config', () => {
        it('a key whose code is not the view code warns and still applies', () => {
            const client = makeClient({
                form: { 0: { mci: { AN1: { text: 'applied' } } } },
            });
            const vc = track(loadMenu(client, { TL1: mci('TL', 1, 1, 1) }));
            assert.equal(vc.getView(1).getData(), 'applied');
            const warned = warningsMatching(client, /configures view 1, which is a %TL/);
            assert.equal(warned.length, 1);
            assert.equal(warned[0].obj.mci, 'AN1');
            assert.equal(warned[0].obj.viewMciCode, 'TL');
            assert.equal(warned[0].obj.menuName, 'testMenu');
            assert.equal(warned[0].obj.formId, '0');
        });

        it('a key that is not exactly a code and an ID warns and still applies', () => {
            const client = makeClient({
                form: { 0: { mci: { MET3: { argName: 'birthdate' } } } },
            });
            const vc = track(loadMenu(client, { ME3: mci('ME', 3, 1, 1) }));
            assert.equal(vc.getView(3).submitArgName, 'birthdate');
            const warned = warningsMatching(client, /not a code and view ID alone/);
            assert.equal(warned.length, 1);
            assert.equal(warned[0].obj.readAs, 'ET3');
            //  ET3 is not ME3 either: that is warned about too
            assert.equal(warningsMatching(client, /which is a %ME/).length, 1);
        });

        it('warns once per form load, not on redraws', () => {
            const client = makeClient({ form: { 0: { mci: { AN1: { text: 'x' } } } } });
            const vc = track(loadMenu(client, { TL1: mci('TL', 1, 1, 1) }));
            vc.redrawAll();
            vc.redrawAll();
            assert.equal(client.log.warnings.length, 1);
        });

        it('a prompt form names the prompt', () => {
            const client = makeClient();
            const vc = track(new ViewController({ client }));
            vc.loadFromPromptConfig(
                {
                    promptName: 'somePrompt',
                    mciMap: { TL1: mci('TL', 1, 1, 1) },
                    config: { mci: { ET1: { text: 'x' } } },
                },
                err => assert.ifError(err)
            );
            const warned = warningsMatching(client, /which is a %TL/);
            assert.equal(warned.length, 1);
            assert.equal(warned[0].obj.promptName, 'somePrompt');
        });
    });

    describe('implicit submit (no `submit: true` in the form)', () => {
        it('a config-placed view with a higher ID does not take submit', () => {
            const client = makeClient({
                form: {
                    0: {
                        mci: {
                            ET1: { focus: true },
                            ET2: {},
                            TL20: { position: { row: 20, col: 1 }, text: 'theme' },
                        },
                    },
                },
            });
            const vc = track(
                loadMenu(client, { ET1: mci('ET', 1, 1, 1), ET2: mci('ET', 2, 2, 1) })
            );
            assert.ok(vc.getView(20), 'placed');
            assert.equal(vc.getView(2).submit, true, 'ET2 still submits');
            assert.notEqual(vc.getView(20).submit, true);
        });

        it('a config-placed key skipped off screen does not take it away either', () => {
            const client = makeClient({
                form: {
                    0: {
                        mci: {
                            ET1: { focus: true },
                            TK30: { position: { row: 30, col: 1 } },
                        },
                    },
                },
            });
            const vc = track(loadMenu(client, { ET1: mci('ET', 1, 1, 1) }));
            assert.equal(vc.getView(1).submit, true);
        });

        it('an art view with a higher ID takes it, as before (bbsList form 0)', () => {
            const client = makeClient({
                form: { 0: { mci: { VM1: {}, TL2: {}, TL9: {} } } },
            });
            const vc = track(
                loadMenu(client, {
                    VM1: mci('VM', 1, 1, 1),
                    TL2: mci('TL', 2, 2, 1),
                    TL9: mci('TL', 9, 9, 1),
                })
            );
            assert.equal(vc.getView(9).submit, true);
            assert.notEqual(vc.getView(1).submit, true);
        });

        it('an art marker moved by position still counts, as an art view', () => {
            const client = makeClient({
                form: {
                    0: { mci: { ET1: {}, TL5: { position: { row: 20, col: 1 } } } },
                },
            });
            const vc = track(
                loadMenu(client, { ET1: mci('ET', 1, 1, 1), TL5: mci('TL', 5, 5, 1) })
            );
            assert.equal(vc.getView(5).submit, true);
        });
    });

    describe('where the art is', () => {
        it('positions count from the art origin, plus viewOffsets, like markers', () => {
            const client = makeClient({
                form: {
                    0: { mci: { TL50: { position: { row: 2, col: 3 } }, TL1: {} } },
                },
            });
            //  art drawn from row 1 and placed 5 rows down by the module
            //  (fse quote builder, file details)
            const vc = track(
                loadMenu(
                    client,
                    { TL1: mci('TL', 1, 2, 3) },
                    { viewOffsets: { row: 5, col: 0 } }
                )
            );
            assert.deepEqual(vc.getView(1).position, { row: 7, col: 3 }, 'marker');
            assert.deepEqual(vc.getView(50).position, { row: 7, col: 3 }, 'placed');
        });

        it('a marker moved by position gets the viewOffsets too', () => {
            const client = makeClient({
                form: { 0: { mci: { TL1: { position: { row: 1, col: 1 } } } } },
            });
            const vc = track(
                loadMenu(
                    client,
                    { TL1: mci('TL', 1, 2, 3) },
                    { viewOffsets: { row: 5, col: 2 } }
                )
            );
            assert.deepEqual(vc.getView(1).position, { row: 6, col: 3 });
        });

        it('art drawn lower down (a menu prompt): positions follow it', () => {
            const client = makeClient();
            const mciMap = { ET1: mci('ET', 1, 18, 10) };
            setArtOrigin(mciMap, { row: 17, col: 1 });
            const vc = track(new ViewController({ client }));
            vc.loadFromPromptConfig(
                {
                    mciMap,
                    config: {
                        mci: {
                            ET1: { focus: true },
                            TL50: { position: { row: 2, col: 1 } },
                        },
                    },
                },
                err => assert.ifError(err)
            );
            //  on the same row as the marker on the art's second row
            assert.deepEqual(vc.getView(50).position, { row: 18, col: 1 });
        });

        it('the origin is not one of the map keys', () => {
            const mciMap = { TL1: mci('TL', 1, 1, 1) };
            setArtOrigin(mciMap, { row: 4, col: 2 });
            assert.deepEqual(Object.keys(mciMap), ['TL1']);
            assert.deepEqual(JSON.parse(JSON.stringify(mciMap)), {
                TL1: mci('TL', 1, 1, 1),
            });
            assert.deepEqual(getArtOrigin(mciMap), { row: 4, col: 2 });
            assert.deepEqual(getArtOrigin({}), { row: 1, col: 1 });
        });
    });

    describe('art.display() records where the art is', () => {
        let art;
        let ClientTerminal;
        before(() => {
            //  lazily: art.js captures config.js's |get| at require time
            art = require('../core/art.js');
            ({ ClientTerminal } = require('../core/client_term.js'));
        });

        function display(text, options, termHeight = 25) {
            const term = new ClientTerminal({
                writable: true,
                write: (data, cb) => cb && cb(null),
            });
            term.outputEncoding = 'cp437';
            term.termWidth = 80;
            term.termHeight = termHeight;
            let result;
            art.display({ term }, text, options, (err, mciMap) => {
                assert.ifError(err);
                result = mciMap;
            });
            return result;
        }

        it('from row 1, or from startRow (a menu prompt under its art)', () => {
            const top = display('A %TL1\r\n', {});
            assert.deepEqual(getArtOrigin(top), { row: 1, col: 1 });
            assert.deepEqual(top.TL1.position, [1, 3]);

            const lower = display('\r\nB %ET1\r\n', { startRow: 10 });
            assert.deepEqual(getArtOrigin(lower), { row: 10, col: 1 });
            assert.deepEqual(lower.ET1.position, [11, 3]);
        });

        it('art that scrolled moves its origin up with its markers', () => {
            //  seven rows on a five row terminal
            const mciMap = display('1\r\n2\r\n3\r\n4\r\n5\r\n6 %TL1\r\n7\r\n', {}, 5);
            const origin = getArtOrigin(mciMap);
            //  the marker on art row 6 is where row 6 counted from the origin is
            assert.equal(mciMap.TL1.position[0], origin.row + 6 - 1);
            assert.ok(origin.row < 1, 'the top of the art scrolled off');
        });
    });

    describe('form matching', () => {
        it('explicit form keys match the art alone; placed views come after', () => {
            const client = makeClient({
                form: {
                    0: {
                        //  the art has %ET1 and %TL2: "ETTL"
                        ETTL: {
                            mci: {
                                ET1: { focus: true, argName: 'exact' },
                                TK30: {
                                    position: { row: 10, col: 1 },
                                    text: 'placed',
                                },
                            },
                        },
                        mci: { ET1: { argName: 'generic' } },
                    },
                },
            });
            const mciMap = { ET1: mci('ET', 1, 1, 1), TL2: mci('TL', 2, 2, 1) };
            const vc = track(loadMenu(client, mciMap));
            assert.equal(vc.getView(1).submitArgName, 'exact', 'ETTL matched');
            assert.ok(vc.getView(30), 'placed after');
            assert.deepEqual(Object.keys(mciMap).sort(), ['ET1', 'TL2'], 'map unchanged');
        });
    });
});
