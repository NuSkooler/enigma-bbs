/* eslint-disable no-control-regex */
'use strict';

const { strict: assert } = require('assert');
const fs = require('fs');
const paths = require('path');
const hjson = require('hjson');

const THEME_DIR = paths.join(__dirname, '..', 'art', 'themes', 'luciano_blocktronics');
const TEMPLATE = paths.join(
    __dirname,
    '..',
    'misc',
    'menu_templates',
    'activitypub.in.hjson'
);

//  Return { MCI code -> 1-based row } for an .ans, by locating each %XXn token.
//  The art is read as latin1 and truncated at the SAUCE/EOF marker so the
//  metadata record can't be mistaken for another row of art.
function mciRows(artName) {
    const raw = fs.readFileSync(paths.join(THEME_DIR, `${artName}.ans`), 'latin1');
    const eof = raw.indexOf('\x1a');
    const lines = (eof >= 0 ? raw.slice(0, eof) : raw).split(/\r?\n/);

    const rows = {};
    lines.forEach((line, idx) => {
        const visible = line.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
        //  Anything wider than the terminal would wrap and throw the row
        //  mapping off; assert rather than silently compute nonsense.
        assert.ok(
            visible.length <= 80,
            `${artName}.ans line ${idx + 1} is ${visible.length} columns wide`
        );
        for (const m of visible.matchAll(/%([A-Z]{2}\d+)/g)) {
            if (!(m[1] in rows)) {
                rows[m[1]] = idx + 1;
            }
        }
    });
    return { rows, height: lines.length };
}

function themeMenus() {
    const theme = hjson.parse(
        fs.readFileSync(paths.join(THEME_DIR, 'theme.hjson'), 'utf8')
    );
    return theme.customization.menus;
}

describe('activityPubSearch layout', () => {
    it('keeps the results list clear of the status line below it', () => {
        const { rows } = mciRows('activitypub_search_main');
        const vm3Row = rows.VM3;
        const tl10Row = rows.TL10;

        assert.ok(vm3Row, 'art should place VM3');
        assert.ok(tl10Row, 'art should place TL10');
        assert.ok(tl10Row > vm3Row, 'TL10 is expected below VM3');

        const height = themeMenus().activityPubSearch['0'].mci.VM3.height;
        const lastRow = vm3Row + height - 1;

        assert.ok(
            lastRow < tl10Row,
            `VM3 height ${height} from row ${vm3Row} reaches row ${lastRow}, ` +
                `overwriting the TL10 status line at row ${tl10Row} ` +
                `(max height is ${tl10Row - vm3Row})`
        );
    });

    it('keeps the results list inside the art', () => {
        const { rows, height: artHeight } = mciRows('activitypub_search_main');
        const height = themeMenus().activityPubSearch['0'].mci.VM3.height;
        const lastRow = rows.VM3 + height - 1;

        assert.ok(
            lastRow <= artHeight,
            `VM3 reaches row ${lastRow} but the art is only ${artHeight} rows`
        );
    });

    it('configures actor-view MCI codes the art actually places', () => {
        //  A form entry naming a view that does not exist is silently dropped,
        //  taking its mode / acceptsFocus / hyperlinks settings with it (#281).
        //  ap_search.js reads the summary as view id 1, and the art places %MT1.
        const template = hjson.parse(fs.readFileSync(TEMPLATE, 'utf8'));
        const form1 = template.menus.activityPubSearch.form['1'].mci;
        const { rows } = mciRows('activitypub_search_results');

        for (const code of Object.keys(form1)) {
            assert.ok(
                code in rows,
                `form 1 configures ${code}, which the shipped art does not place ` +
                    `(art has: ${Object.keys(rows).sort().join(', ')})`
            );
        }
        assert.ok(
            'MT1' in form1,
            'form 1 must configure MT1, the summary view ap_search.js reads'
        );
    });
});
