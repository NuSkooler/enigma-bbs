//  Generate the release notes and upgrade notes pages from the repo root.
//
//  UPGRADE.md and WHATSNEW.md are the two largest documents in the project and
//  the two a sysop most needs on upgrade day, and they lived only in the
//  repository -- the site's Upgrading page was 294 words linking out to raw
//  GitHub. Putting them on the site also puts them in Pagefind, so
//  version-to-version notes become searchable.
//
//  They are GENERATED rather than copied. The root files stay canonical:
//  CONTRIBUTING.md tells contributors to update them there, and they are what
//  someone reads on GitHub. Copying would have produced exactly the two-sources
//  problem this cleanup is removing. Same pattern as build-api-reference.mjs.
//
//  Output is gitignored. `npm run build` regenerates it.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve('..');
const OUT = 'src/content/docs/admin';

const PAGES = [
    {
        src: 'WHATSNEW.md',
        out: 'release-notes.md',
        title: 'Release Notes',
        order: 4,
        description:
            'Major changes and additions in each release of ENiGMA½, newest first.',
        blurb:
            'Major changes and additions, newest first. This page is generated from ' +
            '[`WHATSNEW.md`](https://github.com/NuSkooler/enigma-bbs/blob/master/WHATSNEW.md) ' +
            'in the repository. For the full detail behind any entry, see the linked issue or GitHub.',
    },
    {
        src: 'UPGRADE.md',
        out: 'upgrade-notes.md',
        title: 'Upgrade Notes',
        order: 5,
        description:
            'Version-to-version upgrade notes. Read the entries between your version and the one you are moving to.',
        blurb:
            'Version-to-version notes to read **before** upgrading. This page is generated from ' +
            '[`UPGRADE.md`](https://github.com/NuSkooler/enigma-bbs/blob/master/UPGRADE.md) ' +
            'in the repository. For the upgrade procedure itself, see [Upgrading](upgrading.md).',
    },
];

/** Repo-relative links have to become something that works on the site. */
function rewriteLinks(md) {
    return (
        md
            //  ./website/src/content/docs/a/b.md#c  ->  /a/b/#c
            .replace(
                /\]\(\.?\/?website\/src\/content\/docs\/([^)#]+?)(?:\/index)?\.md(#[^)]*)?\)/g,
                (_m, slug, anchor) => `](/${slug}/${anchor || ''})`
            )
            //  Anything else repo-relative points at a file, not a page: send it
            //  to GitHub rather than leaving a link that 404s on the site.
            .replace(
                /\]\(\.\/([^)#]+)\)/g,
                (_m, path) =>
                    `](https://github.com/NuSkooler/enigma-bbs/blob/master/${path})`
            )
            //  Bare sibling files at the repo root, e.g. (TROUBLESHOOTING.md).
            //  The four that now have a home on the site point at it; the rest
            //  are source files and go to GitHub.
            .replace(
                /\]\(([A-Z][A-Za-z_]*\.(?:md|TXT))(#[^)]*)?\)/g,
                (_m, file, anchor) => {
                    const onSite = {
                        'UPGRADE.md': '/admin/upgrade-notes/',
                        'WHATSNEW.md': '/admin/release-notes/',
                        'TROUBLESHOOTING.md': '/troubleshooting/installation-issues/',
                        'CONTRIBUTING.md': '/contributing/',
                    }[file];
                    return onSite
                        ? `](${onSite}${anchor || ''})`
                        : `](https://github.com/NuSkooler/enigma-bbs/blob/master/${file}${anchor || ''})`;
                }
            )
    );
}

/**
 * Starlight renders the frontmatter title as the page H1, so body headings must
 * start at H2. The two sources differ: UPGRADE.md uses H1 for major sections and
 * needs shifting down, while WHATSNEW.md is already at H2 once its own leading
 * H1 is stripped and must be left alone. So normalise rather than blanket
 * demote -- shift the document so its shallowest heading lands on H2.
 */
function normaliseHeadings(md) {
    const lines = md.split('\n');
    const levels = [];
    let fence = null;
    const scan = line => {
        const f = /^\s*(`{3,}|~{3,})/.exec(line);
        if (f) {
            const tok = f[1][0];
            if (fence === null) fence = tok;
            else if (fence === tok) fence = null;
            return null;
        }
        if (fence) return null;
        return /^(#{1,6})\s+(.*)$/.exec(line);
    };

    for (const line of lines) {
        const h = scan(line);
        if (h) levels.push(h[1].length);
    }
    if (!levels.length) return md;

    const shift = 2 - Math.min(...levels);
    if (shift === 0) return md;

    fence = null;
    return lines
        .map(line => {
            const h = scan(line);
            if (!h) return line;
            const level = Math.max(1, Math.min(6, h[1].length + shift));
            return '#'.repeat(level) + ' ' + h[2];
        })
        .join('\n');
}

mkdirSync(OUT, { recursive: true });

for (const page of PAGES) {
    let md = readFileSync(join(ROOT, page.src), 'utf8');

    //  Drop the source's own leading H1 and any intro paragraph before the
    //  first section: the frontmatter title and blurb replace them.
    md = md.replace(/^#\s+.*\n/, '');

    md = normaliseHeadings(rewriteLinks(md)).trim();

    const esc = page.description.replace(/"/g, '\\"');
    const out = `---
title: ${page.title}
description: "${esc}"
sidebar:
    order: ${page.order}
editUrl: https://github.com/NuSkooler/enigma-bbs/edit/master/${page.src}
---
${page.blurb}

${md}
`;
    const dest = join(OUT, page.out);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, out);
    console.log(`release notes: ${page.src} -> ${dest} (${(out.length / 1024) | 0} KiB)`);
}
