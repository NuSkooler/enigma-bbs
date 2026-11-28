---
title: Installation Methods
description: "Compare the install script, Docker, a release archive and a git checkout, and pick the version and method that fit your system."
sidebar:
    order: 1
---
There are multiple ways of installing ENiGMA BBS, depending on your level of experience and desire to do things manually versus have it automated for you.

| Method | Runs on | Use it when |
|--------|---------|-------------|
| [Installation Script](install-script.md) | Linux, BSD, macOS | You want the quickest route. Installs Node.js via mise, clones ENiGMA½ at the latest release (or the version you set with `ENIGMA_VERSION`), and walks you through an initial configuration |
| [Docker](docker.md) | Linux, BSD, macOS, Windows | You want easy upgrades and no dependencies on the host. The image tag picks the version |
| [Release Archive](release-archive.md) | Linux, BSD, macOS, Windows | You want a release without git: download, verify, unpack, install |
| [Manual](manual.md) | Linux, BSD, macOS | You would rather install the prerequisites and clone the source yourself, then check out a release tag |
| [Windows](windows.md) | Windows | You are installing natively on Windows — needs Visual Studio Build Tools for the native modules |
| [Raspberry Pi](raspberry-pi.md) | Raspberry Pi OS | Notes specific to the Pi, then the install script |

## Choosing a Version

ENiGMA½ is published as **releases**, tagged `vX.Y.Z` (`v0.7.0`, `v0.7.1`, ...) and listed on [GitHub](https://github.com/NuSkooler/enigma-bbs/releases), and as **`master`**, the edge, which gets every change as soon as it is merged. Run a release unless you want to try new work early. See [Versioning & Releases](https://github.com/NuSkooler/enigma-bbs/blob/master/website/src/content/docs/contributing/versioning.md) for what a version number promises.

| Method | Release | Edge |
|--------|---------|------|
| [Installation Script](install-script.md#choosing-a-version) | The default, or `ENIGMA_VERSION=0.7.0` for a particular one | `ENIGMA_VERSION=master` |
| [Docker](docker.md) | `:latest` (the latest release), or `:0.7` / `:0.7.0` | `:edge` |
| [Release Archive](release-archive.md) | Always a release | — |
| [Git checkout](manual.md#enigma-bbs) (manual, Windows) | `git checkout v0.7.0` after cloning | Stay on `master` |

The [Upgrading](../admin/upgrading.md) page covers moving between versions later, for each method.

## After Installing

Whichever route you take, the next step is the same: [test your installation](testing.md),
then [create your configuration](../configuration/config-hjson.md).

If the board is going to stay up, read [Production Installation](production.md) and,
if you are hosting from home, [Network Setup](network.md).

## Community HOWTO's
:::note
Check out [this awesome video on installation and basic configuration](https://youtu.be/WnN-ucVi3ZU) from Al's Geek Lab!
:::

## Keeping Up To Date
After installing, you'll want to [keep your system updated](../admin/upgrading.md) and
get familiar with [running the board day to day](../admin/administration.md).

:::note
Looking to work on ENiGMA½ itself rather than run a board? See
[Development Environment Setup](../contributing/development.md).
:::