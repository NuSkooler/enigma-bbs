---
layout: page
title: Local Doors
---
## Local Doors

ENiGMA½ supports running local BBS door games through several approaches. In addition to the [many built-in door server modules](door-servers.md) (DoorParty, BBSLink, Exodus, etc.), local doors run directly on your server.

:::note
See also [Let's add a DOS door to Enigma½ BBS](https://medium.com/retro-future/lets-add-a-dos-game-to-enigma-1-2-41f257deaa3c) by Robbie Whiting for a great writeup on adding doors!
:::

---

## Choosing an Approach

| Approach | Module | Best For | External Requirements |
|----------|--------|----------|-----------------------|
| **[Native v86 Emulation](local-doors-v86.md)** | `v86_door` | DOS doors, no emulator on server | FreeDOS disk image |
| **[External DOS Emulators](local-doors-dos-emulation.md)** | `abracadabra` | DOS doors, full graphical setup | QEMU or DOSEMU installed |
| **[Scripts & Native Binaries](local-doors-abracadabra.md)** | `abracadabra` | Native terminal apps, shell/Python scripts | None |
| **[Z-Machine Interactive Fiction](local-doors-zmachine.md)** | `zmachine_door` | Zork, Adventure, Photopia, and hundreds of free IF games | None (pure JavaScript) |

### Quick Guide

- **Running a classic DOS door game and want zero server dependencies?** → [Native v86 Emulation](local-doors-v86.md). ENiGMA½ boots FreeDOS in a built-in emulator; no QEMU or DOSEMU required on the production machine.

- **Already have a QEMU or DOSEMU setup, or need a full graphical DOS environment for image configuration?** → [External DOS Emulators](local-doors-dos-emulation.md). Raw disk images are compatible with both approaches, so you can configure with QEMU and run with v86.

- **Running a native terminal application, a shell script, or a Python-based door?** → [Scripts & Native Binaries](local-doors-abracadabra.md). The `abracadabra` module launches any local process that speaks stdio and bridges I/O over stdin/stdout or a TCP socket.

- **Running a Z-Machine interactive fiction game (`.z3`/`.z5`/`.z8`)?** → [Z-Machine Interactive Fiction](local-doors-zmachine.md). Classic Infocom-era text adventures and modern IF competition winners — Zork, Adventure, Photopia, Anchorhead, Lost Pig, etc. — run natively in Node.js with no emulator, no drop file, and cross-platform support.

---

## Drop File Types

All local door approaches in ENiGMA½ support the same drop file types:

| Value | Description |
|-------|-------------|
| `none` | No drop file needed |
| `DOOR` | [DOOR.SYS](https://web.archive.org/web/20160325192739/http://goldfndr.home.mindspring.com/dropfile/doorsys.htm) |
| `DOOR32` | [DOOR32.SYS](https://raw.githubusercontent.com/NuSkooler/ansi-bbs/master/docs/dropfile_formats/door32_sys.txt) |
| `DORINFO` | [DORINFOx.DEF](https://web.archive.org/web/20160321190038/http://goldfndr.home.mindspring.com/dropfile/dorinfo.htm) |

Each of these carries a field naming the connection the door has been handed — `DOOR32.SYS` comm type and socket handle, `DOOR.SYS` comm port, `DORINFO` serial port. ENiGMA½ writes them to match how the door is actually launched, defaulting to local (stdin/stdout). Only [abracadabra](local-doors-abracadabra.md#comm-type) setups where an emulator or bridge sits in between need to say otherwise; [v86](local-doors-v86.md) reports serial on its own, since it bridges the caller to the guest's COM1.

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
