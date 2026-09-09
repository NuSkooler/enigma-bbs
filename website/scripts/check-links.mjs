//  Post-build link check over dist/.
//
//  The remark plugin already fails the build on a dead doc-to-doc markdown
//  link, but it only sees markdown. This catches everything else the build
//  emits: hand-written hrefs in .astro pages, sidebar and pagination links,
//  asset references, and anything a Starlight upgrade quietly changes.
//
//  The old site accumulated roughly twenty dead links precisely because nothing
//  ever checked. Exits non-zero so CI can gate on it.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, posix } from 'node:path';

const DIST = 'dist';

//  Schemes we do not resolve. telnet:// and ssh:// matter here: this is a BBS.
const EXTERNAL = /^(https?:|mailto:|tel:|ftp:|telnet:|ssh:|data:|#)/i;

function walk(dir) {
    const out = [];
    for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) out.push(...walk(full));
        else out.push(full);
    }
    return out;
}

const files = walk(DIST);
const rel = f => relative(DIST, f).split(/[\\/]/).join('/');

//  Every path the built site can serve.
const served = new Set();
for (const f of files) {
    const r = rel(f);
    served.add('/' + r);
    if (r.endsWith('index.html')) {
        const dir = posix.dirname(r);
        served.add(dir === '.' ? '/' : '/' + dir + '/');
    }
}

const problems = [];
for (const f of files.filter(f => f.endsWith('.html'))) {
    const html = readFileSync(f, 'utf8');
    for (const m of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
        const raw = m[1];
        if (!raw || EXTERNAL.test(raw)) continue;

        const path = raw.split('#')[0].split('?')[0];
        if (!path) continue;

        //  Relative targets are legitimate -- the generated API reference loads
        //  its bundle as a sibling -- so resolve them against the page rather
        //  than rejecting them outright.
        const resolved = path.startsWith('/')
            ? path
            : posix.resolve('/' + posix.dirname(rel(f)), path);

        if (!served.has(resolved) && !served.has(resolved + '/')) {
            problems.push([rel(f), raw, 'target not built']);
        }
    }
}

const pages = files.filter(f => f.endsWith('.html')).length;
if (problems.length === 0) {
    console.log(`link check: ${pages} pages, no broken internal links`);
    process.exit(0);
}
console.error(`link check: ${problems.length} broken link(s) across ${pages} pages\n`);
for (const [page, link, why] of problems)
    console.error(`  ${page}\n    -> ${link}  (${why})`);
process.exit(1);
