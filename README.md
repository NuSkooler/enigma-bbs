# ENiGMA½ BBS Software

ENiGMA½ is a modern BBS software with a nostalgic flair!


## Feature Available Now
 * Multiplatform: Anywhere Node.js runs likely works (tested under Linux and OS X)
 * Multi node support
 * **Highly** customizable via [HJSON](http://hjson.org/) based configuration, menus, and theming in addition to JS based mods
 * MCI support for lightbars, toggles, input areas, other bells and whistles you expect with a modern flare
 * Telnet & SSH access built in. Additional servers are easy to build & plug in
 * [CP437](http://www.ascii-codes.com/) and UTF-8 output
 * [SyncTerm](http://syncterm.bbsdev.net/) style font and baud emulation support. Display PC/DOS and Amiga style artwork as it's intended!
 * [SAUCE](http://www.acid.org/info/sauce/sauce.htm) support
 * Renegade style pipe codes
 * [SQLite](http://sqlite.org/) storage of users and message areas
 * Strong [PBKDF2](https://en.wikipedia.org/wiki/PBKDF2) backed password storage
 * Door support including common dropfile formats and [DOSEMU](http://www.dosemu.org/)
 * [Bunyan](https://github.com/trentm/node-bunyan) logging

## In the Works
* Lots of code cleanup, ES6+ usage, and **documentation**!
* FTN import & export
* File areas
* Full access checking framework
* SysOp console
* Missing functionality such as searching, pipe code support in message areas, etc.
* A lot more!

## Known Issues
As of now this is considered **alpha** code! Please **expect bugs** -- and when you find them, log issues and/or submit pull requests. Feature requests, suggestions, and so on are always welcome! I am also looking for semi dedicated testers, artists, etc.

## Boards
* WQH: Xibalba
* Support board: BLACK ƒlag (**telnet://blackflag.acid.org:2425**)


## Installation
1. Clone:
```bash
git clone https://github.com/NuSkooler/enigma-bbs.git
```
2. Create **~/.enigma-bbs/config.hjson**. Example:
```hjson
general: {
  boardName: Super Awesome BBS
}
messages: {
  areas: [
    { name: "local_enigma_discusssion", desc: "ENiGMA Discussion", groups: [ "users" ] }
  ]
}
```
3. Install dependencies:
```bash
npm install
```
4. Launch:
```bash
node main.js
```
(More information will be available in the documentation in the near future)

## Special Thanks
* [M. Brutman](http://www.brutman.com/), author of [mTCP](http://www.brutman.com/mTCP/mTCP.html) (Interwebs for DOS!)
* [M. Griffin](https://github.com/M-griffin), author of [Enthral BBS](https://github.com/M-griffin/Enthral) and [Oblivion/2 XRM](https://github.com/M-griffin/Oblivion2-XRM)
* [Caphood](http://www.reddit.com/user/Caphood), supreme SysOp of [BLACK ƒlag](http://www.bbsnexus.com/directory/listing/blackflag.html) BBS
* Luciano Ayres of [Blocktronics](http://blocktronics.org/)   

## License
Released under the [BSD 2-clause](https://opensource.org/licenses/BSD-2-Clause) license:

Copyright (c) 2015, Bryan D. Ashby
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
