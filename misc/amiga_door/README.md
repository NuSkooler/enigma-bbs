# Amiga door support: the Amiga side

Amiga BBS doors are not standalone programs. An AmiExpress (/X) "XIM" door is a
client of a running BBS node: it finds the message port `AEDoorPort<node>` and
asks the BBS for everything (user name, time left, a key, a line, "print this").
To run such doors in ENiGMA½, an emulated Amiga boots a small program, the
**host shim** (`axshim`), that impersonates an /X node for the door and relays
everything to ENiGMA over the emulated serial port.

```
caller ── ENiGMA½ ── emulator worker ══ serial (framed protocol) ══ axshim ── AEDoorPort<n> ── door
```

This directory holds the Amiga-side pieces. They are built with a cross
compiler, and the binaries are committed in `bin/`, so sysops need no Amiga
toolchain.

| Path | What |
|---|---|
| `bin/axshim` | the host shim, AmigaOS executable (68000, AROS and Kickstart 3.1) |
| `bin/AEDoor.library` | NilBBS's MIT `AEDoor.library` 3.0, which most doors open |
| `shim/axshim.c` | shim source (BSD-2-Clause) |
| `shim/Makefile`, `shim/build.sh` | build both binaries |
| `aedoor/` | AEDoor.library source from NilBBS with ENiGMA's register-preservation patch, see `aedoor/NOTICE` |
| `image/Startup-Sequence` | template `S:Startup-Sequence` for a door image |
| `image/README.md` | how to build a door disk image |

The host (worker) side is `core/amiga_door/`. `core/amiga_door/protocol.js`
implements the framing; `test/amiga_door_protocol.test.js` covers it.

## The shim

`axshim [baud]` (default 115200) runs from `S:Startup-Sequence` and never returns.
It:

- drives Paula's UART directly (AROS has no `serial.device`; the same code runs on
  Kickstart 3.1), 115200 8N1, with interrupt-driven receive and transmit rings
  and no busy-waiting;
- says `H` (hello) and `R` (ready), then waits for a session (`s`) frame holding
  the user block and the door to run;
- creates `AEDoorPort<node>`, starts `<door> <node> [args]` with `SystemTagList`,
  says `L`, and serves the door's 264-byte `JHMessage`s: text out, keys and lines
  in, the `DT_*` user fields, node and terminal queries, and so on. Terminal
  traffic goes through unframed, with a literal 0x1E doubled;
- honours the host's `t` (time left), `d` (hang-up, time-up, sysop break), `w`
  (window size) and `e` (editor answer) frames during the door;
- ends the session with `X` when the door has shut down or its process ended
  (`status=ok|carrier|timeout|break|error`), within 30 seconds of a `d` whatever
  the door does, then says `R` again.

A door that never registers, never shuts down or crashes cannot hang the shim:
it reports `X status=error` (no registration within `regtimeout` seconds) or the
`d` reason after 30 seconds, keeps answering the stray door's requests as
"carrier lost", and refuses a new session with `error=busy` until that door
has gone.

### Protocol

Version 1. The design note "Amiga Door Emulation - Shim Protocol" is
authoritative. In brief:

```
0x1E  type  len_hi  len_lo  payload        payload: key=value lines, ISO-8859-1
```

| Shim to host | | Host to shim | |
|---|---|---|---|
| `H` | hello: `version=1`, `shim`, `exec`, `kick`, `baud` | `s` | start a session (user block) |
| `R` | ready for a session | `t` | `timeleft=<minutes>` |
| `L` | door launched: `door`, `pid` | `d` | `reason=hangup\|timeup\|break` |
| `C` | one door request (only with `log=1`) | `w` | `rows`, `cols` |
| `E` | door wants the editor: `file` | `e` | `status=done\|refused` |
| `X` | session over: `status`, `reg`, `cmds`, `codes`, `return`, `error`, `wrote` | | |

User block keys (`s`): `version` and `door` are required; `dir`, `stack`, `args`,
`node`, `name`, `realname`, `location`, `level`, `timeleft`, `timeused`,
`timelimit`, `calls`, `posts`, `uploads`, `downloads`, `ulbytes`, `dlbytes`,
`laston`, `expert`, `ansi`, `rows`, `cols`, `bbsname`, `sysop`, `mainline`,
`timeout`, `log`, `hostname` and `hostip` feed the door's `DT_*` and node queries.

axshim 1.0 also understands these keys, which the version 1 spec does not list yet
(adding keys never bumps the version):

| Key | Default | Meaning |
|---|---|---|
| `now` | unset | Unix seconds; sets the Amiga clock (a restored snapshot's clock is stale) |
| `tz` | 0 | minutes east of UTC, applied to `now` and `laston` |
| `regtimeout` | 30 | seconds the door has to send `JH_REGISTER`; 0 waits for ever |
| `crlf` | 1 | door LF goes out as CR LF, as /X does on its serial side |
| `slot` | 1 | `DT_SLOTNUMBER` |

and adds these keys to `X` when they apply: `rc` (the door's return code, -1 while
it still runs), `changed` (the first file on the boot volume dated after the session
start, which is how file writes are seen for `wrote=1`), `unknown` (command numbers it
did not recognise), `dropdtr=1` (the door asked to hang up the caller), `indrop`
(typed bytes dropped because the door was not reading), `txpoll=1` (the transmit
interrupt never fired, so the shim fell back to polling).

For `changed`/`wrote` to be right, the Amiga clock and the image's file dates must
agree: send `now` (and `tz` when the image was built in local time).

Time fields follow /X's units: `DT_TIMELIMIT` is the seconds left (counting down,
reset by `t`), `DT_TIMEUSED` is `timeused` minutes plus the session so far in
seconds, `DT_TIMETOTAL` is `timelimit` minutes in seconds. `DT_TIMELASTON` and
`DT_CURR_TIME` use /X's clock (seconds since 1970 plus 6 hours, local time).

## Building

Both binaries come from bebbo's `m68k-amigaos-gcc` 6.5 (`-noixemul`, `-m68000`),
run from Docker:

```sh
misc/amiga_door/shim/build.sh                 # clean build of bin/axshim and bin/AEDoor.library
HUNKTOOL=~/amitools/bin/hunktool misc/amiga_door/shim/build.sh    # and list their hunks
```

`build.sh` mounts `misc/amiga_door` into `amigadev/crosstools:m68k-amigaos` and
runs `make` in `shim/`. Inside that image (or with the toolchain installed),
`make` in `shim/` does the same. Commit the rebuilt `bin/` files.

## What goes into a door image

A door image is a small FFS hard-disk image (4 MB is plenty) holding:

```
C/axshim                     bin/axshim
Libs/AEDoor.library          bin/AEDoor.library
S/Startup-Sequence           image/Startup-Sequence
Doors/<name>/...             the door and its data files, icons, configs
```

plus whatever the door expects to find under `BBS:` (an /X install keeps doors'
configs in `BBS:Doors`, screens under `BBS:Node<n>`, and so on; each door's
documentation says). See `image/README.md` for an `xdftool` recipe.

The images are run with the AROS 20260820 Kickstart replacement (to ship with the
emulator package) or a Kickstart 3.1 ROM the sysop supplies. axshim 1.0 is tested
on AROS 20260820; the Kickstart 3.1 run is pending a ROM.

## Licences

`axshim` (`shim/`), the build files and `image/` are BSD-2-Clause, Copyright (c)
2026 Bryan Ashby (NuSkooler). `aedoor/` and `bin/AEDoor.library` are NilBBS's
code under the MIT licence, Copyright (c) 2026 Laine Jones (`aedoor/LICENSE`).
