# About ENiGMA½

## High Level Feature Overview
 * Multi platform: Anywhere [Node.js](https://nodejs.org/) runs likely works (known to work under Linux, FreeBSD, OpenBSD, OS X and Windows)
 * Unlimited multi node support (for all those BBS "callers"!)
 * **Highly** customizable via [HJSON](http://hjson.org/) based configuration, menus, and themes in addition to JavaScript based mods
 * MCI support for lightbars, toggles, input areas, and so on plus many other other bells and whistles
 * Telnet & **SSH** access built in. Additional servers are easy to implement
 * [CP437](http://www.ascii-codes.com/) and UTF-8 output
 * [SyncTerm](http://syncterm.bbsdev.net/) style font and baud emulation support. Display PC/DOS and Amiga style artwork as it's intended! In general, ANSI-BBS / [cterm.txt](http://cvs.synchro.net/cgi-bin/viewcvs.cgi/*checkout*/src/conio/cterm.txt?content-type=text%2Fplain&revision=HEAD) / [bansi.txt](http://www.bbsdocumentary.com/library/PROGRAMS/GRAPHICS/ANSI/bansi.txt) are followed for expected BBS behavior
 * [SAUCE](http://www.acid.org/info/sauce/sauce.htm) support
 * Renegade style pipe color codes
 * [SQLite](http://sqlite.org/) storage of users, message areas, and so on
 * Strong [PBKDF2](https://en.wikipedia.org/wiki/PBKDF2) backed password encryption
 * [Door support](doors.md) including common dropfile formats for legacy DOS doors. Built in [BBSLink](http://bbslink.net/), and [DoorParty](http://forums.throwbackbbs.com/) support!
 * [Bunyan](https://github.com/trentm/node-bunyan) logging
 * [Message networks](msg_networks.md) with FidoNet Type Network (FTN) + BinkleyTerm Style Outbound (BSO) message import/export
 * [Gazelle](https://github.com/WhatCD/Gazelle) inspirted File Bases including fast fully indexed full text search (FTS), #tags, and HTTP(S) temporary download URLs using a built in [web server](web_server.md). Legacy X/Y/Z modem also supported!
 * Upload processor supporting [FILE_ID.DIZ](https://en.wikipedia.org/wiki/FILE_ID.DIZ) and [NFO](https://en.wikipedia.org/wiki/.nfo) extraction, year estimation, and more!