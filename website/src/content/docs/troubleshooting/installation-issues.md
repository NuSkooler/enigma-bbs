---
title: Installation & Upgrade Issues
description: "Native module compile failures, and the menu and theme entries an upgrade can leave behind."
sidebar:
    order: 0
---
## Native Module Compile Errors

Several of ENiGMA½'s dependencies include C bindings — `sqlite3` and `node-pty`
among them — and need compiling when a prebuilt binary is not published for your
system and architecture. Older Linux distributions and some ARM devices hit this
routinely.

If `npm install` fails with compiler errors, rebuild the offending package from
source explicitly:

```bash
npm rebuild --build-from-source sqlite3
```

With Yarn:

```bash
env npm_config_build_from_source=true yarn install sqlite3
```

Where the failure is the compiler itself rather than the package, override which
one is used:

```bash
env CC=gcc CXX=gcc npm rebuild --build-from-source node-pty
```

:::tip
On a Raspberry Pi this step is slow enough to look like a hang. It is not — let
it finish. See [Raspberry Pi](../installation/raspberry-pi.md).
:::

On Windows, a compile failure is more often a missing or undetected toolchain.
See [Windows](../installation/windows.md#troubleshooting-node-gyp--visual-studio-not-found).

## Missing Menu & Theme Entries After an Upgrade

New features usually arrive with new `menu.hjson` and `theme.hjson` entries. The
templates ENiGMA½ ships are updated alongside them, but **your** copies are
yours — nothing rewrites them — so a feature can land without the menus to reach
it.

After upgrading, compare your files against the templates in
`misc/menu_templates/` and against the default
`art/themes/luciano_blocktronics/theme.hjson`, and merge in what is missing.
[Upgrading](../admin/upgrading.md#configuration-file-updates) covers this in more
detail, including using a clean checkout as a reference.

:::tip
`./oputil.js config validate` reports unknown keys and type mismatches in
`config.hjson`, which catches a different class of upgrade damage. See
[oputil](../admin/oputil.md).
:::
