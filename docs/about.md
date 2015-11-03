# About ENiGMA½

## High Level Feature Overview
* Multi platform: Anywhere Node.js runs likely works (tested under Linux and OS X)
* Multi node support
* **Highly** customizable via [HJSON](http://hjson.org/) based configuration, menus, and themes in addition to JS based mods
* MCI support for lightbars, toggles, input areas, and so on plus many other other bells and whistles
* Telnet & SSH access built in. Additional servers are easy to implement & plug in
* [CP437](http://www.ascii-codes.com/) and UTF-8 output
* [SyncTerm](http://syncterm.bbsdev.net/) style font and baud emulation support. Display PC/DOS and Amiga style artwork as it's intended! In general, ANSI-BBS / [cterm.txt](http://cvs.synchro.net/cgi-bin/viewcvs.cgi/*checkout*/src/conio/cterm.txt?content-type=text%2Fplain&revision=HEAD) / [bansi.txt](http://www.bbsdocumentary.com/library/PROGRAMS/GRAPHICS/ANSI/bansi.txt) are followed for expected BBS behavior.
* [SAUCE](http://www.acid.org/info/sauce/sauce.htm) support
* Renegade style pipe codes
* [SQLite](http://sqlite.org/) storage of users and message areas
* Strong [PBKDF2](https://en.wikipedia.org/wiki/PBKDF2) backed password storage
* Door support including common dropfile formats and [DOSEMU](http://www.dosemu.org/)
* [Bunyan](https://github.com/trentm/node-bunyan) logging