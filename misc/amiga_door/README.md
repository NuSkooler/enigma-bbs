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

The shim also runs **CLI doors**, plain AmigaDOS programs that use their standard
input and output instead of an /X node: it is the DOS handler (the console) behind
the door's `Input()` and `Output()`.

```
caller ── ENiGMA½ ── emulator worker ══ serial ══ axshim (console handler) ── Input()/Output() ── door
```

And it runs **ARexx (AIM) doors**, /X's `TYPE=AIM` scripts: it is the ARexx host
`AERexxControl<node>` that AmiExpress's REXXDOOR used to provide, and runs the
script with `RX`. This needs ARexx in the image, which only the sysop's own
Workbench 3.1 can supply (AROS has none; `oputil.js amiga-door create --workbench`).

```
caller ── ENiGMA½ ── emulator worker ══ serial ══ axshim ── AERexxControl<n> ── RexxMast ── script
```

And it runs **Paragon doors**, the door protocol of Paragon, StarNet and MAX's BBS
(which /X ran as `TYPE=TIM`): it is the BBS's `DoorControl<line>` port, which
those doors send their 106-byte `DoorMsg` requests to.

```
caller ── ENiGMA½ ── emulator worker ══ serial ══ axshim ── DoorControl<line> ── door
```

And it runs **C-Net ARexx doors**, the ARexx "pfiles" of C-Net Amiga 3 to 5: it is
the C-Net port's ARexx host `CNETREXX<port>` (C-Net counts ports from 0, so node 1
is `CNETREXX0`) and starts the script the way C-Net did, with its host address
already set. Like AIM doors these need the sysop's Workbench ARexx.

```
caller ── ENiGMA½ ── emulator worker ══ serial ══ axshim ── CNETREXX<port> ── RexxMast ── script
```

This directory holds the Amiga-side pieces. They are built with a cross
compiler, and the binaries are committed in `bin/`, so sysops need no Amiga
toolchain.

| Path | What |
|---|---|
| `bin/axshim` | the host shim (axshim 1.5), AmigaOS executable (68000, AROS and Kickstart 3.1) |
| `bin/AEDoor.library` | NilBBS's MIT `AEDoor.library` 3.0, which most doors open |
| `shim/axshim.c` | shim source (BSD-2-Clause) |
| `shim/Makefile`, `shim/build.sh` | build both binaries |
| `aedoor/` | AEDoor.library source from NilBBS with ENiGMA's register-preservation patch, see `aedoor/NOTICE` |
| `image/Startup-Sequence` | template `S:Startup-Sequence` for a door image |
| `image/README.md` | how to build a door disk image |

The host (worker) side is `core/amiga_door/`. `core/amiga_door/protocol.js`
implements the framing; `test/amiga_door_protocol.test.js` covers it.

## The shim

`axshim [baud]` runs from `S:Startup-Sequence` and never returns; `baud` is a
session's line rate when its `s` frame names none (default 115200).
It:

- drives Paula's UART directly (AROS has no `serial.device`; the same code runs on
  Kickstart 3.1), 8N1, with interrupt-driven receive and transmit rings
  and no busy-waiting, and with RTS flow control (see "Serial line" below);
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
  the door does (`CARRIER_GRACE`), then says `R` again. ENiGMA waits
  `disconnectGraceSeconds` (default 35) for that `X` before it drops the worker,
  so the exit status is still reported after a hangup, and a door that saves on
  a hangup has saved before its emulator stops.

For a CLI door (`type=cli` in the session frame) it instead:

- starts `"<door>" <args>` with `SystemTags`, its `Input()` and `Output()` two
  handles on a port of the shim's and its console task that port, so `Open("*")`
  lands there too;
- answers the door's DOS packets: reads from the caller (cooked, with line editing
  and echo as in a Shell window, or raw after `SetMode()`; `console=raw` starts raw
  for doors that never ask), writes to the caller, `WaitForChar()` with its timeout,
  `Open("*")`/`CONSOLE:`; `IsInteractive()` is true;
- on a hangup, time-up, break or input timeout makes reads return end of file and
  writes fail, and sends the door CTRL-C;
- reports `X` when `SystemTags()` returns, with the door's return code (`rc`).

The console handler follows NilBBS's (`src/node/door.c`, MIT); the notice is in
`shim/axshim.c`.

### Serial line

The line discipline: RTS watermarks, the `baud` key, the second `H`, the
listening rate and the 3-second rule. axshim 1.5 does not count on the emulator
holding a received byte until the Amiga has read the one before, which enigma-vamiga's patch
0001 does today and a real Amiga does not:

- RTS (CIA-B PA6) and DTR (PA7) are asserted when the port is opened. The RBF
  interrupt drops RTS when the 4 KB receive ring holds 3 KB, and the shim raises it
  again once it has taken the ring down to 1 KB. RTS is also dropped from an `s`
  until the door's first request (at most 3 seconds), and while a session ends:
  loading a door keeps a 7 MHz AROS machine from the serial interrupt for longer
  than a byte at 38400.
- Keys the door has not read stay in the ring when the door's 4 KB input queue is
  full, so the ring fills and RTS drops; before 1.5 the shim dropped them (`X
  indrop`), and lost one byte of a 4096-byte burst sent before the door read.
  Frames behind keys held this way wait until the door reads, except a `d` the
  shim finds in the ring; and once the door has taken no key for 3 seconds with its
  queue full, the shim drops what it cannot queue again (`indrop`), so a door that
  has stopped reading cannot keep a hang-up waiting behind a flood.
- `s` may name the session's rate, `baud=1200..230400`; the shim answers an accepted
  `s` with a second `H` carrying the rate now in effect. Between sessions it listens
  at no more than 38400 (19200 on a 68000 or 68010), whatever the command line says,
  since a damaged `s` cannot be sent again; the boot `H` carries that rate.
- `X` adds `rtsoff=<n>` (times RTS dropped for a full ring) and `rxfull=<n>` (times
  the ring was full and a byte had to wait in `SERDATR`, which only an emulator that
  holds bytes keeps).

On the host side (`core/amiga_door/amiga_worker.js`) caller input waits in the
worker until the guest has room: at most 768 bytes are in the core's receive buffer
that the Amiga has not taken (`serialInPending`), below the 1 KB the ring has above
its RTS watermark. Nothing is dropped below 1 MB of queued input, and held input
is never dropped while the door keeps taking keys. But a hang-up (`d`) queued
behind more than about 7 KB of input the door has not read (its 4 KB queue and
the ring up to RTS) waits for the door to read down to it: a door that reads very
slowly, one key every few seconds, can hold it past the module's 35-second
`disconnectGraceSeconds`, and the worker is then stopped before the door has seen
the hang-up (an XIM door's save on hang-up does not happen; what it wrote before
is in the image). With enigma-vamiga
0.1.3 or later and an `H` that says `shim=axshim 1.5` or later, the worker turns on
the core's RTS/CTS handshake (`serialHandshake`) and offers nothing while
`emu.guestRts` is off; a restored session starts with the setting its snapshot's
machine had.

Without byte holding, how fast the emulated CPU fetches each byte decides the rate:
38400 on the default 68EC020 at 7 MHz, 57600 with `overclock: 2`, 19200 on a 68000.
Kickstart 3.1 fetches faster than AROS (57600 at 7 MHz).

For an ARexx door (`type=aim`) it:

- opens `rexxsyslib.library` (only now: images without ARexx never need it;
  missing, the session ends with `error=no rexxsyslib`), checks that RexxMast's
  `REXX` port is there (starting `SYS:System/RexxMast` once if not);
- creates the public ARexx port `AERexxControl<node>` and runs
  `SYS:Rexxc/RX <script> <node> [args]`;
- answers the script's host commands (`GETUSER n`, `PUTUSTR`/`PUTUSER n` through
  the same tables as XIM `DT_*` requests; `TRANSMIT`, `SENDSTRING`,
  `SENDMESSAGE`, `GETCHAR`, `QUERY`, `RECEIVE`, `PROMPT`, `SHOWFILE`/`SENDFILE`,
  `SHOWGFILE`, `REMOVERESERVED`, `VERREXXDOOR`, `BUFFERFLUSH`, `FLAGFILE`,
  `EDITFILE`, `SHUTDOWN`), with `RESULT` as an argstring;
- after a hangup, time-up or keyboard timeout answers every command with rc 10
  (REXXDOOR's "carrier lost") and sends the script CTRL-C 5 seconds later;
- reports `X` when `RX` returns, with `rc`, `verbs` and, when rc is not 0, `out`
  (ARexx's `+++` message).

The verb table is REXXDOOR 1.3's (read from the binary); the host-port handling
follows NilBBS's `aim_command` (MIT); `shim/axshim.c` has the details.

For a Paragon door (`type=tim`) it:

- creates the public port `DoorControl<line>`, `<line>` being the last digit of
  `node` (a Paragon door takes its line from the first character of its argument),
  and runs `"<door>" <line> [args]`;
- answers the door's `DoorMsg` requests (`command` at offset 20, `data` 22,
  `string[80]` 24, `carrier` 104): 1 print, 3/5 a character, 6/7 a line, 8 a key,
  9 hang up, 10/19 show a file (19 tries `name.gr1`, then `name.txt`), 11 does a
  file exist, 12 the editor (`E`/`e`), 13 a user number and 14 a user string (from
  the user block, with AmiExpress's tables), 15/16 set the access level or location
  for the session, 17 a random number, 20 shutdown, 21 add minutes, and MAX's BBS's
  113/114 (type a file), 200, 201 (check for a key), 202, 203; the sysop-console-only
  2 and 4 print nothing; a reply writes `string` and `carrier` only into a whole
  106-byte message (`mn_Length`), so a door that sends a shorter one still gets its
  other answers and `X` reports its length once as `shortmsg`;
- sends any of CR, LF, CR LF and LF CR in the door's text as one CR LF (`crlf=1`),
  and reads the text past `string[80]` to its NUL, as Paragon and MAX's did;
- from a hangup, time-up, the door's own hang-up (9) or an input timeout sets
  `carrier` to 1 in every reply (input requests return empty) and sends the door
  CTRL-C 5 seconds later;
- reports `X` when the door ends (or 10 seconds after its shutdown request), with
  `rc` and, when the door added time, `addtime`; a door that ends without a single
  request is `status=error` with the first line it printed.

The command set comes from AmiExpress's own Paragon service (`express.e`, MIT) and
MAX's BBS's door kits; `shim/axshim.c` has the table.

For a C-Net ARexx door (`type=cnetrexx`) it:

- opens `rexxsyslib.library` and checks for RexxMast's `REXX` port as for AIM doors;
- creates the public port `CNETREXX<node - 1>` and sends REXX the script (with
  `args` after it, if any) in a `RexxMsg` whose host address is that port, as C-Net
  started pfiles: no `RX`, no node argument (the script needs no `address`);
- answers C-Net's host commands: `TRANSMIT`/`PRINT` and `SENDSTRING` (text through
  C-Net's MCI, with and without a new line), `SEND`, `SENDFILE`, `GETCHAR` (letters
  in capitals), `MAYGETCHAR` (a key, or `NOCHAR` after 40 ms), `QUERY`, `PROMPT len
  NORMAL|HIDE|YESNO|NOYES text`, `GETUSER n` (C-Net's code table; the 7-digit
  structure peeks answer 0 or an empty string), `SETOBJECT`/`PUTUSER n`,
  `BBSIDENTIFY`, `GETCARRIER` (`TRUE`/`FALSE`), `CARRIER`, `CHANGEWHERE`,
  `ADDTIME` (tenths of a minute), `ADDPOINTS`, `FINDACCOUNT`, the scratch account
  (the caller's own only), `SPAWN`, `BYE`; the editor, mail and file transfer
  commands answer `0`;
- runs C-Net's MCI codes in the text (`^Q<cmd><args>}` and `^Y<cmd><char>`): colour,
  clear, cursor, repeats, and the ones that wait or act: `{G}` a key, `{I}` a line,
  `{?}` yes/no, `{W}` seconds, `{* file}`, `{$ cmd}`, `{V n}`, `{L n m}`; and
  word-wraps the text at the caller's width (C-Net's word wrap);
- after a hangup, time-up, keyboard timeout or `BYE` answers input commands and
  every other command `###PANIC` (C-Net's word for it; `GETCARRIER` says `FALSE`),
  rc 0, and sends the script CTRL-C `panicgrace` seconds later (default 10);
- reports `X` when the script (and what it spawned) ends, with `rc`, `verbs`,
  `unknown`, `where` (the last `CHANGEWHERE`), `addtime`, `addpoints` and `out`.

The command set, the `GETUSER` table, MCI and `###PANIC` follow NilBBS's C-Net host
(MIT) and the C-Net 5 SDK's ARexx guide; `shim/axshim.c` has the details.

A door that never registers, never shuts down or crashes cannot hang the shim:
it reports `X status=error` (no registration within `regtimeout` seconds) or the
`d` reason after 30 seconds, keeps answering the stray door's requests as
"carrier lost", and refuses a new session with `error=busy` until that door
has gone.

### Protocol

Version 1. This section, `core/amiga_door/protocol.js` (framing) and
`shim/axshim.c` (the shim's side) are the reference in this repository. In
brief:

```
0x1E  type  len_hi  len_lo  payload        payload: key=value lines, ISO-8859-1
```

| Shim to host | | Host to shim | |
|---|---|---|---|
| `H` | hello: `version=1`, `shim`, `exec`, `kick`, `baud`; again after an accepted `s` (1.5) | `s` | start a session (user block) |
| `R` | ready for a session | `t` | `timeleft=<minutes>` |
| `L` | door launched: `door`, `pid` | `d` | `reason=hangup\|timeup\|break` |
| `C` | one door request (only with `log=1`) | `w` | `rows`, `cols` |
| `E` | door wants the editor: `file` | `e` | `status=done\|refused` |
| `X` | session over: `status`, `reg`, `cmds`, `codes`, `return`, `error`, `wrote` | | |

User block keys (`s`): `version` and `door` are required; `type` (`xim`, `aim`,
`tim`, `cnetrexx` or `cli`, default `xim`), `console` (`cooked` or `raw`, CLI doors), `dir`, `stack`, `args`,
`node`, `name`, `realname`, `location`, `level`, `timeleft`, `timeused`,
`timelimit`, `calls`, `posts`, `uploads`, `downloads`, `ulbytes`, `dlbytes`,
`laston`, `expert`, `ansi`, `rows`, `cols`, `bbsname`, `sysop`, `mainline`,
`timeout` and `log` feed the door's `DT_*` and node queries; `baud` sets the
session's line rate (axshim 1.5). The shim also answers
`DT_HOSTNAME` and `DT_HOSTIP` from `hostname` and `hostip`, which ENiGMA does not
send: a door that asks gets an empty string.
A CLI door gets none of the user block: its `args` (its whole command line, with no
node number in front) is all it knows about the caller; see "For a CLI door" above.
An ARexx door gets the whole user block, which its `GETUSER` commands read, and so
does a Paragon door (its user number and string requests) and a C-Net ARexx door,
which also reads `account` (its account number, `GETUSER 39`/`40`; default 1, C-Net's
sysop; ENiGMA sends the caller's user ID and does not run the door for a caller who
has not logged in) and
takes `panicgrace` (seconds from carrier loss to its CTRL-C, 0 to 25, default 10; 0
breaks the script before its waiting command is answered) and `wrap` (`0` turns
word wrap off).

Two keys, for any door type, stand in for the lines a door's installation adds to
the sysop's `S:Startup-Sequence` (a minimal image has no `C:Assign`):

| Key | Value | Effect |
|---|---|---|
| `assign` | `NAME=PATH[;NAME=PATH...]` | assigns `NAME:` to `PATH` before the door's path is checked; a missing path ends the session with `error=assign NAME: PATH not found` |
| `env` | `NAME=VALUE[;NAME=VALUE...]` | sets the global variable `ENV:NAME` (making `ENV:` in `RAM:` when the image has none) |

The shim also assigns `PGDOORS:` (the door path Paragon doors ask for) to
`SYS:Doors`, next to `BBS:` and `DOORS:`, and, when the image has those
directories, `PFILES:` to `SYS:PFiles` and `CNET:` to `SYS:CNet` (C-Net's pfile
and system trees; pfiles hard-code paths such as `PFILES:Badlibs/`). When
`CNET:Mail/Users` exists, a C-Net session makes the caller's folder
`CNET:Mail/Users/<account>` in it, where C-Net kept per-caller files.

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
(typed bytes dropped: before 1.5 those the door was not reading, since 1.5 those
the door left for 3 seconds with its queue full, or behind a hang-up), `rtsoff` and `rxfull` (1.5, see "Serial
line"), `txpoll=1` (the transmit interrupt never fired, so the shim fell back to
polling).

For a Paragon door `X` carries `cmds` and `codes` (its command numbers), `reg=0`,
`rc`, `addtime` (minutes the door added; informational, ENiGMA does not apply
them) and `shortmsg` (the `mn_Length` of the first request shorter than a whole
106-byte `DoorMsg`; its `string` and `carrier` were left untouched).

For a C-Net ARexx door `X` carries `cmds`, `codes` (the `GETUSER` codes used),
`verbs`, `unknown` (verbs and codes it did not know), `rc`, `out` (ARexx's `+++` line
when rc is not 0) and, when they apply, `where`, `addtime` (minutes) and `addpoints`
(informational; ENiGMA does not apply them).

For a CLI door `X` carries `cmds=0`, `reg=0` and `rc`; `unknown` lists the DOS packet
types the shim refused (AROS start-up code sends `ACTION_DISK_INFO` and `ACTION_SEEK`,
which are harmless).

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

A door image is a small FFS hard-disk image (2000 KB, `oputil.js amiga-door
create`'s default, is plenty) holding:

```
C/axshim                     bin/axshim
Libs/AEDoor.library          bin/AEDoor.library
S/Startup-Sequence           image/Startup-Sequence
Doors/<name>/...             the door and its data files, icons, configs
```

plus whatever the door expects to find under `BBS:` (an /X install keeps doors'
configs in `BBS:Doors`, screens under `BBS:Node<n>`, and so on; each door's
documentation says). `oputil.js amiga-door create IMAGE DOORDIR...` builds the image
(`core/amiga_door/amiga_fs.js` reads and writes OFS/FFS); see `image/README.md`, which
also has `make_image.sh` and an `xdftool` recipe.

CLI doors may need disk libraries that the AROS ROM lacks; DICE-compiled doors need
`mathieeedoubbas`, `mathieeedoubtrans` and `mathieeesingtrans.library` in `Libs/`
(see `image/README.md`).

ARexx doors need `System/RexxMast`, `Libs/rexxsyslib.library` (which needs
`Libs/mathieeedoubbas.library`), `Libs/rexxsupport.library`, `Rexxc/RX` and the C:
commands scripts call, all from the sysop's Workbench 3.1: `oputil.js amiga-door create
--workbench Workbench3.1.adf` (or `image/make_image.sh -w`) copies them, and `image/Startup-Sequence` starts RexxMast before
the shim. Never commit those files or share such an image.

Paragon doors often need an assign or an `ENV:` variable from their install notes
(`assign`/`env` above, `assigns`/`env` in ENiGMA's door config), and their own data
directories under `DOORS:`.

On the host the image is the emulator's hard disk (enigma-vamiga 0.2.0's file-backed
disk, so its name must end in `.hdf`): the core reads it 4 KB at a time as the guest
asks and, for a door with `persist` on, writes the guest's changes into it in place
once the drive has been idle for 100 ms of Amiga time. When a session ends, however
it ends, the worker runs the guest 3 seconds more (flat out) so its file system
flushes, then `hdfSync()`s the image; with `persist: false` the core keeps every write
and the image is never touched. On ENiGMA's SIGINT shutdown the module first tells each
running door the carrier is gone (`d`), then stops its worker, which keeps running the
guest for up to about 2 seconds of Amiga time (100 frames, flat out) so the door can
save and answer `X`; a door still running after that is synced where it stands, like a
power cut. All workers do this at once and the module waits for their syncs, about 3
seconds at most. What write-through has written is in the image whatever happens, but
it is written 100 ms of Amiga time after the drive goes idle, so a crash can still lose
the last 100 ms and whatever the guest's own file system had not written back yet; and
an uncaught error in the worker ends the session without a final sync (what
write-through already wrote stays). No emulator may have an image open while another
writes it (neither re-reads what the other wrote, and each guest's FFS believes it owns
the volume), so images are held readers/writer: a persisting session holds its image
exclusively until that sync is done, `persist: false` sessions share it, and the two
kinds never run on one image at the same moment. A booted machine's snapshot holds the image's path and the guest's file system
caches, so the module uses it only while the image's size, mtime, inode and device are what
they were right after the snapshot: a session that wrote makes the next one boot.

The images are run with the AROS 20260820 Kickstart replacement (to ship with the
emulator package) or a Kickstart 3.1 ROM the sysop supplies. axshim 1.0 passed
every test door on AROS 20260820 and on Kickstart 3.1 (40.68); axshim 1.1 (CLI
doors) is tested on AROS 20260820; axshim 1.2's ARexx doors (KickBoxing, Hacker,
The Death Game) on both: Workbench 3.1's ARexx runs on the AROS ROM too; axshim
1.3's Paragon doors (Master Space Empire, The Land of VEX, Sector Wars II,
AndroFight) on both. axshim 1.5 runs the same doors on both, and, on a vAmiga
core that does not hold bytes (master with the null-modem frame timing fix and
RTS/CTS handshake, vAmiga #1027 and #1028), every door on AROS at 38400 and at
57600 with `overclock: 2`.

## Licences

`axshim` (`shim/`), the build files and `image/` are BSD-2-Clause, Copyright (c)
2026 Bryan Ashby (NuSkooler). `aedoor/` and `bin/AEDoor.library` are NilBBS's
code under the MIT licence, Copyright (c) 2026 Laine Jones (`aedoor/LICENSE`).
