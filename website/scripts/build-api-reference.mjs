//  Build the API reference from src/api/openapi.yaml.
//
//  `redocly build-docs` emits a page that pulls Redoc's ~1MB bundle from
//  cdn.redocly.com at runtime. That is not acceptable for docs: the reference
//  would go blank whenever a third party is unreachable, and every reader would
//  be making a request to one just to read our documentation. So the bundle is
//  copied out of node_modules and served from our own origin, and the CDN
//  reference is rewritten to point at it.
//
//  The rewrite is asserted rather than assumed -- if Redocly changes the URL
//  shape, this fails loudly instead of silently shipping the CDN version.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';

//  The page is a real Astro route (src/pages), not a public/ asset. Astro's dev
//  server does not do directory-index resolution for public/, so a public-only
//  page answers /api/index.html but 404s on /api/ -- fine once a static host is
//  in front of it, broken for anyone running the dev server.
const PAGE_DIR = 'src/pages/api';
const PAGE = `${PAGE_DIR}/index.html`;
//  The bundle stays a plain asset: it is fetched by path, never routed to.
const OUT_DIR = 'public/api';
const BUNDLE = 'redoc.standalone.js';
const SOURCE_BUNDLE = `node_modules/redoc/bundles/${BUNDLE}`;

mkdirSync(PAGE_DIR, { recursive: true });
mkdirSync(OUT_DIR, { recursive: true });

execFileSync(
    'npx',
    [
        'redocly',
        'build-docs',
        'src/api/openapi.yaml',
        '-o',
        PAGE,
        '--template',
        'scripts/redoc-template.hbs',
        '--disableGoogleFont',
        '--title',
        'ENiGMA½ BBS REST API',
    ],
    { stdio: ['ignore', 'ignore', 'inherit'] }
);

copyFileSync(SOURCE_BUNDLE, `${OUT_DIR}/${BUNDLE}`);

const html = readFileSync(PAGE, 'utf8');
const cdn = /https:\/\/cdn\.redocly\.com\/redoc\/[^"']+\/bundles\/redoc\.standalone\.js/g;
const matches = html.match(cdn);
if (!matches) {
    console.error(
        `[api] expected a cdn.redocly.com bundle reference in ${PAGE} to rewrite, and found none.\n` +
            `      Redocly's output shape has changed; check whether it now inlines or ` +
            `references the bundle differently before trusting this build.`
    );
    process.exit(1);
}
const rewritten = html.replace(cdn, `./${BUNDLE}`);
if (/cdn\.redocly\.com|fonts\.googleapis\.com/.test(rewritten)) {
    console.error(`[api] ${PAGE} still references a third-party origin after rewriting.`);
    process.exit(1);
}
writeFileSync(PAGE, rewritten);

const kib = n => `${Math.round(statSync(n).size / 1024)} KiB`;
console.log(
    `api reference: ${PAGE} (${kib(PAGE)}) + ${BUNDLE} (${kib(`${OUT_DIR}/${BUNDLE}`)}), ` +
        `no third-party origins`
);
