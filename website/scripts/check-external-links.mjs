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
//
//  A 404 is never believed on the strength of a HEAD. The VS Code Marketplace
//  and support.google.com both answer HEAD with 404 and GET with 200 for the
//  same live page, whatever User-Agent is used, and #806 reported both as dead
//  on that basis. See probe().
//
//  Source comments are checked too, not just the docs. They cite specs and
//  reference implementations, and those rot the same way; #806 found five dead
//  ones sitting in core/ that the docs-only pass never looked at. Only comments
//  are read, never code, because the URL-shaped strings in code are mostly
//  JSON-LD context and namespace IRIs -- 'https://www.w3.org/ns/activitystreams'
//  and friends. Those are protocol identifiers that happen to look like links:
//  they are matched byte-for-byte by other implementations, so they must not be
//  "fixed" if they ever 404, and reporting them would be an invitation to do
//  exactly that.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const DOCS = 'src/content/docs';
const ROOT = '..';
const ALSO = ['README.md', 'UPGRADE.md', 'WHATSNEW.md', 'CONTRIBUTING.md', 'DEV.md'];

//  Trees whose comments carry citations worth keeping alive.
const SOURCE = ['core', 'misc'];

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
    /\$\{/, //  template literal interpolation
    //  Comments illustrate wire formats with invented hosts. These are not
    //  citations and were never meant to resolve.
    /^https?:\/\/(some\.host|somewhere\.com|some\.website\.com|someethingsomething)\b/i,
    /^https?:\/\/host\//i,
    /^https?:\/\/good\.example\b/i,
    /^https?:\/\/[^/]*\/users\/(alice|victim)\b/i,
    /^https?:\/\/mastodon\.social\/(@|users\/)alice\b/i,
    /^https?:\/\/l33t\.codes:\d+/i, //  web_util.js, illustrating URL construction
    //  Namespace and JSON-LD context IRIs. Code never reaches this list -- only
    //  comments are read -- but comments quote payloads, and a quoted IRI is
    //  still an identifier rather than a citation. Whether it resolves is not
    //  this script's business, and saying it is dead would invite a "fix" that
    //  silently breaks federation.
    /^https?:\/\/(www\.)?w3\.org\/ns\//i,
    /^https?:\/\/w3id\.org\//i,
    /^https?:\/\/joinmastodon\.org\/ns/i,
    /^https?:\/\/nodeinfo\.diaspora\.software\//i,
    /^https?:\/\/ostatus\.org\/schema\//i,
    /^https?:\/\/(www\.)?webfinger\.net\/rel\//i,
    /^https?:\/\/json-schema\.org\/draft\//i,
];

function walk(dir, exts = ['.md']) {
    const out = [];
    for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name.startsWith('.')) continue;
        const full = join(dir, name);
        if (statSync(full).isDirectory()) out.push(...walk(full, exts));
        else if (exts.some(e => full.endsWith(e))) out.push(full);
    }
    return out;
}

const docFiles = [
    ...walk(DOCS),
    ...ALSO.map(f => join(ROOT, f)).filter(f => {
        try {
            return statSync(f).isFile();
        } catch {
            return false;
        }
    }),
];

const sourceFiles = SOURCE.flatMap(d => {
    const full = join(ROOT, d);
    try {
        return statSync(full).isDirectory() ? walk(full, ['.js', '.hjson']) : [];
    } catch {
        return [];
    }
});

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

/**
 * Comment text from a JS source, and only comment text.
 *
 * `//` cannot be found by pattern: every URL in the file contains one, so
 * `'https://www.w3.org/ns/activitystreams'` reads as a comment introducing
 * `www.w3.org/...` unless you already know it is inside a string. Walk the file
 * tracking strings and template literals so that question is answered before it
 * is asked. A regex literal needs no special case -- an unescaped `//` would
 * close it, so one cannot contain the sequence.
 */
function jsComments(src) {
    const out = [];
    for (let i = 0; i < src.length;) {
        const c = src[i];
        if (c === '"' || c === "'" || c === '`') {
            for (i++; i < src.length; i++) {
                if (src[i] === '\\') i++;
                else if (src[i] === c) break;
            }
            i++;
        } else if (c === '/' && src[i + 1] === '/') {
            let end = src.indexOf('\n', i);
            if (end < 0) end = src.length;
            out.push(src.slice(i + 2, end));
            i = end;
        } else if (c === '/' && src[i + 1] === '*') {
            let end = src.indexOf('*/', i + 2);
            if (end < 0) end = src.length;
            out.push(src.slice(i + 2, end));
            i = end + 2;
        } else {
            i++;
        }
    }
    return out;
}

/**
 * HJSON comments, conservatively.
 *
 * HJSON values may be unquoted, so `url: http://example.com` puts a bare `//`
 * where no string delimiter marks it, and the trick above cannot tell it from a
 * comment. A comment that starts its own line is unambiguous either way -- a
 * value is always preceded by its key -- and that is where these citations
 * live, so take only those and leave the rest alone.
 */
function hjsonComments(src) {
    return src
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.startsWith('//') || line.startsWith('#'))
        .map(line => line.replace(/^(\/\/|#)/, ''));
}

/** Bare URLs in prose, as comments cite them. */
function bareUrls(text) {
    return [...text.matchAll(/https?:\/\/[^\s)<>"'`\]]+/g)].map(m => m[0]);
}

/** url -> Set of files citing it */
const cited = new Map();

function cite(url, file) {
    const clean = url.replace(/[.,;:!?]+$/, '');
    if (SKIP.some(re => re.test(clean))) return;
    if (!cited.has(clean)) cited.set(clean, new Set());
    cited.get(clean).add(relative('.', file));
}

for (const file of docFiles) {
    const md = readFileSync(file, 'utf8');
    for (const m of md.matchAll(/\]\((https?:\/\/)/g)) {
        const url = urlAt(md, m.index + 2);
        if (url) cite(url, file);
    }
}

for (const file of sourceFiles) {
    const src = readFileSync(file, 'utf8');
    const comments = file.endsWith('.hjson') ? hjsonComments(src) : jsComments(src);
    for (const comment of comments) {
        for (const url of bareUrls(comment)) cite(url, file);
    }
}

const urls = [...cited.keys()].sort();
console.log(
    `checking ${urls.length} unique external URLs from ${docFiles.length} doc ` +
        `and ${sourceFiles.length} source files\n`
);

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
            //  405 and 501 are a server saying it does not do HEAD. 404 to a
            //  HEAD is less honest but means the same thing often enough to be
            //  worth the second request: the VS Code Marketplace and
            //  support.google.com both serve 404 to HEAD and 200 to GET for a
            //  live page, and #806 listed both as dead because of it. Only a
            //  GET can retire a URL.
            if (method === 'HEAD' && [404, 405, 501].includes(res.status)) continue;
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
    `${dead.length} external link(s) in the documentation and source comments no longer resolve.`,
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
    'which is a bot block rather than link rot. A 404 seen by a HEAD request is',
    're-checked with a GET before it is listed here._',
].join('\n');

//  In CI the workflow turns this into an issue body; locally, just print it.
if (process.env.LINK_REPORT_PATH) {
    writeFileSync(process.env.LINK_REPORT_PATH, report);
} else {
    console.log('\n' + report);
}

process.exit(1);
