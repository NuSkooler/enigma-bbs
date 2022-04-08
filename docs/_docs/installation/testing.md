---
layout: page
title: Testing Your Installation
---
Once you've completed your chosen installation method, it's time to test!

_Note that if you've used the [Docker](docker.md) installation method, you've already done this._

```bash
./main.js
```

If everything went OK:

```bash
ENiGMA½ Copyright (c) 2014-2022, Bryan Ashby
_____________________   _____  ____________________    __________\_   /
\__   ____/\_ ____   \ /____/ /   _____ __         \  /   ______/ // /___jp!
//   __|___//   |    \//   |//   |    \//  |  |    \//        \ /___   /_____
/____       _____|      __________       ___|__|      ____|     \   /  _____  \
---- \______\ -- |______\ ------ /______/ ---- |______\ - |______\ /__/ // ___/
                                                                     /__   _\
 <*>   ENiGMA½  // HTTPS://GITHUB.COM/NUSKOOLER/ENIGMA-BBS   <*>       /__/

-------------------------------------------------------------------------------

System started!
```
Grab your favourite telnet client, connect to localhost:8888 and test out your installation.

To shut down the server, press Ctrl-C.

## Points of Interest

* The default port for Telnet is 8888 and 8889 for SSH.
  * Note that on *nix systems port such as telnet/23 are privileged (e.g. require root). See
  [this SO article](http://stackoverflow.com/questions/16573668/best-practices-when-running-node-js-with-port-80-ubuntu-linode) for some tips on using these ports on your system if desired.
* The first user you create when logging in will be automatically be added to the `sysops` group.

## Telnet Software

If you don't have any telnet software, these are compatible with ENiGMA½:

* [SyncTERM](http://syncterm.bbsdev.net/)
* [EtherTerm](https://github.com/M-griffin/EtherTerm)
* [NetRunner](http://mysticbbs.com/downloads.html)
* [MagiTerm](https://magickabbs.com/utils/)
* [VTX](https://github.com/codewar65/VTX_ClientServer) (Browser based)
* [fTelnet](https://www.ftelnet.ca/) (Browser based)
