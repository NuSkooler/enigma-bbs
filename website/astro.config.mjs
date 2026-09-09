// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import { remarkDocLinks } from './plugins/remark-doc-links.mjs';
import { hjsonFragment } from './src/lib/hjson-grammar.mjs';

export default defineConfig({
    //  Deploys to the org site at the root, so no base path.
    site: 'https://enigma-bbs.github.io',
    output: 'static',
    trailingSlash: 'ignore',
    build: {
        //  `installation/docker/index.html` rather than `installation/docker.html`.
        format: 'directory',
    },
    devToolbar: { enabled: false },
    markdown: {
        //  Strict: an unresolvable doc-to-doc link fails the build. The old
        //  site accumulated ~20 dead links precisely because nothing ever did.
        remarkPlugins: [remarkDocLinks],
    },
    integrations: [
        starlight({
            title: 'ENiGMA½ BBS',
            expressiveCode: {
                //  See src/lib/hjson-grammar.mjs: the stock Hjson grammar cannot
                //  tokenise a braceless fragment, which is every snippet here.
                shiki: {
                    langs: [hjsonFragment],
                    langAlias: { hjson: 'hjson-fragment' },
                },
            },
            description:
                'Modern BBS software with a nostalgic flair, written in Node.js.',
            customCss: ['./src/styles/enigma.css'],
            editLink: {
                baseUrl: 'https://github.com/NuSkooler/enigma-bbs/edit/master/website/',
            },
            lastUpdated: true,
            social: [
                {
                    icon: 'github',
                    label: 'GitHub',
                    href: 'https://github.com/NuSkooler/enigma-bbs',
                },
                {
                    icon: 'discord',
                    label: 'Discord',
                    href: 'https://discord.gg/M2pbyvuGva',
                },
            ],
            //  Section order and titles mirror the old _data/sections.yml, but the
            //  PAGES inside each are discovered from disk. That is what makes it
            //  impossible to add a doc that never appears in the nav.
            sidebar: [
                {
                    label: 'Installation',
                    items: [{ autogenerate: { directory: 'installation' } }],
                },
                {
                    label: 'Configuration',
                    items: [{ autogenerate: { directory: 'configuration' } }],
                },
                {
                    label: 'File Base',
                    items: [{ autogenerate: { directory: 'filebase' } }],
                },
                {
                    label: 'Message Areas',
                    items: [{ autogenerate: { directory: 'messageareas' } }],
                },
                { label: 'Art', items: [{ autogenerate: { directory: 'art' } }] },
                { label: 'Servers', items: [{ autogenerate: { directory: 'servers' } }] },
                { label: 'Modding', items: [{ autogenerate: { directory: 'modding' } }] },
                {
                    label: 'Administration',
                    items: [{ autogenerate: { directory: 'admin' } }],
                },
                {
                    label: 'Troubleshooting',
                    items: [{ autogenerate: { directory: 'troubleshooting' } }],
                },
                {
                    label: 'Miscellaneous',
                    items: [{ autogenerate: { directory: 'misc' } }],
                },
            ],
        }),
    ],
});
