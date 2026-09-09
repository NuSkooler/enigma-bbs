---
title: Built-in Modules
description: "Reference for the modules ENiGMA½ ships with — the config each accepts and the fields available when theming it."
sidebar:
    order: 1
---
Every screen on an ENiGMA½ board is a [menu module](../modding/menu-modules.md).
Most are the standard handler, which needs no code — but a good number of
features ship as purpose-built modules, and each of those accepts its own
`config` block and exposes its own fields for theming.

This section is the reference for the modules ENiGMA½ ships with. You do not need
to write any code to use them: point a `menu.hjson` entry at one, supply its
`config`, and style it from your `theme.hjson`.

:::note
If you are looking to write your own module rather than configure one that ships
with the system, see [Menu Modules](../modding/menu-modules.md).
:::

## Message Base

| Module | What it does |
|--------|--------------|
| [Message Conference & Area Lists](message-lists.md) | Browsing and changing conference and area |
| [Configure Newscan](configure-newscan.md) | Which conferences, areas and file areas a user's newscan covers |
| [Set Newscan Date](set-newscan-date.md) | Resetting a newscan pointer to a chosen date |
| [Auto Signature Editor](autosig-edit.md) | Editing the signature appended to a user's posts |
| [ActivityPub Message Browser](activitypub-msg-browser.md) | Listing Notes received from the Fediverse |
| [ActivityPub Message Viewer](activitypub-msg-viewer.md) | Reading a single Fediverse Note |

## File Base

| Module | What it does |
|--------|--------------|
| [File Area List](file-area-list.md) | Browsing, searching and queueing files |
| [File Base Download Managers](download-managers.md) | The legacy and web download queues |
| [File Transfer Protocol Select](file-transfer-protocol-select.md) | Picking X/Y/ZModem before a transfer |

## Users & Social

| Module | What it does |
|--------|--------------|
| [Who's Online](whos-online.md) | Who is connected right now, and what they are doing |
| [Last Callers](last-callers.md) | Who called recently, with action indicators |
| [User List](user-list.md) | All users on the system |
| [TopX](top-x.md) | Top user statistics for the week, month or all time |
| [Node to Node Messaging](node-msg.md) | Sending a message to a user on another node |
| [Onelinerz](onelinerz.md) | The retro onelinerz wall |
| [Rumorz](rumorz.md) | The classic rumorz board |
| [BBS List](bbs-list.md) | A user-maintained list of other boards |

## SysOp & Account

| Module | What it does |
|--------|--------------|
| [Waiting For Caller (WFC)](wfc.md) | The sysop dashboard — node status, live logs and actions |
| [Sysop Chat](sysop-chat.md) | Two-way split-screen chat with a connected user |
| [Pre-Auth Feedback](pre-auth-feedback.md) | Letting visitors write to the sysop before logging in |
| [2FA/OTP Config](user-2fa-otp-config.md) | Where users opt in to two-factor authentication |

## Display

| Module | What it does |
|--------|--------------|
| [Show Art](show-art.md) | Advanced art display beyond a standard menu's `art` spec |

## Configuring a Module

A module is attached to a menu entry with `module`, and configured through the
`config` block of that entry:

```hjson
lastCallers: {
    art: LASTCALL
    module: last_callers
    config: {
        dateTimeFormat: ddd MMM Do
    }
    form: {
        0: {
            mci: {
                VM1: { height: 14 }
            }
        }
    }
}
```

Each page below documents that module's `config` keys and the `itemFormat`
fields it makes available. See [Menu HJSON](../configuration/menu-hjson.md) for
the surrounding menu entry, [MCI Codes](../art/mci.md) for the format syntax, and
[Themes](../art/themes.md) for where per-menu styling lives.
