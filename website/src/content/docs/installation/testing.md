---
title: Testing Your Installation
description: "Start your board for the first time, connect to it, and confirm the install worked."
sidebar:
    order: 7
---
Once you've completed your chosen installation method, it's time to test!

_Note that if you've used the [Docker](docker.md) installation method, you've already done this._

```bash
./main.js
```

If everything went OK:

```text
ENiGMA½ Copyright (c) 2014-2026, Bryan Ashby                     ______
_____________________   _____  ____________________    __________\_   /
\__   ____/\_ ____   \ /____/ /   _____ __         \  /   ______/ // /___jp!
 //   __|___//   |    \//   |//   |    \//  |  |    \//        \ /___   /_____
/____       _____|      __________       ___|__|      ____|     \   /  _____  \
---- \______\ -- |______\ ------ /______/ ---- |______\ - |______\ /__/ // ___/
                                                                       /__   _\
 <*>   ENiGMA½  // HTTPS://GITHUB.COM/NUSKOOLER/ENIGMA-BBS   <*>         /__/

-------------------------------------------------------------------------------

System started!
```
Grab your favourite telnet client, connect to localhost:8888 and test out your installation.

To shut down the server, press Ctrl-C.

## Points of Interest

* The default port for Telnet is 8888 and 8889 for SSH.
  * Note that on *nix systems port such as telnet/23 are privileged (e.g. require root). See
  [this Stack Overflow article](https://stackoverflow.com/questions/16573668/best-practices-when-running-node-js-with-port-80-ubuntu-linode) for some tips on using these ports on your system if desired.
* The first user you create when logging in will be automatically be added to the `sysops` group.

## Terminal Clients

ENiGMA½ has been tested with many terminals. Any of the following will connect
happily; the first three are the usual recommendations for day-to-day BBSing.

| Client | Platforms | Notes |
|--------|-----------|-------|
| [IcyTERM](https://github.com/mkrueger/icy_tools/tree/master/crates/icy_term) | Linux, macOS, Windows | Modern, actively developed, good CP437 and font support |
| [SyncTERM](http://syncterm.bbsdev.net/) | Linux, macOS, Windows | The long-standing reference client; the fonts ENiGMA½ requests are SyncTERM-style |
| [VTX](https://github.com/codewar65/VTX_ClientServer) | Browser | Pairs with the [WebSocket login server](../servers/loginservers/websocket.md). Try [Xibalba over VTX](https://xibalba.vip) |
| [NetRunner](http://mysticbbs.com/downloads.html) | Windows | See [Troubleshooting SSH](../troubleshooting/ssh-troubleshooting.md#errors-with-netrunner) if connecting over SSH |
| [EtherTerm](https://github.com/M-griffin/EtherTerm) | Linux, macOS, Windows | |
| [MagiTerm](https://gitlab.com/magickabbs/MagiTerm) | Windows | |
| [fTelnet](https://www.ftelnet.ca/) | Browser | Telnet only |

## Next Steps

With the board running and a client connected, move on to
[creating your configuration](../configuration/config-hjson.md) — your board
name, servers, message areas and file areas all live there.

If you plan to leave the board running permanently, read
[Production Installation](production.md) before you expose it.
