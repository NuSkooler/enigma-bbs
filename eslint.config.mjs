import globals from 'globals';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import js from '@eslint/js';
import { FlatCompat } from '@eslint/eslintrc';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const compat = new FlatCompat({
    baseDirectory: __dirname,
    recommendedConfig: js.configs.recommended,
    allConfig: js.configs.all,
});

export default [
    {
        ignores: ['core/acs_parser.js'],
    },
    ...compat.extends('eslint:recommended', 'plugin:json/recommended'),
    {
        languageOptions: {
            globals: {
                ...globals.node,
            },

            ecmaVersion: 2020,
            sourceType: 'commonjs',
        },

        rules: {
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
        },
    },
];
