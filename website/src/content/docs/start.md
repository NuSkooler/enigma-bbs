---
title: Start Here
description: "A map of the ENiGMA½ documentation — install a board, configure it, fill it with content, and keep it running."
sidebar:
    order: 0
---
ENiGMA½ is a modern BBS package written in Node.js: Telnet, SSH and WebSocket
logins in one process, FidoNet mail without an external mailer, an indexed file
base, and DOS doors that run without an emulator on the host.

These docs cover running a board and customising it. Pick the row that matches
where you are.

| If you are… | Start at |
|-------------|----------|
| **Setting up a board for the first time** | [Installation Methods](installation/installation-methods.md) |
| **Just installed, wondering what next** | [Testing Your Installation](installation/testing.md) |
| **Configuring a board you already installed** | [System Configuration](configuration/config-hjson.md) |
| **Making it look like your board** | [General Art Information](art/general.md) and [Themes](art/themes.md) |
| **Running one day to day** | [Administration](admin/administration.md) and [oputil](admin/oputil.md) |
| **Working on ENiGMA½ itself** | [Contributing](contributing/index.md) |

## The Path Through a New System

Roughly the order things happen in:

1. **[Install](installation/installation-methods.md)** — the install script, Docker,
   manually, or on [Windows](installation/windows.md). Then
   [test it](installation/testing.md) and log in; the first account to log in
   becomes the SysOp.
2. **[Configure](configuration/config-hjson.md)** — `config.hjson` holds your board
   name, servers and areas. It is [HJSON](configuration/hjson.md), which is JSON
   that forgives you.
3. **[Open the doors](servers/index.md)** — decide which of Telnet, SSH and
   WebSocket users reach you on, and whether you also expose the board over
   [Gopher](servers/contentservers/gopher.md), [NNTP](servers/contentservers/nntp.md)
   or the [web](servers/contentservers/web-server.md).
4. **Add content** — [message areas](messageareas/configuring-a-message-area.md)
   and, if you want mail from the wider world,
   [a network](messageareas/message-networks.md). Then a
   [file base](filebase/index.md).
5. **[Make it yours](art/general.md)** — art, [themes](art/themes.md),
   [MCI codes](art/mci.md), and the
   [menus](configuration/menu-hjson.md) that tie them together.
6. **[Keep it running](admin/administration.md)** — backups, logs, and
   [upgrades](admin/upgrading.md).

## Reference

* **[Built-in Modules](modules/index.md)** — the features that ship with ENiGMA½ and the config each takes
* **[Doors](doors/index.md)** — DOS games, interactive fiction, and hosted door services
* **[oputil](admin/oputil.md)** — the command line tool for users, areas and maintenance
* **[Access Condition System](configuration/acs.md)** — how access is gated everywhere in the system
* **[REST API](servers/contentservers/rest-api.md)** — programmatic access to the board

## Stuck?

[Troubleshooting](troubleshooting/monitoring-logs.md) covers reading the logs and
the common [SSH](troubleshooting/ssh-troubleshooting.md) and
[WebSocket](troubleshooting/websocket-troubleshooting.md) failures. Beyond that,
try [Discussions](https://github.com/NuSkooler/enigma-bbs/discussions), the
[issue tracker](https://github.com/NuSkooler/enigma-bbs/issues), or
[Discord](https://discord.gg/M2pbyvuGva).
