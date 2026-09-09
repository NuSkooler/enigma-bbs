//  Post-build navigation check over dist/.
//
//  The sidebar was originally pure `autogenerate`, which made it impossible to
//  add a doc that never showed up in the nav. That property is worth keeping,
//  but a few groups have to be listed by hand: Starlight removed `label` on
//  `autogenerate` in v0.39, so a subdirectory that needs a presentable label
//  ("Views" rather than "views") must be wrapped in an explicit group, and the
//  pages that sit alongside such a group have to be named individually.
//
//  So the guarantee moves here: every page the site builds must appear in the
//  sidebar of a built page. A doc that is added but never listed fails the
//  build instead of quietly existing at a URL nobody can navigate to.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const DIST = 'dist';

//  Routes that are deliberately not in the nav.
const EXEMPT = new Set([
    '/', //  the marketing landing page
    '/404/', //  error page
    '/api/', //  linked as an external-style entry, checked separately below
]);

function walk(dir) {
    const out = [];
    for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) out.push(...walk(full));
        else out.push(full);
    }
    return out;
}

const files = walk(DIST).filter(f => f.endsWith('index.html'));

//  Every route the site serves as a page.
const routes = new Set(
    files.map(f => {
        const dir = relative(DIST, f).split(/[\\/]/).slice(0, -1).join('/');
        return dir ? `/${dir}/` : '/';
    })
);

//  Pagefind and the Redoc bundle emit their own index.html files; they are
//  assets, not documentation routes.
for (const r of [...routes]) {
    if (r.startsWith('/pagefind/') || r.startsWith('/_astro/')) routes.delete(r);
}

//  The sidebar is identical on every doc page, so one is enough. Pick a doc
//  page rather than the landing page, which has no sidebar at all.
const sample = files.find(f => relative(DIST, f).startsWith('installation'));
if (!sample) {
    console.error('nav check: no documentation page found in dist/');
    process.exit(1);
}
const html = readFileSync(sample, 'utf8');
const nav = html.slice(html.indexOf('id="starlight__sidebar"'));
const navEnd = nav.indexOf('</nav>');
const sidebar = navEnd === -1 ? nav : nav.slice(0, navEnd);

const linked = new Set(
    [...sidebar.matchAll(/href="(\/[^"]*)"/g)].map(m => m[1].split('#')[0])
);

const missing = [...routes].filter(r => !EXEMPT.has(r) && !linked.has(r)).sort();

//  The API reference is generated rather than a content collection entry, so it
//  is easy to drop out of the nav by accident. Check it explicitly.
if (routes.has('/api/') && !linked.has('/api/')) {
    missing.push('/api/  (generated API reference)');
}

if (missing.length === 0) {
    console.log(`nav check: ${routes.size} routes, all reachable from the sidebar`);
    process.exit(0);
}

console.error(`nav check: ${missing.length} route(s) not linked from the sidebar\n`);
for (const m of missing) console.error(`  ${m}`);
console.error(
    '\nAdd them to the `sidebar` in astro.config.mjs, or to EXEMPT in this script\n' +
        'if they are deliberately unlisted.'
);
process.exit(1);
