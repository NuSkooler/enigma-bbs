---
layout: page
title: Local Doors
---
## Local Doors

ENiGMA½ supports running local BBS door games through several approaches. In addition to the [many built-in door server modules](door-servers.md) (DoorParty, BBSLink, Exodus, etc.), local doors run directly on your server.

> :information_source: See also [Let's add a DOS door to Enigma½ BBS](https://medium.com/retro-future/lets-add-a-dos-game-to-enigma-1-2-41f257deaa3c) by Robbie Whiting for a great writeup on adding doors!

---

## Choosing an Approach

| Approach | Module | Best For | External Requirements |
|----------|--------|----------|-----------------------|
| **[Native v86 Emulation](local-doors-v86.md)** | `v86_door` | DOS doors, no emulator on server | FreeDOS disk image |
| **[External DOS Emulators](local-doors-dos-emulation.md)** | `abracadabra` | DOS doors, full graphical setup | QEMU or DOSEMU installed |
| **[Scripts & Native Binaries](local-doors-abracadabra.md)** | `abracadabra` | Linux-native doors, shell/Python scripts | None |

### Quick Guide

- **Running a classic DOS door game and want zero server dependencies?** → [Native v86 Emulation](local-doors-v86.md). ENiGMA½ boots FreeDOS in a built-in emulator; no QEMU or DOSEMU required on the production machine.

- **Already have a QEMU or DOSEMU setup, or need a full graphical DOS environment for image configuration?** → [External DOS Emulators](local-doors-dos-emulation.md). Raw disk images are compatible with both approaches, so you can configure with QEMU and run with v86.

- **Running a Linux-native binary, a shell script, or a Python-based door?** → [Scripts & Native Binaries](local-doors-abracadabra.md). The `abracadabra` module launches any local process and bridges I/O over stdio or a TCP socket.

---

## Drop File Types

All local door approaches in ENiGMA½ support the same drop file types:

| Value | Description |
|-------|-------------|
| `none` | No drop file needed |
| `DOOR` | [DOOR.SYS](https://web.archive.org/web/20160325192739/http://goldfndr.home.mindspring.com/dropfile/doorsys.htm) |
| `DOOR32` | [DOOR32.SYS](https://raw.githubusercontent.com/NuSkooler/ansi-bbs/master/docs/dropfile_formats/door32_sys.txt) |
| `DORINFO` | [DORINFOx.DEF](https://web.archive.org/web/20160321190038/http://goldfndr.home.mindspring.com/dropfile/dorinfo.htm) |

---

## See Also
* [Door Servers](door-servers.md) — DoorParty, BBSLink, Exodus, and other hosted door services
* [Telnet Bridge](telnet-bridge.md)
* [Scripts & Native Binaries](local-doors-abracadabra.md)
* [External DOS Emulators](local-doors-dos-emulation.md)
* [Native v86 Emulation](local-doors-v86.md)

## Additional Resources
### Door Downloads & Support Sites
#### General
* http://bbsfiles.com/
* http://bbstorrents.bbses.info/

#### L.O.R.D.
* http://lord.lordlegacy.com/
