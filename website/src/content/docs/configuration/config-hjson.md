---
title: System Configuration
description: "How config.hjson overrides system defaults, and the configuration sections available to you."
sidebar:
    order: 2
---
The main system configuration file, `config.hjson` both overrides defaults and provides additional configuration such as message areas. Defaults lived in `core/config_default.js`.

The default path is `/enigma-bbs/config/config.hjson` though this can be overridden using the `--config` parameter when invoking `main.js` (and `oputil.js`). `--config` takes the directory holding `config.hjson`, with a trailing slash: `./main.js --config /srv/bbs/`.

### Relative Paths
Relative file names in `config.hjson`, such as `general.menuFile`, `general.achievementFile` and the [offline mail bulletins](../messageareas/bluewave.md#bulletins), are taken from `paths.config`. Unless you set it, `paths.config` is the directory your `config.hjson` was loaded from, which is also where files listed in [`includes`](config-files.md#includes) are read from. With the stock layout that is `/enigma-bbs/config/`; with `--config /srv/bbs/` it is `/srv/bbs/`, so `menuFile: menu.hjson` reads `/srv/bbs/menu.hjson`.

To take them from somewhere else, set `paths.config` in `config.hjson`:
```hjson
paths: {
    config: /enigma-bbs/config/
}
```

Set it in `config.hjson` itself: like any setting that has a default, `paths.config` in an included file does not replace it.

`oputil.js config new` writes `menuFile` and `achievementFile` as absolute paths into the install's `config/`, so a configuration it creates finds them wherever `config.hjson` is kept. If the achievements file cannot be found, achievements are switched off and the log says `Achievements file not found`, with the path it tried.

:::note
Before 0.6.0-beta, `paths.config` defaulted to the install's `config/` directory even when `--config` named another. See [UPGRADE](https://github.com/NuSkooler/enigma-bbs/blob/master/UPGRADE.md).
:::

:::note
See also [Configuration Files](config-files.md). Additionally [HJSON General Information](hjson.md) may be helpful for more information on the HJSON format.
:::

## Creating a Configuration
Your initial configuration skeleton should be created using the `oputil.js` command line utility. From your enigma-bbs root directory:
```bash
./oputil.js config new
```

You will be asked a series of questions to create an initial configuration, which is
written to `config/config.hjson`. The same run also produces your menu files under
`config/menus/` — see [Menu HJSON](menu-hjson.md).

The last question offers starter menus and a theme for PETSCII (Commodore 64/128)
callers; it defaults to no. See [Starter menus and theme](../servers/loginservers/petscii.md#starter-menus-and-theme).

## Overriding Defaults
The file `core/config_default.js` provides various defaults to the system that you can override via `config.hjson`. For example, the default system name is defined as follows:
```javascript
general : {
  boardName : 'Another Fine ENiGMA½ System'
}
```

To override this for your own board, in `config.hjson`:
```hjson
general: {
  boardName: Super Fancy BBS
}
```

(Note the very slightly [HJSON](hjson.md) different syntax. **You can use standard JSON if you wish!**)

While not everything that is available in your `config.hjson` file can be found defaulted in `core/config_default.js`, a lot is. [Poke around and see what you can find](https://github.com/NuSkooler/enigma-bbs/blob/master/core/config_default.js)!

## Configuration Sections
Below is a list of various configuration sections. There are many more, but this should get you started:

* [Access Condition System (ACS)](acs.md): Gate menus, areas and actions on who the user is.
* [Achievements](achievements.md): Reward users for posting, uploading and calling.
* [Archivers](archivers.md): External archive utilities for ZIP, ARJ, RAR, and so on.
* [Colour Codes](../art/colour-codes.md): Renegade-style pipe codes used throughout your config.
* [Directory Structure](directory-structure.md): What lives where in an installation.
* [Email](email.md): SMTP and IMAP for password resets, 2FA and internet mail.
* [Event Scheduler](event-scheduler.md): Set up events as you see fit!
* [External Support Binaries](external-binaries.md): The tools ENiGMA½ shells out to, and how to install them.
* [File Base](../filebase/index.md): Areas, storage tags, uploads and [TIC](../filebase/tic-support.md).
* [File Transfer Protocols](file-transfer-protocols.md): Oldschool file transfer protocols such as X/Y/Z-Modem!
* [Message Areas](../messageareas/configuring-a-message-area.md), [Networks](../messageareas/message-networks.md), [NetMail](../messageareas/netmail.md), etc.
* [Built-in Modules](../modules/index.md): The modules ENiGMA½ ships with, and how to configure them.
* [Security](security.md): Password storage, 2FA and choosing secure transports.
* [Time Limits](time-limits.md): Daily per-user time budgets, off by default.
* [Servers](../servers/loginservers/telnet.md): [Telnet](../servers/loginservers/telnet.md), [SSH](../servers/loginservers/ssh.md) and [WebSocket](../servers/loginservers/websocket.md) logins; [web](../servers/contentservers/web-server.md), [Gopher](../servers/contentservers/gopher.md) and [NNTP](../servers/contentservers/nntp.md) content.
* ...and a **lot** more! Explore the docs! If you can't find something, please contact us!

