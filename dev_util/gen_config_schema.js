#!/usr/bin/env node
/* jslint node: true */
'use strict';

//
//  Regenerates misc/config.schema.json.
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
const { toJsonSchema, serialize } = require('../core/config/json_schema.js');

const OUTPUT_PATH = paths.join(__dirname, '../misc/config.schema.json');

function main() {
    const generated = serialize(toJsonSchema(buildSchema()));

    let existing;
    try {
        existing = fs.readFileSync(OUTPUT_PATH, 'utf8');
    } catch (e) {
        if ('ENOENT' !== e.code) {
            throw e;
        }
    }

    //  --check: for anyone who wants the guard outside of mocha
    if (process.argv.includes('--check')) {
        if (generated === existing) {
            console.info(`${OUTPUT_PATH}: up to date`);
            return;
        }

        console.error(
            `${OUTPUT_PATH} is out of date; run "npm run build:schema" and commit the result`
        );
        process.exitCode = 1;
        return;
    }

    if (generated === existing) {
        console.info(`${OUTPUT_PATH}: unchanged`);
        return;
    }

    fs.writeFileSync(OUTPUT_PATH, generated, 'utf8');
    console.info(`${OUTPUT_PATH}: written (${generated.length} bytes)`);
}

main();
