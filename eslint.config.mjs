import globals from 'globals';
import js from '@eslint/js';
import json from 'eslint-plugin-json';
import prettier from 'eslint-config-prettier';

//
//  ESLint flat config.
//
//  @eslint/js and eslint-plugin-json both ship native flat configs, so they are
//  used directly. Routing eslint-plugin-json through FlatCompat instead -- as
//  this file used to -- fails outright against v4 of the plugin: extends()
//  parses its target as a legacy eslintrc object, and the plugin's flat
//  "recommended" carries a top-level "files" key that eslintrc rejects. That
//  left `eslint .` unable to run at all.
//
//  eslint-config-prettier goes last and switches off every rule that overlaps
//  with Prettier (indent, quotes, semi, ...), leaving formatting to `npm run
//  pretty` and lint to correctness. The stylistic rules kept below are the ones
//  Prettier does not already settle.
//
export default [
    {
        //  ESLint does not read .gitignore, so anything ignored there but
        //  still present in a working tree has to be repeated here or it gets
        //  linted as if it were ours.
        ignores: [
            'core/acs_parser.js', //  generated -- see the build:acs script
            'node_modules/**',
            'docs/**',
            '.venv/**', //  local Python virtualenv
            'dev_util/gotosocial/web/**', //  fetched GoToSocial assets
            '.vscode/**', //  editor-local, and JSONC rather than JSON
        ],
    },

    {
        //  Several `eslint-disable-line no-control-regex` comments look unused
        //  purely because this config turns that rule off, and the same goes
        //  for the formatting rules eslint-config-prettier disables below.
        //  They still record why the code looks the way it does, and letting
        //  --fix strip them mangles the lines they sit on.
        linterOptions: {
            reportUnusedDisableDirectives: 'off',
        },
    },

    //  JSON is handled by the plugin's processor alone; core JS rules would
    //  misfire on it.
    json.configs.recommended,

    {
        files: ['**/*.js', '**/*.mjs'],
        languageOptions: {
            globals: {
                ...globals.node,
            },

            //  'latest' rather than a pinned year: the codebase already uses
            //  numeric separators (ES2021), which a pinned 2020 could not even
            //  parse -- three files were silently failing outright.
            ecmaVersion: 'latest',
            sourceType: 'commonjs',
        },

        rules: {
            ...js.configs.recommended.rules,

            indent: [
                'error',
                4,
                {
                    SwitchCase: 1,
                },
            ],

            'linebreak-style': ['error', 'unix'],
            quotes: ['error', 'single'],
            semi: ['error', 'always'],
            'comma-dangle': 0,
            'no-trailing-spaces': 'error',
            'no-control-regex': 0,

            //  Matched to conventions already used throughout the codebase:
            //  a leading underscore marks a deliberate throwaway, and a catch
            //  binding is often kept for readability even when unused. ESLint
            //  9 flipped the caughtErrors default from 'none' to 'all', which
            //  is why the latter started reporting.
            'no-unused-vars': [
                'error',
                {
                    args: 'after-used',
                    argsIgnorePattern: '^_',
                    varsIgnorePattern: '^_',
                    caughtErrors: 'none',
                },
            ],
        },
    },

    {
        files: ['**/*.mjs'],
        languageOptions: {
            sourceType: 'module',
        },
    },

    {
        files: ['test/**/*.js'],
        languageOptions: {
            globals: {
                ...globals.mocha,
            },
        },
    },

    prettier,
];
