//  External link rot check.
//
//  Deliberately NOT part of `npm run verify`. The docs cite a few hundred
//  external URLs, many on small hobbyist hosts -- BBS software pages, art scene
//  sites, personal servers -- that rate-limit, block unfamiliar user agents, or
//  are simply down for an afternoon. Gating a build on that would make the build
//  flaky and train people to ignore it. This runs on a schedule instead and
//  reports.
//
//  A response is a response: 403 and 406 mean the server is there and chose not
//  to serve a script, which is not link rot. Only a hard failure counts --
//  nothing resolves, nothing accepts a connection, or the server says the page
//  is gone.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const DOCS = 'src/content/docs';
const ROOT = '..';
const ALSO = ['README.md', 'UPGRADE.md', 'WHATSNEW.md', 'CONTRIBUTING.md', 'DEV.md'];

const CONCURRENCY = 8;
const TIMEOUT_MS = 20000;
const UA =
    'Mozilla/5.0 (compatible; enigma-bbs-docs-linkcheck/1.0; +https://github.com/NuSkooler/enigma-bbs)';

//  Hosts and shapes that are meant to be unreachable from a checker.
const SKIP = [
    /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)/i,
    /example\.(com|org|net)/i,
    /your-?(domain|bbs|hostname)/i,
    /\{[^}]*\}/, //  URLs containing a template placeholder
    /^https?:\/\/[^/]*\byourbbs\b/i,
];

function walk(dir) {
    const out = [];
    for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) out.push(...walk(full));
        else if (full.endsWith('.md')) out.push(full);
    }
    return out;
}

const files = [
    ...walk(DOCS),
    ...ALSO.map(f => join(ROOT, f)).filter(f => {
        try {
            return statSync(f).isFile();
        } catch {
            return false;
        }
    }),
];

/**
 * Pull the URL out of a markdown link starting at `](`. Markdown permits
 * balanced parentheses inside a link destination, and plenty of the URLs here
 * have them -- every Wikipedia article of the form `RAR_(file_format)`. Stopping
 * at the first `)` truncates those and reports a 404 that is the checker's own
 * fault, so scan for the closing paren by depth instead.
 */
function urlAt(md, start) {
    let depth = 1;
    for (let i = start; i < md.length; i++) {
        const c = md[i];
        if (c === '(') depth++;
        else if (c === ')') {
            if (--depth === 0) return md.slice(start, i);
        } else if (c === ' ' || c === '\n' || c === '\t') {
            //  A space ends the destination -- what follows is a link title.
            return md.slice(start, i);
        }
    }
    return null;
}

/** url -> Set of files citing it */
const cited = new Map();
for (const file of files) {
    const md = readFileSync(file, 'utf8');
    for (const m of md.matchAll(/\]\((https?:\/\/)/g)) {
        const url = urlAt(md, m.index + 2);
        if (!url) continue;
        const clean = url.replace(/[.,;:]+$/, '');
        if (SKIP.some(re => re.test(clean))) continue;
        if (!cited.has(clean)) cited.set(clean, new Set());
        cited.get(clean).add(relative('.', file));
    }
}

const urls = [...cited.keys()].sort();
console.log(`checking ${urls.length} unique external URLs from ${files.length} files\n`);

async function probe(url) {
    //  HEAD first: cheaper, and plenty of these are large pages. Fall back to a
    //  ranged GET, since a fair number of older servers do not implement HEAD.
    for (const method of ['HEAD', 'GET']) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
        try {
            const res = await fetch(url, {
                method,
                redirect: 'follow',
                signal: ctrl.signal,
                headers: {
                    'User-Agent': UA,
                    Accept: '*/*',
                    ...(method === 'GET' ? { Range: 'bytes=0-2048' } : {}),
                },
            });
            clearTimeout(timer);
            if (res.status === 405 || res.status === 501) continue; //  try GET
            return { status: res.status };
        } catch (err) {
            clearTimeout(timer);
            if (method === 'GET') return { status: 0, error: String(err.cause || err) };
        }
    }
    return { status: 0, error: 'unreachable' };
}

const dead = [];
let done = 0;
const queue = [...urls];

async function worker() {
    while (queue.length) {
        const url = queue.shift();
        const { status, error } = await probe(url);
        done++;
        //  Gone, or nothing answered at all.
        if (status === 404 || status === 410 || status === 0) {
            dead.push({ url, status, error, files: [...cited.get(url)] });
            process.stdout.write(`  DEAD ${status || 'ERR'}  ${url}\n`);
        }
        if (done % 25 === 0) process.stdout.write(`  …${done}/${urls.length}\n`);
    }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker));

console.log(`\nchecked ${urls.length} URLs, ${dead.length} dead`);

if (dead.length === 0) process.exit(0);

//  Emit a markdown report for the workflow to turn into an issue body.
const report = [
    `${dead.length} external link(s) in the documentation no longer resolve.`,
    '',
    '| URL | Result | Cited in |',
    '|-----|--------|----------|',
    ...dead.map(
        d =>
            `| ${d.url} | ${d.status === 0 ? `unreachable (${d.error})` : d.status} | ${d.files
                .map(f => `\`${f}\``)
                .join('<br>')} |`
    ),
    '',
    '_A 403 or 406 is not reported: those mean the server answered and declined,',
    'which is a bot block rather than link rot._',
].join('\n');

//  In CI the workflow turns this into an issue body; locally, just print it.
if (process.env.LINK_REPORT_PATH) {
    writeFileSync(process.env.LINK_REPORT_PATH, report);
} else {
    console.log('\n' + report);
}

process.exit(1);
