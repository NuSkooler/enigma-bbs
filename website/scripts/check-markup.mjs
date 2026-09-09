//  Post-build check for markdown that never became markup.
//
//  check-links.mjs verifies that every link resolves. It structurally cannot
//  catch the opposite failure: markup that never parsed at all, and so was
//  emitted as literal text. Both forms of that shipped on this site for a while:
//
//    * 23 `<details markdown="1">` blocks across 13 pages. That attribute is a
//      Kramdown idiom; Astro ignores it, so the fenced hjson inside rendered as
//      plain text with visible ``` markers.
//    * A `{{ site.baseurl }}` Liquid link left over from Jekyll, printed as raw
//      `[text](url)` source because the space in the URL stopped markdown
//      parsing it as a link -- so no <a> was ever emitted for check-links to
//      look at.
//    * A code fence closed with ```hjson rather than ```, which is an opening
//      fence, swallowing the prose that followed.
//
//  All three look identical from here: markdown syntax surviving into the
//  rendered body. Exits non-zero so CI gates on it.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const DIST = 'dist';

const PATTERNS = [
    { name: 'unrendered markdown link', re: /\]\([^)\s]/ },
    { name: 'unrendered code fence', re: /(^|[^`])```/ },
    { name: 'Jekyll Liquid tag', re: /\{\{[^}]*\}\}|\{%[^%]*%\}/ },
    { name: 'Kramdown markdown="1" attribute', re: /markdown="1"/ },
    { name: 'unrendered heading', re: /^\s*#{1,6}\s+\S/m },
];

function walk(dir) {
    const out = [];
    for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) out.push(...walk(full));
        else out.push(full);
    }
    return out;
}

/**
 * Reduce a page to the prose a reader sees: the Starlight content body, minus
 * anything that is legitimately allowed to contain these characters -- code
 * blocks and inline code, the copy-to-clipboard button that carries a verbatim
 * copy of every snippet, and script/style.
 */
function proseOf(html) {
    const start = html.indexOf('<div class="sl-markdown-content">');
    if (start === -1) return '';
    let body = html.slice(start);
    const end = body.indexOf('<footer');
    if (end !== -1) body = body.slice(0, end);

    //  Two things about these patterns, both of which HTML allows and a naive
    //  regex misses. Tag names are case insensitive, so <SCRIPT> has to match.
    //  And a closing tag may carry whitespace before its '>', so </script > is
    //  a real end tag. Either miss leaves the element's contents in the text
    //  this check then scans for markdown syntax -- a script body containing
    //  "](" would be reported as an unrendered link on a page that is fine.
    const element = name => new RegExp(`<${name}[\\s\\S]*?</${name}\\s*>`, 'gi');

    return body
        .replace(/<figure class="frame[\s\S]*?<\/figure\s*>/gi, ' ')
        .replace(element('code'), ' ')
        .replace(element('pre'), ' ')
        .replace(element('script'), ' ')
        .replace(element('style'), ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&#x3C;/g, '<')
        .replace(/&lt;/g, '<')
        .replace(/&amp;/g, '&');
}

const pages = walk(DIST).filter(f => f.endsWith('index.html'));
const problems = [];

for (const file of pages) {
    const html = readFileSync(file, 'utf8');
    const prose = proseOf(html);
    if (!prose.trim()) continue;

    for (const { name, re } of PATTERNS) {
        const m = re.exec(prose);
        if (!m) continue;
        const at = Math.max(0, m.index - 60);
        const excerpt = prose
            .slice(at, m.index + 90)
            .replace(/\s+/g, ' ')
            .trim();
        problems.push([relative(DIST, file), name, excerpt]);
    }
}

if (problems.length === 0) {
    console.log(`markup check: ${pages.length} pages, no unrendered markdown`);
    process.exit(0);
}

console.error(
    `markup check: ${problems.length} page(s) with markdown that did not render\n`
);
for (const [page, name, excerpt] of problems) {
    console.error(`  ${page}\n    ${name}: …${excerpt}…\n`);
}
console.error(
    'These render as literal text for readers. Common causes: a code fence closed\n' +
        'with an info string (```hjson rather than ```), raw HTML wrappers such as\n' +
        '<details markdown="1">, or a link whose URL contains a space.'
);
process.exit(1);
