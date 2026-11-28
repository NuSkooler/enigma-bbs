# Releasing ENiGMA½

The maintainer's runbook for cutting a release. What a version number promises, and which changes need a minor rather than a patch release, is in [Versioning & Releases](https://enigma-bbs.github.io/contributing/versioning/).

A pushed tag `vX.Y.Z` (or `vX.Y.Z-rc.N`) runs [`.github/workflows/release.yml`](.github/workflows/release.yml), which checks the tag against `package.json`, runs lint and the tests, and creates a **draft** GitHub release with the source archives, `SHA256SUMS`, build provenance and notes taken from `WHATSNEW.md`. Nothing is public until the draft is published by hand.

## 1. Release pull request

On a branch from `master`:

1. Set the version (updates `package.json` and `package-lock.json`, makes no commit or tag):
   ```sh
   npm version X.Y.Z --no-git-tag-version
   ```
2. In `WHATSNEW.md`, rename `## Unreleased` to `## X.Y.Z (YYYY-MM-DD)` and delete its italic blurb. In `UPGRADE.md`, rename `## Unreleased` to `## A.B.C to X.Y.Z (YYYY-MM-DD)`, A.B.C being the previous release, and delete its blurb. Leave new, empty `## Unreleased` sections above them, with their blurbs, for the next release.
3. If any change upgrades a database, the `UPGRADE.md` section has to say so ("the `message` table is rebuilt", "an index is added to `db/activitypub.sqlite3`"): the release notes then open with a warning to back up.
4. Before merging, try it: **Actions > Release > Run workflow** on the branch is a dry run. It runs the build job, and you can download the archives and `notes.md` from the run's artifact, but it never creates a release. It fails, as a tag would, if `WHATSNEW.md` has no section for the version.

Merge it.

## 2. Tag

On the merge commit:

```sh
git fetch origin
git checkout origin/master        # the release PR's merge commit
git tag -s vX.Y.Z -m "ENiGMA½ X.Y.Z"
git push origin vX.Y.Z
```

The tag must equal `v` + the `package.json` version, or the workflow fails. A release candidate is `vX.Y.Z-rc.N` with `X.Y.Z-rc.N` in `package.json`; its notes come from a `## X.Y.Z-rc.N` section if there is one, else `## X.Y.Z`, and it is marked as a pre-release.

## 3. Watch the workflow

**Actions > Release** for the tag: `build`, then `attest`, then `publish`. If `build` fails, fix it on `master` with a pull request, delete the tag (`git push --delete origin vX.Y.Z`, `git tag -d vX.Y.Z`) and tag the new merge commit. If a draft was already created for the tag, delete it first: `publish` will not replace it.

## 4. Verify the draft

From the draft release (`gh release download vX.Y.Z` works on drafts):

- `sha256sum -c SHA256SUMS`
- `gh attestation verify enigma-bbs-X.Y.Z.tar.gz --repo NuSkooler/enigma-bbs`, and the same for the `.zip`.
- The archive holds what a board needs and nothing it does not (`tar -tzf`). What is left out is `export-ignore` in `.gitattributes`.
- A fresh install of the release: `ENIGMA_VERSION=X.Y.Z` with `misc/install.sh`.
- An upgrade from the previous release: check out the previous tag, start it with a copy of a real board's `config/` and `db/`, then check out `vX.Y.Z`, `npm ci`, and start again. Watch the log for database upgrades.
- Docker: `docker pull enigmabbs/enigma-bbs:X.Y.Z` once the image for the tag is published, and start it.
- Read the notes as rendered: links, the upgrade notes link, and the database warning if there should be one.

## 5. Publish

Edit the draft and publish it. For a patch to an older line (a backport, below), untick **Set as the latest release** if a higher version is out.

## Patch releases and backports

A patch release is normally cut from `master` like any other. When `master` already holds changes meant for the next minor release, release the fix from a `release/X.Y` branch instead:

```sh
git checkout -b release/X.Y vX.Y.Z            # the last tag of that line, if the branch does not exist yet
git cherry-pick -x <commit>                   # the fix, already merged on master
npm version X.Y.W --no-git-tag-version        # the next patch; WHATSNEW / UPGRADE as in step 1
```

Push `release/X.Y`, open the release pull request against it, merge, and tag the merge commit on `release/X.Y` as in step 2. The fix stays recorded on `master` too: its `WHATSNEW.md` entry moves under the patch version there as well.
