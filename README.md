# ENiGMA½ BBS Software

![alt text](http://i325.photobucket.com/albums/k361/request4spam/enigma.ans_zps05w2ey4s.png "ENiGMA½ BBS")

ENiGMA½ is a modern BBS software with a nostalgic flair!


## Feature Available Now
 * Multi platform: Anywhere Node.js runs likely works (tested under Linux and OS X)
 * Multi node support
 * **Highly** customizable via [HJSON](http://hjson.org/) based configuration, menus, and themes in addition to JavaScript based mods
 * MCI support for lightbars, toggles, input areas, and so on plus many other other bells and whistles
 * Telnet & **SSH** access built in. Additional servers are easy to implement & plug in
 * [CP437](http://www.ascii-codes.com/) and UTF-8 output
 * [SyncTerm](http://syncterm.bbsdev.net/) style font and baud emulation support. Display PC/DOS and Amiga style artwork as it's intended! In general, ANSI-BBS / [cterm.txt](http://cvs.synchro.net/cgi-bin/viewcvs.cgi/*checkout*/src/conio/cterm.txt?content-type=text%2Fplain&revision=HEAD) / [bansi.txt](http://www.bbsdocumentary.com/library/PROGRAMS/GRAPHICS/ANSI/bansi.txt) are followed for expected BBS behavior
 * [SAUCE](http://www.acid.org/info/sauce/sauce.htm) support
 * Pipe codes (ala Renegade)
 * [SQLite](http://sqlite.org/) storage of users and message areas
 * Strong [PBKDF2](https://en.wikipedia.org/wiki/PBKDF2) backed password encryption
 * Door support including common dropfile formats and legacy DOS doors (See [Doors](docs/doors.md))
 * [Bunyan](https://github.com/trentm/node-bunyan) logging
 * FidoNet Type Network (FTN) + BinkleyTerm Style Outbound (BSO) message import/export

## In the Works
* More ES6+ usage, and **documentation**!
* File areas
* More ACS support coverage
* SysOp dashboard (ye ol' WFC)
* Missing functionality such as searching, message area coloring, etc.
* String localization
* A lot more! Feel free to request features via [the issue tracker](https://github.com/NuSkooler/enigma-bbs/issues)

## Known Issues
As of now this is considered **alpha** code! Please **expect bugs** :bug: -- and when you find them, log issues and/or submit pull requests. Feature requests, suggestions, and so on are always welcome! I am also **looking for semi dedicated testers, artists, etc**!

See [the issue tracker](https://github.com/NuSkooler/enigma-bbs/issues) for more information.

## Support
* Use [the issue tracker](https://github.com/NuSkooler/enigma-bbs/issues)
* **Discussion on a ENiGMA BBS!**
* IRC: **#enigma-bbs** on **chat.freenode.net**
* Email: bryan -at- l33t.codes
* Facebook ENiGMA½ group

## Terminal Clients
ENiGMA has been tested with many terminals. However, the following are suggested for BBSing:
* [SyncTERM](http://syncterm.bbsdev.net/)
* [EtherTerm](https://github.com/M-griffin/EtherTerm)
* [NetRunner](http://mysticbbs.com/downloads.html)

## Boards
* WQH: :skull: Xibalba :skull: (**telnet://xibalba.l33t.codes:44510**)
* Support board: &#x2620; BLACK ƒlag &#x2620; (**telnet://blackflag.acid.org:2425**)


## Installation
Please see the [Quickstart](docs/index.md#quickstart)

## Special Thanks
* [M. Brutman](http://www.brutman.com/), author of [mTCP](http://www.brutman.com/mTCP/mTCP.html) (Interwebs for DOS!)
* [M. Griffin](https://github.com/M-griffin), author of [Enthral BBS](https://github.com/M-griffin/Enthral), [Oblivion/2 XRM](https://github.com/M-griffin/Oblivion2-XRM) and [EtherTerm](https://github.com/M-griffin/EtherTerm)!
* [Caphood](http://www.reddit.com/user/Caphood), supreme SysOp of [BLACK ƒlag](http://www.bbsnexus.com/directory/listing/blackflag.html) BBS
* Luciano Ayres of [Blocktronics](http://blocktronics.org/), creator of the "Mystery Skulls" default ENiGMA½ theme!
* Sudndeath for Xibalba ANSI work!
* Jack Phlash for kick ass ENiGMA½ and Xibalba ASCII (Check out [IMPURE60](http://pc.textmod.es/pack/impure60/)!!)
* Avon of [Agency BBS](http://bbs.geek.nz/) and fsxNet

## License
Released under the [BSD 2-clause](https://opensource.org/licenses/BSD-2-Clause) license:

Copyright (c) 2015-2016, Bryan D. Ashby
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

* Redistributions of source code must retain the above copyright notice, this
  list of conditions and the following disclaimer.

* Redistributions in binary form must reproduce the above copyright notice,
  this list of conditions and the following disclaimer in the documentation
  and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
