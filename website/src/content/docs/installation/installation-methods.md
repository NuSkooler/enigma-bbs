---
title: Installation Methods
description: "Compare the install script, Docker and manual installation, and pick the one that fits your system."
sidebar:
    order: 1
---
There are multiple ways of installing ENiGMA BBS, depending on your level of experience and desire to do things manually versus have it automated for you.

| Method | Runs on | Use it when |
|--------|---------|-------------|
| [Installation Script](install-script.md) | Linux, BSD, macOS | You want the quickest route. Installs Node.js via mise, clones ENiGMA½, and walks you through an initial configuration |
| [Docker](docker.md) | Linux, BSD, macOS, Windows | You want easy upgrades and no dependencies on the host |
| [Manual](manual.md) | Linux, BSD, macOS | You would rather install the prerequisites and clone the source yourself |
| [Windows](windows.md) | Windows | You are installing natively on Windows — needs Visual Studio Build Tools for the native modules |
| [Raspberry Pi](raspberry-pi.md) | Raspberry Pi OS | Notes specific to the Pi, then the install script |

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