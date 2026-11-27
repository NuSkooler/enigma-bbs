---
title: Versioning & Releases
description: "What an ENiGMA½ version number promises, what counts as a breaking change, and how changes reach a release."
sidebar:
    order: 3
---
This page explains what an ENiGMA½ version number tells you, what the project
promises to keep working from one version to the next, and how a change gets
from a pull request into a release. Sysops will mostly want the first three
sections; contributors and mod authors, all of it.

## Releases and Edge

ENiGMA½ is published two ways:

| | Releases | Edge |
|---|---|---|
| **What** | Tagged versions (`v0.7.0`, `v0.7.1`, ...) | `master`, updated with every merged pull request |
| **Install script** | The default (or `ENIGMA_VERSION=0.7.0` for a specific one) | `ENIGMA_VERSION=master` |
| **Git checkout** | `git fetch --tags && git checkout v0.7.0` | `git pull origin master` |
| **Docker** | `:latest`, `:0.7`, `:0.7.0` | `:edge` |
| **Who it is for** | Most boards | Trying new work early, testing, contributors |

`master` is kept working, but it can carry features that are not finished yet
(switched off until they are) and changes that have not been through a release's
checks. Run a release unless you have a reason not to.

## Version Numbers

ENiGMA½ uses [Semantic Versioning](https://semver.org/): `MAJOR.MINOR.PATCH`.

* **Before 1.0 (where we are now)** versions are `0.MINOR.PATCH`. A **minor**
  release (`0.7.0` to `0.8.0`) adds features and may contain breaking changes,
  each one listed in [Upgrade Notes](../admin/upgrade-notes.md) with what to do
  about it. A **patch** release (`0.7.0` to `0.7.1`) only fixes things and never
  needs any action from you.
* **1.0** comes once the sysop and mod contracts below are complete and
  documented. After that, a breaking change to either one means a new major
  version.
* **Release candidates** are named `0.8.0-rc.1` and so on. They are marked as
  pre-releases on GitHub and never become Docker's `:latest`.
* Versions up to `0.6.3-beta` carried a `-beta` suffix as a maturity label.
  From `0.7.0` on there is no suffix.
* A git checkout that is not exactly on a release reports a version such as
  `0.7.0-14-gabc1234`: 14 commits after `0.7.0`, at commit `abc1234`.

## What a Version Covers

### The Sysop Contract

These are what a patch release never changes and a minor release changes only
with an entry in the Upgrade Notes:

* Configuration keys in `config.hjson` and what they do.
* Menu and theme files: their format, menu module names and their `config` keys,
  `@`-specs such as `@systemMethod:` and `@userMod:`.
* MCI codes, view types and their properties.
* ACS syntax and codes.
* The art file names the system looks for, and the order it looks in.
* Pipe colour codes and string format tokens.
* `oputil.js` commands, their arguments, and output that scripts may rely on.
* Database files (see [Databases](#databases)).
* Dropfile formats, and how doors and `@execute:` event actions are started
  (arguments, environment, working directory).
* The minimum Node.js version and the external tools ENiGMA½ needs.
* The Docker image's paths, volumes and environment variables.
* Web routes, the REST API, and how ENiGMA½ behaves on the network (telnet, SSH,
  WebSocket, FTN, NNTP, Gopher, ActivityPub).

### The Mod Contract

Mods are menu modules and event scripts that live under `mods/` and load parts
of ENiGMA½ itself. There is no formal mod API yet. **What belongs in it is
still being reviewed**, and that review may tidy up some of these pieces
before they are promised. Until then the following are kept stable on a
best-effort basis, and changes to them are listed in the Upgrade Notes:

* The menu module lifecycle and `moduleInfo` (see [Menu Modules](../modding/menu-modules.md)).
* How `@userMod:` finds a mod, and mod art lookup.
* System events, user properties and system statistics keys.
* Module functions that the [modding documentation](../modding/menu-modules.md)
  describes.

Everything else under `core/` is internal and can change in any minor release.
If your mod depends on something internal, check for it when the mod loads
(that the function exists, for example) rather than checking the version
number, and tell us what you needed: that is how things get into the mod
contract.

### Not Covered

* Internal code under `core/` that is not part of the contracts above.
* Log message wording, and the exact layout of stock screens and art.
* Developer tooling (`dev_util/`, test helpers, the docs site).
* Anything documented as experimental.

## When the Version Changes

| Release | Contains |
|---|---|
| **Minor** (`0.7.0` to `0.8.0`) | New features; new configuration keys, menus or MCI codes; any database upgrade; a higher minimum Node.js version or a newly required external tool; deprecations; any change that needs action from sysops (an **Action:** entry in the Upgrade Notes); any breaking change to the contracts above. |
| **Patch** (`0.7.0` to `0.7.1`) | Bug fixes and security fixes that need no action, upgrade no database, and leave defaults as they were apart from the fix itself. |

When in doubt, it is a minor release. A security fix that changes default
behaviour is a minor release too: minor releases can come as quickly as needed.

## Breaking Changes and Deprecation

* A breaking change needs the maintainer's sign-off, and an Upgrade Notes entry
  that says what changes by itself and what action to take.
* Where possible, things are **deprecated** before they are removed: the old
  key, option or function keeps working, with a warning in the log, for **at
  least one minor release**. Something deprecated in `0.8.0` can be removed in
  `0.9.0` at the earliest. Deprecations are listed in the
  [Release Notes](../admin/release-notes.md) and Upgrade Notes.
* A security fix can change behaviour straight away when the old behaviour is
  the problem. It is still documented, and where it is safe the old behaviour
  stays available as an option.

## Databases

ENiGMA½ upgrades its databases automatically when it starts. Upgrades only go
forward: an older version cannot read a database a newer one has upgraded. So:

* **Back up before every upgrade.** See
  [Backing Up Your System](../admin/administration.md#backing-up-your-system).
* To go back to an older version after an upgrade, restore the backup.
* The Upgrade Notes say when a release upgrades a database.

## Node.js and Other Requirements

The minimum Node.js version is in `package.json` (`engines`). It is raised only
in a minor release, usually when a Node.js LTS line reaches end of life, and the
Upgrade Notes say so ahead of time where possible. The same goes for newly
required external tools.

## How Changes Reach a Release

For contributors:

* **All work reaches `master` through pull requests**, one concern per pull
  request.
* **`master` stays working.** Lint and tests pass after every merge, and nothing
  is left half migrated.
* **Larger features land in pieces, switched off.** A feature that takes several
  pull requests stays out of the default menus and templates, or off by default,
  until the last piece is in. Then a pull request switches it on.
* **Changes that cannot be made safely in pieces**, such as a format change that
  would leave `master` broken between steps, use a feature branch. The pieces are
  merged into that branch, and the branch is merged into `master` once.
* **Record user-visible changes** in `WHATSNEW.md` under `## Unreleased`, and
  anything that needs action or breaks something in `UPGRADE.md` under
  `## Unreleased`.
* **Leave the version alone.** `package.json` is changed only when a release is
  cut.

Work planned for a release is gathered in a GitHub milestone named after it
(`0.8.0`). A release is cut when its milestone is done; there is no fixed
schedule. Patch releases go out whenever a fix is worth shipping.

## Cutting a Release

For maintainers, in short:

1. A release pull request sets the version in `package.json` and
   `package-lock.json`, and turns the `## Unreleased` sections of `WHATSNEW.md`
   and `UPGRADE.md` into the new version with its date.
2. Once it is merged, the merge commit is tagged `vX.Y.Z` and the tag is pushed.
3. The release workflow builds the archives, checksums and Docker images and
   creates a draft GitHub release with the notes from `WHATSNEW.md`.
4. After a fresh install and an upgrade from the previous release have been
   checked, the draft is published.

### Patch Releases and Backports

A patch release is normally cut from `master` like any other. When `master`
already holds changes meant for the next minor release, the fix is released from
a `release/X.Y` branch instead: the branch starts at the last `vX.Y.Z` tag, the
fix is cherry-picked onto it, and the patch is tagged there. The fix is recorded
on `master` as well. Docker's `:latest` always points at the highest version,
not the most recently tagged one.
