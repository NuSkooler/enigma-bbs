'use strict';

//
//  The ATASCII starter (#593): the menu tree in
//  misc/menu_templates/atascii.in.hjson, the starter theme in
//  misc/atascii_starter/, its generated art, how it is kept in step with the
//  PETSCII starter, and how "oputil.js config new" opts a board in to either
//  starter, both, or (by default) neither.
//

const { strict: assert } = require('assert');
const fs = require('fs');
const os = require('os');
const paths = require('path');
const hjson = require('hjson');
const _ = require('lodash');

const {
    ALLOWED_SYSTEM_METHODS,
    ALLOWED_METHODS,
    targetsOf,
    artNamesOf,
    mciNeeded,
} = require('./starter_tree.js');

const ROOT = paths.join(__dirname, '..');
const TEMPLATE_DIR = paths.join(ROOT, 'misc/menu_templates');
const STARTER_DIR = paths.join(ROOT, 'misc/atascii_starter');
const PETSCII_STARTER_DIR = paths.join(ROOT, 'misc/petscii_starter');

const readHjson = path => hjson.parse(fs.readFileSync(path, 'utf8'));
const tree = () => readHjson(paths.join(TEMPLATE_DIR, 'atascii.in.hjson'));
const petsciiTree = () => readHjson(paths.join(TEMPLATE_DIR, 'petscii.in.hjson'));
const starterTheme = () => readHjson(paths.join(STARTER_DIR, 'theme.hjson'));
const artBytes = name => fs.readFileSync(paths.join(STARTER_DIR, `${name}.ata`));

function mciInArt(name) {
    const { AtasciiArtParser } = require('../core/term/atascii/art_parser.js');
    const found = [];
    const parser = new AtasciiArtParser({ mciReplaceChar: ' ' });
    parser.on('mci', m => found.push(`${m.mci}${null === m.id ? '' : m.id}`));
    parser.parse(artBytes(name));
    return found;
}

//
//  The ATASCII tree is the PETSCII tree with the names changed and these
//  differences, and nothing else. Each takes the PETSCII tree (already
//  renamed) and makes the one change.
//
const ALLOWED_DIFFERENCES = [
    {
        why:
            'reader: next match is the stock CTRL N (on a Commodore CTRL N is a ' +
            'cursor key, so the PETSCII tree uses CTRL G)',
        apply: t => {
            const keys = t.menus.atasciiMessageRead.form[4].actionKeys;
            const entry = keys.find(k => _.isEqual(k.keys, ['ctrl + g']));
            assert.ok(entry, 'PETSCII reader has no CTRL G');
            entry.keys = ['ctrl + n'];
        },
    },
    {
        why:
            'editor: CTRL S saves at once, as in the stock editor (on a Commodore ' +
            'CTRL S is HOME)',
        apply: t => {
            ['atasciiMessagePost', 'atasciiMessageReply'].forEach(name => {
                const keys = t.menus[name].form[1].actionKeys;
                assert.deepEqual(keys[0], { keys: ['escape'], viewId: 1 });
                keys.splice(1, 0, {
                    keys: ['ctrl + s'],
                    action: '@method:editModeQuickSave',
                });
            });
        },
    },
];

//  the PETSCII tree with every name moved over: petscii... -> atascii...,
//  art PXXX -> AXXX (CONNECT, the system's own name, stays)
function renamedPetsciiTree() {
    const rename = (value, key) => {
        if (_.isString(value)) {
            if ('art' === key) {
                return value.replace(/^P([A-Z0-9]+)$/, 'A$1');
            }
            return value.replace(/petscii/g, 'atascii');
        }
        if (Array.isArray(value)) {
            return value.map(v => rename(v, key));
        }
        if (_.isPlainObject(value)) {
            const out = {};
            Object.entries(value).forEach(([k, v]) => {
                const inArt = 'art' === key;
                out[k.replace(/petscii/g, 'atascii')] = rename(v, inArt ? 'art' : k);
            });
            return out;
        }
        return value;
    };
    return rename(petsciiTree(), null);
}

//  telnetConnected as origin/master's config new writes it on Yes to the
//  PETSCII question (copied from master's PetsciiTelnetConnected)
const MASTER_PETSCII_TELNET_CONNECTED = `        telnetConnected: {
            desc: Telnet Connect
            art: CONNECT
            next: [
                {
                    //  PETSCII (Commodore) callers: the PETSCII starter menus
                    acs: TE[petscii]
                    next: petsciiMatrix
                }
                {
                    next: matrix
                }
            ]
            config: { nextTimeout: 1500 }
        }`;
const STOCK_TELNET_CONNECTED = `        telnetConnected: {
            desc: Telnet Connect
            art: CONNECT
            next: matrix
            config: { nextTimeout: 1500 }
        }`;

describe('ATASCII starter menus (#593)', () => {
    it('every menu and prompt is named atascii...', () => {
        const t = tree();
        Object.keys(t.menus).forEach(n => assert.match(n, /^atascii[A-Z]/));
        Object.keys(t.prompts).forEach(n => assert.match(n, /^atascii[A-Z]/));
    });

    it('no name collides with a stock or PETSCII menu or prompt', () => {
        const others = { menus: new Set(), prompts: new Set() };
        fs.readdirSync(TEMPLATE_DIR)
            .filter(f => f.endsWith('.in.hjson') && 'atascii.in.hjson' !== f)
            .forEach(f => {
                const text = fs
                    .readFileSync(paths.join(TEMPLATE_DIR, f), 'utf8')
                    .replace(/%INCLUDE_FILES%/g, '');
                const parsed = hjson.parse(text);
                Object.keys(parsed.menus || {}).forEach(n => others.menus.add(n));
                Object.keys(parsed.prompts || {}).forEach(n => others.prompts.add(n));
            });
        assert.ok(others.menus.has('petsciiMatrix'), 'the PETSCII tree was not read');
        const t = tree();
        Object.keys(t.menus).forEach(n => assert.ok(!others.menus.has(n), n));
        Object.keys(t.prompts).forEach(n => assert.ok(!others.prompts.has(n), n));
    });

    it('every next, action, prompt and config menu stays inside the tree', () => {
        const t = tree();
        const problems = [];
        let links = 0;
        _.forEach(t.menus, (menu, name) => {
            targetsOf(name, menu).forEach(([where, spec]) => {
                ++links;
                let m;
                if ((m = /^@systemMethod:(.+)$/.exec(spec))) {
                    if (!ALLOWED_SYSTEM_METHODS.includes(m[1])) {
                        problems.push(`${where}: ${spec}`);
                    }
                } else if ((m = /^@method:(.+)$/.exec(spec))) {
                    if (!ALLOWED_METHODS.concat('editModeQuickSave').includes(m[1])) {
                        problems.push(`${where}: ${spec}`);
                    }
                } else if ((m = /^@menu:(.+)$/.exec(spec))) {
                    if (!t.menus[m[1]]) problems.push(`${where}: ${spec}`);
                } else if ((m = /^@prompt:(.+)$/.exec(spec))) {
                    if (!t.prompts[m[1]]) problems.push(`${where}: ${spec}`);
                } else if (spec.startsWith('@')) {
                    problems.push(`${where}: ${spec} (not expected here)`);
                } else if (!t.menus[spec]) {
                    problems.push(`${where}: ${spec}`);
                }
            });
        });
        assert.deepEqual(problems, []);
        assert.ok(links >= 20, `only ${links} links found`);
    });

    it('every art name has an .ata file in the starter theme', () => {
        const t = tree();
        const arts = _.uniq(
            _.flatMap(Object.values(t.menus), artNamesOf)
                .concat(Object.values(t.prompts).map(p => p.art))
                .filter(Boolean)
        );
        assert.ok(arts.includes('AMSGQUOT'), 'editor art not found');
        assert.ok(arts.length > 10);
        arts.forEach(art =>
            assert.ok(fs.existsSync(paths.join(STARTER_DIR, `${art}.ata`)), art)
        );
    });

    it("every view a menu needs has its MCI code in that menu's art", () => {
        const t = tree();
        const needed = mciNeeded(t.menus, starterTheme());
        let checked = 0;
        _.forEach(needed, (keys, art) => {
            const found = mciInArt(art);
            keys.forEach(key => {
                assert.ok(found.includes(key), `${key} not in ${art}`);
                ++checked;
            });
        });
        assert.ok(checked >= 30, `only ${checked} views checked`);
    });

    it('the editor and reader art has the views each mode of the editor needs', () => {
        const t = tree();
        const required = {
            read: { header: ['TL2', 'TL3'], body: ['MT1'], footerView: ['HM1'] },
            post: {
                header: ['TL1', 'ET2', 'ET3', 'TL4'],
                body: ['MT1'],
                footerEditor: ['SB1'],
                footerEditorMenu: ['HM1'],
                footerFind: ['ET1'],
            },
            reply: { quote: ['MT1', 'VM3'] },
        };
        const menus = {
            read: t.menus.atasciiMessageRead,
            post: t.menus.atasciiMessagePost,
            reply: t.menus.atasciiMessageReply,
        };
        _.forEach(required, (pieces, mode) => {
            _.forEach(pieces, (keys, piece) => {
                const art = menus[mode].config.art[piece];
                assert.ok(art, `${mode}: no ${piece} art`);
                const found = mciInArt(art);
                keys.forEach(key => assert.ok(found.includes(key), `${art}: ${key}`));
            });
            assert.ok(menus[mode].config.art.help, `${mode}: no help art`);
        });
        assert.deepEqual(_.omit(menus.reply.config.art, 'quote'), menus.post.config.art);
    });

    it('the editor pieces fit together on a 40x24 screen', () => {
        //  core/fse.js: body below the header, footer from the body's last row
        const { AtasciiArtParser } = require('../core/term/atascii/art_parser.js');
        const { AtasciiScreen } = require('./term_atascii_screens.js');
        const heightOf = (art, startRow) => {
            const parser = new AtasciiArtParser({
                mciReplaceChar: ' ',
                termWidth: 40,
                termHeight: 24,
                startRow,
            });
            let height;
            parser.on('complete', () => (height = parser.row - 1));
            parser.parse(artBytes(art));
            return height;
        };
        //  the screen row (1-based) a piece drawn from |row| ends on
        const lastRow = (art, row) => {
            const screen = new AtasciiScreen(40, 24, { row: row - 1, col: 0 });
            screen.write(artBytes(art));
            assert.equal(screen.scrolls, 0, `${art} from row ${row} scrolled`);
            //  a full last row wraps the cursor to the next one
            return 0 === screen.col ? screen.row : screen.row + 1;
        };
        const t = tree();
        ['atasciiMessageRead', 'atasciiMessagePost', 'atasciiMessageReply'].forEach(
            name => {
                const art = t.menus[name].config.art;
                const header = heightOf(art.header, 1);
                assert.equal(header, 6, `${name}: header height`);
                const footerRow = heightOf(art.body, header + 1);
                const mt1 = starterTheme().customization.menus[name][1].mci.MT1;
                assert.equal(footerRow, header + mt1.height + 1, `${name}: body`);
                ['footerEditor', 'footerEditorMenu', 'footerView', 'footerFind']
                    .filter(f => art[f])
                    .forEach(f => {
                        const bottom = lastRow(art[f], footerRow);
                        assert.ok(bottom <= 24, `${name} ${f} ends on row ${bottom}`);
                    });
                if (art.quote) {
                    const bottom = lastRow(art.quote, header + 1);
                    assert.ok(bottom <= 24, `${name} quote ends on row ${bottom}`);
                    //  the quote builder's views are redrawn after the footer
                    //  is back (a list blanks every row it has): none may
                    //  reach the footer's rows
                    const quote = starterTheme().customization.menus[name][5].mci;
                    const parser = new AtasciiArtParser({
                        mciReplaceChar: ' ',
                        termWidth: 40,
                        termHeight: 24,
                        startRow: header + 1,
                    });
                    parser.on('mci', m => {
                        const key = `${m.mci}${m.id}`;
                        const last = m.position[0] + (quote[key].height || 1) - 1;
                        assert.ok(
                            last < footerRow,
                            `${name} quote ${key} reaches row ${last}; footer starts on ${footerRow}`
                        );
                    });
                    parser.parse(artBytes(art.quote));
                }
            }
        );
    });

    it('every list in the theme fits its art on 24 rows', () => {
        //  a list's rows start where its MCI code is
        const { AtasciiArtParser } = require('../core/term/atascii/art_parser.js');
        const t = tree();
        const custom = starterTheme().customization.menus;
        let checked = 0;
        _.forEach(custom, (layout, name) => {
            const mci = layout.mci || {};
            _.forEach(mci, (view, key) => {
                if (!view.height) return;
                const parser = new AtasciiArtParser({ mciReplaceChar: ' ' });
                let row;
                parser.on('mci', m => {
                    if (`${m.mci}${m.id}` === key) row = m.position[0];
                });
                parser.parse(artBytes(t.menus[name].art));
                assert.ok(row, `${name}.${key} not in its art`);
                assert.ok(row + view.height - 1 <= 24, `${name}.${key} overflows`);
                ++checked;
            });
        });
        assert.ok(checked >= 8, `only ${checked} lists checked`);
    });

    it('every key a menu binds is one the ATASCII input decoder produces', () => {
        //  The names an action key can match are a decoded key's name or, for
        //  a plain character, the character. Collect every one the decoder
        //  can give, from each byte alone and after ESC.
        const {
            createAtasciiInputDecoder,
        } = require('../core/term/atascii/input_decoder.js');
        const producible = new Set();
        const feed = bytes => {
            const d = createAtasciiInputDecoder({ escTimeoutMs: 0 });
            d.decode(Buffer.from(bytes), null, (e, ch, key) =>
                producible.add(key ? key.name : ch)
            );
            d.dispose();
        };
        for (let b = 0; b < 256; ++b) {
            feed([b]);
            feed([0x1b, b]);
        }
        //  the stand-ins, and what the real keys are
        assert.ok(producible.has('page up') && producible.has('page down'));
        assert.ok(producible.has('escape') && producible.has('end'));
        ['ctrl + h', 'ctrl + i', 'ctrl + j', 'ctrl + m', 'ctrl + w', 'ctrl + z'].forEach(
            k => assert.ok(!producible.has(k), k)
        );

        const problems = [];
        let checked = 0;
        _.forEach(tree().menus, (menu, name) => {
            _.forEach(menu.form || {}, (form, id) => {
                (form.actionKeys || []).forEach(ak =>
                    (ak.keys || []).forEach(k => {
                        ++checked;
                        if (!producible.has(k)) {
                            problems.push(`${name}.form.${id}: ${k}`);
                        }
                    })
                );
                _.forEach(form.mci || {}, (view, key) =>
                    Object.keys(view.hotKeys || {}).forEach(hk => {
                        ++checked;
                        if (!producible.has(hk.toLowerCase())) {
                            problems.push(`${name}.form.${id}.${key} hot key ${hk}`);
                        }
                    })
                );
            });
        });
        assert.deepEqual(problems, []);
        assert.ok(checked >= 40, `only ${checked} keys checked`);
    });

    it('the login scan is offered from the second call on, as the stock login does', () => {
        const next = tree().menus.atasciiLoginLastCallers.next;
        assert.deepEqual(next, [
            { acs: 'NC2', next: 'atasciiLoginNewScanConfirm' },
            { next: 'atasciiMainMenu' },
        ]);
    });

    it('every new-scan menu scans the message base only, into the tree', () => {
        const t = tree();
        const scans = _.pickBy(t.menus, m => 'new_scan' === m.module);
        assert.ok(Object.keys(scans).length >= 2);
        _.forEach(scans, (menu, name) => {
            assert.equal(menu.config.skipFileBase, true, name);
            ['newScanMessageList', 'newScanActivityPubList'].forEach(k =>
                assert.ok(t.menus[menu.config[k]], `${name}.config.${k}`)
            );
            assert.ok(mciInArt(menu.art).includes('TL1'), `${name}: TL1`);
        });
    });

    it('the reader has its own no-reply notice and the editor its no-access one', () => {
        const t = tree();
        assert.ok(
            t.menus[t.menus.atasciiMessageRead.config.noReplyGhostSenderMenu],
            'noReplyGhostSenderMenu'
        );
        ['atasciiMessagePost', 'atasciiMessageReply'].forEach(n =>
            assert.ok(t.menus[t.menus[n].config.messageBasePostMessageNoAccess], n)
        );
    });

    it('the theme is an ATASCII theme customising only menus of the tree', () => {
        const theme = starterTheme();
        assert.equal(theme.info.emulation, 'atascii');
        const t = tree();
        Object.keys(theme.customization.menus).forEach(n => assert.ok(t.menus[n], n));
    });
});

describe('ATASCII and PETSCII starter trees stay in step (#593)', () => {
    it('the ATASCII tree is the PETSCII tree renamed, plus the allowed differences', () => {
        const expected = renamedPetsciiTree();
        ALLOWED_DIFFERENCES.forEach(d => d.apply(expected));
        const actual = tree();
        //  menu by menu first, for a readable failure
        assert.deepEqual(Object.keys(actual.menus), Object.keys(expected.menus));
        Object.keys(expected.menus).forEach(name =>
            assert.deepEqual(actual.menus[name], expected.menus[name], name)
        );
        assert.deepEqual(actual, expected);
    });

    it('the allowed differences are few and each one applies', () => {
        assert.ok(ALLOWED_DIFFERENCES.length <= 3);
        //  without them the trees differ: each one is needed
        ALLOWED_DIFFERENCES.forEach((d, i) => {
            const expected = renamedPetsciiTree();
            ALLOWED_DIFFERENCES.filter((_d, j) => j !== i).forEach(o =>
                o.apply(expected)
            );
            assert.notDeepEqual(tree(), expected, d.why);
        });
    });

    it('both themes lay out the same menus and views', () => {
        const pet = readHjson(paths.join(PETSCII_STARTER_DIR, 'theme.hjson'));
        const ata = starterTheme();
        const shape = theme =>
            _.mapValues(theme.customization.menus, layout =>
                _.mapValues(_.omit(layout, 'config'), part =>
                    Object.keys(part.mci || part).sort()
                )
            );
        const renamed = _.mapKeys(shape(pet), (v, k) => k.replace('petscii', 'atascii'));
        assert.deepEqual(shape(ata), renamed);
    });

    it('both generators make a screen for each menu, under matching names', () => {
        const { buildAll } = require('../dev_util/petscii_art/build.js');
        const seq = Object.keys(buildAll('petscii')).map(f =>
            f.replace(/\.seq$/, '').replace(/^P([A-Z0-9]+)$/, 'A$1')
        );
        const ata = Object.keys(buildAll('atascii')).map(f => f.replace(/\.ata$/, ''));
        assert.deepEqual(ata.sort(), seq.sort());
    });
});

describe('ATASCII starter art (#593)', () => {
    it('the generator reproduces the committed .ata files', () => {
        const { buildAll } = require('../dev_util/petscii_art/build.js');
        const built = buildAll('atascii');
        const committed = fs.readdirSync(STARTER_DIR).filter(f => f.endsWith('.ata'));
        assert.deepEqual(Object.keys(built).sort(), committed.sort());
        Object.entries(built).forEach(([file, bytes]) => {
            assert.ok(bytes.equals(fs.readFileSync(paths.join(STARTER_DIR, file))), file);
        });
    });

    it('the generator still reproduces the committed PETSCII .seq files', () => {
        const { buildAll } = require('../dev_util/petscii_art/build.js');
        Object.entries(buildAll()).forEach(([file, bytes]) =>
            assert.ok(
                bytes.equals(fs.readFileSync(paths.join(PETSCII_STARTER_DIR, file))),
                file
            )
        );
    });

    it('the art is safe for an Atari screen', () => {
        const { AtasciiScreen } = require('./term_atascii_screens.js');
        const { Controls, isControlByte } = require('../core/term/atascii/charset.js');
        const files = fs.readdirSync(STARTER_DIR).filter(f => f.endsWith('.ata'));
        assert.ok(files.length >= 30);
        files.forEach(file => {
            const bytes = fs.readFileSync(paths.join(STARTER_DIR, file));
            //  no ESC at all, so no ESC-quoted 0x1B-0x1F (SyncTERM misdraws
            //  those), and no control byte but CLEAR and END OF LINE
            bytes.forEach((b, i) => {
                if (isControlByte(b)) {
                    assert.ok(
                        [Controls.clear, Controls.eol].includes(b),
                        `${file}: control byte 0x${b.toString(16)} at ${i}`
                    );
                }
            });
            assert.ok(!bytes.includes(Controls.escape), `${file}: ESC`);
            //  CLEAR only as the first byte of a whole screen
            assert.ok(bytes.indexOf(Controls.clear, 1) < 0, `${file}: CLEAR inside`);
            assert.ok(bytes.length < 1024, `${file}: ${bytes.length} bytes`);
            //  strict model: throws on an edge crossing; no scroll; the bottom
            //  right cell stays empty
            const screen = new AtasciiScreen(40, 24, { row: 0, col: 0 });
            screen.write(bytes);
            assert.equal(screen.scrolls, 0, `${file} scrolled the screen`);
            //  no row reaches the last column, so nothing relies on wrapping
            //  and the art draws the same on an 80 column (XEP80) screen
            screen.grid.forEach((row, r) =>
                assert.equal(row[39], 0x20, `${file}: row ${r + 1} reaches column 40`)
            );
            const wide = new AtasciiScreen(80, 25, { row: 0, col: 0 });
            wide.write(bytes);
            screen.grid.forEach((row, r) =>
                assert.deepEqual(
                    wide.grid[r].slice(0, 40),
                    row,
                    `${file}: row ${r + 1} at 80`
                )
            );
        });
    });

    it('every screen says it is placeholder art, or belongs to one that does', () => {
        const {
            AtasciiArtParser,
            atasciiArtToText,
        } = require('../core/term/atascii/art_parser.js');
        assert.ok(AtasciiArtParser);
        const text = name => atasciiArtToText(artBytes(name));
        assert.match(text('CONNECT'), /placeholders/);
        assert.match(text('CONNECT'), /Artists: replace them/);
        assert.match(text('AMATRIX'), /Placeholder art: artists wanted!/);
    });
});

describe('ATASCII starter theme shows focus in inverse video (#593)', () => {
    let pipeToAnsi;
    let format;

    before(() => {
        ({ pipeToAnsi } = require('../core/color_codes.js'));
        format = require('../core/string_format.js');
    });

    //  modules whose VM1 is a display list, never focused
    const DISPLAY_ONLY = ['last_callers', 'whos_online'];

    //  [menu, form id, MCI key] for every menu or list view a caller moves
    //  focus in
    function focusableViews(t) {
        const out = [];
        _.forEach(t.menus, (menu, name) => {
            _.forEach(menu.form || {}, (form, id) => {
                Object.keys(form.mci || {})
                    .filter(k => /^(VM|HM|TM)\d+$/.test(k))
                    .filter(() => !DISPLAY_ONLY.includes(menu.module))
                    .forEach(k => out.push([name, id, k]));
            });
        });
        return out;
    }

    //  the inverse flags of the cells |ansi| draws on a cleared ATASCII screen
    function inverseCells(ansi, width) {
        const {
            createAtasciiTranslator,
        } = require('../core/term/atascii/output_translator.js');
        const { AtasciiScreen } = require('./term_atascii_screens.js');
        const t = createAtasciiTranslator({ cols: 40, rows: 24, quoted: 'portable' });
        const screen = new AtasciiScreen(40, 24, { row: 0, col: 0 });
        screen.write(t.translate('\x1b[2J\x1b[1;1H' + ansi));
        return _.range(width).map(c => screen.actual(0, c).inverse);
    }

    const SAMPLE = {
        text: 'sample',
        index: 1,
        name: 'General',
        msgNum: 1,
        subject: 'Subject',
        fromUserName: 'someone',
        newIndicator: '*',
    };

    function renderPair(layout) {
        if (layout.focusItemFormat) {
            assert.ok(layout.itemFormat, 'focusItemFormat without itemFormat');
            return [layout.itemFormat, layout.focusItemFormat].map(f =>
                pipeToAnsi(format(f, SAMPLE))
            );
        }
        assert.ok(layout.styleSGR1 && layout.styleSGR2, 'no focus style');
        //  as the views do: the style, then the text
        return [layout.styleSGR1, layout.styleSGR2].map(s => pipeToAnsi(s) + 'sample');
    }

    it('finds the views it checks', () => {
        assert.ok(focusableViews(tree()).length >= 12);
    });

    it('every focusable menu and list has a focus style that is inverse video', () => {
        const t = tree();
        const theme = starterTheme().customization.menus;
        const problems = [];
        focusableViews(t).forEach(([name, id, key]) => {
            const custom = theme[name] || {};
            const layout = _.get(custom, [id, 'mci', key]) || _.get(custom, ['mci', key]);
            const where = `${name}.form.${id}.${key}`;
            if (!layout) {
                problems.push(`${where}: no layout in the theme`);
                return;
            }
            let normal;
            let focus;
            try {
                [normal, focus] = renderPair(layout).map(a => inverseCells(a, 6));
            } catch (e) {
                problems.push(`${where}: ${e.message}`);
                return;
            }
            //  normal is plain, focus is inverse, over the whole sample
            if (normal.some(Boolean)) problems.push(`${where}: unfocused is inverse`);
            if (!focus.every(Boolean)) problems.push(`${where}: focus is not inverse`);
        });
        assert.deepEqual(problems, []);
    });

    it('a plain style after a focused one is plain again', () => {
        //  a foreground pipe code alone keeps the background before it
        const theme = starterTheme().customization.menus;
        const tm = theme.atasciiLoginNewScanConfirm.mci.TM1;
        const both =
            pipeToAnsi(tm.styleSGR2) + 'yes' + pipeToAnsi(tm.styleSGR1) + ' / no';
        const cells = inverseCells(both, 8);
        assert.deepEqual(cells, [true, true, true, false, false, false, false, false]);
    });
});

describe('Connect menu branches for the starters (#593)', () => {
    let addConnectBranches;
    let addPetsciiConnectBranch;

    before(() => {
        ({
            addConnectBranches,
            addPetsciiConnectBranch,
        } = require('../core/oputil/oputil_config.js'));
    });

    const loginText = () =>
        fs.readFileSync(paths.join(TEMPLATE_DIR, 'login.in.hjson'), 'utf8');

    function nextFor(menus, emulation) {
        const ACS = require('../core/acs.js');
        const client = { term: { emulation: { name: emulation, layers: new Map() } } };
        const acs = new ACS({ client, user: { groups: [], isGroupMember: () => false } });
        return acs.getConditionalValue(menus.telnetConnected.next, 'next');
    }

    it('the PETSCII branch alone is exactly what master writes', () => {
        const stock = loginText();
        assert.equal(stock.split(STOCK_TELNET_CONNECTED).length, 2);
        const master = stock.replace(
            STOCK_TELNET_CONNECTED,
            MASTER_PETSCII_TELNET_CONNECTED
        );
        assert.equal(addPetsciiConnectBranch(stock), master);
        assert.equal(addConnectBranches(stock, ['petscii']), master);
    });

    it('no starter leaves the text as it is', () => {
        assert.equal(addConnectBranches(loginText(), []), loginText());
    });

    it('ATASCII alone sends ATASCII sessions to the ATASCII matrix', () => {
        const menus = hjson.parse(addConnectBranches(loginText(), ['atascii'])).menus;
        assert.equal(nextFor(menus, 'atascii'), 'atasciiMatrix');
        assert.equal(nextFor(menus, 'petscii'), 'matrix');
        assert.equal(nextFor(menus, 'ansi'), 'matrix');
        assert.deepEqual(menus.telnetConnected.next, [
            { acs: 'TE[atascii]', next: 'atasciiMatrix' },
            { next: 'matrix' },
        ]);
    });

    it('both compose: PETSCII, ATASCII, then the default, whatever the order asked', () => {
        [
            ['petscii', 'atascii'],
            ['atascii', 'petscii'],
        ].forEach(asked => {
            const menus = hjson.parse(addConnectBranches(loginText(), asked)).menus;
            assert.deepEqual(menus.telnetConnected.next, [
                { acs: 'TE[petscii]', next: 'petsciiMatrix' },
                { acs: 'TE[atascii]', next: 'atasciiMatrix' },
                { next: 'matrix' },
            ]);
            assert.equal(nextFor(menus, 'petscii'), 'petsciiMatrix');
            assert.equal(nextFor(menus, 'atascii'), 'atasciiMatrix');
            assert.equal(nextFor(menus, 'ansi'), 'matrix');
        });
    });

    it('changes nothing but telnetConnected.next', () => {
        const before = hjson.parse(loginText());
        const after = hjson.parse(
            addConnectBranches(loginText(), ['petscii', 'atascii'])
        );
        after.menus.telnetConnected.next = before.menus.telnetConnected.next;
        assert.deepEqual(after, before);
    });

    it('works on a checkout with CRLF line endings', () => {
        const crlf = loginText().replace(/\r?\n/g, '\r\n');
        const out = addConnectBranches(crlf, ['petscii', 'atascii']);
        assert.ok(!/[^\r]\n/.test(out), 'a bare LF crept in');
        assert.equal(nextFor(hjson.parse(out).menus, 'atascii'), 'atasciiMatrix');
    });

    it('refuses text without the stock entry, and an unknown emulation', () => {
        assert.throws(() => addConnectBranches('{ menus: {} }', ['atascii']), /ATASCII/);
        assert.throws(
            () => addConnectBranches('{ menus: {} }', ['petscii', 'atascii']),
            /PETSCII and ATASCII branches not added/
        );
        assert.throws(() => addConnectBranches(loginText(), ['ansi']));
    });
});

describe('oputil config new and the starters (#593)', function () {
    this.timeout(20000);

    let tmp;
    let restore = [];

    const answersFor = (includePetscii, includeAtascii) => ({
        createNewConfig: true,
        configPath: paths.join(tmp, 'out', 'config.hjson'),
        overwriteConfig: true,
        boardName: 'Test Board',
        msgConfName: 'Local',
        msgConfDesc: 'Local Areas',
        msgAreaName: 'General',
        msgAreaDesc: 'General chit-chat',
        loggingLevel: 'info',
        includePetscii,
        includeAtascii,
    });

    const asked = [];

    function stubInquirer(answers) {
        const inq = require('inquirer');
        const prompt = inq.prompt;
        const BottomBar = inq.ui.BottomBar;
        inq.prompt = questions => {
            questions.forEach(q => asked.push(q));
            return Promise.resolve(
                _.pick(
                    answers,
                    questions.map(q => q.name)
                )
            );
        };
        inq.ui.BottomBar = class {
            constructor() {
                this.log = { write() {} };
            }
        };
        restore.push(() => {
            inq.prompt = prompt;
            inq.ui.BottomBar = BottomBar;
        });
    }

    function runConfigNew(includePetscii, includeAtascii) {
        stubInquirer(answersFor(includePetscii, includeAtascii));
        const { buildNewConfig } = require('../core/oputil/oputil_config.js');
        const dirs = {
            installConfigDir: paths.join(tmp, 'config'),
            themesDir: paths.join(tmp, 'themes'),
        };
        fs.mkdirSync(dirs.themesDir, { recursive: true });
        const log = console.info;
        console.info = () => {};
        return new Promise((resolve, reject) => {
            buildNewConfig(dirs, (err, configPath, result) => {
                console.info = log;
                if (err) return reject(new Error(String(err)));
                const menuDir = paths.join(dirs.installConfigDir, 'menus');
                resolve({
                    petsciiNotes: (result && result.petsciiNotes) || [],
                    atasciiNotes: (result && result.atasciiNotes) || [],
                    config: readHjson(configPath),
                    menus: fs.readdirSync(menuDir).sort(),
                    menuDir,
                    file: n =>
                        fs.readFileSync(paths.join(menuDir, `test_board-${n}.hjson`)),
                    themes: fs.readdirSync(dirs.themesDir).sort(),
                    themesDir: dirs.themesDir,
                });
            });
        });
    }

    const template = n => fs.readFileSync(paths.join(TEMPLATE_DIR, `${n}.in.hjson`));
    const STOCK_MENUS = [
        'test_board-activitypub.hjson',
        'test_board-doors.hjson',
        'test_board-file_base.hjson',
        'test_board-login.hjson',
        'test_board-main.hjson',
        'test_board-message_base.hjson',
        'test_board-new_user.hjson',
        'test_board-private_mail.hjson',
    ];
    const STOCK_COPIES = [
        'message_base',
        'private_mail',
        'new_user',
        'doors',
        'file_base',
        'activitypub',
    ];

    //  every menu the generated menus name exists, and so do the themes
    function validateReferences(out, themeIds) {
        const ConfigLoader = require('../core/config_loader.js');
        const merged = readHjson(paths.join(out.menuDir, 'test_board-main.hjson'));
        merged.includes.forEach(inc =>
            _.defaultsDeep(merged, readHjson(paths.join(out.menuDir, inc)))
        );
        const menus = new ConfigLoader({ hotReload: false })._resolveAtSpecs(
            merged
        ).menus;
        const { validateDeferredReferences } = require('../core/config/refs.js');
        const issues = validateDeferredReferences(out.config, {
            themeIds: ['luciano_blocktronics', ...themeIds],
            menuNames: Object.keys(menus),
        });
        assert.deepEqual(issues, []);
        return menus;
    }

    beforeEach(() => {
        tmp = fs.mkdtempSync(paths.join(os.tmpdir(), 'enigma-atascii-starter-'));
        asked.length = 0;
    });

    afterEach(() => {
        restore.forEach(r => r());
        restore = [];
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    it('asks the ATASCII question after the PETSCII one, default No', async () => {
        await runConfigNew(false, false);
        const names = asked.map(q => q.name);
        const p = names.indexOf('includePetscii');
        const a = names.indexOf('includeAtascii');
        assert.ok(p >= 0 && a === p + 1, names.join(','));
        const q = asked[a];
        assert.equal(q.type, 'confirm');
        assert.equal(q.default, false);
        assert.equal(
            q.message,
            'Include starter menus and theme for ATASCII (Atari 8-bit) callers?'
        );
    });

    it('No / No writes exactly the stock menus and no starter settings', async () => {
        const out = await runConfigNew(false, false);
        assert.deepEqual(out.menus, STOCK_MENUS);
        assert.deepEqual(out.themes, []);
        assert.equal(_.get(out.config, 'theme.emulations'), undefined);
        STOCK_COPIES.concat('login').forEach(n =>
            assert.ok(out.file(n).equals(template(n)), n)
        );
        //  main is the template with its includes filled in, as on master
        const main = template('main')
            .toString('utf8')
            .replace(
                /%INCLUDE_FILES%/g,
                [
                    'message_base',
                    'private_mail',
                    'login',
                    'new_user',
                    'doors',
                    'file_base',
                    'activitypub',
                ]
                    .map(n => `test_board-${n}.hjson`)
                    .join('\n\t\t')
            );
        assert.equal(out.file('main').toString('utf8'), main);
        assert.deepEqual(out.petsciiNotes, []);
        assert.deepEqual(out.atasciiNotes, []);
    });

    it('PETSCII only writes what master writes on Yes', async () => {
        const out = await runConfigNew(true, false);
        assert.deepEqual(
            out.menus.filter(m => /scii/.test(m)),
            ['test_board-petscii.hjson']
        );
        assert.ok(out.file('petscii').equals(template('petscii')));
        STOCK_COPIES.forEach(n => assert.ok(out.file(n).equals(template(n)), n));
        //  master's login: the stock template with master's PETSCII branch
        const login = out.file('login').toString('utf8');
        assert.equal(
            login,
            template('login')
                .toString('utf8')
                .replace(STOCK_TELNET_CONNECTED, MASTER_PETSCII_TELNET_CONNECTED)
        );
        assert.notEqual(login, template('login').toString('utf8'));
        assert.deepEqual(
            readHjson(paths.join(out.menuDir, 'test_board-login.hjson')).menus
                .telnetConnected.next,
            [{ acs: 'TE[petscii]', next: 'petsciiMatrix' }, { next: 'matrix' }]
        );
        assert.ok(!/atascii/i.test(out.file('main').toString('utf8')));
        assert.deepEqual(out.themes, ['petscii_starter']);
        assert.deepEqual(out.config.theme.emulations, {
            petscii: { default: 'petscii_starter', preLogin: 'petscii_starter' },
        });
        validateReferences(out, ['petscii_starter']);
    });

    it('ATASCII only adds the ATASCII menus, branch, theme and setting', async () => {
        const out = await runConfigNew(false, true);
        assert.deepEqual(
            out.menus.filter(m => /scii/.test(m)),
            ['test_board-atascii.hjson']
        );
        assert.ok(out.file('atascii').equals(template('atascii')));
        assert.match(out.file('main').toString('utf8'), /test_board-atascii\.hjson/);
        assert.ok(!/petscii/i.test(out.file('main').toString('utf8')));
        const login = readHjson(paths.join(out.menuDir, 'test_board-login.hjson'));
        assert.deepEqual(login.menus.telnetConnected.next, [
            { acs: 'TE[atascii]', next: 'atasciiMatrix' },
            { next: 'matrix' },
        ]);
        assert.deepEqual(out.themes, ['atascii_starter']);
        assert.deepEqual(
            fs.readdirSync(paths.join(out.themesDir, 'atascii_starter')).sort(),
            fs.readdirSync(STARTER_DIR).sort()
        );
        assert.deepEqual(out.config.theme.emulations, {
            atascii: { default: 'atascii_starter', preLogin: 'atascii_starter' },
        });
        const menus = validateReferences(out, ['atascii_starter']);
        assert.ok(menus.atasciiMatrix && menus.atasciiConnected);
        assert.deepEqual(out.atasciiNotes, []);
    });

    it('both write both trees, both themes, both settings and a two-way branch', async () => {
        const out = await runConfigNew(true, true);
        assert.ok(out.file('petscii').equals(template('petscii')));
        assert.ok(out.file('atascii').equals(template('atascii')));
        const main = out.file('main').toString('utf8');
        assert.ok(
            main.indexOf('test_board-petscii.hjson') <
                main.indexOf('test_board-atascii.hjson')
        );
        const login = readHjson(paths.join(out.menuDir, 'test_board-login.hjson'));
        assert.deepEqual(login.menus.telnetConnected.next, [
            { acs: 'TE[petscii]', next: 'petsciiMatrix' },
            { acs: 'TE[atascii]', next: 'atasciiMatrix' },
            { next: 'matrix' },
        ]);
        assert.deepEqual(out.themes, ['atascii_starter', 'petscii_starter']);
        assert.deepEqual(out.config.theme.emulations, {
            petscii: { default: 'petscii_starter', preLogin: 'petscii_starter' },
            atascii: { default: 'atascii_starter', preLogin: 'atascii_starter' },
        });
        const menus = validateReferences(out, ['petscii_starter', 'atascii_starter']);
        assert.ok(menus.petsciiMatrix && menus.atasciiMatrix);
        assert.deepEqual(out.petsciiNotes, []);
        assert.deepEqual(out.atasciiNotes, []);
    });

    it('never overwrites an ATASCII theme directory that is already there', async () => {
        const mine = paths.join(tmp, 'themes', 'atascii_starter');
        fs.mkdirSync(mine, { recursive: true });
        fs.writeFileSync(paths.join(mine, 'theme.hjson'), '{ mine: true }');
        await runConfigNew(false, true);
        assert.equal(
            fs.readFileSync(paths.join(mine, 'theme.hjson'), 'utf8'),
            '{ mine: true }'
        );
        assert.deepEqual(fs.readdirSync(mine), ['theme.hjson']);
    });

    describe('when a starter cannot be completed', () => {
        let errors;
        let consoleError;

        beforeEach(() => {
            errors = [];
            consoleError = console.error;
            console.error = (...args) => errors.push(args.join(' '));
        });

        afterEach(() => {
            console.error = consoleError;
        });

        it('a login menu in the way is reported for each starter asked for', async () => {
            const menuDir = paths.join(tmp, 'config', 'menus');
            fs.mkdirSync(menuDir, { recursive: true });
            const mine = paths.join(menuDir, 'test_board-login.hjson');
            fs.writeFileSync(mine, '{ mine: true }');

            const result = await runConfigNew(true, true);

            assert.equal(fs.readFileSync(mine, 'utf8'), '{ mine: true }');
            assert.equal(result.petsciiNotes.length, 1);
            assert.equal(result.atasciiNotes.length, 1);
            assert.match(result.petsciiNotes[0], /already exists.*TE\[petscii\]/);
            assert.match(
                result.atasciiNotes[0],
                /already exists.*TE\[atascii\].*ATASCII documentation/
            );
            assert.ok(errors.some(e => /PETSCII starter is not complete/.test(e)));
            assert.ok(errors.some(e => /ATASCII starter is not complete/.test(e)));
        });

        it('a login menu in the way, ATASCII only: only ATASCII is reported', async () => {
            const menuDir = paths.join(tmp, 'config', 'menus');
            fs.mkdirSync(menuDir, { recursive: true });
            fs.writeFileSync(
                paths.join(menuDir, 'test_board-login.hjson'),
                '{ mine: true }'
            );
            const result = await runConfigNew(false, true);
            assert.deepEqual(result.petsciiNotes, []);
            assert.equal(result.atasciiNotes.length, 1);
            assert.ok(!errors.some(e => /PETSCII/.test(e)));
        });

        it('an ATASCII theme that cannot be copied leaves only its setting out', async () => {
            const { AtasciiStarter } = require('../core/oputil/oputil_config.js');
            const source = AtasciiStarter.themeSourceDir;
            const moved = `${source}.moved-by-test`;
            fs.renameSync(source, moved);
            try {
                const result = await runConfigNew(true, true);
                assert.deepEqual(result.config.theme.emulations, {
                    petscii: { default: 'petscii_starter', preLogin: 'petscii_starter' },
                });
                assert.deepEqual(result.petsciiNotes, []);
                assert.equal(result.atasciiNotes.length, 1);
                assert.match(result.atasciiNotes[0], /could not be copied/);
                assert.match(result.atasciiNotes[0], /theme\.emulations\.atascii/);
                assert.deepEqual(result.themes, ['petscii_starter']);
                //  the branch is still written: the menus are there
                const login = readHjson(
                    paths.join(tmp, 'config', 'menus', 'test_board-login.hjson')
                );
                assert.equal(login.menus.telnetConnected.next.length, 3);
            } finally {
                fs.renameSync(moved, source);
            }
        });

        it('a complete run has nothing to report', async () => {
            const result = await runConfigNew(true, true);
            assert.deepEqual(result.petsciiNotes, []);
            assert.deepEqual(result.atasciiNotes, []);
            assert.equal(errors.length, 0);
        });
    });
});
