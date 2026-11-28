'use strict';

const { strict: assert } = require('assert');
const fs = require('fs');
const path = require('path');

const {
    slugify,
    parseSections,
    findWhatsNewSection,
    findUpgradeSection,
    databaseUpgradeLines,
    absolutizeLinks,
    buildNotes,
} = require('../.github/scripts/release-notes.js');

//
//  The release notes the release workflow (.github/workflows/release.yml)
//  builds from WHATSNEW.md and UPGRADE.md. Synthetic documents in the layout
//  the real ones use, plus the real ones themselves.
//

const ROOT = path.join(__dirname, '..');
const readRoot = name => fs.readFileSync(path.join(ROOT, name), 'utf8');

const WHATSNEW = `# Whats New
This document attempts to track **major** changes and additions in ENiGMA½.

## Unreleased

_Merged since the last release: on \`master\` now, and in the next release._

* **Not yet.** Still on master.

## 0.7.0-rc.1

* **Candidate.** Only in the candidate.

## 0.7.0 (2026-12-01)

* **Feature one.** See [UPGRADE](UPGRADE.md) and [the docs](./website/src/content/docs/admin/upgrading.md#before).
  * A sub bullet, with an [issue](https://github.com/NuSkooler/enigma-bbs/issues/1) and [an anchor](#up).

\`\`\`
## 0.6.9 inside a code block is not a heading
\`\`\`

* **Feature two.**

## 0.6.3-beta

* **Old.**

## 0.6.2

## 0.6.1
`;

const UPGRADE = `# Introduction
Upgrade notes.

# Version to Version Notes

## Unreleased

_Notes for changes merged since the last release._

## 0.6.3-beta to 0.7.0 (2026-12-01)

* **The message table is rebuilt once, at the first start.** Back up first.

## 0.6.2-beta to 0.6.3-beta

* **Nothing to do.** No action.
`;

describe('release notes', function () {
    describe('slugify', function () {
        it('matches the anchors GitHub and the docs site give UPGRADE headings', function () {
            assert.equal(slugify('0.6.2-beta to 0.6.3-beta'), '062-beta-to-063-beta');
            assert.equal(
                slugify('0.6.3-beta to 0.7.0 (2026-12-01)'),
                '063-beta-to-070-2026-12-01'
            );
            assert.equal(slugify('Unreleased'), 'unreleased');
        });
    });

    describe('parseSections', function () {
        it('ends a section at the next level 1 or 2 heading, not inside a fence', function () {
            const s = parseSections(WHATSNEW);
            assert.deepEqual(
                s.map(x => x.title),
                [
                    'Unreleased',
                    '0.7.0-rc.1',
                    '0.7.0 (2026-12-01)',
                    '0.6.3-beta',
                    '0.6.2',
                    '0.6.1',
                ]
            );
            assert.match(s[2].body, /^\* \*\*Feature one/);
            assert.match(s[2].body, /## 0\.6\.9 inside a code block/);
            assert.match(s[2].body, /Feature two\.\*\*$/);
        });

        it('leaves out what comes before the first section and under a level 1 heading', function () {
            const s = parseSections(UPGRADE);
            assert.deepEqual(
                s.map(x => x.title),
                [
                    'Unreleased',
                    '0.6.3-beta to 0.7.0 (2026-12-01)',
                    '0.6.2-beta to 0.6.3-beta',
                ]
            );
        });
    });

    describe('finding the version', function () {
        const wn = parseSections(WHATSNEW);
        const up = parseSections(UPGRADE);

        it('finds `## X.Y.Z` with or without a date', function () {
            assert.equal(findWhatsNewSection(wn, '0.7.0').title, '0.7.0 (2026-12-01)');
            assert.equal(findWhatsNewSection(wn, '0.6.3-beta').title, '0.6.3-beta');
            assert.equal(findWhatsNewSection(wn, '0.6.2').title, '0.6.2');
        });

        it('does not take a prerelease or a longer version for the version', function () {
            assert.equal(findWhatsNewSection(wn, '0.6.3'), null);
            assert.equal(findWhatsNewSection(wn, '0.7'), null);
            assert.equal(findWhatsNewSection(wn, '0.6.1-rc.1').title, '0.6.1');
        });

        it('a prerelease uses its own section, else the one of its version', function () {
            assert.equal(findWhatsNewSection(wn, '0.7.0-rc.1').title, '0.7.0-rc.1');
            assert.equal(
                findWhatsNewSection(wn, '0.7.0-rc.2').title,
                '0.7.0 (2026-12-01)'
            );
            assert.equal(
                findUpgradeSection(up, '0.7.0-rc.2').title,
                '0.6.3-beta to 0.7.0 (2026-12-01)'
            );
        });

        it('finds the UPGRADE section ending in the version', function () {
            assert.equal(
                findUpgradeSection(up, '0.7.0').title,
                '0.6.3-beta to 0.7.0 (2026-12-01)'
            );
            assert.equal(
                findUpgradeSection(up, '0.6.3-beta').title,
                '0.6.2-beta to 0.6.3-beta'
            );
            //  the version it upgrades from is not the version
            assert.equal(findUpgradeSection(up, '0.6.2-beta'), null);
        });
    });

    describe('databaseUpgradeLines', function () {
        it('finds the wording the Upgrade Notes have used for one', function () {
            for (const line of [
                '* **The message table is rebuilt once, at the first start.**',
                'At the first start two indexes are added to `db/activitypub.sqlite3`, which can take a moment.',
                'Existing `file.db` databases will need to be updated **manually**.',
                '### Manual Database Upgrade',
                'The `system.db` `user_event_log` table has been updated to include a session ID.',
            ]) {
                assert.equal(databaseUpgradeLines(line).length, 1, line);
            }
        });

        it('passes over a database mentioned for something else', function () {
            for (const line of [
                'A flow file naming a file in the database or log directories is no longer sent at all. It is still upgraded.',
                'Four built-in events appear (`optimizeDatabases`, `backupDatabases`).',
                '%TV TableView rows are added as they arrive.',
                'Nothing in your configuration needs to change.',
            ]) {
                assert.deepEqual(databaseUpgradeLines(line), [], line);
            }
        });
    });

    describe('absolutizeLinks', function () {
        it('points repository links at the tag and leaves the rest', function () {
            const out = absolutizeLinks(
                'See [U](UPGRADE.md), [W](./website/a.md#b), [I](https://x.y/1), [A](#a), [M](mailto:a@b)',
                { repo: 'o/r', tag: 'v1.2.3' }
            );
            assert.equal(
                out,
                'See [U](https://github.com/o/r/blob/v1.2.3/UPGRADE.md), ' +
                    '[W](https://github.com/o/r/blob/v1.2.3/website/a.md#b), ' +
                    '[I](https://x.y/1), [A](#a), [M](mailto:a@b)'
            );
        });
    });

    describe('buildNotes', function () {
        it('builds the notes for a release (pinned)', function () {
            const r = buildNotes({
                version: '0.7.0',
                whatsnew: WHATSNEW,
                upgrade: UPGRADE,
            });
            assert.deepEqual(r.warnings, []);
            assert.equal(
                r.notes,
                [
                    '> **This release upgrades a database.** ENiGMA½ upgrades it when it first starts, and an older version cannot read it afterwards. **Back up before upgrading**, and read the upgrade notes below.',
                    '',
                    '* **Feature one.** See [UPGRADE](https://github.com/NuSkooler/enigma-bbs/blob/v0.7.0/UPGRADE.md) and [the docs](https://github.com/NuSkooler/enigma-bbs/blob/v0.7.0/website/src/content/docs/admin/upgrading.md#before).',
                    '  * A sub bullet, with an [issue](https://github.com/NuSkooler/enigma-bbs/issues/1) and [an anchor](#up).',
                    '',
                    '```',
                    '## 0.6.9 inside a code block is not a heading',
                    '```',
                    '',
                    '* **Feature two.**',
                    '',
                    '---',
                    '',
                    '**Before upgrading**, read the [upgrade notes for 0.6.3-beta to 0.7.0 (2026-12-01)](https://github.com/NuSkooler/enigma-bbs/blob/v0.7.0/UPGRADE.md#063-beta-to-070-2026-12-01) (also on the [docs site](https://enigma-bbs.github.io/admin/upgrade-notes/#063-beta-to-070-2026-12-01)). [Upgrading](https://enigma-bbs.github.io/admin/upgrading/) covers how.',
                    '',
                    '**Verifying the download:** `sha256sum -c SHA256SUMS`, and `gh attestation verify enigma-bbs-0.7.0.tar.gz --repo NuSkooler/enigma-bbs` (the same for the `.zip`).',
                    '',
                ].join('\n')
            );
        });

        it('has no database line when the upgrade notes do not say so', function () {
            const r = buildNotes({
                version: '0.6.3-beta',
                whatsnew: WHATSNEW,
                upgrade: UPGRADE,
            });
            assert.match(r.notes, /^\* \*\*Old\.\*\*\n/);
            assert.doesNotMatch(r.notes, /upgrades a database/);
            assert.match(r.notes, /UPGRADE\.md#062-beta-to-063-beta\)/);
        });

        it('fails when the WHATSNEW section is missing', function () {
            assert.throws(
                () =>
                    buildNotes({
                        version: '0.8.0',
                        whatsnew: WHATSNEW,
                        upgrade: UPGRADE,
                    }),
                { code: 'NO_WHATSNEW_SECTION' }
            );
        });

        it('fails when the WHATSNEW section is empty', function () {
            assert.throws(
                () =>
                    buildNotes({
                        version: '0.6.2',
                        whatsnew: WHATSNEW,
                        upgrade: UPGRADE,
                    }),
                { code: 'EMPTY_WHATSNEW_SECTION' }
            );
        });

        it('drops a leftover `## Unreleased` blurb, and fails if that was all', function () {
            const renamed = WHATSNEW.replace('## Unreleased', '## 0.8.0');
            const r = buildNotes({
                version: '0.8.0',
                whatsnew: renamed,
                upgrade: UPGRADE,
            });
            assert.match(r.notes, /^\* \*\*Not yet\.\*\*/);
            assert.equal(r.warnings.length, 2); //  the blurb, and no UPGRADE section

            const blurbOnly = renamed.replace('* **Not yet.** Still on master.\n', '');
            assert.throws(
                () =>
                    buildNotes({
                        version: '0.8.0',
                        whatsnew: blurbOnly,
                        upgrade: UPGRADE,
                    }),
                { code: 'EMPTY_WHATSNEW_SECTION' }
            );
        });

        it('links to the upgrade notes as a whole, with a warning, when UPGRADE has no section', function () {
            const r = buildNotes({
                version: '0.6.1',
                whatsnew: WHATSNEW + '\n* x\n',
                upgrade: UPGRADE,
            });
            assert.equal(r.upgradeTitle, null);
            assert.equal(r.warnings.length, 1);
            assert.match(
                r.notes,
                /\[upgrade notes\]\(https:\/\/enigma-bbs\.github\.io\/admin\/upgrade-notes\/\)/
            );
        });

        it('uses the repository it is given in its links', function () {
            const r = buildNotes({
                version: '0.6.3-beta',
                whatsnew: WHATSNEW,
                upgrade: UPGRADE,
                repo: 'me/fork',
            });
            assert.match(
                r.notes,
                /github\.com\/me\/fork\/blob\/v0\.6\.3-beta\/UPGRADE\.md/
            );
            assert.match(r.notes, /--repo me\/fork/);
        });
    });

    describe('the real WHATSNEW.md and UPGRADE.md', function () {
        const whatsnew = readRoot('WHATSNEW.md');
        const upgrade = readRoot('UPGRADE.md');

        it('build the notes for 0.6.3-beta', function () {
            const r = buildNotes({ version: '0.6.3-beta', whatsnew, upgrade });
            assert.equal(r.whatsNewTitle, '0.6.3-beta');
            assert.equal(r.upgradeTitle, '0.6.2-beta to 0.6.3-beta');
            assert.deepEqual(r.warnings, []);
            assert.match(r.notes, /^\* \*\*SSH logins refused/);
            //  ends before 0.6.2-beta's first entry
            assert.doesNotMatch(r.notes, /narrower than 20 columns/);
        });

        it('flag 0.6.0-beta as upgrading a database (the message table rebuild)', function () {
            const r = buildNotes({ version: '0.6.0-beta', whatsnew, upgrade });
            assert.match(r.notes, /^> \*\*This release upgrades a database/);
        });

        it('build the notes once a release PR has renamed `## Unreleased`', function () {
            //  As the release PR does, with an entry in case Unreleased is
            //  empty when this runs.
            const wn = whatsnew.replace(
                /^## Unreleased\n(?:\n_[^\n]*_\n)?/m,
                '## 9.9.9 (2026-12-01)\n\n* **A synthetic entry.**\n'
            );
            const up = upgrade.replace(
                /^## Unreleased\n(?:\n_[^\n]*_\n)?/m,
                '## 0.6.3-beta to 9.9.9\n'
            );
            const r = buildNotes({ version: '9.9.9', whatsnew: wn, upgrade: up });
            assert.equal(r.whatsNewTitle, '9.9.9 (2026-12-01)');
            assert.equal(r.upgradeTitle, '0.6.3-beta to 9.9.9');
            assert.deepEqual(r.warnings, []);
            assert.match(r.notes, /^\* \*\*A synthetic entry\.\*\*/);
            assert.match(r.notes, /UPGRADE\.md#063-beta-to-999\)/);
        });
    });
});
