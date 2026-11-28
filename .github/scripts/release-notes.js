'use strict';

//
//  Release notes for a tagged version, built from WHATSNEW.md and UPGRADE.md.
//  Run by .github/workflows/release.yml; unit tests in
//  test/release_notes.test.js. No dependencies, so it runs before (or without)
//  npm ci.
//
//      node .github/scripts/release-notes.js --version 0.7.0 \
//          [--repo NuSkooler/enigma-bbs] [--whatsnew WHATSNEW.md] \
//          [--upgrade UPGRADE.md] [--out notes.md]
//
//  The notes are the `## X.Y.Z` section of WHATSNEW.md, then links to the
//  matching UPGRADE.md section (`## A.B.C to X.Y.Z`) on GitHub and on the docs
//  site. A loud line goes at the top when that UPGRADE section mentions a
//  database upgrade. Exits 1 when the WHATSNEW section is missing or empty:
//  that is a release PR that forgot to rename `## Unreleased`.
//
//  A prerelease (0.8.0-rc.1) uses its own section if there is one, else the
//  section of the version it leads to (0.8.0).
//

const fs = require('fs');

const DOCS_SITE = 'https://enigma-bbs.github.io';
const DEFAULT_REPO = 'NuSkooler/enigma-bbs';

const escapeRegExp = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

//  The anchor GitHub and the docs site (Astro, github-slugger) give a heading:
//  lower case, punctuation other than - and _ dropped, spaces to hyphens.
//  "0.6.2-beta to 0.6.3-beta" -> "062-beta-to-063-beta".
function slugify(heading) {
    return heading
        .trim()
        .toLowerCase()
        .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
        .replace(/ /g, '-');
}

//  Every `## ` section of a Markdown document: { title, body }. A section runs
//  to the next heading of level 1 or 2. Fenced code blocks are skipped, so a
//  `## ` inside one is not taken for a heading.
function parseSections(markdown) {
    const sections = [];
    let current = null;
    let fence = null;

    for (const line of markdown.split(/\r?\n/)) {
        const f = /^\s*(`{3,}|~{3,})/.exec(line);
        if (f) {
            if (fence === null) {
                fence = f[1][0];
            } else if (fence === f[1][0]) {
                fence = null;
            }
        }

        const heading = fence === null && !f && /^(#{1,2})\s+(.*?)\s*#*\s*$/.exec(line);
        if (heading) {
            current = null;
            if (heading[1].length === 2) {
                current = { title: heading[2], lines: [] };
                sections.push(current);
            }
            continue;
        }

        if (current) {
            current.lines.push(line);
        }
    }

    return sections.map(s => ({ title: s.title, body: s.lines.join('\n').trim() }));
}

//  0.8.0-rc.1 -> [ '0.8.0-rc.1', '0.8.0' ]; 0.8.0 -> [ '0.8.0' ]
function candidateVersions(version) {
    const base = version.replace(/-.*$/, '');
    return base === version ? [version] : [version, base];
}

//  `## 0.7.0` or `## 0.7.0 (2026-12-01)`, but not `## 0.7.0-rc.1`.
function findWhatsNewSection(sections, version) {
    for (const v of candidateVersions(version)) {
        const re = new RegExp(`^v?${escapeRegExp(v)}(?:\\s.*)?$`);
        const section = sections.find(s => re.test(s.title));
        if (section) {
            return section;
        }
    }
    return null;
}

//  `## 0.6.3-beta to 0.7.0`, optionally with a date after it, or `## 0.7.0`.
function findUpgradeSection(sections, version) {
    for (const v of candidateVersions(version)) {
        const re = new RegExp(`(?:^|\\sto\\s+)v?${escapeRegExp(v)}(?:\\s*\\(.*\\))?$`);
        const section = sections.find(s => re.test(s.title));
        if (section) {
            return section;
        }
    }
    return null;
}

//  The lines of an UPGRADE section that say a database is upgraded or
//  migrated. The policy (docs: contributing/versioning, "Databases") says the
//  Upgrade Notes always say so, but not in set words, so this looks for a
//  database word and a change word in the same sentence: "the `message` table
//  is recreated", "two indexes are added to `db/activitypub.sqlite3`",
//  "databases will need to be updated". It leans towards saying yes: a wrong
//  loud line is caught when the draft is read, a missing one is not. The
//  workflow log lists the lines that matched.
function databaseUpgradeLines(text) {
    const DB = String.raw`(?:\bdatabases?|\.sqlite3|\.db|\btables?|\b(?:full-text|search) index(?:es)?)`;
    const CHANGE = String.raw`(?:upgrade[sd]?|upgrading|updated|migrat\w*|schema|recreat\w*|rebuil\w*|(?:added|dropped|altered))`;
    //  a sentence: no full stop followed by a space between the two words
    const GAP = String.raw`(?:(?!\.\s)[^\n])*?`;
    const re = new RegExp(
        `${DB}\\b${GAP}\\b${CHANGE}\\b|\\b${CHANGE}\\b${GAP}${DB}\\b`,
        'i'
    );

    return text
        .split(/\r?\n/)
        .map(l => l.trim())
        .filter(l => re.test(l));
}

//  A link to a file in the repository means nothing in a release body, which
//  GitHub resolves against /releases/: point it at the file at the tag.
function absolutizeLinks(markdown, { repo, tag }) {
    return markdown.replace(
        /\]\((?!#|\/|[a-z][a-z0-9+.-]*:)(?:\.\/)?([^)\s]+)\)/gi,
        (_m, path) => `](https://github.com/${repo}/blob/${tag}/${path})`
    );
}

//  The italic line `## Unreleased` opens with. A release PR should drop it
//  along with the heading; if it did not, it would tell readers of a release
//  that it is unreleased.
const UNRELEASED_BLURB = /^_[^\n]*since the last release[^\n]*_\s*(?:\n|$)/i;

function buildNotes({ version, whatsnew, upgrade, repo = DEFAULT_REPO }) {
    const tag = `v${version}`;
    const warnings = [];

    const wn = findWhatsNewSection(parseSections(whatsnew), version);
    if (!wn) {
        const err = new Error(
            `WHATSNEW.md has no "## ${version}" section. The release PR renames ` +
                '"## Unreleased" to the version.'
        );
        err.code = 'NO_WHATSNEW_SECTION';
        throw err;
    }

    let body = wn.body;
    if (UNRELEASED_BLURB.test(body)) {
        body = body.replace(UNRELEASED_BLURB, '').trim();
        warnings.push(
            `WHATSNEW.md "## ${wn.title}" still opens with the "## Unreleased" ` +
                'blurb; it was left out of the notes.'
        );
    }
    if (!body) {
        const err = new Error(`WHATSNEW.md "## ${wn.title}" is empty.`);
        err.code = 'EMPTY_WHATSNEW_SECTION';
        throw err;
    }

    const up = findUpgradeSection(parseSections(upgrade), version);
    const dbLines = up ? databaseUpgradeLines(up.body) : [];

    const out = [];

    if (dbLines.length > 0) {
        out.push(
            '> **This release upgrades a database.** ENiGMA½ upgrades it when it ' +
                'first starts, and an older version cannot read it afterwards. ' +
                '**Back up before upgrading**, and read the upgrade notes below.',
            ''
        );
    }

    out.push(absolutizeLinks(body, { repo, tag }), '', '---', '');

    if (up) {
        const anchor = slugify(up.title);
        out.push(
            `**Before upgrading**, read the [upgrade notes for ${up.title}]` +
                `(https://github.com/${repo}/blob/${tag}/UPGRADE.md#${anchor}) ` +
                `(also on the [docs site](${DOCS_SITE}/admin/upgrade-notes/#${anchor})). ` +
                `[Upgrading](${DOCS_SITE}/admin/upgrading/) covers how.`
        );
    } else {
        warnings.push(
            `UPGRADE.md has no section ending in "to ${version}"; the notes link ` +
                'to the upgrade notes as a whole.'
        );
        out.push(
            '**Before upgrading**, read the ' +
                `[upgrade notes](${DOCS_SITE}/admin/upgrade-notes/) for every version ` +
                `since yours. [Upgrading](${DOCS_SITE}/admin/upgrading/) covers how.`
        );
    }

    out.push(
        '',
        '**Verifying the download:** `sha256sum -c SHA256SUMS`, and ' +
            `\`gh attestation verify enigma-bbs-${version}.tar.gz --repo ${repo}\` ` +
            '(the same for the `.zip`).',
        ''
    );

    return {
        notes: out.join('\n'),
        whatsNewTitle: wn.title,
        upgradeTitle: up ? up.title : null,
        databaseUpgradeLines: dbLines,
        warnings,
    };
}

function parseArgs(argv) {
    const args = {
        whatsnew: 'WHATSNEW.md',
        upgrade: 'UPGRADE.md',
        repo: DEFAULT_REPO,
    };
    for (let i = 0; i < argv.length; ++i) {
        const m = /^--(version|repo|whatsnew|upgrade|out)$/.exec(argv[i]);
        if (!m || i + 1 >= argv.length) {
            throw new Error(`unexpected argument: ${argv[i]}`);
        }
        args[m[1]] = argv[++i];
    }
    if (!args.version) {
        throw new Error('--version is required');
    }
    return args;
}

function main(argv) {
    //  In a workflow, warnings become annotations on the run.
    const gha = process.env.GITHUB_ACTIONS === 'true';
    const say = (level, msg) =>
        console.error(gha ? `::${level}::${msg}` : `${level}: ${msg}`);

    let result;
    try {
        const args = parseArgs(argv);
        result = buildNotes({
            version: args.version,
            whatsnew: fs.readFileSync(args.whatsnew, 'utf8'),
            upgrade: fs.readFileSync(args.upgrade, 'utf8'),
            repo: args.repo,
        });
        if (args.out) {
            fs.writeFileSync(args.out, result.notes);
        } else {
            process.stdout.write(result.notes);
        }
    } catch (err) {
        say('error', err.message);
        return 1;
    }

    result.warnings.forEach(w => say('warning', w));
    console.error(
        `release notes: WHATSNEW "## ${result.whatsNewTitle}", UPGRADE ` +
            (result.upgradeTitle ? `"## ${result.upgradeTitle}"` : '(none)')
    );
    const dbLines = result.databaseUpgradeLines;
    if (dbLines.length > 0) {
        say(
            'notice',
            `The notes say this release upgrades a database: ${dbLines.length} ` +
                `line(s) of UPGRADE.md "## ${result.upgradeTitle}" say so, ` +
                `the first: ${dbLines[0].slice(0, 160)}`
        );
    }
    return 0;
}

module.exports = {
    slugify,
    parseSections,
    findWhatsNewSection,
    findUpgradeSection,
    databaseUpgradeLines,
    absolutizeLinks,
    buildNotes,
};

if (require.main === module) {
    process.exitCode = main(process.argv.slice(2));
}
