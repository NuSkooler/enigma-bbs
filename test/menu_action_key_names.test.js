'use strict';

//
//  Key names in shipped menus, themes and docs must be names the input
//  decoder can produce. Enter arrives as "return" (core/term/ansi/
//  input_decoder.js); nothing names a key "enter", so a binding to it never
//  fires. configure newscan shipped with one, and the #447 docs copied it.
//

const { strict: assert } = require('assert');
const fs = require('fs');
const paths = require('path');

const { decode } = require('../core/term/ansi/input_decoder.js');

const ROOT = paths.join(__dirname, '..');

function walk(dir, exts, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = paths.join(dir, entry.name);
        if (entry.isDirectory()) {
            walk(full, exts, out);
        } else if (exts.some(ext => entry.name.endsWith(ext))) {
            out.push(full);
        }
    }
    return out;
}

//  a keys: [ ... ] list naming "enter", commented out or not
const EnterBinding = /keys\s*:\s*\[[^\]]*["']enter["']/i;

describe('menu action key names', () => {
    it('the input decoder names Enter "return"', () => {
        const keys = [];
        decode(Buffer.from('\r'), {}, (event, ch, key) => {
            if ('key press' === event) {
                keys.push(key && key.name);
            }
        });
        assert.ok(keys.includes('return'), JSON.stringify(keys));
        assert.equal(keys.includes('enter'), false);
    });

    it('no shipped menu, theme or doc binds a key named "enter"', () => {
        const files = [
            ...walk(paths.join(ROOT, 'misc', 'menu_templates'), ['.hjson']),
            ...walk(paths.join(ROOT, 'art', 'themes'), ['.hjson']),
            ...walk(paths.join(ROOT, 'website', 'src', 'content', 'docs'), [
                '.md',
                '.mdx',
            ]),
        ];
        assert.ok(files.length > 10, 'is reading something');

        const offenders = [];
        files.forEach(file => {
            fs.readFileSync(file, 'utf8')
                .split('\n')
                .forEach((line, i) => {
                    if (EnterBinding.test(line)) {
                        offenders.push(`${paths.relative(ROOT, file)}:${i + 1}`);
                    }
                });
        });
        assert.deepEqual(offenders, [], 'use "return" for Enter');
    });
});
