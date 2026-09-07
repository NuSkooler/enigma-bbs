#!/usr/bin/env node
/* jslint node: true */
'use strict';

//
//  Regenerates the published JSON Schema artifacts:
//
//      misc/config.schema.json    from config_default.js + config/meta.js
//      misc/menu.schema.json      from config/menu_schema.js
//
//      npm run build:schema
//
//  Everything of substance lives in core/config/json_schema.js so the same
//  projection can be unit tested and, later, served to a configuration editor
//  without a build step. This file only decides where the output goes.
//
//  test/config_json_schema.test.js fails if the checked-in artifact does not
//  match what this produces, so a forgotten regeneration is caught by
//  "npm test" rather than by whoever next reads the file.
//

const fs = require('fs');
const paths = require('path');

const { buildSchema } = require('../core/config/schema.js');
const { buildMenuSchema } = require('../core/config/menu_schema.js');
const { toJsonSchema, serialize } = require('../core/config/json_schema.js');

const ARTIFACTS = [
    {
        path: paths.join(__dirname, '../misc/config.schema.json'),
        build: () => buildSchema(),
        title: 'ENiGMA½ BBS configuration',
    },
    {
        path: paths.join(__dirname, '../misc/menu.schema.json'),
        build: () => buildMenuSchema(),
        title: 'ENiGMA½ BBS menus',
        source: 'core/config/menu_schema.js',
    },
];

function generateOne({ path, build, title, source }, check) {
    const generated = serialize(
        toJsonSchema(build(), { title, id: paths.basename(path), source })
    );

    let existing;
    try {
        existing = fs.readFileSync(path, 'utf8');
    } catch (e) {
        if ('ENOENT' !== e.code) {
            throw e;
        }
    }

    if (generated === existing) {
        console.info(`${path}: ${check ? 'up to date' : 'unchanged'}`);
        return true;
    }

    if (check) {
        console.error(
            `${path} is out of date; run "npm run build:schema" and commit the result`
        );
        return false;
    }

    fs.writeFileSync(path, generated, 'utf8');
    console.info(`${path}: written (${generated.length} bytes)`);
    return true;
}

function main() {
    //  --check: for anyone who wants the guard outside of mocha
    const check = process.argv.includes('--check');
    const ok = ARTIFACTS.map(artifact => generateOne(artifact, check)).every(Boolean);

    if (!ok) {
        process.exitCode = 1;
    }
}

main();
