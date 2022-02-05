---
layout: default
title: Home
include-banner: true
---
![ENiGMA½ BBS](assets/images/enigma-bbs.png "ENiGMA½ BBS")

ENiGMA½ is a modern BBS software with a nostalgic flair!


## Features Available Now
 * Multi platform: Anywhere [Node.js](https://nodejs.org/) runs likely works (known to work under Linux, FreeBSD, OpenBSD, OS X and Windows)
 * Unlimited multi node support (for all those BBS "callers"!)
 * **Highly** customizable via [HJSON](http://hjson.org/) based configuration, menus, and themes in addition to JavaScript based [mods](_docs/modding/existing-mods.md)
 * [MCI support](_docs/art/mci.md) for lightbars, toggles, input areas, and so on plus many other other bells and whistles
 * Telnet, **SSH**, and both secure and non-secure [WebSocket](https://en.wikipedia.org/wiki/WebSocket) access built in! Additional servers are easy to implement
 * [CP437](http://www.ascii-codes.com/) and UTF-8 output
 * [SyncTERM](http://syncterm.bbsdev.net/) style font and baud emulation support. Display PC/DOS and Amiga style artwork as it's intended! In general, ANSI-BBS / [cterm.txt](http://cvs.synchro.net/cgi-bin/viewcvs.cgi/*checkout*/src/conio/cterm.txt?content-type=text%2Fplain&revision=HEAD) / [bansi.txt](http://www.bbsdocumentary.com/library/PROGRAMS/GRAPHICS/ANSI/bansi.txt) are followed for expected BBS behavior.
 * Full [SAUCE](http://www.acid.org/info/sauce/sauce.htm) support.
 * Renegade style [pipe color codes](_docs/configuration/colour-codes.md).
 * [SQLite](http://sqlite.org/) storage of users, message areas, etc.
 * Strong [PBKDF2](https://en.wikipedia.org/wiki/PBKDF2) backed password encryption.
 * Support for 2-Factor Authentication with One-Time-Passwords
 * [Door support](_docs/modding/door-servers.md) including common dropfile formats for legacy DOS doors. Built in [BBSLink](http://bbslink.net/), [DoorParty](http://forums.throwbackbbs.com/), [Exodus](https://oddnetwork.org/exodus/) and [CombatNet](http://combatnet.us/) support!
 * [Bunyan](https://github.com/trentm/node-bunyan) logging!
 * [Message networks](_docs/messageareas/message-networks.md) with FidoNet Type Network (FTN) + BinkleyTerm Style Outbound (BSO) message import/export. Messages Bases can also be exposed via [Gopher](_docs/servers/contentservers/gopher.md), or [NNTP](_docs/servers/contentservers/nntp.md)!
 * [Gazelle](https://github.com/WhatCD/Gazelle) inspired File Bases including fast fully indexed full text search (FTS), #tags, and HTTP(S) temporary download URLs using a built in [web server](_docs/servers/contentservers/web-server.md). Legacy X/Y/Z modem also supported!
 * Upload processor supporting [FILE_ID.DIZ](https://en.wikipedia.org/wiki/FILE_ID.DIZ) and [NFO](https://en.wikipedia.org/wiki/.nfo) extraction, year estimation, and more!
 * ANSI support in the Full Screen Editor (FSE), file descriptions, etc.
 * A built in achievement system. BBSing gamified!

